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
import { readTailEvents } from './log-tail.js'

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

/**
 * 已经读出来的**会话标题**，也按 query 分开存一份。
 *
 * 为什么单独缓存它：清单本身（safeRecords）有 30 秒缓存，但冷会话的标题要去加载它的日志
 * 才能折出来（DSH 的 readTitleSnapshots 就是逐个 load），实测展开一个工作区要 3 秒——
 * 而这一步原先每次展开都重付一次。标题定下来基本不变，读过就该记住。
 *
 * 同样用 WeakMap 认"这份数据是谁的"，理由见上面 caches 的注释。
 * **空标题也记**：会话确实没有标题时，没理由每次再去重读一遍；将来它有了标题，
 * 事件流那条路（knownTitles）会先命中并覆盖掉。
 */
/**
 * 展开工作区时，标题**最多**等这么久（毫秒）。
 *
 * 快的读取（几条会话、日志不大）在这个上限内就回来了，行为和原来一样；
 * 慢的读取（实测有工作区要 19 秒）到点就放手，响应先走，标题留给后台补齐。
 * 为什么是 250：这是"人感觉不到"和"人开始看表"之间的分界，也远小于手机页一次渲染的间隔。
 */
const TITLE_WAIT_MS = 250

/**
 * 内存里这份标题缓存放多久。
 *
 * 原来是 10 分钟，因为那时它是**唯一**的一份——过期就真的没了，得回去重读日志。
 * 现在落盘那份（lib/title-cache.js）才是长期记忆，内存这份只是它的快照，
 * 过期了从盘上再捞一次即可（见 titleCacheFor）。所以两边统一成同一个七天，
 * 免得出现"盘上有、内存说没有、又去读一遍日志"这种白花的活。
 */
const TITLE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const TITLE_CACHE_MAX = 500
const titleCaches = new WeakMap()

/**
 * 建内存缓存时**先把落盘那份灌进来**。
 *
 * 这一步就是"标题落盘"的全部意义所在：DSH 一重启，内存清零，而盘上那份还在，
 * 于是展开一个读过的工作区依然是毫秒级——不必把 1.4 GB 日志重付一遍。
 */
function titleCacheFor(query, persisted) {
  if (!query) return null
  let entry = titleCaches.get(query)
  if (!entry) {
    entry = new Map()
    for (const [id, row] of persisted?.all() ?? []) entry.set(id, row)
    titleCaches.set(query, entry)
  }
  return entry
}

/**
 * 记下一条标题。重插一次是为了让 Map 的顺序等于"最近更新在后"，好按容量淘汰最老的。
 *
 * 同时写进落盘那份（如果有）——**事件流里见到的新标题也走这条**，
 * 于是盘上那个旧值当场就被覆盖，不会留着一个过时的说法。
 */
function rememberTitle(cache, id, title, persisted) {
  if (!cache || !id) return
  cache.delete(id)
  cache.set(id, { title, at: Date.now() })
  if (cache.size > TITLE_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  persisted?.set(id, title)
}

/**
 * 后台读标题的**全局**并发上限。
 *
 * 一趟 readTitleSnapshots 就是"把这几份会话日志解压 + 折标题"，实测单条约 5 秒且吃 CPU。
 * 列表不再干等之后，用户连续展开几个工作区就会有几趟同时在跑、互相抢。原先只有
 * "按 query 去重"（见 titleInflight 的注释）——那只挡住同一个会话被读两遍，**不是闸门**：
 * 五个工作区各读各的，照样是五趟并行。
 *
 * 为什么是 2：一台电脑上同时解两份日志，用户感觉不到卡；再多就会和别的事（模型请求、
 * 手机页面自己）抢。而且这些标题本来就没人等着，晚几百毫秒没有任何代价。
 */
export const TITLE_CONCURRENCY = 2
const TITLE_READ_TIMEOUT_MS = 8_000
const TITLE_RETRY_MS = 60_000

let titleRunning = 0
const titleWaiting = []

/** 排队等一个名额。fn 跑完（成了、抛了都算）把名额让给下一个。 */
function withTitleSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      titleRunning += 1
      Promise.resolve()
        .then(fn)
        .then(
          (value) => {
            titleRunning -= 1
            runNextTitle()
            resolve(value)
          },
          (err) => {
            titleRunning -= 1
            runNextTitle()
            reject(err)
          },
        )
    }
    if (titleRunning < TITLE_CONCURRENCY) run()
    else titleWaiting.push(run)
  })
}

function runNextTitle() {
  const next = titleWaiting.shift()
  if (next) next()
}

/**
 * 取一条缓存标题。
 *
 * 「过期的当场删掉；"没查到过"和"查到是空标题"要分得出来」——后者返回的是空串，
 * 前者返回 null，调用方（尤其是 pending 那个数）全靠这个区别。
 *
 * **内存里没有就去盘上找一眼**：内存这份上限 500 条，而本机 36 个工作区全展开一遍
 * 就可能把它挤满；标题的长期记忆本来就在盘上（lib/title-cache.js），
 * 被挤掉一条不该等于"回去重读 5 秒日志"。找到就顺手回灌进内存，只回灌不写盘——
 * 盘上那份本来就是它。
 */
function cachedTitle(cache, id, persisted) {
  const hit = cache?.get(id)
  if (hit) {
    if (Date.now() - hit.at <= TITLE_TTL_MS) return hit.title
    cache.delete(id)
  }
  const fromDisk = persisted?.get(id)
  if (typeof fromDisk !== 'string') return null
  if (cache) rememberTitle(cache, id, fromDisk)
  return fromDisk
}

/**
 * query → 正在读日志的会话 id 集合。
 *
 * 不 await 之后有个新风险：用户连点两下、或两个标签页同时展开同一个工作区，
 * 同一批冷会话会被读两遍。这里挡住重复的在途请求，读完即释放（失败也释放）。
 */
const titleInflight = new WeakMap()
const titleFailures = new WeakMap()

function legacyTitle(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.startsWith('import-')) return null
  try {
    const result = readTailEvents(sessionId, { windowBytes: 1024 * 1024, maxEvents: 1000 })
    for (const event of result?.events ?? []) {
      if (event?.type !== 'session/title') continue
      const title = event.data?.title ?? event.data?.text
      if (typeof title === 'string') return title.trim()
    }
    return ''
  } catch {
    return ''
  }
}

function markTitleFailure(query, ids) {
  let cache = titleFailures.get(query)
  if (!cache) {
    cache = new Map()
    titleFailures.set(query, cache)
  }
  const until = Date.now() + TITLE_RETRY_MS
  for (const id of ids) cache.set(id, until)
}

function failedTitle(query, id) {
  const until = titleFailures.get(query)?.get(id)
  if (!until) return false
  if (until <= Date.now()) {
    titleFailures.get(query).delete(id)
    return false
  }
  return true
}

/**
 * 后台把缺的标题读出来，写进缓存。**调用方不 await 它**。
 *
 * 为什么不 await：标题是列表里的装饰，没有它界面退回用日期（见 titleText 的注释），
 * 而读它要加载会话日志——实测一个工作区里几条冷会话就是十几秒。那十几秒是用户在
 * 盯着"正在读取…"干等，不该发生。
 */
async function fillTitles(query, cache, ids, persisted, workspaceId, onTitle) {
  if (!query?.readTitleSnapshots || !ids.length) return
  let flying = titleInflight.get(query)
  if (!flying) {
    flying = new Set()
    titleInflight.set(query, flying)
  }
  const todo = ids.filter((id) => !flying.has(id))
  if (!todo.length) return
  for (const id of todo) flying.add(id)
  try {
    // 读之前先过全局闸门（见 TITLE_CONCURRENCY）：这一步是这次改动里唯一真正吃 CPU 的地方。
    let timer
    const controller = new AbortController()
    let items
    try {
      timer = setTimeout(() => controller.abort(), TITLE_READ_TIMEOUT_MS)
      items = await withTitleSlot(() => Promise.race([
        query.readTitleSnapshots(todo, controller.signal),
        new Promise((_, reject) => controller.signal.addEventListener(
          'abort', () => reject(new Error('标题读取超时')), { once: true },
        )),
      ]))
    } catch {
      markTitleFailure(query, todo)
      return
    } finally {
      if (timer) clearTimeout(timer)
    }
    for (const item of items ?? []) {
      if (item?.status !== 'fulfilled') {
        markTitleFailure(query, [item?.sessionId].filter(Boolean))
        continue
      }
      const title = titleText(item.value?.title)
      rememberTitle(cache, item.sessionId, title, persisted)
      if (typeof onTitle === 'function') onTitle({ workspaceId, sessionId: item.sessionId, title })
    }
  } catch (err) {
    markTitleFailure(query, todo)
  } finally {
    for (const id of todo) flying.delete(id)
  }
}

async function safeRecords(query, { force = false, meta } = {}) {
  if (!query) return []
  let entry = caches.get(query)
  if (!entry) {
    entry = { at: 0, records: null, inflight: null }
    caches.set(query, entry)
  }
  if (!force && !entry.records && meta?.all) {
    const cached = meta.all()
    if (cached.length) {
      entry.records = cached
      // 这份数据只负责冷启动首屏，后台立刻用 DSH 清单校正。
      entry.at = 0
    }
  }
  if (!force && entry.records && Date.now() - entry.at < CACHE_TTL_MS) return entry.records
  // 有旧记录时直接返回，同时只启动一趟后台校正；没有旧记录才等待首次读取。
  if (entry.records && !force) {
    if (!entry.inflight) entry.inflight = refreshRecords(query, entry, meta)
    return entry.records
  }
  if (entry.inflight) return entry.inflight
  entry.inflight = refreshRecords(query, entry, meta)
  return entry.inflight
}

async function refreshRecords(query, entry, meta) {
  entry.inflight = (async () => {
    try {
      const records = (await query.listSessions()) ?? []
      entry.at = Date.now()
      entry.records = records
      meta?.replace(records)
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
export async function listWorkspaces({ registry, query, runningIds, force, includeEmpty, meta }) {
  const byId = toRecordMap(await safeRecords(query, { force, meta }))
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
export async function createSessionIn({ controller, registry, workspaceId, agentPreset }) {
  if (!controller || typeof controller.create !== 'function') {
    return { ok: false, reason: 'no-controller' }
  }
  const ws = safeList(registry).find((w) => w.id === workspaceId)
  if (!ws) return { ok: false, reason: 'no-workspace' }

  let created
  try {
    // agentPreset（2026-10-04，手机上也能选模式）：**选了才带**——没选就让 DSH 用它
    // 自己的默认，不猜、不塞一个假值。
    created = await controller.create(agentPreset
      ? { workspaceId, agentPreset }
      : { workspaceId })
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
 *
 * `persisted` 是标题的落盘缓存（lib/title-cache.js）——读过一次的标题跨重启也算数。
 * 它是可选的：没给就是纯内存的老行为，测试和 headless 组合都走这条路。
 */
export async function listSessionsOf({
  registry, query, agents, knownTitles, persisted, workspaceId,
  limit = SESSIONS_PER_WORKSPACE, force, onTitle, meta,
}) {
  const ws = safeList(registry).find((w) => w.id === workspaceId)
  if (!ws) return null

  const byId = toRecordMap(await safeRecords(query, { force, meta }))
  const rows = (ws.sessionIds ?? [])
    .map((id) => byId.get(id))
    .filter(visible)
    .sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0))
    .slice(0, limit)

  // 内存里已知的标题先用着，缺的再去读日志。
  const cache = titleCacheFor(query, persisted)
  const titles = new Map()
  const missing = []
  for (const r of rows) {
    const id = r.header.id
    const known = knownTitles?.get(id)
    if (known) {
      titles.set(id, known)
      rememberTitle(cache, id, known, persisted)
      continue
    }
    const legacy = legacyTitle(id)
    if (legacy !== null) {
      titles.set(id, legacy)
      rememberTitle(cache, id, legacy, persisted)
      continue
    }
    if (failedTitle(query, id)) {
      titles.set(id, '')
      continue
    }
    const hit = cachedTitle(cache, id, persisted)
    if (hit === null) missing.push(id)
    else if (hit) titles.set(id, hit)
  }
  // 标题只等一个很短的窗口：等得到就用上（和原来一样），等不到就放手、交给后台，
  // 那几条先显示日期。缓存里已有的照旧直接用，所以反复展开同一个工作区始终是快的。
  if (missing.length && query?.readTitleSnapshots) {
    await Promise.race([
      fillTitles(query, cache, missing, persisted, workspaceId, onTitle),
      new Promise((resolve) => setTimeout(resolve, TITLE_WAIT_MS)),
    ])
    for (const id of missing) {
      const hit = cachedTitle(cache, id, persisted)
      if (hit) titles.set(id, hit)
    }
  }

  /**
   * 「还有几条标题没读出来」——服务端把这件事**如实**告诉手机，手机据此决定要不要再问一次。
   *
   * 为什么要这个数：页面原来是"固定补三次"（1.5 秒 / 3 秒 / 3 秒），而一个工作区里
   * 四五个冷会话实测要 19 秒才读完——三次补拉盖不住，标题还是长不出来，
   * 用户只能退出去再进来。**猜次数不如问事实**：这个数归零，就是真的一条都不剩了。
   *
   * 两件事必须分开：
   *   - "读过了、确实没有标题"（缓存里记的是空串）再等多久也不会有，不计入 pending；
   *   - "还没读到"（cachedTitle 给 null）才算。
   * 另外，拿不到 readTitleSnapshots 这个能力时一律 0：谁也不去读，却让页面一直问，那是骗人。
   */
  let pending = 0
  if (typeof query?.readTitleSnapshots === 'function') {
    for (const r of rows) {
      const id = r.header.id
      if (!titles.has(id) && !failedTitle(query, id) && cachedTitle(cache, id, persisted) === null) pending += 1
    }
  }

  return {
    workspaceId,
    total: (ws.sessionIds ?? []).length,
    truncated: (ws.sessionIds ?? []).length > rows.length,
    pending,
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
