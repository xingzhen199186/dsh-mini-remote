/**
 * 执行轨迹：把 DSH 会话事件里**过程**那部分（思考、工具调用、工具结果）重放成
 * 手机「完整」模式要的一组一组条目。
 *
 * 和 lib/history.js 并列，吃的是**同一批原始事件**：那边产出「聊天记录」（你说了什么、
 * 它答了什么），这边产出「过程」（它想了什么、调了哪个工具、那个工具返回了什么）。
 *
 * **实时那条路和重放那条路必须用同一个提取器**（下面 createTrajectoryTracker）：
 * 两边各写一套判断，「哪条算这一步的思考」「哪次调用配哪条结果」迟早会走散，
 * 同一个会话在手机上和重开后就会长得不一样。lib/history.js 开头立过这条纪律。
 *
 * 边界（一个字都不许越）：
 *   - 这里产出的一切**只走「完整」模式**：latest / history / 回答气泡一个字节都不碰。
 *   - 思考（reasoning 块）只在这里出现；lib/events.js 的 visibleText 仍然只取 text 块，
 *     stepSelfTalk 仍然只念旁白（2026-09-27 用户定的：思维链一个字都不上气泡）。
 *   - **旁白（say）2026-10-04 起进轨迹**（用户裁决）：带工具调用那一步的 text 块就是
 *     「对用户说的话」，别的模式由鲸鱼娘气泡念；完整模式把气泡藏了，它塞回轨迹——
 *     照 PC，它是过程里的一段正文。收尾那条回答不带工具调用，它是回答，不进轨迹。
 *   - **不编时间**：事件上没有 `time` 就是 null。
 *   - **不编耗时**：一步一行没有耗时（桌面 ui-tool 里 duration / elapsed 各出现 0 次，
 *     2026-10-01 实测），轮次级的耗时也不做。
 *   - 参数摘要只截**那一行的预览**，不丢内容：原始参数整段在同一张卡里（`args`）。
 *
 * 条目形状（一条 = 手机上一次折叠好的「一行的东西」）：
 *   {
 *     id: string,            // 稳定身份：工具步就是 callId（结果靠它配对）；思考是
 *                            //   r<事件 seq>-<块序号>，没有 seq 时退回 t<轮>s<步>r<序号>。
 *                            //   必须是**同一个事件在两条路上算出同一个 id**，否则
 *                            //   「插件亲眼看见的」和「日志重放的」会对成两行。
 *     turn, step: number|null,
 *     kind: 'think'|'say'|'tool',
 *     name: string|null,     // 工具名；思考为 null
 *     args: string|null,     // 模型原样产出的参数 JSON（截断后）
 *     summary: string|null,  // 折叠态那一行的参数摘要（一行、有长度上限；内容不丢，args 里有全文）
 *     output: string|null,   // 这一条的正文：思考的内容 / 工具的结果文本（截断后）
 *     state: 'running'|'ok'|'error'|'stopped',
 *     error: {name, code, reason}|null,   // 失败身份；reason 取不到就是 null（**不编原因**）
 *     truncated: {think?|args?|output?: {chars, total}}|null,
 *     timestamp: number|null
 *   }
 *
 * 「一步」不单独落一条条目：步号写在每条条目上，再落一条空条目的话，手机上的过程组里
 * 会多出一行没有内容的行。step/start / step/end 只用来给「当前是第几步」定边界。
 */
import { visibleText } from './events.js'

/** 单条正文（思考的内容 / 工具的参数 / 工具的输出）的硬上限。超出才截。 */
export const TRAJECTORY_MAX_CHARS = 4000

/** 每个会话保留的轨迹条目数上限，**从尾部留**（手机上看的是刚发生的过程）。 */
export const TRAJECTORY_MAX_ENTRIES = 120

/**
 * 折叠态那一行的参数摘要上限。
 *
 * 和正文那条 4000 不是一回事：这一行是给「一眼扫过去」用的，原始参数整段在同一张卡里，
 * 所以截它**不丢内容**，只是不让折叠行被一段 JSON 撑破。
 */
const SUMMARY_MAX_CHARS = 200

/**
 * 把一段正文按硬上限截断，并如实标出原始长度。
 *
 * 措辞照桌面端的 `json.truncated`：「… 已截断，共 {total} 字符」。
 * **只兜极端值**：实测单条工具输出最大 49,930 字符、单条思考最大 31,210，而 4000 已经
 * 是手机一屏的十倍——再长的只能靠页面那边滚动去读，这里只保证「不会一次性甩一兆到手机上」。
 */
export function clipForTrajectory(text, limit = TRAJECTORY_MAX_CHARS) {
  if (typeof text !== 'string' || text === '') return { text: '', truncated: null }
  if (text.length <= limit) return { text, truncated: null }
  return {
    text: `${text.slice(0, limit)}\n… 已截断，共 ${text.length} 字符`,
    truncated: { chars: limit, total: text.length },
  }
}

/** 压成一行：摘要要的是「一眼」，换行和缩进不该带进来。 */
function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

/**
 * 折叠态那一行的参数摘要。
 *
 * 只做「取字段 + 压成一行 + 限长」：命令和查询词就该原样给人读。
 * **不要**拿它当正文——原始参数整段在 `args` 里，正是桌面端「展开才格式化 bodyRaw」那个分工。
 * 这不是审批卡上那个 commandPreview（那边要的是完整的命令原文、上限 1200），两件事，
 * 别把其中一个的上限套到另一个上。
 */
export function argSummary(rawArgs) {
  if (typeof rawArgs !== 'string' || !rawArgs.trim()) return ''
  let args = null
  try {
    args = JSON.parse(rawArgs)
  } catch {
    // 参数不是合法 JSON（模型有时吐不完整）：原样压成一行，**不假装解析成功**。
    return oneLine(rawArgs).slice(0, SUMMARY_MAX_CHARS)
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return oneLine(rawArgs).slice(0, SUMMARY_MAX_CHARS)
  }
  // 常见字段优先：这几种一眼就知道要干什么，比按 JSON 里的顺序取前几个更有用。
  const preferred = ['command', 'cmd', 'script', 'query', 'pattern', 'file_path', 'filePath', 'path', 'url']
  const bits = []
  for (const key of preferred) {
    const v = args[key]
    if (typeof v !== 'string' || !v.trim()) continue
    bits.push(oneLine(v))
    if (bits.length >= 2) break
  }
  if (!bits.length) {
    for (const [k, v] of Object.entries(args)) {
      if (v === null || v === undefined || typeof v === 'object') continue
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue
      bits.push(`${k}: ${oneLine(v)}`)
      if (bits.length >= 3) break
    }
  }
  const text = bits.length ? bits.join(' · ') : oneLine(rawArgs)
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS)}…` : text
}

/** 失败身份：只认事件里真有的字段，取不到就是 null（页面据此写「这一步失败了」）。 */
function readError(err) {
  if (!err || typeof err !== 'object') return { name: null, code: null, reason: null }
  return {
    name: typeof err.name === 'string' ? err.name : null,
    code: typeof err.code === 'string' ? err.code : null,
    reason: typeof err.reason === 'string' ? err.reason : null,
  }
}

/**
 * 一轮跑完之后，这一轮算「什么状态」。
 *
 * 桌面端那一档是 `location.turn.status === 'open' || reason.kind === 'aborted' || 'error'`，
 * 手机这里对应四种：正在跑 / 已停 / 失败 / 完成。
 *
 * `blocked` / `max-tokens` 和没见过的一律算「已停」：那一轮确实没有正常跑完，而说成
 * 「失败」会把「被挡下」和「出错了」混成一句话——这是两件不同的事。
 */
export function turnStateOf(reasonKind) {
  if (reasonKind === 'completed') return 'done'
  if (reasonKind === 'error') return 'error'
  return 'stopped'
}

/** 事件上的轮 / 步号。不是数字就是「不知道」，**不回退成 0**。 */
function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** id 里的块序号：同一条消息里可能有不止一个 reasoning 块。 */
function thinkId(turn, step, index, seq) {
  // 事件自己的 `seq` 在同一个会话里唯一，而且**两条路看到的是同一个值**——
  // 这是「实时那份和重放那份能把同一条思考认成同一条」的关键。
  if (typeof seq === 'number' && Number.isFinite(seq) && seq > 0) return `r${seq}-${index}`
  return `t${turn}s${step}r${index}`
}

/** 旁白（say）的 id：和思考同一套编号法，前缀错开（y），实时与重放照样对得上。 */
function sayId(turn, step, index, seq) {
  if (typeof seq === 'number' && Number.isFinite(seq) && seq > 0) return `y${seq}-${index}`
  return `t${turn}s${step}y${index}`
}

/**
 * 轨迹提取器。实时那条路（lib/index.js 的 session/event）和重放那条路
 * （下面的 replayTrajectory）都喂它，按 sessionId 各自累计。
 *
 * `feed` 只回「这一口带来的变化」，不自己存条目：条目要落在哪个缓冲里、要不要推给手机，
 * 是调用方的事（实时那条路落在 store 的内存缓冲里，重放那条路直接攒成一组一组）。
 */
export function createTrajectoryTracker() {
  /** @type {Map<string, {turn:number|null, step:number|null, running:Set<string>}>} */
  const bySession = new Map()

  function slot(sessionId) {
    let s = bySession.get(sessionId)
    if (!s) {
      s = { turn: null, step: null, running: new Set() }
      bySession.set(sessionId, s)
    }
    return s
  }

  return {
    /**
     * 喂一条会话事件。
     * @returns {null | {turn:number|null, entries:Array<object>, updates:Array<object>,
     *                   state:string|null, reason:string|null}}
     *          null = 这件事与轨迹无关（或者不该单独成一条），什么都不用做。
     */
    feed(sessionId, event) {
      if (!event || typeof event.type !== 'string') return null
      const s = slot(sessionId)
      const data = event.data ?? {}
      const at = typeof event.time === 'number' ? event.time : null

      switch (event.type) {
        case 'turn/start': {
          const turn = numOrNull(data.turn) ?? s.turn
          s.turn = turn
          s.step = null
          s.running.clear()
          // 一轮开始也要说一声：手机上那一组靠它先立起来（状态「正在跑」= 不折起来）。
          return { turn, entries: [], updates: [], state: 'running', reason: null }
        }

        case 'step/start':
        case 'step/end': {
          s.turn = numOrNull(data.turn) ?? s.turn
          s.step = numOrNull(data.step) ?? s.step
          return null
        }

        case 'assistant/message': {
          const turn = numOrNull(data.turn) ?? s.turn
          const step = numOrNull(data.step) ?? s.step
          s.turn = turn
          s.step = step
          const content = data.message?.content
          if (!Array.isArray(content)) return null
          // 被按停的那一轮，这条消息是「已经吐出来的那半句」（interrupted: true）：
          // 内容留着（那是它真想过的东西），但状态如实说「停了」。
          const interrupted = data.interrupted === true
          // 带工具调用的那一步，它的正文是**旁白**（对用户说的话，别的模式由鲸鱼娘
          // 气泡念）。2026-10-04 用户裁决把它塞回轨迹（完整模式把气泡藏了，它没处去）：
          // 照 PC，它是过程里的一段正文。收尾那条回答不带工具调用——它是回答，
          // 回答区已经有它，**不进轨迹**（events.js 的「哪条算最终回答」是同一把尺）。
          const hasToolCall = content.some((b) => b && b.type === 'tool-call')
          const entries = []
          let thinkIndex = 0
          let sayIndex = 0
          for (const block of content) {
            if (!block) continue
            if (block.type === 'reasoning') {
              const i = thinkIndex++
              if (typeof block.text !== 'string' || !block.text.trim()) continue
              const clipped = clipForTrajectory(block.text)
              entries.push({
                id: thinkId(turn, step, i, event.seq),
                turn,
                step,
                kind: 'think',
                name: null,
                args: null,
                summary: null,
                // 思考的正文放 output：这一条「想的内容」和工具「返回的内容」在页面上
                // 是同一个位置（折叠行的正文），不另造一个字段。
                output: clipped.text,
                state: interrupted ? 'stopped' : 'ok',
                error: null,
                truncated: clipped.truncated ? { think: clipped.truncated } : null,
                timestamp: at,
              })
              continue
            }
            if (block.type === 'text' && hasToolCall) {
              const i = sayIndex++
              if (typeof block.text !== 'string' || !block.text.trim()) continue
              const clipped = clipForTrajectory(block.text)
              entries.push({
                id: sayId(turn, step, i, event.seq),
                turn,
                step,
                kind: 'say',
                name: null,
                args: null,
                summary: null,
                output: clipped.text,
                state: interrupted ? 'stopped' : 'ok',
                error: null,
                truncated: clipped.truncated ? { output: clipped.truncated } : null,
                timestamp: at,
              })
            }
          }
          if (!entries.length) return null
          return { turn, entries, updates: [], state: null, reason: null }
        }

        case 'tool/call': {
          const turn = numOrNull(data.turn) ?? s.turn
          const step = numOrNull(data.step) ?? s.step
          s.turn = turn
          s.step = step
          const raw = typeof data.arguments === 'string' ? data.arguments : ''
          const clipped = clipForTrajectory(raw)
          const callId = data.callId === undefined || data.callId === null ? '' : String(data.callId)
          // callId 是结果回来时配对的钥匙。真缺了就按事件位置造一个——**不假装有配对**，
          // 那条工具步会一直停在「正在跑」（它确实没有结果可配）。
          const id = callId || `k${typeof event.seq === 'number' ? event.seq : turn}.${step}`
          s.running.add(id)
          return {
            turn,
            entries: [{
              id,
              turn,
              step,
              kind: 'tool',
              name: typeof data.name === 'string' && data.name ? data.name : null,
              args: clipped.text,
              summary: argSummary(raw),
              output: null,
              state: 'running',
              error: null,
              truncated: clipped.truncated ? { args: clipped.truncated } : null,
              timestamp: at,
            }],
            updates: [],
            state: null,
            reason: null,
          }
        }

        case 'tool/result': {
          const turn = numOrNull(data.turn) ?? s.turn
          const step = numOrNull(data.step) ?? s.step
          s.turn = turn
          s.step = step
          const message = data.message ?? {}
          const id = String(message.toolCallId ?? data.callId ?? data.toolCallId ?? '')
          // 没有编号就配不上任何一条，**不硬塞一条新的**：那会在手机上多出一行
          // 没有名字、也没有参数的空壳。
          if (!id) return null
          // 工具的正文只有文本那一份：拿不到文本块（比如只有一张图）就是空——
          // 照桌面「不受支持的输入用压平后的工具结果文本」那条 fallback，**不编内容**。
          const clipped = clipForTrajectory(visibleText(message.content))
          const failed = message.isError === true || data.error !== undefined && data.error !== null
          // 结果到了（不管成没成）就不再是「正在跑」：不然收尾那一轮会把这条
          // 已经落定的失败/成功改写成「停了」。
          s.running.delete(id)
          const patch = {
            id,
            state: failed ? 'error' : 'ok',
            output: clipped.text,
            error: failed ? readError(data.error) : null,
          }
          if (clipped.truncated) patch.truncated = { output: clipped.truncated }
          return { turn, entries: [], updates: [patch], state: null, reason: null }
        }

        case 'turn/end': {
          const turn = numOrNull(data.turn) ?? s.turn
          // 这一轮里还在「正在跑」的工具步，结果永远不会来了（被按停 / 出错 / 会话断了）：
          // 如实标成「停了」，否则手机上那一行会一直转圈。
          const updates = []
          for (const id of s.running) updates.push({ id, state: 'stopped' })
          s.running.clear()
          s.turn = turn
          s.step = null
          return {
            turn,
            entries: [],
            updates,
            state: turnStateOf(data.reason?.kind),
            reason: data.reason?.kind ?? null,
          }
        }

        default:
          return null
      }
    },

    /** 会话销毁时清掉累计器，避免长期运行下 Map 无限增长。 */
    forget(sessionId) {
      bySession.delete(sessionId)
    },
  }
}

/**
 * 把一串原始事件重放成**一组一轮**的轨迹（形状和实时那条路攒出来的完全一样）。
 *
 * 这一步就是「点开一个老会话时，完整模式里看到的过程」的来源。窗口是从日志尾部读的，
 * 所以第一组可能是「半轮」——那由调用方如实标注（读取上限），不在这里假装完整。
 */
export function replayTrajectory(events) {
  const tracker = createTrajectoryTracker()
  const groups = []
  const byTurn = new Map()
  for (const event of events ?? []) {
    // 一个会话的日志只会喂给一个 tracker，传个固定值就行（同 lib/history.js）。
    const change = tracker.feed('replay', event)
    if (!change) continue
    let group = byTurn.get(change.turn)
    if (!group) {
      group = { turn: change.turn, state: 'running', reason: null, entries: [] }
      byTurn.set(change.turn, group)
      groups.push(group)
    }
    for (const entry of change.entries) group.entries.push(entry)
    for (const patch of change.updates) {
      const hit = entryById(group.entries, patch.id)
      // 结果落在窗口之外（读日志只读了尾部，那条 tool/call 没进来）：那一条工具步
      // 本来就不在手机上，没有「一直转圈」的一面，丢掉即可。**不补一条空壳。**
      if (hit) applyTrajectoryPatch(hit, patch)
    }
    if (change.state) {
      group.state = change.state
      group.reason = change.reason ?? null
    }
  }
  return groups
}

/** 从后往前找（结果总是紧跟着它的调用回来，尾部命中率最高）。 */
function entryById(entries, id) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.id === id) return entries[i]
  }
  return null
}

/**
 * 把一条增量补丁贴到条目上。**只改补丁里真有的字段**——「停了」那种补丁不该顺手
 * 把输出清空。截断信息是**合并**而不是替换：一条工具步可能参数超长、结果也超长，
 * 两个都要留。
 */
export function applyTrajectoryPatch(entry, patch) {
  if (!entry || !patch || !patch.id) return
  if (typeof patch.state === 'string') entry.state = patch.state
  if (Object.prototype.hasOwnProperty.call(patch, 'output')) entry.output = patch.output
  if (Object.prototype.hasOwnProperty.call(patch, 'error')) entry.error = patch.error
  if (patch.truncated) entry.truncated = { ...(entry.truncated ?? {}), ...patch.truncated }
}

/**
 * 条目数上限：**从尾部留**。
 *
 * 整轮整轮地数，只有在「这一轮整个放不下」时才把它截开——所以还活着的那一轮、
 * 以及一条条目都还没产生的新一轮（turn/start 刚到）都不会因为上限被丢掉。
 * 返回被砍掉的条数（只为如实说「这不是全部」）。
 */
export function capTrajectory(turns, max = TRAJECTORY_MAX_ENTRIES) {
  const list = Array.isArray(turns) ? turns : []
  let total = 0
  for (const g of list) total += g?.entries?.length ?? 0
  if (total <= max) return { turns: list, dropped: 0 }

  let budget = max
  let start = list.length
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const n = list[i]?.entries?.length ?? 0
    if (n > budget) break
    budget -= n
    start = i
  }

  const kept = []
  const partial = start - 1
  if (partial >= 0 && budget > 0) {
    const g = list[partial]
    kept.push({ ...g, entries: (g.entries ?? []).slice(-budget) })
  }
  for (let i = start; i < list.length; i += 1) kept.push(list[i])

  let shown = 0
  for (const g of kept) shown += g?.entries?.length ?? 0
  return { turns: kept, dropped: total - shown }
}

/**
 * 把「插件亲眼看见的那份」和「会话记录里重放出来的那份」合成一张表。
 *
 * 两个来源覆盖的是同一段过程的不同部分：重放那份来自日志（完整，但最多 60 秒前读的），
 * 内存那份是刚发生的（实时，但插件可能中途才起来）。按 `id` 认人——**同一个 id 只留一条**，
 * 内容以内存那份为准（它是后发生的，见 mergeInto 的那条例外），重放那份补上更早的轮次。
 *
 * 产出的条目是**副本**：调用方（GET 接口）会往上贴补丁，不能回头污染重放缓存。
 */
export function mergeTrajectory(liveTurns, replayTurns) {
  const live = Array.isArray(liveTurns) ? liveTurns : []
  const replay = Array.isArray(replayTurns) ? replayTurns : []
  if (!live.length) return replay.map(copyGroup)
  const out = []
  const byTurn = new Map()
  for (const g of replay.map(copyGroup)) {
    byTurn.set(g.turn, g)
    out.push(g)
  }
  for (const g of live) {
    const entries = (g.entries ?? []).map((e) => ({ ...e }))
    let hit = byTurn.get(g.turn)
    if (!hit) {
      hit = { turn: g.turn, state: g.state ?? 'running', reason: g.reason ?? null, entries: [] }
      byTurn.set(g.turn, hit)
      out.push(hit)
    }
    const known = new Set(hit.entries.map((e) => e.id))
    for (const e of entries) {
      if (!known.has(e.id)) {
        hit.entries.push(e)
        known.add(e.id)
        continue
      }
      mergeInto(hit.entries.find((x) => x.id === e.id), e)
    }
    // 同一条纪律也管整轮：状态以内心里那份为准，但「正在跑」不是一个更晚的结论，
    // 不许把重放那份已经落定的那一轮改回转圈。
    if (g.state && (g.state !== 'running' || hit.state === 'running')) {
      hit.state = g.state
      hit.reason = g.reason ?? null
    }
  }
  // 轮的先后按轮号排。内存那份可能是从中间开始的，直接首尾相接会乱；
  // 轮号不是数字的（极少见）排在最后，它们之间保持原顺序。
  const rank = (turn) => (typeof turn === 'number' ? turn : Number.MAX_SAFE_INTEGER)
  return out.sort((a, b) => rank(a.turn) - rank(b.turn))
}

function copyGroup(g) {
  return {
    turn: g?.turn ?? null,
    state: g?.state ?? 'running',
    reason: g?.reason ?? null,
    entries: (g?.entries ?? []).map((e) => ({ ...e })),
  }
}

/**
 * 把「实时那份」的一条合并进「重放那份」的同一条上（同一个 id = 同一次调用、同一段思考）。
 *
 * 以内心里那份为准：它是亲眼看见的、后发生的，而日志最长可能是一分钟前读的。
 * 只有一条例外——**「正在跑」是「还不知道」，不是一种更晚的结论**：重放那份已经落定
 * （结果回来了、或者被标成停了）而实时那份还停在「正在跑」时，不许把它改回转圈。
 * 两边的正文也各取有内容的那个：实时那份可能还没等到结果，重放那份可能读得早了一点。
 */
function mergeInto(target, fresh) {
  if (!target || !fresh) return
  const keepSettled = fresh.state === 'running' && target.state !== 'running'
  target.state = keepSettled ? target.state : (fresh.state ?? target.state)
  target.name = fresh.name ?? target.name
  target.args = fresh.args ?? target.args
  target.summary = fresh.summary ?? target.summary
  target.output = fresh.output ?? target.output
  target.error = fresh.error ?? target.error
  target.timestamp = fresh.timestamp ?? target.timestamp
  const truncated = { ...(target.truncated ?? {}), ...(fresh.truncated ?? {}) }
  target.truncated = Object.keys(truncated).length ? truncated : null
}
