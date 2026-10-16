/**
 * 「我能连的电脑」名册（**B 侧**）：一台远端电脑一条记录，落盘在
 * `$DSH_HOME/dsh-mini-remote/remotes.json`（和 `devices.json` 并排，同一个数据目录）。
 *
 * ## 它和 devices.json 是两个人，别看错方向
 *
 * `devices.json` 记的是**谁连得上我**（那台电脑来配对时留下的名册：密钥只存哈希，
 * 读了文件也冒充不了）；这一份记的是**我连得上谁**：里面那枚 `credential` 是**别人
 * 发给我的**门卡，每次去换票都要**原样**发回去，所以它必须留着、而且只能是明文
 * （见下面"明文存"那一段）。
 *
 * ## 为什么不能放进 settings.json（和 devices.json 当初同一条口径）
 *
 * `settings.json` 是给用户手改的，字段会进设置页那张表单。**长期凭据混进去，等于
 * 「改个设置」都有机会碰坏登录凭据**——而且那份文件还会进备份、进界面的表单回显。
 * 这份名册由插件自己管；界面要看，就照这一份渲染一份名单。
 *
 * ## 凭据只活在宿主进程里，**绝不进浏览器**
 *
 * `list()` 和 `add()` 回来的都是 `publicRecord()`——**没有 credential**（照
 * lib/devices.js 的 `publicRecord` 那个先例）。整份文件里**唯一**把凭据交出去的地方是
 * `secret()`：它只给「取票」那条宿主路由用（见 lib/index.js 的
 * `/mini-remote/remotes/window`），而那一条只把它放进发给 A 的**请求头**。
 * 界面拿到的永远只是 id、名字、地址、两个时间。
 *
 * ## 明文存，不加密（有意的）
 *
 * devices.json 那边只需要**认**（存哈希就够）；这一份反过来：B 必须把凭据**发回给 A**，
 * 所以只能明文。同一目录下的 `token` 本身就是明文，多一道锁只是自欺。该做的是两件事：
 * **文件权限 0600、永不外发**——能读这个文件的人，本来也读得到同一目录里的 `token`。
 *
 * ## 一条记录长什么样
 *
 * ```
 * { id, name, baseUrl, credential, addedAt, lastOk }
 * ```
 *   · `id`：**B 自己起的**名字（随机 128 位），只在 B 内部用。A 那边名册里那份 id 是
 *     另一个（就在凭据里，形如 `<id>.<密钥>`），两边不互通、也不该互通；
 *   · `baseUrl`：A 的地址，**存进来的时候就规整过**（见 normalizeBaseUrl）；
 *   · `lastOk`：**最近一次成功换到票**的时刻；`0` = 还没成功过。
 *     只记时间，不记地址、不记 IP（和 devices.js 的 `lastSeen` 同一条口径）。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { credentialLooksLikeOurs } from './devices.js'

/** id 128 位。它只是 B 内部的名字，不是任何凭据。 */
const ID_BYTES = 16

/** 名字最长多少字。只管住界面（理由同 lib/devices.js 的 NAME_MAX）。 */
const NAME_MAX = 40

/** 地址最长多少字：够写下一整条 https 地址，又不至于把列表撑变形。 */
const URL_MAX = 300

/**
 * 把用户给的地址规整成我们要存的那一条：去空格、去尾斜杠；**必须带 scheme**，
 * 而且不带查询串和片段（那种地址后面拼 `/mini-remote/pair` 就拼坏了）。
 *
 * 为什么不"少了就替他补一个 `http://`"：Tailscale 那条路是 **https**，补错了会在
 * 对面表现成"连不上"，而用户手里那条地址本来是对的——错在我们。所以宁可当场说清
 * 怎么改，也不猜。
 *
 * @param {unknown} value
 * @returns {string} 规整过的地址；`''` = 这个值不能用（调用方据此说人话）
 */
export function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim().replace(/\/+$/, '')
  if (!text || text.length > URL_MAX) return ''
  let url
  try {
    url = new URL(text)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  if (url.search || url.hash) return ''
  return text
}

/**
 * 名字没给的时候用什么。取地址里的 host（`192.168.1.5:3090`、`a.example.ts.net`）——
 * 列表上要能一眼分出是哪一台；统一叫「另一台电脑」等于没名字。
 */
function defaultNameFor(baseUrl) {
  return new URL(baseUrl).host.slice(0, NAME_MAX)
}

export function createRemotes({ file }) {
  /** 内存这份就是当前名册；磁盘那份是它的落点。 */
  let table = []
  /** 磁盘那份的「改动标记」（mtime + 大小）。null = 还没对过。 */
  let stamp = null

  function readFromDisk() {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const list = Array.isArray(raw?.remotes) ? raw.remotes : []
      return list
        .filter((r) => r && typeof r.id === 'string' && typeof r.baseUrl === 'string' && typeof r.credential === 'string')
        .map((r) => ({
          id: r.id,
          name: typeof r.name === 'string' ? r.name : '',
          baseUrl: r.baseUrl,
          credential: r.credential,
          // 缺字段当 0 = 「还没有过」，**不拿 addedAt 顶替 lastOk**（那会凭空造出一次成功）。
          addedAt: Number(r.addedAt) || 0,
          lastOk: Number(r.lastOk) || 0,
        }))
    } catch {
      // 首次运行没有这个文件，或文件损坏——都不该让插件起不来。
      // 损坏时名册当作空的（那是"这台电脑还没连过别的电脑"最接近的说法）。
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
   * 和 devices.js 那边同一条理由：这份文件是明文 JSON，用户完全可能自己去删一行
   * （"这台电脑我不想连了"）。要是拿启动时抄的那一份当真相，这种改动就得等重启才生效
   * ——列表上照旧列着它，而用户以为自己已经断开了。每次多一次 stat，代价看不见。
   */
  function syncFromDisk() {
    const tag = fileTag()
    if (tag === stamp) return
    stamp = tag
    table = readFromDisk()
  }

  /**
   * 一条记录对外的那一面（**credential 不在里面**）。
   *
   * 这是「凭据不进浏览器」这条规矩的**落点**：界面（以及日志、错误信息）能拿到的
   * 只有这里这五个字段。谁要改这里，先想清楚是不是在把门卡递给界面。
   */
  function publicRecord(record) {
    return {
      id: record.id,
      name: record.name,
      baseUrl: record.baseUrl,
      addedAt: record.addedAt,
      lastOk: record.lastOk,
    }
  }

  /**
   * 落盘。**照 lib/store.js:378-392 / lib/devices.js:182-192 那一段原子写**
   * （先写临时文件、再改名过去）：直接往目标文件上写，写到一半断电就留下一份半截
   * JSON，名册里那几台电脑一起没了。
   *
   * `mode: 0o600`：这份文件里有**别人发给我的长期凭据**，不该给别人看。
   * （Windows 上这条基本被忽略，留着的意义是别的系统上一致——和 devices.js 同样的说明。）
   *
   * 失败不影响本次运行：内存里那份照常用，界面这一轮不会看到"添加失败"。
   */
  function save() {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ version: 1, remotes: table }, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, file)
    } catch {
      // 落盘失败不影响本次运行——内存里那台电脑这一轮照常能用。
    }
    stamp = fileTag()
  }

  return {
    /**
     * 名册（**不含 credential**），最近添加的排在前面。
     *
     * @returns {{id:string,name:string,baseUrl:string,addedAt:number,lastOk:number}[]}
     */
    list() {
      syncFromDisk()
      return table
        .map(publicRecord)
        .sort((a, b) => (b.addedAt - a.addedAt) || (a.id < b.id ? -1 : 1))
    },

    /**
     * 拿一台电脑的**地址和凭据**。
     *
     * ⚠️ **这是整份名册里唯一交出凭据的地方**，只该被「取票」那一条宿主路由调用，
     * 而且调用方有义务做到两件事：凭据**只进发给 A 的请求头**、**不进任何回给界面的
     * JSON**（见 lib/index.js 的 `/mini-remote/remotes/window`）。
     *
     * 每次现查磁盘那份（见 syncFromDisk）：用户手删了一行，下一次取票就找不到它了。
     *
     * @returns {{baseUrl:string, credential:string} | null}
     */
    secret(id) {
      if (typeof id !== 'string' || !id) return null
      syncFromDisk()
      const hit = table.find((r) => r.id === id)
      return hit ? { baseUrl: hit.baseUrl, credential: hit.credential } : null
    },

    /**
     * 收下一台电脑（凭据是从 A 换回来的那枚）。
     *
     * 地址和凭据都在这儿验一遍（**唯一**一份校验，路由那一层只负责把错话递出去）：
     * 地址不像样、或者那枚凭据的形状不对，**一律不落盘**——脏记录比没有记录难查得多。
     *
     * @param {{name?: string, baseUrl?: unknown, credential?: unknown}} [opts]
     * @returns {{ok:true, remote:object} | {ok:false, error:string}}
     */
    add({ name, baseUrl, credential } = {}) {
      const clean = normalizeBaseUrl(baseUrl)
      if (!clean) return { ok: false, error: '那台电脑的地址要写成 http:// 或 https:// 开头的一整条。' }
      if (!credentialLooksLikeOurs(credential)) {
        return { ok: false, error: '那台电脑回了话，但那枚凭据不像是它发出来的——多半是它那边的版本和这边对不上。' }
      }
      const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, NAME_MAX) : defaultNameFor(clean)
      syncFromDisk()
      const record = {
        id: randomBytes(ID_BYTES).toString('hex'),
        name: label,
        baseUrl: clean,
        credential,
        addedAt: Date.now(),
        // 刚加进来还没换过票：0 = 「还没成功过」（第一次换票成功才写上）。
        lastOk: 0,
      }
      table.push(record)
      save()
      return { ok: true, remote: publicRecord(record) }
    },

    /**
     * 「这台电脑刚成功换到过票」——`lastOk` 的唯一写入点。
     *
     * @returns {boolean} 真的记上了（找不到那条记录就 false，比如另一个标签页刚断开它）
     */
    markOk(id) {
      if (typeof id !== 'string' || !id) return false
      syncFromDisk()
      const hit = table.find((r) => r.id === id)
      if (!hit) return false
      hit.lastOk = Date.now()
      save()
      return true
    },

    /**
     * **忘掉**一台电脑：删掉那条记录。
     *
     * ⚠️ 它和 A 那边的「撤销」（`/mini-remote/devices/revoke`）**不是一回事**，而且
     * 这一层**不许**替用户去 A 撤销（用户拍板的：**B 不管理它连的那台 A**）。
     * 所以这里只删 B 本地这一条——**B 手上那枚凭据跟着没了**（删记录本身就把它带走了），
     * 但 A 名册里那条记录**照旧还在**，那台电脑照旧认它。要彻底收回，只能去 A 的设置页
     * 撤销那一台（给用户的话写在 lib/index.js 的 `REMOTE_FORGOTTEN_NOTE` 里）。
     *
     * @returns {boolean} 真的删掉了一条
     */
    forget(id) {
      if (typeof id !== 'string' || !id) return false
      syncFromDisk()
      const at = table.findIndex((r) => r.id === id)
      if (at < 0) return false
      table.splice(at, 1)
      save()
      return true
    },
  }
}
