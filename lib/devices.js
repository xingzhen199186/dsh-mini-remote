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
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** id 和密钥各 128 位。 */
const ID_BYTES = 16
const KEY_BYTES = 16

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
   * 下一步的设置页也会改它。要是拿启动时抄的那一份去认人，这些改动都得等重启才生效
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
      const label = typeof name === 'string' && name.trim() ? name.trim() : '新设备'
      table.push({
        id,
        name: label,
        // 恒为 'phone'：这一步只登记手机。桌面端「远程窗口」是另一套（见 lib/mirror.js），
        // 两者不合并——那张票是一次通行证、寿命跟着进程，不进这份名单。
        kind: 'phone',
        keyHash: sha256(key).toString('hex'),
        createdAt: Date.now(),
      })
      save()
      return { id, name: label, credential: `${id}.${key}` }
    },

    /**
     * 认一枚凭据：对得上就回那条记录（副本），否则 null。
     *
     * **每次都现查磁盘那份**（见 syncFromDisk）：记录被删掉之后，同一台设备的下一次
     * 请求就认不出来了，不必重启、也没有缓存窗口。
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
  }
}
