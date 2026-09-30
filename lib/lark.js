/**
 * 飞书通路：飞书里发的文字 → DSH 会话 → 最终回答回到飞书。
 *
 * 两个方向各只有一条最短路径，别在这里长别的东西：
 *   入站：官方 SDK 的 WebSocket 长连接（不需要公网地址、不需要域名）→ 白名单 → 去重
 *         → `onInstruction(text, [])`（和手机页同一个总入口）
 *   出站：这一轮落定的最终回答 → 「回复某条消息」接口挂回原消息下 → 纯文本，超长分段
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

/** 等回答的飞书消息最多挂几条；超了淘汰最早的。 */
const PENDING_KEEP = 50

/** 等回答的飞书消息多久没人认领就丢掉（见 sweepPending）。 */
const PENDING_TTL_MS = 10 * 60 * 1000

/** 多久扫一遍上面那个名单。 */
const PENDING_SWEEP_MS = 60 * 1000

/** 已经处理过的飞书事件 id 最多记多少条。 */
const DEDUP_KEEP = 200

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
 * 被拒时把原因和「这条消息带的 id」一起写出来：用户唯一能从哪儿抄到自己的 open_id，
 * 就是日志里这一行（飞书后台要绕几层菜单才看得到，等于给非技术用户加门槛）。
 *
 * @returns {{ok: boolean, reason: string|null}}
 */
export function admitSource({ openId, chatId, listedOpenIds, listedChatIds }) {
  const opens = listedOpenIds ?? []
  const chats = listedChatIds ?? []
  // 这一行开头那句「来源不在白名单：open_id=…」是**对外的承诺**：设置页那份配置指引里
  // 告诉用户他会看到这句话（第 8 步）。两处措辞必须一致，所以改这里时去看一眼
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
 */
export function segmentsFor(text, limit = FEISHU_TEXT_LIMIT) {
  const chunks = splitText(text, Math.max(1, limit - MARKER_BUDGET))
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
   * @param {{userText?: string}} [meta] `userText` 是这一轮用户的原话，用来认领消息
   * @returns {Promise<{ok: boolean, segments?: number, error?: string}>} 永不抛出——发不出去
   *          不该影响 agent，原因写进日志、也返回给调用方。
   */
  async function reply(text, meta = {}) {
    try {
      if (stopped) return { ok: false, error: '飞书通路已经关掉了' }
      const body = String(text ?? '').trim()
      if (!body) return { ok: false, error: '这一轮没有文字可发' }
      const target = takeTarget(meta.userText)
      if (!target) {
        log.info('飞书：这一轮找不到对应的飞书消息（不是从飞书发起的），不发。')
        return { ok: false, error: 'no-target' }
      }
      const segments = segmentsFor(body)
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
