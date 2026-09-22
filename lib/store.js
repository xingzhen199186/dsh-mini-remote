/**
 * 插件端状态：最新一条回复、历史记录、会话绑定、手机在线状态。
 *
 * 内存为准，落盘只是为了重启后手机刷新还能看到东西。用 JSON 而不是 SQLite——
 * 这点数据量（默认 50 条）不值得引依赖。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

export function createStore({ file, maxHistory = 50, maxSessions = 12 }) {
  const state = {
    /**
     * 单帧模式的数据源：**每个会话各自一条**，sessionId -> { text, title, timestamp, reason }。
     *
     * 原来这里是全局一个 latest，于是切到别的会话时，屏幕上还是上一个会话的答案
     * （2026-09-21 用户实机报的：「切到一个正在执行中的会话，显示的却是之前会话的回答」）。
     * 和 running 是同一个病根——**显示状态不能跨会话串**。
     */
    latestBySession: {},
    /** 聊天模式的数据源，同样按会话分开。 */
    historyBySession: {}, // sessionId -> [{ role, text, timestamp, sessionId }]
    /** 手机当前遥控的那个会话。 */
    boundSessionId: null,
    /** 手机会话在线状态，用于决定要不要发外部推送。 */
    presence: 'foreground',
    lastSeen: 0,
    /**
     * 正在流出来的那一段：sessionId -> string。**故意不落盘**——它是过眼云烟，
     * 存下来只会在下次启动时冒出一段没头没尾的半句话。
     *
     * 为什么要自己留一份：DSH 那条增量事件是**进程本地**的，不重放。手机中途刷新
     * 或重连时，已经流过的部分再也拿不到，界面会突然空白一下。留一份塞进快照里，
     * 任何一条广播都能把它补上。
     */
    liveBySession: {},
  }

  /** 已知会话的元信息：sessionId -> { id, title, running, lastActivity, seq } */
  const sessions = new Map()

  /**
   * 单调递增的「谁更新」序号。
   *
   * 不能用 lastActivity（毫秒时间戳）来判最近活跃：两个会话在同一毫秒里被碰到时
   * 时间戳相等，而 Map 的迭代顺序是**插入顺序**，于是先插入的那个会赢——
   * 「最近活跃」就成了错的。这不是理论问题：`session/event` 来得很密，
   * 同毫秒完全可能。而 index.js 用它决定手机在看哪个会话，判错就会串内容。
   */
  let touchSeq = 0

  /** 最近活跃的会话——手机没绑定时默认遥控它。 */
  function mostRecentSession() {
    let best = null
    for (const s of sessions.values()) {
      if (!best || s.seq > best.seq) best = s
    }
    return best
  }

  /**
   * 手机此刻在看哪个会话：绑定了认绑定，没绑过才退回最近活跃的。
   *
   * 这里和 index.js 的 targetSessionId() 是同一套口径。那边多一层「问 agents 注册表
   * 要一个」的兜底（插件是热加载进来的、或者会话早就开着了，事件流里一次都没见过），
   * 但两者都从这张 sessions 表取事实，所以不会打架。
   */
  function targetSessionId() {
    if (state.boundSessionId) return state.boundSessionId
    return mostRecentSession()?.id ?? null
  }

  /**
   * 「队列里还排着什么」从哪儿问。
   *
   * 做成一个回调，而不是让 store 自己记一份，是因为队列的**真相在 agent 的收件箱里**
   * （`agent.inbox.nextTurn`），而 store 拿不到 ctx。每次取快照现读一遍，
   * 就不存在「手机上显示的队列和电脑上不一致」这种事——根本没有第二份状态可以漂移。
   *
   * 默认空实现：测试和 headless 组合里可能没有 agent 注册表，那时就是「队列是空的」。
   */
  let queueSource = () => []

  function setQueueSource(fn) {
    queueSource = typeof fn === 'function' ? fn : () => []
  }

  /** 某个会话的最新回复；没有就是 null。 */
  function latestOf(sessionId) {
    return sessionId ? (state.latestBySession[sessionId] ?? null) : null
  }

  /** 某个会话的聊天记录；没有就是空数组。 */
  function historyOf(sessionId) {
    return sessionId ? (state.historyBySession[sessionId] ?? []) : []
  }

  /**
   * 正在流出来的那一段。空字符串表示「这会儿没有东西在流」。
   *
   * 只在**已经决定要显示**之后才写进来。服务端会先按兵不动一小会儿再决定露不露
   * （理由见 lib/index.js 的 STREAM_GRACE_MS），所以这里为空不代表模型没在写，
   * 只代表「还不到显示的时候」。
   */
  function liveOf(sessionId) {
    return sessionId ? (state.liveBySession[sessionId] ?? '') : ''
  }

  /**
   * 只保留最近碰过的若干会话的数据，免得这个 JSON 文件无限长大。
   * 被丢掉的会话切过去会显示「还没有回复」——**这比显示别人的回答强**。
   */
  function trimSessions() {
    const ids = Object.keys(state.historyBySession)
    if (ids.length <= maxSessions) return
    ids.sort((a, b) => (sessions.get(b)?.seq ?? 0) - (sessions.get(a)?.seq ?? 0))
    for (const id of ids.slice(maxSessions)) {
      delete state.historyBySession[id]
      delete state.latestBySession[id]
      delete state.liveBySession[id]
    }
  }

  function pushHistory(sessionId, entry) {
    let list = state.historyBySession[sessionId]
    if (!list) list = state.historyBySession[sessionId] = []
    list.push(entry)
    if (list.length > maxHistory) list.splice(0, list.length - maxHistory)
    trimSessions()
  }

  function load() {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw && typeof raw === 'object') {
        if (raw.latestBySession && typeof raw.latestBySession === 'object') {
          state.latestBySession = raw.latestBySession
        }
        if (raw.historyBySession && typeof raw.historyBySession === 'object') {
          for (const [id, list] of Object.entries(raw.historyBySession)) {
            if (Array.isArray(list)) state.historyBySession[id] = list.slice(-maxHistory)
          }
        }
        // 迁移旧格式（全局一个 latest / history）。按条目里记的 sessionId 归位，
        // 归不了的丢掉——总比塞给错误的会话强。
        if (raw.latest?.sessionId && !state.latestBySession[raw.latest.sessionId]) {
          state.latestBySession[raw.latest.sessionId] = raw.latest
        }
        if (Array.isArray(raw.history)) {
          for (const m of raw.history) {
            if (m?.sessionId) pushHistory(m.sessionId, m)
          }
        }
        if (raw.boundSessionId) state.boundSessionId = raw.boundSessionId
      }
    } catch {
      // 首次运行没有文件，或文件损坏——都不该让插件起不来。
    }
  }

  let flushTimer = null
  function persist() {
    if (flushTimer) return
    // 事件流可能很密（每个 step 都有事件），合并写盘，避免拖慢 agent。
    flushTimer = setTimeout(() => {
      flushTimer = null
      try {
        mkdirSync(dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        writeFileSync(tmp, JSON.stringify({
          latestBySession: state.latestBySession,
          historyBySession: state.historyBySession,
          boundSessionId: state.boundSessionId,
        }))
        renameSync(tmp, file)
      } catch {
        // 落盘失败不影响本次运行。
      }
    }, 500)
    if (flushTimer.unref) flushTimer.unref()
  }

  load()

  return {
    state,
    sessions,

    /** 会话出现在事件流里时登记/更新。 */
    touchSession(sessionId, patch = {}) {
      let s = sessions.get(sessionId)
      if (!s) {
        s = { id: sessionId, title: '', running: false, lastActivity: 0, seq: 0 }
        sessions.set(sessionId, s)
      }
      Object.assign(s, patch, { lastActivity: Date.now(), seq: ++touchSeq })
      return s
    },

    forgetSession(sessionId) {
      sessions.delete(sessionId)
    },

    setRunning(sessionId, running) {
      const s = this.touchSession(sessionId, {})
      s.running = running
    },

    /** 最近活跃的会话——手机没绑定时默认遥控它。 */
    mostRecentSession,

    /** 手机此刻在看哪个会话。 */
    targetSessionId,

    /** 告诉 store「队列里有什么」该去哪儿问（见 setQueueSource）。 */
    setQueueSource,

    /** 某个会话的最新回复 / 聊天记录。 */
    latestOf,
    historyOf,

    bind(sessionId) {
      state.boundSessionId = sessionId
      persist()
    },

    /**
     * Agent 产出了最终回复。只写进**这个会话**自己的那一份。
     *
     * interrupted 是「这一轮被中止了，下面只是已经吐出来的那半句」。
     * 手机要把它标出来——不标的话，按了停止之后冒出来的半句话看着像模型答崩了。
     */
    pushReply({ text, sessionId, reason, interrupted }) {
      const timestamp = Date.now()
      const session = sessions.get(sessionId)
      state.latestBySession[sessionId] = {
        text, sessionId, title: session?.title ?? '', timestamp, reason,
        interrupted: interrupted === true,
      }
      pushHistory(sessionId, {
        role: 'assistant', text, timestamp, sessionId, interrupted: interrupted === true,
      })
      persist()
    },

    /** 用户（手机上或电脑上）发出了一条指令。 */
    pushUser({ text, sessionId, id }) {
      // id 要留着：排队中的指令靠它和 agent 收件箱里的那一条对上号，
      // 界面上才能标出「这条还在排队」、也才能撤掉它。
      pushHistory(sessionId, { role: 'user', text, timestamp: Date.now(), sessionId, id })
      persist()
    },

    /**
     * 清空**当前会话**在单帧模式里的内容。
     *
     * **目前没有任何地方调用它**，是历史遗留（清理逻辑当初写在手机端，见 page.html
     * 的 send()）。而且 2026-09-21 之后，清空这件事本身就是错的方向：用户要的是
     * 发完指令后上一条回答**留着**，在它下面加一条「正在执行」。别为了「修」什么
     * 把它接上去。
     */
    clearLatest() {
      const id = targetSessionId()
      if (id) delete state.latestBySession[id]
      persist()
    },

    markSeen(presence) {
      state.lastSeen = Date.now()
      if (presence) state.presence = presence
    },

    /**
     * 记下「正在流出来的那一段」。传空字符串就是收工。
     *
     * **不 persist()**：这是几秒钟的临时状态，写盘只是白费 I/O，还会在下次启动时
     * 留下一段没头没尾的半句话。快照和广播都从内存里现读。
     */
    setLive(sessionId, text) {
      if (!sessionId) return
      if (text) state.liveBySession[sessionId] = text
      else delete state.liveBySession[sessionId]
    },

    /** 手机是否真的在看着——决定要不要额外发系统推送。 */
    isForeground() {
      return state.presence === 'foreground' && Date.now() - state.lastSeen < 60_000
    },

    snapshot() {
      const target = targetSessionId()
      return {
        /**
         * latest 和 history 都是**当前这个会话**的那一份。
         *
         * 原来是全局一份，于是切到别的会话时，单帧模式里还显示着上一个会话的答案
         * （2026-09-21 用户实机报的）。和 running 一样，显示状态不能跨会话串。
         */
        latest: latestOf(target),
        history: historyOf(target),
        /**
         * 正在流出来的那一段（可能为空）。
         *
         * 跟着会话走，和 latest/history 同一条口径。手机把它显示在答案区、但**不**
         * 当成答案——真正的答案还是要等不含工具调用的那一步落定（见 events.js）。
         */
        live: liveOf(target),
        boundSessionId: state.boundSessionId,
        /**
         * 「正在执行」必须跟着会话走。
         *
         * 原来它只从 SSE 的 status 事件推过来，于是有两个都实测到的毛病：
         * 在手机上切到别的会话，那个会话明明闲着也显示「正在执行」（切会话时
         * 没人重算过它）；页面刷新时如果任务正在跑，又反过来显示「已连接」。
         * 放进快照里，**任何一条广播都能把它纠正回来**，两个毛病一起没了。
         */
        running: target ? (sessions.get(target)?.running ?? false) : false,
        /**
         * 排在队里、还没轮到的指令。
         *
         * 手机上跑着任务时接着发，那条不会丢，而是排进 agent 的收件箱
         * （`followup()` 的语义就是「排队一个后续轮次」），等当前这一轮结束再跑。
         * 既然收下了，就得让用户看见它排在哪——不然和「发出去了但没反应」没区别。
         *
         * 每次现读，不缓存：见 setQueueSource 的说明。
         */
        queued: target ? queueSource(target) : [],
        // 同毫秒时用 seq 兜底，顺序才是确定的
        sessions: [...sessions.values()].sort(
          (a, b) => (b.lastActivity - a.lastActivity) || (b.seq - a.seq),
        ),
      }
    },
  }
}
