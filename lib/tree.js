/**
 * 工作区 → 会话 的树，给手机左侧导航栏用。
 *
 * 数据来自两个服务，都在 web 组合里，headless 组合里没有：
 *   - workspaceRegistry.list()    同步。工作区的顺序、每个工作区下有哪些会话，
 *                                 以及会话的排列顺序，全在这里。桌面端左侧栏的
 *                                 分组用的就是它。
 *   - sessionQuery.listSessions() 异步。会话的事实：id、创建时间、cwd、origin。
 *                                 注意它**不含标题**，标题要另外去读日志。
 *
 * 两个都不是必需的：拿不到就退回「只知道当前活跃会话」的老样子，不报错。
 *
 * 关于规模：本机实测 35 个工作区，最多的一个有 452 个会话。所以这里所有查询
 * 都是**按需 + 限量**的——打开导航栏只列工作区（便宜），展开某个工作区才去取
 * 它的会话（要读日志折标题，贵）。
 */
import { basename } from 'node:path'
import { statSync } from 'node:fs'
import { findSessionLog } from './log-tail.js'

/** 一个工作区默认最多列多少会话。手机上再多也划不动。 */
export const SESSIONS_PER_WORKSPACE = 20

function safeList(registry) {
  if (!registry) return []
  try {
    return registry.list() ?? []
  } catch (err) {
    // 服务还没启动时 requireState() 会抛。导航栏少几项，不该影响遥控本身。
    return []
  }
}

/**
 * `listSessions()` 很贵：它要扫盘列出所有持久化的会话，再给每条记录做一次
 * `structuredClone`。本机几百个会话，实测这个接口要 **850 毫秒左右**。
 *
 * 而导航栏会反复问同一个问题——打开一次、展开一个工作区、切回来再看一眼，
 * 每次都问。用户报的「打开导航栏似乎每次都要重新读取」，根源就是这一秒。
 *
 * 所以在这里缓存一份。会话列表晚 30 秒知道不算错（手机上你本来也是手动刷新的），
 * 真想立刻看到最新的，按导航栏的 ⟳，它带 `refresh=1` 绕过缓存。
 */
const CACHE_TTL_MS = 30_000
/**
 * query 服务 → { at, records, inflight }。
 *
 * **用 WeakMap 而不是一个模块级变量**：缓存必须认得出「这份数据是谁的」。
 * 写成一个全局变量时，服务实例一换（插件重载、测试里每个用例各给一个桩），
 * 新来的调用方就会拿到上一个实例的数据——而且不报错，只是安静地串味。
 * 测试就是这么把它逮住的：五个用例突然读到了别的用例的工作区。
 */
const caches = new WeakMap()

async function safeRecords(query, { force = false } = {}) {
  if (!query) return []
  let entry = caches.get(query)
  if (!entry) {
    entry = { at: 0, records: null, inflight: null }
    caches.set(query, entry)
  }
  if (!force && entry.records && Date.now() - entry.at < CACHE_TTL_MS) return entry.records
  // 同一时刻来两个请求就共用一趟，别让它们各扫一遍盘。
  if (entry.inflight) return entry.inflight
  entry.inflight = (async () => {
    try {
      const records = (await query.listSessions()) ?? []
      entry.at = Date.now()
      entry.records = records
      return records
    } catch (err) {
      // 读不到就当作没有：导航栏少几项，不该影响遥控本身。失败不进缓存，下次还会重试。
      return []
    } finally {
      entry.inflight = null
    }
  })()
  return entry.inflight
}

function toRecordMap(records) {
  const map = new Map()
  for (const r of records) {
    if (r?.header?.id) map.set(r.header.id, r)
  }
  return map
}

/** 子 agent 的会话不进手机——用户遥控的是自己的会话，不是它派出去的小弟。 */
function visible(record) {
  return Boolean(record) && record.header.origin !== 'subagent'
}

/**
 * 把标题从服务返回的形状里抠出来。
 *
 * 坑在这里：`readTitleSnapshots()` 给的**不是字符串**，而是一个「标题快照」对象
 * `{ title, messageSeqs, source, eventSeq, updatedAt }`（见 dsh-session-title 的
 * `titleSnapshotFromState`）。真正那句话在 `.title` 里。
 * 而 `readTitle()` 反而直接返回字符串——同一件事的两个接口形状不一样。
 *
 * 不处理的话界面会显示 `[object Object]`（真机上就是这么发现的）。
 * 两种形状都收，免得以后哪边改了又炸。
 */
function titleText(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.title === 'string') return value.title
  return ''
}

/**
 * 工作区列表。默认只给「有会话可切」的那些，空工作区不占地方。
 * 返回顺序就是桌面端的显示顺序。
 *
 * `includeEmpty`：把一条会话都没有的工作区也列出来。
 * **手机端必须开着这个**——手机现在能自己新建工作区了，一个刚建好的工作区
 * 本来就是空的；要是列表把它滤掉，用户建完它就当场消失，只会以为没建成。
 * （闸门脚本就是这么逮到的：接口回 created=true，列表里却找不到。）
 * 默认仍然是「滤掉」，桌面端那些老调用方的行为一点不变。
 */
export async function listWorkspaces({ registry, query, runningIds, force, includeEmpty }) {
  const byId = toRecordMap(await safeRecords(query, { force }))
  const out = []
  for (const ws of safeList(registry)) {
    const ids = (ws.sessionIds ?? []).filter((id) => visible(byId.get(id)))
    if (!ids.length && !includeEmpty) continue
    let running = 0
    for (const id of ids) if (runningIds?.has(id)) running += 1
    out.push({
      id: ws.id,
      // title 可能为空，退回到目录名——总比一个 UUID 强
      title: (ws.title || '').trim() || basename(ws.path || '') || '未命名工作区',
      path: ws.path || '',
      count: ids.length,
      running,
      // 手机据此决定是「展开看会话」还是直接提示「这里还没有会话，可以建一个」。
      empty: ids.length === 0,
    })
  }
  return out
}

/**
 * 在一个已有的工作区里新建一个会话。
 *
 * **走 DSH 自己那条路**：`sessionController.create({ workspaceId })`——就是网页端
 * 点「新建会话」时走的那条。不自己拼会话，理由是装配一个能用的会话远不止「起个 id」：
 * 要先装模型选择（`agentDefaultModel`），再把 agent preset 挂到它的作用域上
 * （工具、指令、技能全在那里面），最后才注册进 sessions 和 agents 两张表。
 * 这些都在 `dsh-api-session-controller` 内部，抄一遍等于把 DSH 的内部结构复制到
 * 我们这儿，它一改我们就散架。它自己也是拿 `ctx.agents.create(...)` 做的，
 * 而 `ctx.agents` 就是注入给我们的那个 AgentRegistry。
 *
 * 三种失败分得开，因为手机上的说法不一样：
 *   - `no-controller` 这台电脑上的 DSH 没提供会话服务（headless 组合里没有）
 *   - `no-workspace`  工作区不在了（桌面端刚把它删掉）
 *   - `failed`        DSH 拒绝了，原因原样带回
 */
export async function createSessionIn({ controller, registry, workspaceId }) {
  if (!controller || typeof controller.create !== 'function') {
    return { ok: false, reason: 'no-controller' }
  }
  const ws = safeList(registry).find((w) => w.id === workspaceId)
  if (!ws) return { ok: false, reason: 'no-workspace' }

  let created
  try {
    created = await controller.create({ workspaceId })
  } catch (err) {
    return { ok: false, reason: 'failed', error: String(err?.message ?? err) }
  }
  // 建成了就必须有 id。没有 id 的话手机没法绑过去，等于白建——宁可报错也不装作成功。
  const sessionId = created?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, reason: 'failed', error: 'DSH 建了会话但没返回 id' }
  }
  return {
    ok: true,
    sessionId,
    // 手机建完要显示一句「已在《xxx》里建好」，所以顺手把标题带回去。
    workspaceTitle: (ws.title || '').trim() || basename(ws.path || '') || '未命名工作区',
  }
}

/**
 * 把一个目录登记成工作区。
 *
 * 先 `resolveByPath` 再 `create`，虽然 `create` 自己也会复用同路径的已有记录
 * （它的文档写着 "Repeated calls for the same canonical path return the existing
 * entity without changing its title"）。多问一次是为了**能如实告诉手机
 * 「这是新建的，还是本来就有」**——用户点了「新建工作区」，结果只是切到一个
 * 早就登记过的目录，界面得说清楚，不能让他以为建了个新的。
 *
 * 两个方法的失败形状不一样，都要接：
 *   - `resolveByPath` 在路径**不存在**时靠 realpath 抛错（文档原话：
 *     "A missing path rejects during realpath"）
 *   - `create` 在路径是相对路径、不存在、或者不是目录时拒绝
 *
 * 注意 `create` 会把路径用 `fs.realpath` 规范化——所以我们报回去的 `path`
 * 用它给的那份，而不是手机传进来的那份。两者可能不一样（短路径、大小写、
 * 符号链接），界面上要显示的是**真实的那条**。
 */
export async function createWorkspaceAt({ registry, path }) {
  if (!registry || typeof registry.create !== 'function') {
    return { ok: false, reason: 'no-registry' }
  }
  if (typeof path !== 'string' || path.trim() === '') {
    return { ok: false, reason: 'bad-path' }
  }

  try {
    const existing = await registry.resolveByPath(path)
    if (existing) {
      return { ok: true, created: false, workspace: shapeWorkspace(existing) }
    }
  } catch (err) {
    // 路径不存在时这里就会抛。**不当作失败**：让它落到下面 create 那一步，
    // 由 create 给出「不存在 / 不是目录」的准确说法。两处各报一次错的话，
    // 手机上会看到两条不一样的话，反而不知道信哪条。
  }

  try {
    const created = await registry.create(path)
    return { ok: true, created: true, workspace: shapeWorkspace(created) }
  } catch (err) {
    return { ok: false, reason: 'failed', error: String(err?.message ?? err) }
  }
}

/** 工作区实体 → 手机要的那几项。别把整个实体丢过去：它带一堆内部字段。 */
function shapeWorkspace(ws) {
  return {
    id: ws?.id ?? '',
    path: ws?.path ?? '',
    title: (ws?.title || '').trim() || basename(ws?.path || '') || '未命名工作区',
  }
}

/**
 * 某个工作区下的会话，新的在前，最多 limit 条。
 *
 * 标题分两步拿：插件自己在事件流里见过的（内存里就有，免费）优先；
 * 剩下的冷会话才去读日志。**只在展开一个工作区时才付这个代价**，所以有上限。
 */
export async function listSessionsOf({ registry, query, agents, knownTitles, workspaceId, limit = SESSIONS_PER_WORKSPACE, force }) {
  const ws = safeList(registry).find((w) => w.id === workspaceId)
  if (!ws) return null

  const byId = toRecordMap(await safeRecords(query, { force }))
  const rows = (ws.sessionIds ?? [])
    .map((id) => byId.get(id))
    .filter(visible)
    .sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0))
    .slice(0, limit)

  // 内存里已知的标题先用着，缺的再去读日志。
  const titles = new Map()
  const missing = []
  for (const r of rows) {
    const known = knownTitles?.get(r.header.id)
    if (known) titles.set(r.header.id, known)
    else missing.push(r.header.id)
  }
  if (missing.length && query?.readTitleSnapshots) {
    try {
      for (const item of await query.readTitleSnapshots(missing)) {
        const title = item?.status === 'fulfilled' ? titleText(item.value?.title) : ''
        if (title) titles.set(item.sessionId, title)
      }
    } catch (err) {
      // 读不出来就没有标题，界面会退回用日期，不影响切换。
    }
  }

  return {
    workspaceId,
    total: (ws.sessionIds ?? []).length,
    truncated: (ws.sessionIds ?? []).length > rows.length,
    sessions: rows.map((r) => {
      const id = r.header.id
      const status = agents?.get(id)?.status
      return {
        id,
        title: titles.get(id) ?? '',
        createdAt: r.header.createdAt ?? 0,
        running: status === 'running',
        live: Boolean(r.live),
      }
    }),
  }
}

/**
 * 会话日志的压缩体积（字节）。拿不到就返回 null——**不猜**。
 *
 * 为什么要它：`sessionQuery.readSession()` 会把整份事件解出来（还要做两次全量克隆），
 * 而且 0.1.7-rc.2 起 v3 日志要走 v3→v4 迁移，迁移过程会把这个父会话的
 * **每个直接子会话整份解码**。实测：26MB / 2.2 万事件的父会话带 310 个子会话时，
 * 默认约 4GB 堆 20 秒就 OOM（见 2026-09-25 事故）。所以读之前先量体积。
 */
function logBytes(sessionId) {
  const file = findSessionLog(sessionId)
  if (!file) return null
  try {
    return statSync(file).size
  } catch {
    return null
  }
}

/**
 * 一次「整份读」值不值得。子会话数用已缓存的 `listSessions()` 记录算（**无额外扫盘**）。
 *
 * 读不动有两类原因：① **子会话太多**（迁移要把它们全解出来）；② **自己太大**
 * （解 + 两次克隆 ≈ 体积的 5–8 倍）。两个信号都给出去，阈值由调用方定。
 *
 * @param {{query:object, sessionId:string}} args
 * @returns {Promise<{children:number, bytes:number|null}>} children = 以它为 parentSession 的会话数
 */
export async function sessionScale({ query, sessionId }) {
  const records = await safeRecords(query)
  let children = 0
  for (const r of records) {
    if (r?.header?.parentSession === sessionId) children += 1
  }
  return { children, bytes: logBytes(sessionId) }
}
