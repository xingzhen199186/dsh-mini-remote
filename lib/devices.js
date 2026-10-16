/**
 * 「设备身份」名册：一台设备一条记录，落盘在 `$DSH_HOME/dsh-mini-remote/devices.json`
 * （和 `token`、`settings.json`、`state.json` 并排，见 lib/index.js 的 dataDir）。
 *
 * 设计（2026-10-16 用户拍板的那一份，一个字都没改）：
 *   · **身份 = 随机 128 位的 id + 随机 128 位的密钥**；**名字只是标签**，随时能改。
 *   · **不用指纹**：设备类型只用来给个像样的默认名，认人从不看它——指纹会变
 *     （换浏览器、升级系统、隐私模式），拿它认人会**认错人**，比不认更糟。
 *   · **只存密钥的 SHA-256**：读了这份文件也冒充不了已有设备。
 *   · 不加密、不签名：同一目录下的 `token` 本身就是明文，多一道锁只是自欺。
 *   · `kind` 恒为 `'phone'`，留着是为了**跨机落地时省一次文件迁移**。
 *   · **删掉一条记录 = 那台设备当场失效**：认人每次都现查这份表，没有缓存窗口
 *     （见下面的 syncFromDisk——手改文件、或者别的进程删掉一条，下一次请求就生效）。
 *
 * 凭据的线上形状是 `<32 位 hex>.<32 位 hex>`（`id.密钥`）：
 *   id 是明文（它只是个名字），密钥**只在发出去那一下**在服务器手里——之后手上
 *   只剩它的哈希。所以凭据丢了只能重新登记，找不回来。这是对的，不是缺陷。
 *
 * 凭据怎么带（三处都是 lib/server.js 的 isAuthorized 收的，和令牌同一道门）：
 *   · cookie `dsh_mini_device`——**真机上的主路**：浏览器自己带，手机页一行都不用改
 *     （SSE、立绘、镜像框里那些请求全都沾光）；
 *   · 请求头 `X-Mini-Device`；
 *   · 地址里的 `?device=`。
 * **转发到上游之前这三样都要被摘干净**（见 lib/server.js 的 stripOurSecrets 和
 * lib/mirror.js 的 upstreamHeaders）：凭据进没进上游的日志，是两回事。
 *
 * ## 这份模块是名册**唯一**的读写口（2026-10-16 第三步）
 *
 * 设置页那张列表要列出、要改名、要撤销，走的是这里的 `list` / `rename` / `remove`，
 * **不是**自己去读写那个 JSON 文件。理由就一句：内存一份、磁盘一份，两处各写各的
 * 迟早对不上——而对不上的表现是「界面上删了，那台手机还能进」，最难查也最要命。
 *
 * ## `lastSeen`：只记时间，不记 IP、不记指纹
 *
 * 用户拍板的：列表上要有「最近使用时间」。**只存一个时间戳**——地址和指纹一概不留
 * （留了就成了一份"谁在哪儿用过"的档案，而我们只想回答"这台设备还活着吗"）。
 *
 * **不是每个请求都写盘**：手机刷一下就是几十个请求，每个都写盘等于拿磁盘换一个没人
 * 看得见的秒级精度。所以攒在内存里（`pendingSeen`），**最多每 `SEEN_FLUSH_MS` 写一次**，
 * 详见 touch() 上面那一段。
 *
 * ## 对外形状：**永不外泄 keyHash**
 *
 * `list()` / `rename()` 回的是 `publicRecord()`——id、名字、类型、创建时间、最近使用。
 * 密钥的哈希一个字节都不出去（它是"读了文件也冒充不了"的那道保险，摆在界面上没有任何
 * 用处，只会多一处泄漏面）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** id 和密钥各 128 位。 */
const ID_BYTES = 16
const KEY_BYTES = 16

/**
 * 名字最长多少字。**只管住界面**：名字是标签，写长了只是那一行撑破，不是安全问题。
 * 40 够写清是哪台手机（"妈妈那台"、"客厅的 iPad"），又不至于把列表挤变形。
 */
const NAME_MAX = 40

/**
 * `lastSeen` 攒多久写一次盘。
 *
 * 为什么是 60 秒：这个字段的**用途只有屏幕上的那一句话**（"3 分钟前用过"），
 * 精度需求本来就是分钟级；而手机连着的时候一秒能来好几个请求。
 * 攒着 + 定期落盘的代价是**崩溃时会丢**：最多丢掉最近 60 秒里发生的那几次使用
 * ——也就是列表上那句"最近使用时间"最多比真实情况早一分钟。
 * **设备进不进得来这件事一点不受影响**：认人查的是名册本身，不是这个时间戳。
 */
const SEEN_FLUSH_MS = 60_000

/**
 * 凭据的形状。
 *
 * **只写一处、导出给转发那一层用**：lib/server.js 往上游转之前按「值像不像我们的凭据」
 * 摘参数，用的是同一个正则。两处各写一遍，迟早一边改了另一边没改——而那种不一致的
 * 表现是「凭据悄悄进了上游日志」，谁都不会发现。
 */
const CREDENTIAL_SHAPE = /^[0-9a-f]{32}\.[0-9a-f]{32}$/

/**
 * 这个值长得像不像我们的设备凭据。**只看形状，不看参数名。**
 *
 * 为什么按形状而不是「查表里有没有」：撤销掉的那枚凭据已经查不出来了，可它照样
 * 不该被转发出去。形状对就摘，是更保守的那一边——多摘一个我们自己形状的值，
 * 代价只是上游少看到一次它本来也不认识的东西。
 */
export function credentialLooksLikeOurs(value) {
  return typeof value === 'string' && CREDENTIAL_SHAPE.test(value)
}

function sha256(text) {
  return createHash('sha256').update(text).digest()
}

export function createDevices({ file }) {
  /** 内存这份就是当前名册；磁盘那份是它的落点。 */
  let table = []
  /** 磁盘那份的「改动标记」（mtime + 大小）。null = 还没对过。 */
  let stamp = null
  /** 还没落盘的 `lastSeen`：id → 时间戳（每台设备只留最新那一次，不排队）。 */
  const pendingSeen = new Map()
  /** 上一次把 `lastSeen` 写进磁盘的时刻。**0 = 还没写过**，所以第一台设备一进来就落一次。 */
  let seenFlushedAt = 0

  function readFromDisk() {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const list = Array.isArray(raw?.devices) ? raw.devices : []
      return list
        .filter((d) => d && typeof d.id === 'string' && typeof d.keyHash === 'string')
        .map((d) => ({
          id: d.id,
          name: typeof d.name === 'string' ? d.name : '',
          // 缺失或写坏一律当 phone：这个字段恒为 'phone'，认不出别的值。
          kind: typeof d.kind === 'string' && d.kind ? d.kind : 'phone',
          keyHash: d.keyHash,
          createdAt: Number(d.createdAt) || 0,
          // 第三步之前写下的老记录没有这个字段：当 0 = 「还没记过」。
          // **不拿 createdAt 顶替**——那会凭空造出一次"使用"。
          lastSeen: Number(d.lastSeen) || 0,
        }))
    } catch {
      // 首次运行没有这个文件，或文件损坏——都不该让插件起不来。
      // 损坏时名册当作空的：手机重新打开一次页面就重新登记，用户不用做任何事。
      return []
    }
  }

  function fileTag() {
    try {
      const info = statSync(file)
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return 'missing'
    }
  }

  /**
   * 把内存那份对齐到磁盘那份。**只在磁盘真的变过时才重读。**
   *
   * 为什么非要这样，而不是启动时读一次就完事：撤销的语义是**「删掉记录，那台设备
   * 立刻失效」**。用户完全可能自己去删 devices.json 里那一行（它是明文 JSON），
   * 设置页那张列表也在改它。要是拿启动时抄的那一份去认人，这些改动都得等重启才生效
   * ——那就不叫「立刻」了。
   *
   * 每次请求多一次 stat：一条 phone 的请求频率下，这点开销看不见。
   */
  function syncFromDisk() {
    const tag = fileTag()
    if (tag === stamp) return
    stamp = tag
    table = readFromDisk()
  }

  /**
   * 一条记录对外的那一面（**keyHash 不在里面**）。
   *
   * `lastSeen` 取「磁盘那份」和「还没落盘那份」里更新的那个：列表刷新时用户看到的
   * 该是刚刚那一次使用，而不是最多 60 秒之前的旧数（落盘只是持久化，不是真相本身）。
   */
  function publicRecord(record) {
    return {
      id: record.id,
      name: record.name,
      kind: record.kind,
      createdAt: record.createdAt,
      lastSeen: Math.max(record.lastSeen, pendingSeen.get(record.id) ?? 0),
    }
  }

  /**
   * 落盘。**照 lib/store.js:386-392 那一段原子写**（先写临时文件、再改名过去）：
   * 直接往目标文件上写，写到一半断电就留下一份半截 JSON，名册里那几台设备一起没了。
   *
   * `mode: 0o600`：名册里有密钥的哈希，不该给别人看（Windows 上这条基本被忽略，
   * 留着的意义是别的系统上一致）。
   */
  function save() {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ version: 1, devices: table }, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, file)
    } catch {
      // 落盘失败不影响本次运行——内存里那台设备这一轮照常能用。
    }
    stamp = fileTag()
  }

  /**
   * 把攒着的 `lastSeen` 写进磁盘（stamp 上写的那个策略的落点）。
   *
   * 三条细节都是有意的：
   *   · **先对一次磁盘再写**：这中间可能有人撤销了一台设备，拿旧表去写等于把它复活；
   *   · 记录已经不在了 → 这条时间戳跟着它一起扔掉（撤销就是撤销，别留半条尾巴）；
   *   · 只往**更新**的方向改（`at > hit.lastSeen`）：万一另一个进程也写了这份文件，
   *     不让这次落盘把时间戳往回拨。
   */
  function flushSeen() {
    if (!pendingSeen.size) {
      seenFlushedAt = Date.now()
      return
    }
    syncFromDisk()
    for (const [id, at] of pendingSeen) {
      const hit = table.find((d) => d.id === id)
      if (hit && at > hit.lastSeen) hit.lastSeen = at
    }
    pendingSeen.clear()
    save()
    seenFlushedAt = Date.now()
  }

  return {
    /**
     * 登记一台新设备，返回它的凭据（`id.密钥`）。
     *
     * **密钥只在这一刻存在服务器手里**：落盘的只有它的 SHA-256，返回值也没有第二次。
     *
     * @param {{name?: string}} [opts] 名字只是标签，认人从不看它
     * @returns {{id: string, name: string, credential: string}}
     */
    register({ name } = {}) {
      syncFromDisk()
      const id = randomBytes(ID_BYTES).toString('hex')
      const key = randomBytes(KEY_BYTES).toString('hex')
      const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, NAME_MAX) : '新设备'
      table.push({
        id,
        name: label,
        // 恒为 'phone'：这一步只登记手机。桌面端「远程窗口」是另一套（见 lib/mirror.js），
        // 两者不合并——那张票是一次通行证、寿命跟着进程，不进这份名单。
        kind: 'phone',
        keyHash: sha256(key).toString('hex'),
        createdAt: Date.now(),
        // 登记发生在**用户真的打开了一次手机页**那一下（见 lib/server.js 那两处调用点），
        // 所以这一刻本身就算一次使用——列表上刚扫完码的那台设备不该显示成"从未使用"。
        lastSeen: Date.now(),
      })
      save()
      return { id, name: label, credential: `${id}.${key}` }
    },

    /**
     * 认一枚凭据：对得上就回那条记录（副本），否则 null。
     *
     * **每次都现查磁盘那份**（见 syncFromDisk）：记录被删掉之后，同一台设备的下一次
     * 请求就认不出来了，不必重启、也没有缓存窗口。
     *
     * **认人就是认人**：这里一个字都不写盘（"这台设备刚露过面"由调用方显式调 touch，
     * 见下面那个的说明）。
     */
    verify(credential) {
      if (!credentialLooksLikeOurs(credential)) return null
      const dot = credential.indexOf('.')
      const id = credential.slice(0, dot)
      const key = credential.slice(dot + 1)
      syncFromDisk()
      const hit = table.find((d) => d.id === id)
      if (!hit) return null
      const want = Buffer.from(hit.keyHash, 'hex')
      const got = sha256(key)
      // 定长比较（和令牌那边同一条理由）：别让人拿响应时间逐字节试出密钥。
      if (want.length !== got.length || !timingSafeEqual(want, got)) return null
      return { ...hit }
    },

    /**
     * 名册里**还有没有这条记录**（按 id）。
     *
     * **每次都现查磁盘那份**（见 syncFromDisk），和 verify() 同一条口径：撤销是
     * 「删掉那条记录」，删掉之后这里立刻回 false——不必重启，也没有缓存窗口。
     *
     * 为什么不用 verify() 顶这一条：会话里带的是 **id**，不是那枚凭据。凭据能认人
     * （还能进 `/mini/api/*` 全部接口），而窗口会话只够进镜像那一层——把凭据写进
     * 会话等于顺手给窗口升了一次权，所以这里只问「记录还在不在」。
     *
     * @param {string} id
     * @returns {boolean}
     */
    has(id) {
      if (typeof id !== 'string' || !id) return false
      syncFromDisk()
      return table.some((d) => d.id === id)
    },

    /**
     * 名册（**不含 keyHash**），最近登记的排在前面——用户刚加的那台就在眼皮底下。
     *
     * `lastSeen` 在这里就并上了还没落盘的那一份（见 publicRecord），所以列表上看到的
     * 永远是"此刻最新的"那个数，而不是磁盘上那个可能落后一分钟的。
     *
     * @returns {{id:string,name:string,kind:string,createdAt:number,lastSeen:number}[]}
     */
    list() {
      syncFromDisk()
      return table
        .map(publicRecord)
        .sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? -1 : 1))
    },

    /**
     * 改名字。**只改名字**：认人从不看它（见文件开头），改了不影响那台设备还进不进得来。
     *
     * @returns {{ok:true, device:object} | {ok:false, error:string}}
     */
    rename(id, name) {
      const label = typeof name === 'string' ? name.trim() : ''
      if (!label) return { ok: false, error: '名字不能是空的。' }
      if (label.length > NAME_MAX) return { ok: false, error: `名字最多 ${NAME_MAX} 个字。` }
      syncFromDisk()
      const hit = table.find((d) => d.id === id)
      // 找不到就说找不到：界面据此让用户刷新一下（多半是另一个标签页刚撤销了它）。
      if (!hit) return { ok: false, error: '这台设备已经不在名册里了，刷新看看。' }
      hit.name = label
      save()
      return { ok: true, device: publicRecord(hit) }
    },

    /**
     * 撤销一台设备：**删掉那条记录**。
     *
     * 删掉之后那枚凭据什么都换不来了（认人现查这份表），但**这一层只负责名册**——
     * 「它手上那条活连接」不归这儿管，由 lib/server.js 的 dropDeviceConnections
     * 掐掉（只靠"下次请求被拒"，用户会以为撤销没生效）。
     *
     * 攒着的那条 `lastSeen` 一并扔掉——不然下次落盘会拿着一条已经删掉的 id 去找记录，
     * 白跑一趟（flushSeen 里那条"记录不在了就扔掉"就是给这一条兜底的）。
     *
     * @returns {boolean} 真的删掉了一条
     */
    remove(id) {
      syncFromDisk()
      const at = table.findIndex((d) => d.id === id)
      if (at < 0) return false
      table.splice(at, 1)
      pendingSeen.delete(id)
      save()
      return true
    },

    /**
     * 「这台设备刚露过面」——`lastSeen` 的**唯一**写入点。
     *
     * **不在 verify() 里顺手做**，理由是可读性：认人是认人，记时间是记时间，
     * 两件事分开写，才不会出现「某个认人的路径悄悄漏掉了时间戳」或者反过来。
     *
     * 节流（用户拍板的策略，写在文件头 `SEEN_FLUSH_MS` 那一段）：
     *   · 时间戳先攒在内存里（每台设备只留最新那一次，不排队）；
     *   · **最多每 60 秒落一次盘**——所以磁盘上那个数最多比真实情况早一分钟；
     *   · 第一次触达（`seenFlushedAt === 0`）当场就落一次，免得"刚用过"这台设备
     *     在一分钟之内看着像从未用过。
     *   · **崩溃丢多少**：最多丢掉最近 60 秒内的那几次使用记录。设备能不能进门
     *     **一点不受影响**（认人查名册本身，不查时间戳）。
     */
    touch(id) {
      if (typeof id !== 'string' || !id) return
      const now = Date.now()
      pendingSeen.set(id, now)
      if (now - seenFlushedAt < SEEN_FLUSH_MS) return
      flushSeen()
    },
  }
}
