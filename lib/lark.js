/**
 * 飞书通路：飞书里发的文字 → DSH 会话 → 最终回答回到飞书。
 *
 * 三个方向各只有一条最短路径，别在这里长别的东西：
 *   入站：官方 SDK 的 WebSocket 长连接（不需要公网地址、不需要域名）→ 白名单 → 去重
 *         → 第三条：`/` 开头的当命令（见 handleCommand）；正有一道题等着他拍板时当答复
 *         （见 handleAnswer，出口是「取消」）；都不是才走 `onInstruction(text, [])`
 *         （和手机页同一个总入口）；被白名单挡下且是单聊时回一句他自己的编号（见 sendHint）
 *   出站：这一轮落定的最终回答 → 「回复某条消息」接口挂回原消息下 → 纯文本，超长分段
 *         → 末尾补一行「会话：…」，让人在飞书里也看得出这条回答出自哪个会话
 *         （只在飞书这一条路上加，见 sessionTagLine 与 reply）
 *   中途：会话停下来等用户拍板（提问／审批）时，**用普通文字问出来**，用户回一句话就算答复。
 *         接的是手机页那套接缝——同一份清单、同一个 settle，谁先答谁生效
 *         （见 openAsk 与 lib/server.js 的 answerQuestion / decideApproval）。
 *         这一层只做文字，**不做交互卡片、不加任何飞书权限**。
 *
 * **只用官方 SDK 的三样东西**：长连接（WSClient）、事件分发（EventDispatcher）、
 * 鉴权（Client 自己刷 tenant_access_token）。**不用**它的高层 `createLarkChannel`——
 * 那个封装自带消息归一化、策略、分片、流式卡片一大堆东西，而这一版要的口径是
 * 「默认拒绝、只认纯文本、只回一条」，自己写清楚比去调它的开关更可信。
 *
 * **依赖是动态加载的**（见 loadSdk）：没装的时候只关掉飞书这一块、说清是哪一环缺的，
 * 插件其余部分照常。这是本插件一贯的规矩：少了哪样就关掉哪一块，不整个倒下。
 *
 * 这一版**不做**：审批与提问回飞书、图片附件、群聊、卡片消息、飞书侧切换会话。
 * 「不做群聊」不是一句口头承诺——下面 handleInbound 里有一条 chat_type !== 'p2p'
 * 的挡板，非单聊一律不进。
 */

/**
 * 一条飞书文本消息最多装多少字。
 *
 * 取 3500 是有出处的：官方 SDK 自己的出站分段默认值就是 `DEFAULT_CHUNK_LIMIT = 3500`
 * （见 node_modules/@larksuiteoapi/node-sdk/lib/index.js 的 OutboundSender）。
 * 官方限制是「单条消息的大小」，没有公开一个干净的字数，所以跟着 SDK 的口径走——
 * 它是这本 SDK 作者按真实限制试出来的值，比我自己拍一个数可信。
 */
export const FEISHU_TEXT_LIMIT = 3500

/** 官方 SDK 的包名。装没装都要能加载插件，所以只在真要连的时候才 import。 */
const SDK_NAME = '@larksuiteoapi/node-sdk'

/** 分段标头「（12/34）」＋换行占掉的字数。留宽一点，标头再长也装得下。 */
const MARKER_BUDGET = 16

/**
 * 回答末尾那行「会话：…」的前缀、兜底，以及它和正文之间那个空行。
 *
 * 为什么要有这一行：飞书那边看不出这条回答出自哪个会话（电脑上可能同时开着好几个），
 * 而手机页顶上就写着当前会话的名字。这行是同一件事在飞书里的说法。
 *
 * 为什么一点记号都不用（`**`、`#` 之类）：我们发的是 `msg_type: 'text'` 纯文本消息，
 * 记号不会被渲染，只会原样显示成一串符号。
 *
 * 兜底为什么不写会话 id：手机页从头到尾没显示过 id，用户拿着它没有地方可以对；
 * 而且「没标题」通常就是「这条会话还没起过名字」，照实说就够了。
 */
export const SESSION_TAG_PREFIX = '会话：'
export const SESSION_TAG_FALLBACK = '未命名会话'
const TAG_GAP = '\n\n'

/**
 * 把标题收拾成一行能放进标记的样子：连着换行／空格都压成一个空格——「一行」是这行
 * 标记的格式要求。空标题（或全是空白）就用兜底文案。
 */
export function sessionTagLine(title) {
  const one = String(title ?? '').replace(/\s+/g, ' ').trim()
  return `${SESSION_TAG_PREFIX}${one || SESSION_TAG_FALLBACK}`
}

// ---------------------------------------------------------------------------
// 会话中途等用户拍板：飞书那边说什么、怎么听懂他的回答
//
// 这一版只做「普通文字」：不用交互卡片、不加飞书权限。所以下面这几句是**印给用户看的
// 全部文字**，改动它们等于改动用户看到的东西——每一句都单独有测试钉着。
//
// 一律纯文本，记号（`**`、`#`）不进正文：我们发的是 `msg_type: 'text'`，记号不渲染，
// 只会原样显示成一串符号（同 sessionTagLine 那条注释里的理由）。
// ---------------------------------------------------------------------------

/** 不答这道题的出口。回它就放回电脑，走的是手机锁屏时那条现成的路（见 handleAnswer）。 */
export const CANCEL_WORD = '取消'

/** 这道题已经被别人答掉了（手机先拍了板）时回的那一句。 */
export const ASK_EXPIRED_TEXT = '这次提问已经过期了。'

/** 回了「取消」之后的一句。 */
export const ASK_CANCELLED_TEXT = '好，这道题放回电脑了。'

/** 答复交回电脑之后的一句——不说这一句，用户不知道他那句话到底算不算数。 */
export const ASK_DELIVERED_TEXT = '收到，交回电脑了。'

/** 答复没交回去（电脑那边的遥控服务不在）时的一句。 */
export const ASK_FAILED_TEXT = '这句话没能交回电脑，稍后再试。'

/** `/` 开头的、不认识的命令。只提那一条真有的，不列一串用不上的。 */
export const UNKNOWN_COMMAND_TEXT = '这条命令我不认识。飞书里只有一个：/会话（列出会话，可以切过去）。'

/** 这台电脑上一个会话都没有时，`/会话` 回的那一句。 */
export const NO_SESSIONS_TEXT = '这台电脑上还没有会话。'

/** 会话列表没取到（插件那边抛了）。**不装作空列表**——那看起来像「一个会话都没有」。 */
export const LIST_FAILED_TEXT = '会话列表没取到，稍后再试。'

/** 切不过去（写绑定的时候出错了）。 */
export const BIND_FAILED_TEXT = '切不过去，稍后再试。'

/**
 * `/会话` 这一条的解析。**飞书里只有这一条命令**（用户 2026-10-02 定的）。
 *
 *   `/会话`（也认 `/会话 `、`/session`？——不认，只有中文这一条）→ `{kind:'list'}`
 *   `/会话 3`，写成一坨 `/会话3` 也认 → `{kind:'switch', index:3}`
 *   别的 `/xxx`、编号不是个整数 → `{kind:'unknown'}`，回那一句最简提示
 *
 * 前面多敲几个斜杠照样认（`//会话` 是手滑，不是另一条命令）。
 */
export function parseFeishuCommand(text) {
  const raw = String(text ?? '').trim()
  // 先要求开头真有那个斜杠：`会话` 这两个字不构成命令（handleInbound 也只把 `/` 开头的送到这儿）。
  if (!raw.startsWith('/')) return { kind: 'unknown' }
  const body = raw.replace(/^\/+/, '').trim()
  if (!body.startsWith('会话')) return { kind: 'unknown' }
  const rest = body.slice('会话'.length).trim()
  if (!rest) return { kind: 'list' }
  if (/^\d+$/.test(rest)) return { kind: 'switch', index: Number(rest) }
  return { kind: 'unknown' }
}

/** 会话列表里那一行的标题：取不到就写「未命名会话」（和会话尾标记用同一个兜底词）。 */
function pickTitle(title) {
  return oneLine(title) || SESSION_TAG_FALLBACK
}

/**
 * `/会话` 列表那一段话：编号 + 标题，当前用的那个标出来。
 *
 * `bound` 是**手机页此刻绑着的那个会话 id**——两边是同一个绑定，所以这里标出的也就是
 * 手机页上正开着的那个。条数超出上限时如实说还剩多少，不让人以为只有这些。
 */
export function sessionPickText({ rows, total, bound }) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return NO_SESSIONS_TEXT
  const lines = ['现在能切的会话：']
  list.forEach((one, i) => {
    const mark = one?.id && one.id === bound ? '（当前）' : ''
    lines.push(`${i + 1}. ${pickTitle(one?.title)}${mark}`)
  })
  const all = Number(total) || list.length
  if (all > list.length) lines.push(`（只列了最近 ${list.length} 条，一共 ${all} 条）`)
  lines.push(`回「/会话 2」就切到第 2 个。`)
  return lines.join('\n')
}

/**
 * 切过去之后的确认。
 *
 * 末了那句「手机页那边跟着一起变」是刻意留的：两边**共用同一个全局绑定**，
 * 不说清楚，用户会以为飞书和手机各绑各的，切完手机没变就是坏了。
 */
export function sessionSwitchedText(title) {
  return `切到「${pickTitle(title)}」了。手机页那边跟着一起变——两边用的是同一个会话。`
}

/** 提问没有正文时印出来的那句话，而不是一个空行。 */
const NO_QUESTION_TEXT = '（这道题没有正文）'

/** 打印工具名/命令/说明时，一行最多多少字。多的部分如实说还有多少，不装作这就是全部。 */
const ASK_DETAIL_MAX = 300

/** 压成一行：命令原文可能是多行的，而这段文字一行一件事。 */
function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** 压成一行并限量，超了就说清还有多少字没印出来。 */
function clip(value, max) {
  const one = oneLine(value)
  return one.length > max ? `${one.slice(0, max)}…（后面还有 ${one.length - max} 字）` : one
}

/** 一道题给的选项（没给、给的不是数组都算「没有选项」）。 */
function optionsOf(question) {
  const options = question?.options
  return Array.isArray(options) ? options.filter((one) => one && typeof one === 'object') : []
}

/** 选项印出来的一行：没有 label 就写「选项 N」，不印一个空点。 */
function optionLabel(option, index) {
  return oneLine(option?.label) || `选项 ${index + 1}`
}

/**
 * 把电脑的提问写成飞书里那一段话。
 *
 * 格式是用户定下的：**问题一行、选项按 `1. …` 列、末尾一句「回数字就行」**（外加出口）。
 * 多道题时改成「一道题一行、选项跟在同一行上」（`1. 选哪个？ 1) 甲  2) 乙`），
 * 回复按顺序给数字（`1 2`）——多题也还是一屏，而且不会出现两套编号。
 *
 * **写不成时返回空串**，调用方据此不接管（见 lib/index.js 的提问钩子）：接过来却问不清，
 * 比不接更糟。写不成的只有一种：两道以上的题里出现了没有选项的题——那道题的答案只能是
 * 一整句话，夹在数字序列里没法跟别的题分开。这时候让手机或电脑去问（它们本来就收得了）。
 */
export function feishuQuestionText(questions) {
  const list = (Array.isArray(questions) ? questions : []).filter((q) => q && typeof q === 'object')
  if (!list.length) return ''
  const many = list.length > 1
  if (many && list.some((q) => optionsOf(q).length === 0)) return ''
  const lines = []
  if (many) lines.push(`电脑问你 ${list.length} 件事，按顺序回数字：`)
  list.forEach((q, qi) => {
    const head = oneLine(q.question) || NO_QUESTION_TEXT
    const options = optionsOf(q)
    if (!many) {
      lines.push(head)
      options.forEach((one, i) => lines.push(`${i + 1}. ${optionLabel(one, i)}`))
      return
    }
    const inline = options.map((one, i) => `${i + 1}) ${optionLabel(one, i)}`).join('  ')
    lines.push(`${qi + 1}. ${head}${inline ? ` ${inline}` : ''}`)
  })
  lines.push(askTail(list, many))
  return lines.join('\n')
}

/** 那最后一句（「怎么回」）。出口也写在这一行里——不写，远处的人不知道还能不答。 */
function askTail(list, many) {
  const anyMulti = list.some((q) => q.multiSelect === true)
  if (many) {
    return anyMulti
      ? '按顺序回数字就行，多选的题用逗号隔开（像「1 2,3」）。不想答就回「取消」。'
      : '按顺序回数字就行（像「1 2」）。不想答就回「取消」。'
  }
  if (list.every((q) => optionsOf(q).length === 0)) return '直接回一句话就行，不想答就回「取消」。'
  return anyMulti
    ? '回数字就行，多个用逗号隔开。不想答就回「取消」。'
    : '回数字就行。不想答就回「取消」。'
}

/**
 * 审批推给飞书的那段话。写清「要批准什么」：工具、命令原文、电脑给的理由。
 *
 * 命令取不到时**明说没取到**，不静默藏起来——手机那张卡上也是这么写的
 * （见 lib/page.html 的 approveShow）：用户要的就是看见命令。
 */
export function approvalText(view) {
  const lines = ['电脑要动手，等你拍板：']
  lines.push(`工具：${oneLine(view?.toolName) || '某个工具'}`)
  const command = clip(view?.command, ASK_DETAIL_MAX)
  lines.push(`命令：${command || '（这条没取到命令原文）'}`)
  const reason = clip(view?.reason, ASK_DETAIL_MAX)
  if (reason) lines.push(`说明：${reason}`)
  lines.push('回「同意」或「拒绝」，不想拍板就回「取消」。')
  return lines.join('\n')
}

/** 「同意」和「拒绝」在飞书里可能被怎么说。多认几个近义词，免得为差一个字重打一遍。 */
const ALLOW_WORDS = new Set(['同意', '批准', '允许', '可以', '好的', '好', '是', 'ok', 'okay', 'y', 'yes', 'allow'])
const DENY_WORDS = new Set(['拒绝', '不同意', '不允许', '不行', '不', '否', 'no', 'n', 'deny'])

/** 审批的答复解成结论。解不出来就如实说解不出来，调用方不消费这条消息。 */
export function parseDecision(text) {
  const word = oneLine(text).toLowerCase()
  if (ALLOW_WORDS.has(word)) return { ok: true, decision: 'allowed-once' }
  if (DENY_WORDS.has(word)) return { ok: true, decision: 'rejected' }
  return { ok: false, error: 'unparsed' }
}

/**
 * 把飞书里回的那句话解成电脑要的答案（形状照手机页：`[{ id, selected, custom? }]`）。
 *
 * 只有一道没有选项的题时，整句话就是答案（手机页那个「我自己说」）。
 * 其余一律数字：一道题回一个数字（多选用逗号隔开）；多道题按顺序用空格隔开
 * （`1 2`），每一格里的多选同样用逗号（`1 2,3`）。
 *
 * **解不出来就返回 `{ok:false}`，由调用方决定怎么办**（现在是「不消费、回一句怎么答」）。
 * 翻译不了还硬塞进会话，等于把这道题毁掉。
 */
export function parseAnswer(text, questions) {
  const list = (Array.isArray(questions) ? questions : []).filter((q) => q && typeof q === 'object')
  if (!list.length) return { ok: false, error: 'bad-questions' }
  const raw = String(text ?? '').trim()
  if (!raw) return { ok: false, error: 'unparsed' }
  // 只有一道没有选项的题：回什么都算它的答案。
  if (list.length === 1 && optionsOf(list[0]).length === 0) {
    return { ok: true, answers: [{ id: list[0].id, selected: [], custom: raw }] }
  }
  // 只有一道题时整句话是一个格（多选可以「1,3」也能「1 3」）；多道题按空白分格。
  const groups = list.length === 1 ? [raw] : raw.split(/[\s;；]+/).filter(Boolean)
  if (groups.length !== list.length) return { ok: false, error: 'unparsed' }
  const answers = []
  for (let i = 0; i < list.length; i += 1) {
    const options = optionsOf(list[i])
    const picks = groups[i].split(/[,，、\s]+/).filter(Boolean)
    if (!picks.length) return { ok: false, error: 'unparsed' }
    if (list[i].multiSelect !== true && picks.length > 1) return { ok: false, error: 'unparsed' }
    const selected = []
    for (const pick of picks) {
      const n = Number(pick)
      if (!Number.isInteger(n) || n < 1 || n > options.length) return { ok: false, error: 'unparsed' }
      const label = optionLabel(options[n - 1], n - 1)
      if (!selected.includes(label)) selected.push(label)
    }
    answers.push({ id: list[i].id, selected })
  }
  return { ok: true, answers }
}

/** 解不出来时回的那一句：说清怎么答，别忘了那个出口。 */
function askHint(ask) {
  if (ask?.kind === 'approval') return '回「同意」或「拒绝」就行（回「取消」放回电脑）。'
  const list = Array.isArray(ask?.payload) ? ask.payload : []
  if (list.length === 1 && optionsOf(list[0]).length === 0) {
    return '这道题直接回一句话就行（回「取消」放回电脑）。'
  }
  return '没看懂。回数字就行（回「取消」放回电脑）。'
}

/**
 * 过期之后，这句话像不像那道题的答复。
 *
 * 为什么要分：一道题被手机先答掉之后，那格记录不会立刻消失（要留着说「已经过期了」）。
 * 但用户完全可能紧接着发一条**真正的新指令**——把它也当成答复回一句「已经过期了」，
 * 那条指令就被吃掉了。所以只有「像答复的」才回那句，别的话照旧当新指令。
 *
 * 没有选项的那道题（答案本来就是一整句话、认不出形状）不做这个判断，见上面。
 */
function looksLikeAnswer(text, ask) {
  if (!ask) return false
  if (ask.kind === 'approval') return parseDecision(text).ok
  const list = Array.isArray(ask.payload) ? ask.payload : []
  if (list.length !== 1 || optionsOf(list[0]).length === 0) return false
  return parseAnswer(text, list).ok
}

/** 等回答的飞书消息最多挂几条；超了淘汰最早的。 */
const PENDING_KEEP = 50

/** 等回答的飞书消息多久没人认领就丢掉（见 sweepPending）。 */
const PENDING_TTL_MS = 10 * 60 * 1000

/**
 * `/会话` 列出来的那份清单认多久。
 *
 * 定 10 分钟只为一件事：**编号不能中途错位**——用户看着「3. 部署脚本」去回 `/会话 3`，
 * 中间要是重新列了一遍而恰好多了个会话，他就会切到另一个上去。10 分钟够他看完再回，
 * 过后清单太旧就现问一次。
 */
const PICK_TTL_MS = 10 * 60 * 1000

/** 多久扫一遍上面那个名单。 */
const PENDING_SWEEP_MS = 60 * 1000

/** 已经处理过的飞书事件 id 最多记多少条。 */
const DEDUP_KEEP = 200

/**
 * 同一个来源两次「被白名单挡下」的回话之间，至少隔多久。
 *
 * 60 秒是照人的节奏定的：被挡下的人多半会紧接着再试一两句，每句都收到一模一样的话
 * 就成了刷屏。**按来源记、不按消息记**——认的是这个人，不是那一条消息。
 */
const HINT_COOLDOWN_MS = 60 * 1000

/** 被挡下的来源最多记几个（过了冷却就等于没记过，攒着没有意义）。 */
const HINT_KEEP = 100

/**
 * 一条回答分成几段发时，段与段之间停多久。
 *
 * 飞书官方对「向同一会话发消息」的限制是 5 条/秒（SDK 类型注释里印着这句），
 * 一口气连发会撞上限。250 毫秒 = 4 条/秒，留一点余量。
 */
const SEGMENT_GAP_MS = 250

function describe(err) {
  if (!err) return '未知原因'
  return err.message ?? String(err)
}

/**
 * 名单：设置页里是一行一人（也认逗号、分号）。空字符串 = 没有名单。
 * @returns {string[]}
 */
export function listOf(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;，；]+/)
  return raw.map((one) => String(one).trim()).filter(Boolean)
}

/**
 * 这条消息允不允许处理。
 *
 * **默认拒绝**：两个名单都空的时候，任何来源都不处理。这条是刻意的——这一版的功能是
 * 「我自己的手机连我自己的电脑」，默认就该是关着的门，而不是等用户发现门开着。
 *
 * 配了的名单**都要过**（配 open_id 就认人，配 chat_id 就认会话，两个都配就两个都要对上）。
 * 被拒时把原因和「这条消息带的 id」一起写出来：日志里有一行，设置页那行「上一次被挡住的
 * 来源」也照登；单聊被挡下时还会另回一句带编号的话给发消息的人（见 sendHint，措辞是
 * hintText 现写的，和这里的 reason 不是同一句）——飞书后台要绕几层菜单才看得到自己的
 * open_id，等于给非技术用户加门槛。
 *
 * @returns {{ok: boolean, reason: string|null}}
 */
export function admitSource({ openId, chatId, listedOpenIds, listedChatIds }) {
  const opens = listedOpenIds ?? []
  const chats = listedChatIds ?? []
  // 「来源不在白名单：open_id=…」这句是给**日志和设置页**看的（设置页那行「上一次被挡住的
  // 来源」原样照登）。飞书里回给发消息的人的是另一句、由 hintText 现取编号写出来（「你的编号
  // 是 open_id=…」）；配置指引第 8 步描述的是 hintText 那句，不是这一句。改哪边都要去看一眼
  // client/client.js 里的 feishuGuide。
  if (!opens.length && !chats.length) {
    return {
      ok: false,
      reason: '来源不在白名单：'
        + `open_id=${openId || '(没带 open_id)'}、chat_id=${chatId || '(没带 chat_id)'}。`
        + '两个名单都是空的（默认谁都不认），把其中一个填进来再保存。',
    }
  }
  if (opens.length && !opens.includes(openId)) {
    return { ok: false, reason: `来源不在白名单：open_id=${openId || '(没带 open_id)'}` }
  }
  if (chats.length && !chats.includes(chatId)) {
    return {
      ok: false,
      reason: `来源不在白名单：chat_id=${chatId || '(没带 chat_id)'}`
        + `（发送者 open_id=${openId || '(没带 open_id)'}）`,
    }
  }
  return { ok: true, reason: null }
}

/**
 * 被白名单挡下时，在飞书里回给发消息的人的那句话。
 *
 * 写给完全不懂技术的人的：先给编号原值，再说清去哪儿把它填进去。抄的是**他自己的**
 * 编号，只有这一条消息里现取的那两个值，不带凭据、也不带别人的东西。
 *
 * open_id 是单聊消息必然带的那一个；万一载荷里没有，就退回说 chat_id（设置页两份名单
 * 任填一份都能通），而不是印一句「open_id=(没带 open_id)」给人看。
 */
function hintText({ openId, chatId }) {
  const id = openId
    ? `open_id=${openId}${chatId ? `（chat_id=${chatId}）` : ''}`
    : `chat_id=${chatId}`
  const field = openId ? '「允许的 open_id」' : '「允许的 chat_id」'
  return `你的编号是 ${id}，它还没有被允许使用这台电脑。\n`
    + `请在 DSH 设置页的「飞书」那一块把它填进${field}并保存，然后再发一次就能用了。`
}

/**
 * 飞书的文本消息内容是 JSON 字符串：`{"text":"你好"}`。
 * 解析不出来就当没有文字——宁可当没收到，也不把一段 JSON 原文丢给会话。
 */
export function parseMessageText(content) {
  if (typeof content !== 'string' || !content) return ''
  try {
    const parsed = JSON.parse(content)
    return typeof parsed?.text === 'string' ? parsed.text : ''
  } catch {
    return ''
  }
}

/**
 * 把一段长文本切成每段不超过 limit 的若干段。
 *
 * **优先在换行处断开**：一段回答从句子中间截开，读起来像断了。找不到合适的换行
 * （或者那个换行太靠前，断在那里等于白浪费一整段）就硬切。
 */
export function splitText(text, limit = FEISHU_TEXT_LIMIT) {
  const src = String(text ?? '')
  if (!src) return []
  const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : FEISHU_TEXT_LIMIT
  const chunks = []
  let rest = src
  while (rest.length > size) {
    const cut = rest.lastIndexOf('\n', size)
    // 断点不到半段就硬切：那样切出来的第一段太小，会白白多出一条消息。
    if (cut >= 0 && cut >= size / 2) {
      chunks.push(rest.slice(0, cut))
      rest = rest.slice(cut + 1) // 那个换行是断点本身，顺手吃掉
    } else {
      chunks.push(rest.slice(0, size))
      rest = rest.slice(size)
    }
  }
  if (rest) chunks.push(rest)
  return chunks
}

/**
 * 要往外发的若干条文本：只有一段时原样返回（不加标头），多段时每段顶上写「（1/3）」。
 *
 * 分段前先按 MARKER_BUDGET 缩小每段的容量，这样加上标头也不会越过上限——
 * 上限是硬的，标头是软的，先保上限。
 *
 * `tail` 是要接在**最后一段**末尾的那行标记（见 reply）。它的位置同样要预留下来：
 * 否则一条刚好接近上限的回答，接上标记就顶上 3500 那条硬线，飞书直接拒收。
 * 预留对每一段都生效（只留最后一段也行，但那样每段的容量就不一样了，不值当）。
 */
export function segmentsFor(text, limit = FEISHU_TEXT_LIMIT, tail = '') {
  const reserve = tail ? tail.length + TAG_GAP.length : 0
  const chunks = splitText(text, Math.max(1, limit - MARKER_BUDGET - reserve))
  if (chunks.length <= 1) return chunks
  return chunks.map((body, i) => `（${i + 1}/${chunks.length}）\n${body}`)
}

/** 装不上 SDK 时说人话：缺的是哪一环、去哪儿补。 */
export async function loadSdk() {
  try {
    return await import(SDK_NAME)
  } catch (err) {
    throw new Error(`没装上 ${SDK_NAME}（在插件目录里执行一次 npm install ${SDK_NAME}）。${describe(err)}`)
  }
}

/**
 * 造一条飞书通路。形状照 `createMiniServer(...)`：拿回调、返回一个能被 `ctx.effect`
 * 卸载的对象（`close()` 会把长连接和定时器一起收干净）。
 *
 * @param {object} opts
 * @param {object} opts.config 飞书那一块配置：`{ appId, appSecret, openIds, chatIds }`
 * @param {{info: Function, warn: Function}} opts.log
 * @param {(text: string, uploadIds: string[]) => Promise<object>} opts.onInstruction 入站总入口
 * @param {(reply: {kind: string, id: string, cancel?: boolean, answers?: Array, decision?: string})
 *   => Promise<{ok: boolean, error?: string}>} [opts.onAnswer] 把拍板结果交回电脑。
 *   `{ok:false, error:'expired'}` = 这道题已经被别人答了（手机先拍了板）。
 * @param {() => Promise<{rows: Array<{id: string, title: string}>, total?: number, bound?: string}>}
 *   [opts.listSessions] `/会话` 要列的可选会话（标题用手机页同一份缓存）。不传就回「没取到」。
 * @param {(sessionId: string) => Promise<string>|string} [opts.bindSession] `/会话 <编号>` 切过去，
 *   返回切好之后那个会话的标题。**切的必须是手机页同一个全局绑定**（见 lib/index.js）。
 * @param {object} [opts.sdk] 已经加载好的 SDK（测试注入假的那份；不传就现 import）
 * @param {{setInterval: Function, clearInterval: Function}} [opts.timers] 定时器（测试注入）
 */
export async function createFeishuChannel({
  config, log, onInstruction, onAnswer, listSessions, bindSession,
  sdk: injectedSdk, loadSdk: loader = loadSdk, timers = { setInterval, clearInterval },
}) {
  const appId = String(config?.appId ?? '').trim()
  const appSecret = String(config?.appSecret ?? '').trim()

  /**
   * appId 先自己查形状，**这一步必须在加载 SDK 之前**。
   *
   * 原因是实测出来的：`WSClient.start()` 不等待、不抛错，appId 不匹配
   * `/^cli_[0-9a-fA-F]{16}$/` 时它只往自己的 logger 打一行 error 就**静默返回**——
   * 用户看到的现象是「开关开了，什么都没发生，也没有任何提示」。所以这里照抄它那条
   * 正则，在它前面把话说清楚。
   */
  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
    throw new Error('appId 的样子不对：应该是 cli_ 开头加 16 位十六进制（飞书后台「凭据与基础信息」里那一串）。')
  }
  if (!appSecret) {
    throw new Error('appSecret 是空的（飞书后台「凭据与基础信息」里那一串）。')
  }

  const sdk = injectedSdk ?? await loader()
  const client = new sdk.Client({ appId, appSecret })

  const listedOpenIds = listOf(config?.openIds)
  const listedChatIds = listOf(config?.chatIds)

  /** 处理过的事件 id：同一条不许注入第二次（长连接重连后飞书会重推）。 */
  const seen = new Set()

  /**
   * 等着被回答的飞书消息，形如 `{ messageId, text, at }`。
   *
   * **不是「每来一条就回最后一条」**：一轮回答要挂回发它的那条消息下面，靠的是
   * 指令原文对上号（见 takeTarget）。飞书那边没有会话映射，全局绑定的那个会话
   * 可能同时收着手机和飞书发来的指令，对不上号宁可不发——把别人的回答挂到这条
   * 消息下，比漏发更糟。
   */
  const pending = []

  /**
   * 飞书那边此刻正在等哪一道题。null = 没有。
   * 形如 `{ id, kind, payload, expired, at }`——`payload` 是题目数组或审批那个 view，
   * 解析用户的答复要用（见 handleAnswer）。
   *
   * **这不是第二套「待答状态」**：真的那份在 lib/server.js 的 waitingQuestions /
   * waitingApprovals 里，一道题一条、一个 settle。这一格只回答「飞书这边刚问了谁、问的是哪条」，
   * 好把用户那句话对回那道题上——谁先答谁生效这件事由那份清单管，不靠这里。
   */
  let awaiting = null

  let stopped = false
  let connected = false
  let error = null
  /**
   * 上一次被白名单挡住的来源。
   *
   * 这一格是**给新用户留的路**：名单默认是空的（谁都不认），而他不可能凭空知道自己的
   * open_id 长什么样。所以第一次发消息必然被挡，那时要把「来源是什么」原样交出来——
   * 走日志（console 那一行）也走这里（设置页能把这一行印出来），抄进去就能通。
   * 只留最后一次：用户要的是「我刚发的那条是谁发的」，攒一串历史只会让人不知道该抄哪个。
   */
  let rejected = null

  /**
   * 刚给哪些来源回过「你的编号是…」，形如 `来源 id → 回话的时刻`。
   *
   * 按来源记（open_id 优先，没有就用 chat_id），过了 HINT_COOLDOWN_MS 就等于没记过——
   * 见 rememberHint 与 sendHint。
   */
  const hintSentAt = new Map()

  const ws = new sdk.WSClient({
    appId,
    appSecret,
    // 官方默认是 info：一启动就打一大段「怎么配长连接」的横幅，还会记每一次 ping。
    // 出问题时 warn 那档够了，日志留给真正的毛病。
    loggerLevel: sdk.LoggerLevel?.warn,
    onReady: () => {
      connected = true
      error = null
      log.info('飞书：长连接已经连上了。')
    },
    onError: (err) => {
      connected = false
      error = describe(err)
      log.warn(`飞书长连接出问题：${error}`)
    },
    onReconnecting: () => {
      connected = false
      log.info('飞书：连接断了，正在自动重连…')
    },
    onReconnected: () => {
      connected = true
      log.info('飞书：重连上了。')
    },
  })

  const dispatcher = new sdk.EventDispatcher({}).register({
    'im.message.receive_v1': (data) => handleInbound(data),
  })

  /**
   * 把等回答等太久的那些丢掉。
   *
   * 为什么需要：一轮被按停、或者卡在工具里出不来时，`turn/end` 不产生回答
   * （见 events.js），那条飞书消息就永远没人认领。留着它本身不致命（认领是按文字
   * 对号入座的），但长期跑下来是个只增不减的表，所以给它一个上限＋保质期。
   * `unref()` 是必须的：这个定时器不该拖着进程不让它退出。
   *
   * 过期的那一格待答也在这里收：它还留着只为等一句晚到的答复（好回「已经过期了」），
   * 过了保质期就没人会再回它了。
   */
  function sweepPending() {
    const now = Date.now()
    while (pending.length && now - pending[0].at > PENDING_TTL_MS) pending.shift()
    if (awaiting?.expired && now - awaiting.at > PENDING_TTL_MS) awaiting = null
  }
  const sweepTimer = timers.setInterval(sweepPending, PENDING_SWEEP_MS)
  if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref()

  /** 飞书推来一条消息。整条路只有这一处入口。 */
  async function handleInbound(data) {
    if (stopped) return
    const message = data?.message ?? {}
    const openId = data?.sender?.sender_id?.open_id ?? ''
    const chatId = message.chat_id ?? ''
    const chatType = message.chat_type ?? ''
    const messageId = message.message_id ?? ''
    const eventId = data?.event_id ?? ''

    // 群聊不在这一版里（见文件开头）。chat_type 没带的时候不拦——老版本载荷里可能没有
    // 这个字段，拿它当判据会把好好的单聊一起挡掉。
    if (chatType && chatType !== 'p2p') {
      log.info('飞书：不是单聊，这一版不处理群里的消息。')
      return
    }
    // 只做纯文本。图片、文件、卡片、表情……一律当没看见（这一版不做附件）。
    if (message.message_type !== 'text') {
      log.info(`飞书：不是纯文本（${message.message_type || '没带类型'}），不处理。`)
      return
    }

    const admitted = admitSource({ openId, chatId, listedOpenIds, listedChatIds })
    if (!admitted.ok) {
      // 原因里带着这条消息的来源 id（原值，不做任何加工），一行日志 + 一格给设置页。
      rejected = { reason: admitted.reason, at: Date.now() }
      log.warn(`飞书：这条消息不处理——${admitted.reason}`)
      // 人在飞书里，不该为了抄自己的编号再跑回电脑：单聊被挡下时回一句，编号当场给他。
      // 只在单聊回、同一来源 60 秒只回一次、发不出去也不影响这里——三条都在 sendHint 里。
      sendHint({ chatType, openId, chatId, messageId })
      return
    }

    // 去重：优先用 event_id（飞书给事件发的唯一号），没有就退回 message_id。
    // 两样都没有就只能放过去——宁可重复一次，也不能把正常消息吞掉。
    const key = eventId || messageId
    if (key && seen.has(key)) {
      log.info(`飞书：这条已经处理过了，跳过（${key}）。`)
      return
    }
    if (key) {
      seen.add(key)
      while (seen.size > DEDUP_KEEP) seen.delete(seen.values().next().value)
    }

    const text = parseMessageText(message.content).trim()
    if (!text) {
      log.info('飞书：这条消息里没有文字，跳过。')
      return
    }

    /**
     * 三条路，顺序是刻意的（用户 2026-10-02 定的）：
     *   ① `/` 开头的一律当命令——**优先级高于「当成待答问题的答复」**。正等着拍板时
     *      想看一眼会话列表，不该被当成答错了一句话。
     *   ② 正有一道题等着他拍板：这话先当答复解释（出口是「取消」）。
     *   ③ 其余才是指令。
     * 过期那道题只影响②之后的一小步行文（见 looksLikeAnswer），不插到这三条前面。
     */
    if (text.startsWith('/')) {
      // 不 await：命令要读盘（列会话），而飞书只给我们三秒（同 sendHint 那条注释）。
      handleCommand(text, messageId)
      return
    }
    if (awaiting && !awaiting.expired) {
      await handleAnswer(text, messageId)
      return
    }
    if (awaiting?.expired && looksLikeAnswer(text, awaiting)) {
      awaiting = null
      void sendPlain(messageId, ASK_EXPIRED_TEXT)
      return
    }
    // 过期那一格到这儿就没用了：这条是**真正的新指令**，别让它被那句「已经过期了」吃掉。
    awaiting = null

    pending.push({ messageId, text, at: Date.now() })
    while (pending.length > PENDING_KEEP) pending.shift()

    let result = null
    try {
      result = await onInstruction(text, [])
    } catch (err) {
      result = { ok: false, error: describe(err) }
    }
    if (result && result.ok === false) {
      // 没交给会话，就把这条从等回答的名单里撤掉（留着的话，下一条回答会被挂到
      // 这条从没被处理过的消息下面）。**不往飞书回一句错误**——这一版只做「回答回飞书」。
      const at = pending.findIndex((one) => one.messageId === messageId)
      if (at >= 0) pending.splice(at, 1)
      log.warn(`飞书：这条指令没能交给会话——${result.error}`)
    }
  }

  /**
   * 正等着他拍板时收到的那句话——**先当答复解释，不当新指令**。
   *
   * 三条出口，全在这里：
   *   1. 回「取消」：不答。走的是**现成的**那条路——settle(null)，和手机锁屏时
   *      「没人等了就把题还给电脑」一模一样（见 lib/server.js 的 stillWaited），
   *      所以电脑那边照常弹窗，不会两头都卡住。
   *   2. 解不出来：**不消费**这条消息，回一句怎么答，继续等。硬塞进会话会毁掉这道题。
   *   3. 交回去时已经被别人答了（手机先拍了板）：如实回「这次提问已经过期了」。
   */
  async function handleAnswer(text, messageId) {
    const ask = awaiting
    const cancel = oneLine(text) === CANCEL_WORD
    const parsed = cancel
      ? { ok: true }
      : (ask.kind === 'approval' ? parseDecision(text) : parseAnswer(text, ask.payload))
    if (!parsed.ok) {
      void sendPlain(messageId, askHint(ask))
      return
    }
    awaiting = null
    let verdict = { ok: false, error: 'no-channel' }
    try {
      if (typeof onAnswer === 'function') {
        verdict = await onAnswer(cancel
          ? { kind: ask.kind, id: ask.id, cancel: true }
          : (ask.kind === 'approval'
            ? { kind: ask.kind, id: ask.id, decision: parsed.decision }
            : { kind: ask.kind, id: ask.id, answers: parsed.answers }))
      }
    } catch (err) {
      verdict = { ok: false, error: describe(err) }
    }
    if (verdict?.ok !== true) {
      log.warn(`飞书：这句话没能交回电脑——${verdict?.error ?? '原因未知'}`)
      void sendPlain(messageId, verdict?.error === 'expired' ? ASK_EXPIRED_TEXT : ASK_FAILED_TEXT)
      return
    }
    void sendPlain(messageId, cancel ? ASK_CANCELLED_TEXT : ASK_DELIVERED_TEXT)
  }

  /**
   * `/` 开头的命令。**只负责把话带回去**：这台电脑上有哪些会话、怎么切，插件才知道
   * （见 lib/index.js 的 listSessions / bindSession）。认不出来的回那一句最简提示。
   *
   * 不 await、也不往外抛：命令要读盘（列会话），而飞书只给我们三秒（同 sendHint 那条注释）。
   */
  function handleCommand(text, messageId) {
    void (async () => {
      const command = parseFeishuCommand(text)
      let out = UNKNOWN_COMMAND_TEXT
      try {
        if (command.kind !== 'unknown') out = await runSessionCommand(command)
      } catch (err) {
        log.warn(`飞书：这条命令没跑成——${describe(err)}`)
        out = LIST_FAILED_TEXT
      }
      await sendPlain(messageId, out)
    })()
  }

  /**
   * `/会话` 最近列出来的那份清单。
   *
   * **为什么不每次都现列**：用户看着屏幕上那串编号去回「/会话 3」，中间要是我又列一遍、
   * 期间正好多了一个会话，编号就整体错位一位——他会切到一个自己没见过的会话上去。
   * 所以短时间内认同一份（PICK_TTL_MS），过了就现问一次。
   */
  let lastPick = { at: 0, rows: [], total: 0, bound: '' }

  /**
   * 要一份清单：认着上次那份，或者现问插件。
   *
   * 取不到就回 null——调用方据此说「没取到」，**不装作一个空列表**：
   * 那看起来像「这台电脑上一个会话都没有」，是另一回事。
   */
  async function takePick() {
    const now = Date.now()
    if (lastPick.at && now - lastPick.at < PICK_TTL_MS) return lastPick
    let got = null
    try {
      got = typeof listSessions === 'function' ? await listSessions() : null
    } catch (err) {
      log.warn(`飞书：会话列表没取到——${describe(err)}`)
    }
    if (!got || !Array.isArray(got.rows)) return null
    lastPick = {
      at: now,
      rows: got.rows,
      total: Number(got.total) || got.rows.length,
      bound: typeof got.bound === 'string' ? got.bound : '',
    }
    return lastPick
  }

  /** `/会话` 与 `/会话 <编号>` 要回的那句话。发送由 handleCommand 管。 */
  async function runSessionCommand(command) {
    const pick = await takePick()
    if (!pick) return LIST_FAILED_TEXT
    if (command.kind === 'list') return sessionPickText(pick)
    if (command.index < 1 || command.index > pick.rows.length) {
      return `没有第 ${command.index} 个。先发「/会话」看一眼有哪些。`
    }
    const target = pick.rows[command.index - 1]
    try {
      const title = typeof bindSession === 'function' ? await bindSession(target.id) : ''
      // 切完记住新绑定，接着从这份清单里再列一次时，标记要落在对的那一行上。
      lastPick.bound = target.id
      return sessionSwitchedText(typeof title === 'string' && title ? title : target.title)
    } catch (err) {
      log.warn(`飞书：切会话没成——${describe(err)}`)
      return BIND_FAILED_TEXT
    }
  }

  /**
   * 被白名单挡下时，在飞书里回一句「你的编号是…」，让他当场就能抄下来。
   *
   * 四条边界，每条都是刻意的：
   *   1. **只回单聊**：`chat_type` 明明白白写着 p2p 才回。群里回一句，等于把发消息的人的
   *      编号贴给一屋子人（这一版本就不处理群消息）；载荷没带 chat_type 时同样不回——
   *      单聊群聊分不清，宁可不告诉他，也不能把编号发错地方。
   *   2. 只回**他自己**的编号：这一句是从这条消息里现取的那两个值，不带凭据、不带别人的。
   *   3. 同一个来源 60 秒只回一次（见 rememberHint）：连发三句不该收到三句一样的话。
   *   4. **不等它、也不往外抛**：发不出去（没权限、限频、断网）就吞掉、写一行日志。
   *      不 await 是刻意的——飞书要求三秒内响应，而 SDK 是等我们这层处理完才回执的
   *      （见 ws-client 的 handleEventData），在这里多挂一次 HTTP 往返就可能让它重推这条
   *      事件；重推的那条会再走一遍这里，被第 3 条兜住，不会变成两句。
   */
  function sendHint({ chatType, openId, chatId, messageId }) {
    if (chatType !== 'p2p' || !messageId) return
    const from = openId || chatId
    if (!from) return
    const now = Date.now()
    const last = hintSentAt.get(from)
    if (last !== undefined && now - last < HINT_COOLDOWN_MS) return
    rememberHint(from, now)
    // 发出去就撒手：这条链上不抛错（try 包全了），所以不会有「未处理的拒绝」。
    void (async () => {
      try {
        const res = await client.im.message.reply({
          path: { message_id: messageId },
          data: { content: JSON.stringify({ text: hintText({ openId, chatId }) }), msg_type: 'text' },
        })
        // 和出站同一条判据：HTTP 200 + 业务 code，code 非 0 才是真失败。
        if (res && res.code) throw new Error(`飞书接口返回 code ${res.code}：${res.msg ?? ''}`)
      } catch (err) {
        log.warn(`飞书：被挡下的提示没发出去——${describe(err)}`)
      }
    })()
  }

  /**
   * 记下「刚给这个来源回过提示」，顺手把过期的清掉。
   *
   * 清的理由和 pending 一样：这是个只增不减的表，跑上一个月就是几百个来源。
   * 过了冷却的那些本来就等于没记过。
   */
  function rememberHint(from, now) {
    for (const [key, at] of hintSentAt) {
      if (now - at >= HINT_COOLDOWN_MS) hintSentAt.delete(key)
    }
    hintSentAt.set(from, now)
    while (hintSentAt.size > HINT_KEEP) hintSentAt.delete(hintSentAt.keys().next().value)
  }

  /** 从等回答的名单里认领一条：认指令原文，对不上号就不认（返回 null）。 */
  function takeTarget(userText) {
    const wanted = typeof userText === 'string' ? userText.trim() : ''
    if (!wanted || !pending.length) return null
    const at = pending.findIndex((one) => one.text === wanted)
    return at < 0 ? null : pending.splice(at, 1)[0]
  }

  /**
   * 发一条纯文本，挂在某条消息下面。只用来发「问句」和那几句一两行的回话。
   *
   * 和 reply 分开写、这里不掺进分段和「会话：…」那套：那套是**回答**的口径，有测试逐字钉着，
   * 而这里发的东西一句话就该说完。发不出去只写一行日志、回 false——调用方据此决定退让。
   */
  async function sendPlain(messageId, text) {
    try {
      if (stopped || !messageId) return false
      const res = await client.im.message.reply({
        path: { message_id: messageId },
        data: { content: JSON.stringify({ text: String(text ?? '') }), msg_type: 'text' },
      })
      // 和出站同一条判据：HTTP 200 + 业务 code，code 非 0 才是真失败。
      if (res && res.code) throw new Error(`飞书接口返回 code ${res.code}：${res.msg ?? ''}`)
      return true
    } catch (err) {
      log.warn(`飞书：这条文字没发出去——${describe(err)}`)
      return false
    }
  }

  /**
   * 飞书这条通路此刻能不能替用户拍板（决定电脑那边的提问要不要也推到飞书来）。
   *
   * 判据是「**有一轮从飞书发起的指令还没落定**」（pending 里还有它）：问句要挂回发起它的
   * 那条消息下面，所以只有确实有人在飞书里跟这台电脑说话时才接。手机上发起的轮次不会
   * 因此被抢掉电脑上的弹窗——那条判据在 lib/index.js 的提问钩子里，这里是它的另一半。
   */
  function serving() {
    return !stopped && pending.length > 0
  }

  /**
   * 开始等用户在飞书里拍板。返回 false = 没接（没人在等、或者这段话写不成）。
   *
   * **先挂上再发**：电脑那边的看门狗每 2 秒问一次「还有别人在等吗」（见 lib/server.js 的
   * stillWaited），发送这一趟 HTTP 往返不能算「没人等」。发不出去就当场撤回，
   * 于是看门狗照旧把题还给电脑——不会出现「飞书上什么都没有、电脑那边也不弹」。
   *
   * @param {{id: string, kind: 'question'|'approval', payload: unknown}} ask
   *        `payload` 是题目数组或审批那个 view，解析答复要用（见 handleAnswer）。
   */
  function openAsk({ id, kind, payload }) {
    const target = pending[pending.length - 1]
    const text = kind === 'approval' ? approvalText(payload) : feishuQuestionText(payload)
    if (!target || !text) return false
    awaiting = { id, kind, payload, expired: false, at: Date.now() }
    void sendPlain(target.messageId, text).then((ok) => {
      if (!ok && awaiting?.id === id) awaiting = null
    })
    return true
  }

  /** 这道题是不是还挂在飞书上等着（`expired` 的那种不算——它只是留着说一句「过期了」）。 */
  function isWaiting(id) {
    return Boolean(awaiting && awaiting.id === id && !awaiting.expired)
  }

  /**
   * 这道题已经有结果了（谁答的都算）。**不清掉那一格**，只把它标成过期——
   * 用户可能晚一步才回那句话，那时候要回他「这次提问已经过期了」，
   * 而不是把他那句话当成一条新指令发进会话（见 looksLikeAnswer 与 sweepPending）。
   */
  function expireAsk(id) {
    if (awaiting && awaiting.id === id) awaiting.expired = true
  }

  /** 那一格没用了（比如问句压根没发出去、或者飞书自己答掉了）。 */
  function clearAsk(id) {
    if (awaiting && (id === undefined || awaiting.id === id)) awaiting = null
  }

  /**
   * 把这一轮的回答发回飞书（挂在原消息下面）。
   *
   * @param {string} text 这一轮落定的最终回答
   * @param {{userText?: string, sessionTitle?: string}} [meta] `userText` 是这一轮用户的原话，
   *        用来认领消息；`sessionTitle` 是这条会话的名字，给了就在最后一段末尾写一行
   *        「会话：…」**（空串也算给了**——取不到标题时写兜底文案；整个字段不给才是不加标记）
   * @returns {Promise<{ok: boolean, segments?: number, error?: string}>} 永不抛出——发不出去
   *          不该影响 agent，原因写进日志、也返回给调用方。
   */
  async function reply(text, meta = {}) {
    try {
      if (stopped) return { ok: false, error: '飞书通路已经关掉了' }
      const body = String(text ?? '').trim()
      /**
       * 末尾那行「会话：…」。
       *
       * **只在这一个函数里生成**，所以只影响飞书这一条路：手机页那份文本、外部推送、
       * 会话历史都碰都不碰（test/plugin.test.mjs 里有一条逐字比对的用例钉着）。
       */
      const tag = typeof meta.sessionTitle === 'string' ? sessionTagLine(meta.sessionTitle) : ''
      // 「没东西可发」的判据是**正文和标记都没有**：答空但有标记时，这一行标记还要发出去。
      if (!body && !tag) return { ok: false, error: '这一轮没有文字可发' }
      const target = takeTarget(meta.userText)
      if (!target) {
        log.info('飞书：这一轮找不到对应的飞书消息（不是从飞书发起的），不发。')
        return { ok: false, error: 'no-target' }
      }
      // 标记只接在**最后一段**末尾，不每段都带——同一行字在一轮回答里重复三遍就是噪音。
      const segments = segmentsFor(body, FEISHU_TEXT_LIMIT, tag)
      if (tag) {
        if (segments.length) segments[segments.length - 1] += `${TAG_GAP}${tag}`
        else segments.push(tag) // 回答是空的：只把这一行标记发出去
      }
      for (let i = 0; i < segments.length; i += 1) {
        // 段与段之间歇一下：官方对同一会话的限制是 5 条/秒。
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, SEGMENT_GAP_MS))
        const res = await client.im.message.reply({
          path: { message_id: target.messageId },
          data: { content: JSON.stringify({ text: segments[i] }), msg_type: 'text' },
        })
        // 飞书这套接口是「HTTP 200 + 业务 code」：code 非 0 才是真失败。
        if (res && res.code) throw new Error(`飞书接口返回 code ${res.code}：${res.msg ?? ''}`)
      }
      return { ok: true, segments: segments.length }
    } catch (err) {
      const reason = describe(err)
      log.warn(`飞书：回答没发出去——${reason}`)
      return { ok: false, error: reason }
    }
  }

  /** 关掉：断开长连接、清掉定时器，之后不再处理任何消息。可重复调用。 */
  function close() {
    if (stopped) return
    stopped = true
    if (sweepTimer) timers.clearInterval(sweepTimer)
    pending.length = 0
    hintSentAt.clear()
    // 待答那一格也清掉：通路关了，飞书这边问出去的话再也收不回来了，
    // 而电脑那边等的是 settle（它由 index.js 的提问钩子收尾，不靠这一格）。
    awaiting = null
    try {
      ws.close({ force: true })
    } catch (err) {
      log.warn(`飞书：关长连接时抛了一下——${describe(err)}`)
    }
  }

  log.info('飞书：正在建立长连接…')
  // start() 不等待连接成功（看它的实现：只把 dispatcher 挂上就开始重连循环），
  // 但它仍然是个 Promise——留一个 catch，免得万一日后它真的 reject 变成未处理拒绝。
  Promise.resolve(ws.start({ eventDispatcher: dispatcher })).catch((err) => {
    error = describe(err)
    log.warn(`飞书：长连接起不来——${error}`)
  })

  return {
    reply,
    close,
    /** 给测试用：假装长连接推进来一条事件。 */
    handleInbound,
    /** 给设置页用：这条通路的现状。`rejected` 是上一次被白名单挡住的来源（含原值 id）。 */
    status: () => ({ connected, error, pending: pending.length, rejected }),
    /** 给测试用：只看配置解析出来的两份名单。 */
    listed: { openIds: listedOpenIds, chatIds: listedChatIds },

    // ---- 会话中途等用户拍板（见文件开头第三条）--------------------------------
    /** 这一轮要不要把电脑的提问也推到飞书来。 */
    serving,
    /** 开始等；false = 没接（没人等、或这段话写不成），调用方据此不接管。 */
    openAsk,
    /** 这道题还挂在飞书上等着吗——**电脑那边「还有别人在等吗」问的就是它**。 */
    isWaiting,
    /** 这道题有结果了：标成过期，好接住晚到的那句答复。 */
    expireAsk,
    /** 那一格直接作废。 */
    clearAsk,
  }
}
