/**
 * 插件端状态：最新一条回复、历史记录、会话绑定、手机在线状态。
 *
 * 内存为准，落盘只是为了重启后手机刷新还能看到东西。用 JSON 而不是 SQLite——
 * 这点数据量（默认 50 条）不值得引依赖。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import {
  applyTrajectoryPatch,
  capTrajectory,
  mergeTrajectory,
  TRAJECTORY_MAX_ENTRIES,
} from './trajectory.js'

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
    /**
     * 模型此刻的「自言自语」：sessionId -> { text, at }。**同样故意不落盘**。
     *
     * 只给手机上的鲸鱼娘当台词用，和 latest/history 完全分开——它既不是回答，
     * 也不是历史的一部分（历史有 50 条上限，思考会把它挤爆）。一轮结束就清掉，
     * 所以刷新页面看到的是「当前这一句」，而不是上一次的残留。
     */
    thoughtBySession: {},
    /**
     * 执行轨迹（「完整」模式里那一块过程）：sessionId ->
     * `{ entries, turns, currentTurn, patches, dropped, seq }`。**故意不落盘**。
     *
     * 为什么连它一起不落盘（照 liveBySession 的理由，但这里更硬）：实测轨迹正文是
     * 回答正文的 90.7 倍（单轮最高约 946KB），而落盘那份是**每 500 毫秒重写整份 JSON**。
     * 灌进去等于每半秒重写一遍几兆的文件。它本来就是「刚发生的过程」，重启后从会话记录里
     * 重放即可（见 lib/index.js 读历史那一段），聊天记录才是要留的那份。
     *
     * - `entries`：扁平的条目数组，每条自带 turn/step；上限 TRAJECTORY_MAX_ENTRIES 条，从尾部留。
     * - `turns`：轮号 -> { state, reason }，只留「还有条目的轮」和「当前这一轮」。
     * - `patches`：没认领到的补丁（插件中途起来时，那次调用的 tool/call 没亲眼看见，
     *   但结果看见了）。少了它，手机上的那一行会一直停在「正在跑」。
     * - `seq`：这个会话的帧序号，客户端靠它认出「我漏了几帧」。
     */
    trajectoryBySession: {},
    /** 当前父会话名下正在运行的子智能体：parentId -> childId -> true。只在内存中。 */
    subagentRunningBySession: {},
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

  /**
   * 「这个会话**完整**的历史」从哪儿问。
   *
   * 和 queueSource 同一个道理、同一套写法：真相在 DSH 自己的会话记录里
   * （`sessionQuery.readSession`），而 store 拿不到 ctx，所以由插件注入一个回调。
   * 回调返回 `{ entries, latest, pending }`；没读过这个会话时返回 null。
   *
   * **同一份记录里还带着执行轨迹**（`trajectory` / `trajectoryDropped`）：轨迹和聊天记录
   * 是同一批原始事件的两面，读一次日志顺手把两面都重放出来，别为它再读一遍盘。
   * 轨迹那份**已经在插件那边按上限截过**（120 条）再放这儿，否则 20 个会话的缓存
   * 会各压着几兆。
   *
   * **为什么不把读出来的历史塞进 `state.historyBySession`**：那一份是要落盘的，
   * 而且是 500 毫秒写一次整个 JSON。几百条历史灌进去，等于每半秒重写一遍几百 KB
   * 的文件。所以完整历史只活在内存里，落盘的仍然是「插件亲眼看过的事件」。
   */
  let replaySource = null

  function setReplaySource(fn) {
    replaySource = typeof fn === 'function' ? fn : null
  }

  /**
   * 展示用的聊天记录 = **硬盘那份（完整）+ 还没来得及落进日志的那几条**。
   *
   * 硬盘那份是 DSH 自己写的日志，权威且完整；内存那份只在两种情况下有用：
   * ① 硬盘那份还没读出来（刚点进去的那一下）；② 刚发生、日志里还没有的那一条。
   * 所以规则是：以硬盘那份为主，把时间戳比它最后一条更新的内存条目接在后面。
   * 两边的钟是同一台机器的（事件的 `time` 与记录时的 `Date.now()`），不会接重或接丢。
   *
   * **斜杠指令要多一道手续**：同一条指令可能在硬盘那份里还写着「执行中」——读日志的
   * 那一瞬间它**确实还在跑**（`/compact` 要跑十几秒，而一分钟会重读一次日志，撞上的
   * 机会不小）。手里这份后来收到了 `command/done`，可它的时间戳和硬盘那条**一样**
   * （同一条 `command/run` 事件），按上面的时间戳规则接不上去，于是手机上会一直挂着
   * 「执行中」，直到下一次重读——最多一分钟。所以指令行按 `commandId` 认人：
   * 硬盘那条就地改成手里这份的结果，然后**不能**再把它接一遍。
   */
  function mergeHistory(live, disk) {
    if (!disk || !disk.length) return live
    if (!live.length) return disk
    const settled = new Map()
    for (const m of live) {
      if (m?.role === 'command' && m.commandId && m.kind !== 'running') settled.set(m.commandId, m)
    }
    const mergedInto = new Set()
    const merged = settled.size
      ? disk.map((m) => {
        if (m?.role !== 'command' || !m.commandId) return m
        const better = settled.get(m.commandId)
        if (!better) return m
        mergedInto.add(m.commandId)
        return { ...m, kind: better.kind, text: better.text }
      })
      : disk
    const last = merged[merged.length - 1].timestamp ?? 0
    const tail = live.filter((m) => {
      // 刚在上面并进去的那几条，不能再作为「新的一条」接一遍。
      if (m?.role === 'command' && m.commandId && mergedInto.has(m.commandId)) return false
      return (m.timestamp ?? 0) > last
    })
    return tail.length ? merged.concat(tail) : merged
  }

  /** 单帧模式显示哪一条：两份里取时间更新的那条。 */
  function newestLatest(a, b) {
    if (!a) return b
    if (!b) return a
    return (b.timestamp ?? 0) > (a.timestamp ?? 0) ? b : a
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
   * 模型此刻的自言自语（鲸鱼娘的台词）。
   *
   * 和 live 分开存，**不是为了整齐**：页面上的鲸鱼娘只要发现 live 非空就会整块让位
   * （那是「正在流出来的回答」的规矩），把思考塞进 live 会让该出现台词的时候鲸鱼娘
   * 直接消失。
   */
  function thoughtOf(sessionId) {
    const t = sessionId ? state.thoughtBySession[sessionId] : null
    return t ? { text: t.text, at: t.at } : null
  }

  /**
   * 「当前这一轮」的哨兵。用 Symbol 而不是 null：`turn` 本身可能是 null
   * （事件里没带轮号），拿 null 当哨兵就分不清「还没轮到过」和「这一轮没有轮号」。
   */
  const NO_TURN = Symbol('no-turn')

  /** 轨迹缓冲的那一格。第一次碰到才建，删会话时一起丢。 */
  function trajectorySlot(sessionId) {
    let buf = state.trajectoryBySession[sessionId]
    if (!buf) {
      buf = state.trajectoryBySession[sessionId] = {
        entries: [],
        turns: new Map(),
        currentTurn: NO_TURN,
        patches: new Map(),
        dropped: 0,
        seq: 0,
      }
    }
    return buf
  }

  /**
   * 轨迹缓冲也按会话数收着点：插件会看到**所有**主会话的事件，不设上限的话，
   * 一个跑了几十上百个会话的晚上就是几十份几 MB 的条目压在内存里。
   * 丢掉的是「没在看的那些会话」刚发生的那一段——老的都在会话记录里（重放那条路），
   * 手机切过去照样能拉出来。
   */
  function trimTrajectory(keepId) {
    const ids = Object.keys(state.trajectoryBySession)
    if (ids.length <= maxSessions) return
    ids.sort((a, b) => (sessions.get(b)?.seq ?? 0) - (sessions.get(a)?.seq ?? 0))
    for (const id of ids.slice(maxSessions)) {
      if (id === keepId) continue
      delete state.trajectoryBySession[id]
    }
  }

  /** 找那条条目（结果总是紧跟着它的调用回来，所以从后往前找）。 */
  function trajectoryEntryOf(buf, id) {
    for (let i = buf.entries.length - 1; i >= 0; i -= 1) {
      if (buf.entries[i]?.id === id) return buf.entries[i]
    }
    return null
  }

  /**
   * 轮状态表只留「还有条目的轮」+「当前这一轮」。
   * 不留的话，一个长会话跑几百轮就攒几百个 key；而当前这一轮哪怕一条条目都还没有
   * （turn/start 刚到）也得留——手机靠它把那一组先立起来。
   */
  function pruneTrajectoryTurns(buf) {
    if (!buf.turns.size) return
    const live = new Set(buf.entries.map((e) => e.turn))
    for (const turn of [...buf.turns.keys()]) {
      if (live.has(turn) || turn === buf.currentTurn) continue
      buf.turns.delete(turn)
    }
  }

  /** 内存那份轨迹按轮分组（形状和重放那份、和增量帧要的形状一样）。 */
  function liveTrajectoryTurns(buf) {
    const out = []
    const byTurn = new Map()
    for (const entry of buf.entries) {
      let group = byTurn.get(entry.turn)
      if (!group) {
        const st = buf.turns.get(entry.turn)
        group = {
          turn: entry.turn,
          state: st?.state ?? 'running',
          reason: st?.reason ?? null,
          entries: [],
        }
        byTurn.set(entry.turn, group)
        out.push(group)
      }
      group.entries.push(entry)
    }
    for (const [turn, st] of buf.turns) {
      if (byTurn.has(turn)) continue
      out.push({ turn, state: st.state, reason: st.reason ?? null, entries: [] })
    }
    return out
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
      delete state.thoughtBySession[id]
      delete state.trajectoryBySession[id]
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

    setSubagentRunning(parentSessionId, childSessionId, running) {
      if (!parentSessionId || !childSessionId) return
      const group = state.subagentRunningBySession[parentSessionId]
        ?? (state.subagentRunningBySession[parentSessionId] = {})
      if (running) group[childSessionId] = true
      else delete group[childSessionId]
      if (!Object.keys(group).length) delete state.subagentRunningBySession[parentSessionId]
    },

    /** 最近活跃的会话——手机没绑定时默认遥控它。 */
    mostRecentSession,

    /** 手机此刻在看哪个会话。 */
    targetSessionId,

    /** 告诉 store「队列里有什么」该去哪儿问（见 setQueueSource）。 */
    setQueueSource,

    /** 告诉 store「这个会话完整的历史」该去哪儿问（见 setReplaySource）。 */
    setReplaySource,

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
    pushReply({ text, sessionId, reason, interrupted, timestamp }) {
      // 同上：事件带过来的 `time` 优先。合成时两边的钟不一样，同一条回复就会
      // 既从硬盘来一遍、又从手里这份来一遍，手机上显示两遍。
      const at = timestamp ?? Date.now()
      const session = sessions.get(sessionId)
      state.latestBySession[sessionId] = {
        text, sessionId, title: session?.title ?? '', timestamp: at, reason,
        interrupted: interrupted === true,
      }
      pushHistory(sessionId, {
        role: 'assistant', text, timestamp: at, sessionId, interrupted: interrupted === true,
      })
      persist()
    },

    /** 用户（手机上或电脑上）发出了一条指令。 */
    pushUser({ text, sessionId, id, timestamp }) {
      // id 要留着：排队中的指令靠它和 agent 收件箱里的那一条对上号，
      // 界面上才能标出「这条还在排队」、也才能撤掉它。
      //
      // 时间戳要是有事件带过来的那个 `time`，就用它，别用 Date.now()——理由和
      // pushCommand 那段一模一样：这一条要和硬盘重放出来的那份按时间戳合成，
      // **两边得是同一个钟**。差一毫秒就够它被当成「新的一条」再接一遍，手机上
      // 同一条指令显示两遍（2026-09-27 用户实机报的，实测两份差 1 毫秒）。
      pushHistory(sessionId, {
        role: 'user', text, timestamp: timestamp ?? Date.now(), sessionId, id,
      })
      persist()
    },

    /**
     * 子智能体完工的通知（`subagent-settled`）。
     *
     * 第三种东西，和指令行同类：既不是用户说的话，也不是模型的回答，而是**这个会话
     * 派出去的一件事有结果了**。所以单独一个 role，界面上按一张可展开的卡片画——
     * 混进用户气泡就变成「我说过这句话」，混进回答又会被读成模型的话，两种都是假的。
     *
     * 时间戳同样用事件自己的 `time`：硬盘重放出来那份（lib/history.js 里的 notice）
     * 用的也是它，两边同一个钟才合成得成一条，而不是显示两遍。
     */
    pushNotice({ sessionId, text, summary, senderSessionId, timestamp }) {
      pushHistory(sessionId, {
        role: 'notice',
        text,
        summary: summary ?? '',
        senderSessionId: senderSessionId ?? '',
        timestamp: timestamp ?? Date.now(),
        sessionId,
      })
      persist()
    },

    /**
     * 一条斜杠指令开跑了（`command/run`）。
     *
     * 指令是**第三种东西**：不是用户说的话，也不是模型的回答。所以在聊天记录里
     * 单独一个 role，界面上按「系统动作」画。混进用户气泡会让「这句到底是谁说的」
     * 变糊——手机上看聊天记录时这个判断最要紧。
     */
    pushCommand({ sessionId, commandId, name, args, timestamp }) {
      pushHistory(sessionId, {
        role: 'command', commandId, name, args: args ?? '', kind: 'running', text: null,
        // 时间戳用事件自己的 `time`（事件里带过来的），不是 Date.now()：
        // 这一条要和硬盘重放出来的那份按时间戳合成，两边得用同一个钟。
        timestamp: timestamp ?? Date.now(), sessionId,
      })
      persist()
    },

    /**
     * 那条指令收尾了（`command/done`）：**就地改那一条，不新加一条**。
     *
     * 认 commandId 从后往前找——同一条会话里同时跑两条同名指令是可能的，
     * 按名字找会改错行。
     *
     * 找不到就什么都不做：这只可能是「插件是中途起来的、没看见 run」。
     * 下一次读日志（点开会话时、或六十秒内那一次）会把这一对完整地重放出来，
     * 那时候它自然就在了。**不能**在这儿补一条没有名字的记录——那比晚几十秒更糟。
     */
    settleCommand({ sessionId, commandId, kind, text }) {
      const list = historyOf(sessionId)
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i]
        if (m.role === 'command' && m.commandId === commandId) {
          m.kind = kind
          m.text = text ?? null
          persist()
          return
        }
      }
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

    /**
     * 记下模型此刻的自言自语，给鲸鱼娘当台词。传 null 就是「没话说了」，清掉。
     *
     * 同样不 persist()：它活不过一轮，写盘只会留下一句没头没尾的旧台词。
     */
    setThought(sessionId, thought) {
      if (!sessionId) return
      if (thought && thought.text) {
        state.thoughtBySession[sessionId] = { text: thought.text, at: thought.at ?? Date.now() }
      } else {
        delete state.thoughtBySession[sessionId]
      }
    },

    /** 手机是否真的在看着——决定要不要额外发系统推送。 */
    isForeground() {
      return state.presence === 'foreground' && Date.now() - state.lastSeen < 60_000
    },

    /**
     * 实时轨迹来了一批变化：落进内存缓冲，并给出**这一批的增量帧**。
     *
     * 为什么是增量而不是整份：实测轨迹正文是回答正文的 90.7 倍（单轮最高约 946KB），
     * 每来一次工具事件就把一整份重新发一遍（现在的 state 快照就是这么发的），
     * 手机上会被压垮、隧道里流量也不可接受。所以这里只回「新加的那几条 + 改了的那几笔」。
     *
     * **不 persist()**：理由见 state.trajectoryBySession 那段。
     *
     * @returns {null|{turn:number|null, state:string|null, reason:string|null, seq:number,
     *                 add:Array<object>, update:Array<object>}} null = 什么都没变，不必推
     */
    applyTrajectory(sessionId, change) {
      if (!sessionId || !change) return null
      const entries = Array.isArray(change.entries) ? change.entries : []
      const updates = Array.isArray(change.updates) ? change.updates : []
      const turnState = typeof change.state === 'string' && change.state ? change.state : null
      if (!entries.length && !updates.length && !turnState) return null

      const buf = trajectorySlot(sessionId)
      for (const entry of entries) buf.entries.push(entry)
      for (const patch of updates) {
        if (!patch?.id) continue
        const hit = trajectoryEntryOf(buf, patch.id)
        if (hit) applyTrajectoryPatch(hit, patch)
        // 没认领到就先存着（见 state.trajectoryBySession 里 patches 那条）：
        // 插件可能是中途起来的——那次调用的 tool/call 没亲眼看见，结果却看见了。
        // 直接丢掉的话，手机上那一行会一直停在「正在跑」。
        else buf.patches.set(patch.id, { ...(buf.patches.get(patch.id) ?? {}), ...patch })
      }
      while (buf.patches.size > TRAJECTORY_MAX_ENTRIES) {
        buf.patches.delete(buf.patches.keys().next().value)
      }
      if (turnState) {
        buf.turns.set(change.turn, { state: turnState, reason: change.reason ?? null })
        buf.currentTurn = change.turn
      }
      // 从尾部留：手机上看的是刚发生的过程，最早的先走。
      if (buf.entries.length > TRAJECTORY_MAX_ENTRIES) {
        const cut = buf.entries.length - TRAJECTORY_MAX_ENTRIES
        buf.entries.splice(0, cut)
        buf.dropped += cut
      }
      pruneTrajectoryTurns(buf)
      trimTrajectory(sessionId)
      buf.seq += 1

      return {
        turn: change.turn ?? null,
        state: turnState,
        reason: turnState ? (change.reason ?? null) : null,
        seq: buf.seq,
        add: entries,
        update: updates,
      }
    },

    /**
     * 这个会话的轨迹视图：内存那份（刚发生的）+ 会话记录里重放出来的那份（更完整的），
     * 按 id 合成一组一轮。上限 120 条、从尾部留；「这不是全部」由 truncated/note 说出去。
     *
     * 条目是**副本**：GET 接口会往上贴那些没认领到的补丁，不能回头污染重放缓存。
     * 序列号 `seq` 和帧里那个是同一个（客户端据此认出「我漏了几帧」）。
     */
    trajectoryOf(sessionId) {
      const buf = sessionId ? state.trajectoryBySession[sessionId] : null
      const replay = sessionId && replaySource ? replaySource(sessionId) : null
      const merged = mergeTrajectory(
        buf ? liveTrajectoryTurns(buf) : [],
        replay?.trajectory ?? null,
      )
      if (buf?.patches.size) {
        for (const group of merged) {
          for (const entry of group.entries ?? []) {
            const patch = buf.patches.get(entry.id)
            if (patch) applyTrajectoryPatch(entry, patch)
          }
        }
      }
      const capped = capTrajectory(merged, TRAJECTORY_MAX_ENTRIES)
      const cut = capped.dropped > 0
        || (buf?.dropped ?? 0) > 0
        || (replay?.trajectoryDropped ?? 0) > 0
      return {
        sessionId: sessionId ?? null,
        seq: buf?.seq ?? 0,
        turns: capped.turns,
        truncated: cut,
        note: cut ? `轨迹只显示最近一段（读取上限：${TRAJECTORY_MAX_ENTRIES} 条）` : null,
        // 读会话记录是后台动作：手机切到「完整」模式那一刻可能还没读完。
        // 空了要说「正在读」，不能让人以为这个会话没有过程。
        loading: replay?.pending === true && !buf,
      }
    },

    snapshot() {
      const target = targetSessionId()
      // 内存里记着的那一份（插件在场时看见的）
      const live = historyOf(target)
      // DSH 记录里那一份（完整），没读过就是 null；读取中 pending 为 true
      const replay = target && replaySource ? replaySource(target) : null
      return {
        /**
         * latest 和 history 都是**当前这个会话**的那一份。
         *
         * 原来是全局一份，于是切到别的会话时，单帧模式里还显示着上一个会话的答案
         * （2026-09-21 用户实机报的）。和 running 一样，显示状态不能跨会话串。
         *
         * 现在两份来源合成一份：内存里那份（插件亲眼看见的）和 DSH 记录里那份（完整）。
         * 合成规则见 mergeHistory / newestLatest——**只看时间戳，不猜**。
         */
        latest: newestLatest(latestOf(target), replay?.latest ?? null),
        history: mergeHistory(live, replay?.entries ?? null),
        /**
         * 「正在去读这个会话的记录」。
         *
         * 手机点开一个从没看过的会话时，读它的日志要一会儿（实测最大的那条 20 MB、
         * 约半秒）。这期间内存里空空如也，界面该说「正在读」而不是「还没有对话记录」——
         * 后者会让用户以为这个会话是空的。
         */
        historyLoading: replay?.pending === true && live.length === 0,
        /**
         * 「这份历史不是全部，只到最近一段」。
         *
         * 读历史有上限（见 index.js 的 HISTORY_MAX_ENTRIES / 尾部窗口）：会话太大时
         * 只读日志尾部。**必须跟着内容一起说出去**——否则用户会以为这个会话就这么点。
         */
        historyTruncated: replay?.truncated === true,
        /** 给手机的一句人话（为什么不是全部）；null = 不用解释。 */
        historyNote: replay?.note ?? null,
        /**
         * 正在流出来的那一段（可能为空）。
         *
         * 跟着会话走，和 latest/history 同一条口径。手机把它显示在答案区、但**不**
         * 当成答案——真正的答案还是要等不含工具调用的那一步落定（见 events.js）。
         */
        live: liveOf(target),
        /**
         * 模型此刻的自言自语（鲸鱼娘的气泡台词），没有就是 null。
         *
         * **第三次重申它的边界**：这不是回答、不进历史、不参与「有没有新回复」的
         * 判断。哪怕它错乱到显示了上一句，代价也只是气泡里一句话旧了。
         */
        thought: thoughtOf(target),
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
        subagentsRunning: Boolean(
          target && Object.keys(state.subagentRunningBySession[target] ?? {}).length,
        ),
        // 同毫秒时用 seq 兜底，顺序才是确定的
        sessions: [...sessions.values()].sort(
          (a, b) => (b.lastActivity - a.lastActivity) || (b.seq - a.seq),
        ),
      }
    },
  }
}
