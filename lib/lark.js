/**
 * 飞书通路：飞书里发的文字 → DSH 会话 → 最终回答回到飞书。
 *
 * 两个方向各只有一条最短路径，别在这里长别的东西：
 *   入站：官方 SDK 的 WebSocket 长连接（不需要公网地址、不需要域名）→ 白名单 → 去重
 *         → `onInstruction(text, [])`（和手机页同一个总入口）；被白名单挡下且是单聊时
 *         回一句他自己的编号（见 sendHint）
 *   出站：这一轮落定的最终回答 → 「回复某条消息」接口挂回原消息下 → 纯文本，超长分段
 *         → 末尾补一行「会话：…」，让人在飞书里也看得出这条回答出自哪个会话
 *         （只在飞书这一条路上加，见 sessionTagLine 与 reply）
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

/** 等回答的飞书消息最多挂几条；超了淘汰最早的。 */
const PENDING_KEEP = 50

/** 等回答的飞书消息多久没人认领就丢掉（见 sweepPending）。 */
const PENDING_TTL_MS = 10 * 60 * 1000

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
 * @param {object} [opts.sdk] 已经加载好的 SDK（测试注入假的那份；不传就现 import）
 * @param {{setInterval: Function, clearInterval: Function}} [opts.timers] 定时器（测试注入）
 */
export async function createFeishuChannel({
  config, log, onInstruction, sdk: injectedSdk, loadSdk: loader = loadSdk, timers = { setInterval, clearInterval },
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
   */
  function sweepPending() {
    const now = Date.now()
    while (pending.length && now - pending[0].at > PENDING_TTL_MS) pending.shift()
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
  }
}
