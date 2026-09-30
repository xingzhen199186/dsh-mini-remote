/**
 * 飞书通路（lib/lark.js）的守卫。
 *
 * 这一层**不连真实飞书、不用真实凭据**：SDK 是注入进来的假对象，事件是手工造的。
 * 真的长连接和真机往返需要用户自己的飞书应用凭据，这里测不了——报告里如实写了这一条。
 *
 * 钉住的五件事（对应需求里点名的几条）：
 *   1. 去重：同一条 event_id／message_id 只注入一次；
 *   2. 白名单：两个名单都空 → 谁都不认；不在名单 → 丢弃并留一行原因；在名单 → 放行；
 *   3. 被拒时的回话：只在单聊、只回他本人的编号、同一来源 60 秒一次、发不出去也不崩；
 *   4. 纯文本化与超长分段：切成多段、顺序正确、每段不超上限；
 *   5. 生命周期：卸载后连接与定时器都停（假连接对象断言）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createFeishuChannel, admitSource, listOf, parseMessageText,
  splitText, segmentsFor, FEISHU_TEXT_LIMIT,
  sessionTagLine, SESSION_TAG_FALLBACK,
  feishuQuestionText, approvalText, parseAnswer, parseDecision,
  parseFeishuCommand, sessionPickText, sessionSwitchedText,
  UNKNOWN_COMMAND_TEXT, NO_SESSIONS_TEXT, LIST_FAILED_TEXT, BIND_FAILED_TEXT,
  ASK_EXPIRED_TEXT, ASK_CANCELLED_TEXT, ASK_DELIVERED_TEXT,
} from '../lib/lark.js'

/** 必须是这个形状：lib/lark.js 自己会照 SDK 那条正则查一遍（见下面那条用例）。 */
const APP_ID = 'cli_0123456789abcdef'

/**
 * 假的官方 SDK：只实现这一版真正用到的那几个方法，并把每次调用记下来。
 *
 * `reply` 默认返回 `{ code: 0 }`——飞书这套接口是「HTTP 200 + 业务 code」，
 * code 为 0 才算发成功。要试别的结局（抛错、卡住不回）就传一个 `reply` 进来：
 * 每条调用**先记下来再交给它**，所以「调用发生了」这件事和它成没成无关。
 */
function fakeSdk({ reply } = {}) {
  const calls = { starts: 0, closes: [], replies: [], clientParams: null, wsParams: null }
  class Client {
    constructor(params) {
      calls.clientParams = params
      this.im = {
        message: {
          reply: async (payload) => {
            calls.replies.push(payload)
            return reply ? reply(payload) : { code: 0, msg: 'success' }
          },
        },
      }
    }
  }
  class WSClient {
    constructor(params) {
      calls.wsParams = params
      this.params = params
    }
    start({ eventDispatcher }) {
      calls.starts += 1
      this.dispatcher = eventDispatcher
      return Promise.resolve()
    }
    close(params) {
      calls.closes.push(params ?? null)
    }
  }
  class EventDispatcher {
    constructor() {
      this.handles = new Map()
    }
    register(handles) {
      for (const key of Object.keys(handles)) this.handles.set(key, handles[key])
      return this
    }
    unregister(...keys) {
      for (const key of keys) this.handles.delete(key)
      return this
    }
  }
  return { calls, mod: { Client, WSClient, EventDispatcher, LoggerLevel: { error: 1, warn: 2, info: 3 } } }
}

/** 假的定时器登记表：用来断言「卸载后定时器也停了」——这是真跑不出来的那一半。 */
function fakeTimers() {
  const live = new Set()
  let seq = 0
  return {
    live,
    timers: {
      setInterval: () => {
        seq += 1
        const handle = { id: seq }
        live.add(handle)
        return handle
      },
      clearInterval: (handle) => { live.delete(handle) },
    },
  }
}

/** 造一条飞书推来的消息事件。 */
function inbound({ event_id = 'ev_1', openId = 'ou_me', message = {}, ...rest } = {}) {
  return {
    event_id,
    sender: { sender_id: { open_id: openId }, sender_type: 'user' },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '你好' }),
      ...message,
    },
    ...rest,
  }
}

async function makeChannel({
  config = {}, result = { ok: true }, reply, onAnswer, listSessions, bindSession,
} = {}) {
  const { calls, mod } = fakeSdk({ reply })
  const { live, timers } = fakeTimers()
  const logs = []
  const injected = []
  /** 飞书那边交回电脑的每一笔拍板结果（形状见 lib/lark.js 的 handleAnswer）。 */
  const handed = []
  const channel = await createFeishuChannel({
    config: { enabled: true, appId: APP_ID, appSecret: 'app-secret', openIds: 'ou_me', chatIds: '', ...config },
    log: { info: (m) => logs.push(`info:${m}`), warn: (m) => logs.push(`warn:${m}`) },
    onInstruction: async (text, uploadIds) => {
      injected.push({ text, uploadIds })
      return typeof result === 'function' ? result(text) : result
    },
    onAnswer: async (reply2) => {
      handed.push(reply2)
      return typeof onAnswer === 'function' ? onAnswer(reply2) : { ok: true }
    },
    listSessions,
    bindSession,
    sdk: mod,
    timers,
  })
  return {
    channel, calls, live, logs, injected, handed,
    warns: () => logs.filter((line) => line.startsWith('warn:')),
    /** 飞书里最后发出去的那几句话（纯文本，解出 content 里的 text）。 */
    sent: () => calls.replies.map((one) => JSON.parse(one.data.content).text),
  }
}

// ---------------------------------------------------------------------------
// 名单与解析：纯函数，先单独钉死
// ---------------------------------------------------------------------------

test('名单：一行一个，也认逗号分号，空白与空行都丢掉', () => {
  assert.deepEqual(listOf('ou_a\nou_b\n\n  ou_c  '), ['ou_a', 'ou_b', 'ou_c'])
  assert.deepEqual(listOf('oc_1, oc_2；oc_3'), ['oc_1', 'oc_2', 'oc_3'])
  assert.deepEqual(listOf(''), [])
  assert.deepEqual(listOf(undefined), [])
  assert.deepEqual(listOf(['ou_a', ' ou_b ']), ['ou_a', 'ou_b'])
})

test('文本内容：飞书给的是 JSON 字符串，解不出来就当没有文字', () => {
  assert.equal(parseMessageText(JSON.stringify({ text: '在吗' })), '在吗')
  assert.equal(parseMessageText('not json'), '')
  assert.equal(parseMessageText(''), '')
  assert.equal(parseMessageText(undefined), '')
  assert.equal(parseMessageText(JSON.stringify({ image_key: 'x' })), '')
})

test('白名单：两个名单都空 = 谁都不认，而且把这条消息的 id 一起说出来', () => {
  const verdict = admitSource({ openId: 'ou_x', chatId: 'oc_x', listedOpenIds: [], listedChatIds: [] })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /都是空的/, '要说清是「名单没填」，不是「你不许用」')
  assert.match(verdict.reason, /ou_x/, '用户唯一能抄到自己 open_id 的地方就是这一行')
  assert.match(verdict.reason, /oc_x/)
})

test('白名单：不在名单 → 拒；在名单 → 放行；两份名单都要对上', () => {
  assert.equal(admitSource({ openId: 'ou_me', chatId: 'oc_1', listedOpenIds: ['ou_me'], listedChatIds: [] }).ok, true)
  const denied = admitSource({ openId: 'ou_other', chatId: 'oc_1', listedOpenIds: ['ou_me'], listedChatIds: [] })
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /ou_other/)
  // 只填了 open_id，chat_id 随便来一条也不设限（空的那份名单 = 不设限）
  assert.equal(admitSource({ openId: 'ou_me', chatId: 'oc_any', listedOpenIds: ['ou_me'], listedChatIds: [] }).ok, true)
  // 两份都填了就要都对上
  const both = admitSource({ openId: 'ou_me', chatId: 'oc_other', listedOpenIds: ['ou_me'], listedChatIds: ['oc_1'] })
  assert.equal(both.ok, false)
  assert.match(both.reason, /chat_id/)
})

// ---------------------------------------------------------------------------
// 出站：纯文本化与超长分段
// ---------------------------------------------------------------------------

test('分段：短的一段不分，原样返回', () => {
  assert.deepEqual(segmentsFor('就一句话'), ['就一句话'])
  assert.deepEqual(segmentsFor(''), [])
  assert.equal(splitText('x'.repeat(FEISHU_TEXT_LIMIT - 16)).length, 1)
})

test('分段：超长回答切成多段，顺序正确、每段不超过上限、带着（1/3）标头', () => {
  const text = 'x'.repeat(9000)
  const segments = segmentsFor(text)
  assert.equal(segments.length, 3, '9000 字按 3484 一段切，该是三段')
  for (const one of segments) {
    assert.ok(one.length <= FEISHU_TEXT_LIMIT, `一段 ${one.length} 字，越过了 ${FEISHU_TEXT_LIMIT} 的上限`)
  }
  for (let i = 0; i < segments.length; i += 1) {
    assert.match(segments[i], new RegExp(`^（${i + 1}/3）\\n`), `第 ${i + 1} 段要带自己的编号`)
  }
  // 顺序：把标头和换行剥掉拼回去，必须还是原文
  const rejoined = segments.map((one) => one.replace(/^（\d+\/\d+）\n/, '')).join('')
  assert.equal(rejoined, text, '拼回去要和原文一字不差，顺序错了这里就露馅')
})

test('分段：优先在换行处断开，不从句子中间截', () => {
  const text = `${'a'.repeat(3400)}\n${'b'.repeat(100)}`
  const segments = segmentsFor(text)
  assert.equal(segments.length, 2)
  assert.equal(segments[0], `（1/2）\n${'a'.repeat(3400)}`)
  assert.equal(segments[1], `（2/2）\n${'b'.repeat(100)}`)
  for (const one of segments) assert.ok(one.length <= FEISHU_TEXT_LIMIT)
})

// ---------------------------------------------------------------------------
// 入站
// ---------------------------------------------------------------------------

test('入站：白名单里的单聊纯文本交给 onInstruction，附件清单是空的', async () => {
  const p = await makeChannel()
  await p.channel.handleInbound(inbound())
  assert.deepEqual(p.injected, [{ text: '你好', uploadIds: [] }], '入站总入口就是这一个，uploadIds 传空数组')
  assert.equal(p.calls.starts, 1, '长连接要真的挂上')
})

test('入站：没有 event_id 时按 message_id 去重', async () => {
  const p = await makeChannel()
  const first = inbound()
  const second = inbound()
  delete first.event_id
  delete second.event_id
  await p.channel.handleInbound(first)
  await p.channel.handleInbound(second)
  assert.equal(p.injected.length, 1, '两条都没有 event_id，就该按 message_id 认出这是同一条')
})

test('入站：去重——同一条 event_id 只注入一次', async () => {
  const p = await makeChannel()
  await p.channel.handleInbound(inbound())
  await p.channel.handleInbound(inbound())
  await p.channel.handleInbound(inbound({ event_id: 'ev_2', message: { message_id: 'om_2' } }))
  assert.deepEqual(p.injected.map((one) => one.text), ['你好', '你好'])
  assert.equal(p.injected.length, 2, '重复那条不许再注入；换一条 id 的照旧进来')
})

test('入站：两个名单都空 → 不处理，日志里留一行原因', async () => {
  const p = await makeChannel({ config: { openIds: '', chatIds: '' } })
  await p.channel.handleInbound(inbound())
  assert.deepEqual(p.injected, [], '默认拒绝：两个名单都空的时候谁都不认')
  assert.equal(p.warns().length, 1)
  assert.match(p.warns()[0], /都是空的/)
  assert.match(p.warns()[0], /ou_me/, '日志里要带上 open_id，用户才抄得出来')
})

test('入站：不在名单的人被丢弃，日志里留一行原因', async () => {
  const p = await makeChannel({ config: { openIds: 'ou_me' } })
  await p.channel.handleInbound(inbound({ openId: 'ou_stranger' }))
  assert.deepEqual(p.injected, [])
  assert.equal(p.warns().length, 1)
  assert.match(p.warns()[0], /ou_stranger/)
})

test('入站：被挡下的来源要能被设置页看见（含 open_id / chat_id 原值）', async () => {
  // 这是新用户唯一走得通的那条路：名单默认是空的，他不可能凭空知道自己的 id 长什么样。
  // 所以被挡这一下不能只写日志——设置页那块要把这一行印出来，他照着抄进去才能通。
  // 第一次发消息时两份名单都是空的，所以两个 id 都得给出来，让用户想抄哪个抄哪个。
  const p = await makeChannel({ config: { openIds: '', chatIds: '' } })
  await p.channel.handleInbound(inbound({ openId: 'ou_stranger', message: { chat_id: 'oc_abc' } }))
  const status = p.channel.status()
  assert.ok(status.rejected, '被挡住时这一格要有东西')
  assert.match(status.rejected.reason, /ou_stranger/, '原值照登，不许加工')
  assert.match(status.rejected.reason, /oc_abc/)
  assert.equal(typeof status.rejected.at, 'number')
})

test('拒绝时说的那句话，要和设置页那份配置指引里的承诺对得上', () => {
  // 指引第 8 步告诉用户：他会看到「来源不在白名单：open_id=ou_xxxxx」。
  // 这句话要是改了而指引没跟着改，用户按指引做完却看到别的话，会以为自己哪一步做错了。
  const both = admitSource({ openId: 'ou_x', chatId: 'oc_x', listedOpenIds: [], listedChatIds: [] })
  assert.match(both.reason, /^来源不在白名单：open_id=ou_x/)
  const one = admitSource({ openId: 'ou_x', chatId: 'oc_x', listedOpenIds: ['ou_me'], listedChatIds: [] })
  assert.match(one.reason, /^来源不在白名单：open_id=ou_x/)
})

test('入站：chat_id 名单配了就也要对上', async () => {
  const p = await makeChannel({ config: { openIds: '', chatIds: 'oc_allowed' } })
  await p.channel.handleInbound(inbound())
  assert.deepEqual(p.injected, [], '不在 chat_id 名单里的会话不处理')
  assert.match(p.warns()[0], /oc_1/)
  await p.channel.handleInbound(inbound({ event_id: 'ev_2', message: { message_id: 'om_2', chat_id: 'oc_allowed' } }))
  assert.equal(p.injected.length, 1)
})

test('入站：群聊不处理、非纯文本不处理', async () => {
  const p = await makeChannel()
  await p.channel.handleInbound(inbound({ message: { chat_type: 'group' } }))
  await p.channel.handleInbound(inbound({
    event_id: 'ev_2',
    message: { message_id: 'om_2', message_type: 'image', content: JSON.stringify({ image_key: 'img_x' }) },
  }))
  assert.deepEqual(p.injected, [], '这一版只做「单聊里发来的纯文本」')
})

test('入站：没交给会话的那条，不许留在等回答的名单里', async () => {
  const p = await makeChannel({ result: { ok: false, error: '这个会话已经不在了' } })
  await p.channel.handleInbound(inbound())
  const warned = p.warns().join('\n')
  assert.match(warned, /没能交给会话/, '失败要留一行原因')
  // 之后来了别人的回答，绝不能挂到这条从没被处理过的消息下面
  const r = await p.channel.reply('别处的回答', { userText: '你好' })
  assert.equal(r.ok, false)
  assert.equal(p.calls.replies.length, 0)
})

// ---------------------------------------------------------------------------
// 被白名单挡下时的那句回话：只在单聊、只回他本人的编号、限流、发不出去也不崩
// ---------------------------------------------------------------------------

/**
 * 那句回话是「发出去就撒手」的（见 lib/lark.js 的 sendHint：飞书只给三秒，不能挂在
 * 那儿等一次 HTTP 往返）。等一轮宏任务让它落定——中间全是微任务，一轮就够。
 */
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('被拒且是单聊：回一句，编号是他自己的，并说清去哪儿填', async () => {
  const p = await makeChannel({ config: { openIds: 'ou_me' } })
  await p.channel.handleInbound(inbound({ openId: 'ou_stranger', message: { message_id: 'om_x', chat_id: 'oc_x' } }))
  await flush()
  assert.equal(p.calls.replies.length, 1, '被挡下的人该当场收到一句，而不是只能回电脑上翻日志')
  const payload = p.calls.replies[0]
  assert.equal(payload.path.message_id, 'om_x', '要用「回复某条消息」挂在他自己发的那条下面')
  assert.equal(payload.data.msg_type, 'text')
  const sent = JSON.parse(payload.data.content).text
  assert.match(sent, /open_id=ou_stranger/, '必须带他自己的 open_id 原值——他要抄的就是这一串')
  assert.match(sent, /设置页/, '要告诉他去哪儿填')
  assert.match(sent, /允许的 open_id/, '要指名道姓说是设置页里的哪一个框')
  assert.ok(!sent.includes('ou_me'), '别人的编号不许出现在这一句里')
  assert.deepEqual(p.injected, [], '被挡下的消息照旧不进会话')
  assert.equal(p.warns().length, 1, '回话发成功时不许再多写一行日志')
})

test('被拒但是在群里：一句话都不回', async () => {
  const p = await makeChannel({ config: { openIds: '' } })
  await p.channel.handleInbound(inbound({ message: { chat_type: 'group' } }))
  await flush()
  assert.equal(p.calls.replies.length, 0, '群里回一句 = 把他的编号贴给一屋子人')
})

test('被拒但载荷没说是不是单聊：也不回', async () => {
  // 上面那条群聊挡板只拦「明确不是单聊」的（老载荷可能没这个字段），所以没带 chat_type
  // 的消息会一路走到白名单；但回话这里把门关死：分不清单聊群聊，宁可不告诉他。
  const p = await makeChannel({ config: { openIds: '' } })
  await p.channel.handleInbound(inbound({ message: { chat_type: '' } }))
  await flush()
  assert.equal(p.calls.replies.length, 0)
})

test('放行的消息：不走这条拒绝回话', async () => {
  const p = await makeChannel()
  await p.channel.handleInbound(inbound())
  await flush()
  assert.equal(p.injected.length, 1)
  assert.equal(p.calls.replies.length, 0, '放行的消息由「回答」那条路回，这里一句都不发')
})

test('同一个来源 60 秒内被拒多次：只回第一次', async () => {
  const p = await makeChannel({ config: { openIds: '' } })
  await p.channel.handleInbound(inbound({ message: { message_id: 'om_1' } }))
  await p.channel.handleInbound(inbound({ event_id: 'ev_2', message: { message_id: 'om_2' } }))
  await p.channel.handleInbound(inbound({ event_id: 'ev_3', message: { message_id: 'om_3' } }))
  await flush()
  assert.equal(p.calls.replies.length, 1, '连发三句不该收到三句一模一样的话')
  // 换个人来问，还是各回各的：限流认的是来源，不是「全局只回一次」。
  await p.channel.handleInbound(inbound({ event_id: 'ev_4', openId: 'ou_other', message: { message_id: 'om_4' } }))
  await flush()
  assert.equal(p.calls.replies.length, 2)
})

test('回话发不出去：吞掉、写一行日志，主流程照常', async () => {
  const p = await makeChannel({
    config: { openIds: '' },
    reply: () => { throw new Error('没权限：99991672') },
  })
  await p.channel.handleInbound(inbound())
  await flush()
  assert.equal(p.calls.replies.length, 1, '试还是要试一下')
  const warned = p.warns().join('\n')
  assert.match(warned, /被挡下的提示没发出去/)
  assert.match(warned, /99991672/, '发不出去的原因要留在日志里')
  assert.match(p.logs.join('\n'), /来源不在白名单/, '白名单那一行日志照旧')
})

test('回话不等它：飞书那边一直不回，主流程也照常返回', async () => {
  // 假的 reply 永不落定，模拟「飞书那边迟迟不回」。要是 sendHint 里 await 了它，这一句
  // 就回不来了——而飞书只给三秒，超时就会把同一条事件重推一遍。
  const p = await makeChannel({ config: { openIds: '' }, reply: () => new Promise(() => {}) })
  const done = await Promise.race([
    p.channel.handleInbound(inbound()).then(() => 'ok'),
    new Promise((resolve) => setTimeout(() => resolve('等超时了'), 300)),
  ])
  assert.equal(done, 'ok')
  assert.equal(p.calls.replies.length, 1, '照发，只是不等')
  p.channel.close()
})

// ---------------------------------------------------------------------------
// 出站
// ---------------------------------------------------------------------------

test('出站：回答回到原消息下面，纯文本，文字原样', async () => {
  const p = await makeChannel()
  await p.channel.handleInbound(inbound())
  const r = await p.channel.reply('落定的回答', { userText: '你好' })
  assert.equal(r.ok, true)
  assert.equal(r.segments, 1)
  assert.equal(p.calls.replies.length, 1)
  const payload = p.calls.replies[0]
  assert.equal(payload.path.message_id, 'om_1', '要挂在原消息下面，才有上下文')
  assert.equal(payload.data.msg_type, 'text', '纯文本，不做卡片')
  assert.deepEqual(JSON.parse(payload.data.content), { text: '落定的回答' })
})

test('出站：按指令原文对号入座，两条待回答时不会串台', async () => {
  const p = await makeChannel()
  await p.channel.handleInbound(inbound({ message: { content: JSON.stringify({ text: '第一条' }) } }))
  await p.channel.handleInbound(inbound({ event_id: 'ev_2', message: { message_id: 'om_2', content: JSON.stringify({ text: '第二条' }) } }))
  await p.channel.reply('回答第二条', { userText: '第二条' })
  assert.equal(p.calls.replies[0].path.message_id, 'om_2')
  await p.channel.reply('回答第一条', { userText: '第一条' })
  assert.equal(p.calls.replies[1].path.message_id, 'om_1')
})

test('出站：手机发起的轮次（对不上号）一条都不发', async () => {
  const p = await makeChannel()
  await p.channel.handleInbound(inbound())
  const r = await p.channel.reply('手机上问出来的回答', { userText: '这是手机上打的字' })
  assert.equal(r.ok, false)
  assert.equal(p.calls.replies.length, 0, '对不上号宁可漏发，也不能把别人的回答挂到这条消息下')
  assert.match(p.logs.join('\n'), /找不到对应的飞书消息/)
})

test('出站：超长回答分多条发出，顺序对、每段不超上限', async () => {
  const p = await makeChannel()
  await p.channel.handleInbound(inbound())
  const text = `开头\n${'y'.repeat(8000)}`
  const r = await p.channel.reply(text, { userText: '你好' })
  assert.equal(r.ok, true)
  assert.equal(r.segments, p.calls.replies.length, '发了就得记几条')
  assert.ok(p.calls.replies.length >= 3)
  const sent = p.calls.replies.map((one) => JSON.parse(one.data.content).text)
  for (const one of sent) assert.ok(one.length <= FEISHU_TEXT_LIMIT)
  for (const payload of p.calls.replies) {
    assert.equal(payload.path.message_id, 'om_1', '每一段都挂在原消息下')
    assert.equal(payload.data.msg_type, 'text')
  }
  assert.match(sent[0], /^（1\/\d+）\n开头/)
})

// ---------------------------------------------------------------------------
// 末尾那行「会话：…」：只走飞书这一条路、只加在最后一段、取不到标题也不裸奔 id
// ---------------------------------------------------------------------------

test('标记那行：接在「会话：」后面的是标题本身，空标题写兜底文案', () => {
  assert.equal(sessionTagLine('改登录按钮'), '会话：改登录按钮')
  assert.equal(sessionTagLine(''), `会话：${SESSION_TAG_FALLBACK}`)
  assert.equal(sessionTagLine('   '), `会话：${SESSION_TAG_FALLBACK}`)
  assert.equal(sessionTagLine(undefined), `会话：${SESSION_TAG_FALLBACK}`)
  // 「一行」是这行的格式要求：标题里的换行、连续空格都压成一个空格
  assert.equal(sessionTagLine('甲\n  乙'), '会话：甲 乙')
  assert.ok(!sessionTagLine('甲\n乙').includes('\n'))
  // 不加装饰：前缀后面就是标题本身，前后没有记号（飞书那边发的是纯文本，记号不渲染）
  assert.equal(sessionTagLine('甲'), '会话：甲')
})

test('出站：传了会话标题，回答末尾就多一行「会话：…」（正文原样）', async () => {
  const p = await makeChannel()
  await p.channel.handleInbound(inbound())
  const r = await p.channel.reply('改好了。', { userText: '你好', sessionTitle: '改登录按钮' })
  assert.equal(r.ok, true)
  assert.equal(r.segments, 1)
  const sent = JSON.parse(p.calls.replies[0].data.content).text
  assert.equal(sent, '改好了。\n\n会话：改登录按钮')
})

test('出站：没给标题字段就一个字都不加；给了空串则写「未命名会话」', async () => {
  const p = await makeChannel()
  await p.channel.handleInbound(inbound({ message: { content: JSON.stringify({ text: '第一条' }) } }))
  await p.channel.handleInbound(inbound({ event_id: 'ev_2', message: { message_id: 'om_2', content: JSON.stringify({ text: '第二条' }) } }))
  // 不给 sessionTitle 这个字段 = 不加标记（测试和别的调用方走的老路子）
  await p.channel.reply('回答一', { userText: '第一条' })
  const plain = JSON.parse(p.calls.replies[0].data.content).text
  assert.equal(plain, '回答一', '没这个字段就不加，别人不会被这个功能顺手改掉')
  // 给了但是空串 = 这条会话没有名字，照写标记，写兜底文案
  await p.channel.reply('回答二', { userText: '第二条', sessionTitle: '' })
  const tagged = JSON.parse(p.calls.replies[1].data.content).text
  assert.equal(tagged, `回答二\n\n会话：${SESSION_TAG_FALLBACK}`)
  assert.ok(!tagged.includes('sess-'), '兜底文案里不许出现任何会话 id')
})

test('出站：分段发送时，标记只加在最后一段末尾', async () => {
  const p = await makeChannel()
  await p.channel.handleInbound(inbound())
  const r = await p.channel.reply(`开头\n${'y'.repeat(8000)}`, { userText: '你好', sessionTitle: '长回答' })
  assert.ok(r.segments >= 3)
  const sent = p.calls.replies.map((one) => JSON.parse(one.data.content).text)
  assert.equal(sent.length, r.segments)
  assert.ok(sent[sent.length - 1].endsWith('\n\n会话：长回答'), '最后一段末尾要带上')
  for (let i = 0; i < sent.length - 1; i += 1) {
    assert.ok(!sent[i].includes('会话：'), `第 ${i + 1} 段不该带标记——同一行字重复三遍就是噪音`)
  }
  for (const one of sent) assert.ok(one.length <= FEISHU_TEXT_LIMIT)
})

test('出站：回答正好顶到上限时，加上标记也不越过上限', async () => {
  // 3484 字是一段的满格量（3500 减去分段标头那点预算）。标记的位置不预留下来的话，
  // 最后一段就成了 3484 + 空行 + 标记那一行，顶上 3500 那条硬线，飞书直接拒收。
  // 标题特意取长的：短标题下 3476 + 十几字也还在 3500 以内，这条用例就白写了。
  const p = await makeChannel()
  await p.channel.handleInbound(inbound())
  const title = '一条名字特别长的会话标题用来验证越界保护'
  assert.ok(title.length > 11, '标题得长到 3484 + 标记 > 3500，这条用例才有意义')
  const r = await p.channel.reply('z'.repeat(3484), { userText: '你好', sessionTitle: title })
  assert.equal(r.ok, true)
  const sent = p.calls.replies.map((one) => JSON.parse(one.data.content).text)
  for (const one of sent) {
    assert.ok(one.length <= FEISHU_TEXT_LIMIT, `一段 ${one.length} 字，越过了 ${FEISHU_TEXT_LIMIT} 的上限`)
  }
  assert.ok(sent[sent.length - 1].endsWith(`会话：${title}`), '标记本身要完整，不许为了凑上限被截掉')
})

test('出站：回答是空的或只有空白，标记照样发得出去（不崩）', async () => {
  const p = await makeChannel()
  await p.channel.handleInbound(inbound())
  const r = await p.channel.reply('  \n ', { userText: '你好', sessionTitle: '空回答' })
  assert.equal(r.ok, true, '正文是空的不是错，标记该发就发')
  assert.equal(r.segments, 1)
  const sent = JSON.parse(p.calls.replies[0].data.content).text
  assert.equal(sent, '会话：空回答', '只有标记那一条，前面不许多出空行')
  assert.equal(p.calls.replies[0].path.message_id, 'om_1', '照旧挂回原消息')
})

test('出站：正文空、又没标记可写，还是不发（老行为）', async () => {
  const p = await makeChannel()
  await p.channel.handleInbound(inbound())
  const r = await p.channel.reply('   ', { userText: '你好' })
  assert.equal(r.ok, false)
  assert.equal(p.calls.replies.length, 0)
})

test('出站：飞书接口返回非 0 的 code 时，记一行原因而不是当成功', async () => {
  // 飞书这套接口是「HTTP 200 + 业务 code」：code 非 0 才是真失败。只看 HTTP 状态
  // 会把「限频」「权限不够」当成「发成功了」，用户那边什么都收不到。
  const { mod } = fakeSdk()
  const warnLogs = []
  const channel = await createFeishuChannel({
    config: { enabled: true, appId: APP_ID, appSecret: 's', openIds: 'ou_me', chatIds: '' },
    log: { info: () => {}, warn: (m) => warnLogs.push(m) },
    onInstruction: async () => ({ ok: true }),
    sdk: {
      ...mod,
      Client: class {
        constructor() {
          this.im = { message: { reply: async () => ({ code: 99991663, msg: 'rate limited' }) } }
        }
      },
    },
    timers: fakeTimers().timers,
  })
  await channel.handleInbound(inbound())
  const r = await channel.reply('回答', { userText: '你好' })
  assert.equal(r.ok, false)
  assert.match(r.error, /99991663/)
  assert.match(warnLogs.join('\n'), /99991663/, '失败原因要写进日志')
  channel.close()
})

// ---------------------------------------------------------------------------
// 生命周期：卸载后连接与定时器都停
// ---------------------------------------------------------------------------

test('生命周期：卸载后长连接和定时器都停，之后不再处理消息', async () => {
  const p = await makeChannel()
  assert.equal(p.calls.starts, 1)
  assert.equal(p.live.size, 1, '等回答的名单要有一个清扫定时器，且它必须能被停掉')
  await p.channel.handleInbound(inbound())
  assert.equal(p.injected.length, 1)

  p.channel.close()
  assert.deepEqual(p.calls.closes, [{ force: true }], '长连接必须真的关掉，不能留一条看不见的旧连接')
  assert.equal(p.live.size, 0, '定时器也要清掉')

  p.channel.close()
  assert.equal(p.calls.closes.length, 1, '重复卸载不该再关一次')

  await p.channel.handleInbound(inbound({ event_id: 'ev_9', message: { message_id: 'om_9' } }))
  assert.equal(p.injected.length, 1, '关掉之后不许再注入')
})

test('appId 形状不对：当场说清是哪一环，而且不去加载 SDK', async () => {
  // 实测过的坑：SDK 的 start() 不等待、不抛错，appId 正则不匹配时它只打一行日志就
  // 静默返回——用户看到的是「开关开着、什么都没发生」。所以这里必须自己先查形状。
  let loaded = 0
  await assert.rejects(
    () => createFeishuChannel({
      config: { enabled: true, appId: 'cli_bad', appSecret: 's' },
      log: { info: () => {}, warn: () => {} },
      onInstruction: async () => ({ ok: true }),
      loadSdk: async () => { loaded += 1; return fakeSdk().mod },
      timers: fakeTimers().timers,
    }),
    /appId/,
  )
  assert.equal(loaded, 0, '形状都不对就别去动 SDK')
})

test('凭据不全：appSecret 空着也要当面拒绝', async () => {
  await assert.rejects(
    () => createFeishuChannel({
      config: { enabled: true, appId: APP_ID, appSecret: '' },
      log: { info: () => {}, warn: () => {} },
      onInstruction: async () => ({ ok: true }),
      loadSdk: async () => { throw new Error('不该走到这里') },
      timers: fakeTimers().timers,
    }),
    /appSecret/,
  )
})

// ---------------------------------------------------------------------------
// 会话中途等用户拍板（第一层）：文案、解析、入站优先级、过期
//
// 这一层要的是「会用普通文字问出来、用户回一句话就算答复」——不做卡片、不加飞书权限。
// 所以下面钉两件事：
//   ① 印出去的每一句文案（用户看到的就是这些字，一个字都不能飘）；
//   ② 三种入站（命令 / 答复 / 指令）各走哪条路，尤其是**谁也抢不过谁**的那两处。
// ---------------------------------------------------------------------------

const ONE_CHOICE = [{ id: 'q1', question: '选哪个方案？', options: [{ label: '甲' }, { label: '乙' }] }]
const TWO_CHOICES = [
  { id: 'q1', question: '选哪个方案？', options: [{ label: '甲' }, { label: '乙' }] },
  { id: 'q2', question: '要不要继续？', options: [{ label: '要' }, { label: '不要' }] },
]

test('问句文案：问题一行、选项按「1. …」列、末尾一句「回数字就行」', () => {
  assert.equal(feishuQuestionText(ONE_CHOICE), [
    '选哪个方案？',
    '1. 甲',
    '2. 乙',
    '回数字就行。不想答就回「取消」。',
  ].join('\n'))
})

test('问句文案：多选说清「多个用逗号隔开」；没有选项的题说清「直接回一句话」', () => {
  assert.equal(feishuQuestionText([{ ...ONE_CHOICE[0], multiSelect: true }]).split('\n').pop(),
    '回数字就行，多个用逗号隔开。不想答就回「取消」。')
  assert.equal(feishuQuestionText([{ id: 'q1', question: '今天想做什么？' }]), [
    '今天想做什么？',
    '直接回一句话就行，不想答就回「取消」。',
  ].join('\n'))
})

test('问句文案：多道题一屏列完，选项跟在同一行上，回复按顺序给数字', () => {
  assert.equal(feishuQuestionText(TWO_CHOICES), [
    '电脑问你 2 件事，按顺序回数字：',
    '1. 选哪个方案？ 1) 甲  2) 乙',
    '2. 要不要继续？ 1) 要  2) 不要',
    '按顺序回数字就行（像「1 2」）。不想答就回「取消」。',
  ].join('\n'))
})

test('问句文案：多道题里混着一道没有选项的题 → 空串，飞书不接（写不成数字协议）', () => {
  // 那道题的答案只能是一整句话，夹在「1 2」中间没法跟别的题分开。与其编一套没人记得住的
  // 写法，不如不接——让手机或电脑去问。空串就是「别接」的信号。
  assert.equal(feishuQuestionText([TWO_CHOICES[0], { id: 'q3', question: '还有什么要说的？' }]), '')
  assert.equal(feishuQuestionText([]), '')
})

test('问句文案：选项没有 label 就不印一个空点，正文空了也如实写一句', () => {
  assert.equal(feishuQuestionText([{ id: 'q1', question: '', options: [{}, { label: '乙' }] }]), [
    '（这道题没有正文）',
    '1. 选项 1',
    '2. 乙',
    '回数字就行。不想答就回「取消」。',
  ].join('\n'))
})

test('审批文案：写清要批准什么（工具、命令、理由），末尾两步都有', () => {
  assert.equal(approvalText({ toolName: 'shell', command: 'rm -rf build', reason: '要清构建产物' }), [
    '电脑要动手，等你拍板：',
    '工具：shell',
    '命令：rm -rf build',
    '说明：要清构建产物',
    '回「同意」或「拒绝」，不想拍板就回「取消」。',
  ].join('\n'))
})

test('审批文案：命令取不到就明说没取到；多行的命令压成一行；超长时如实说还有多少字', () => {
  const noCmd = approvalText({ toolName: 'shell' })
  assert.match(noCmd, /命令：（这条没取到命令原文）/, '藏起来等于骗他——手机那张卡上也是这么写的')
  const multiline = approvalText({ toolName: 'shell', command: 'git add .\ngit commit -m x' })
  assert.match(multiline, /命令：git add \. git commit -m x/)
  const long = approvalText({ toolName: 'shell', command: 'x'.repeat(420) })
  assert.match(long, /…（后面还有 120 字）/, '不装作这就是全部')
  assert.ok(long.length < 420)
})

test('解析：单选题回数字，回别的、越界的、单选却回了两个都不认', () => {
  assert.deepEqual(parseAnswer('2', ONE_CHOICE), { ok: true, answers: [{ id: 'q1', selected: ['乙'] }] })
  assert.deepEqual(parseAnswer(' 1 ', ONE_CHOICE), { ok: true, answers: [{ id: 'q1', selected: ['甲'] }] })
  for (const bad of ['0', '3', '甲', '1 2', '', '选乙']) {
    assert.equal(parseAnswer(bad, ONE_CHOICE).ok, false, `「${bad}」不该被当成答案`)
  }
})

test('解析：多选题认逗号也认空格；没有选项的题整句话就是答案（手机页那个「我自己说」）', () => {
  const multi = [{ ...ONE_CHOICE[0], multiSelect: true }]
  assert.deepEqual(parseAnswer('1,2', multi).answers, [{ id: 'q1', selected: ['甲', '乙'] }])
  assert.deepEqual(parseAnswer('2 1', multi).answers, [{ id: 'q1', selected: ['乙', '甲'] }])
  assert.deepEqual(parseAnswer('1,1', multi).answers, [{ id: 'q1', selected: ['甲'] }], '同一个选项重复点只算一次')
  const open = [{ id: 'q9', question: '随便说点什么' }]
  assert.deepEqual(parseAnswer('  今天先不做  ', open).answers,
    [{ id: 'q9', selected: [], custom: '今天先不做' }])
})

test('解析：多道题按顺序给数字，个数不对就不认（不能猜）', () => {
  assert.deepEqual(parseAnswer('2 1', TWO_CHOICES).answers, [
    { id: 'q1', selected: ['乙'] },
    { id: 'q2', selected: ['要'] },
  ])
  for (const bad of ['1', '1 2 3', '1 甲']) {
    assert.equal(parseAnswer(bad, TWO_CHOICES).ok, false, `「${bad}」不该被当成答案`)
  }
})

test('解析：审批只认「同意」「拒绝」那几个词，别的都不算', () => {
  for (const yes of ['同意', '批准', '好的', 'OK', 'yes']) {
    assert.deepEqual(parseDecision(yes), { ok: true, decision: 'allowed-once' }, yes)
  }
  for (const no of ['拒绝', '不同意', '不行', 'no', 'N']) {
    assert.deepEqual(parseDecision(no), { ok: true, decision: 'rejected' }, no)
  }
  for (const bad of ['', '随便', '同意一下']) assert.equal(parseDecision(bad).ok, false, bad)
})

/** 先把一条指令交给会话（于是「有一轮从飞书发起的指令还没落定」成立），再开始等拍板。 */
async function awaitOn(p, payload = { kind: 'question', payload: ONE_CHOICE }) {
  await p.channel.handleInbound(inbound())
  p.calls.replies.length = 0
  assert.equal(p.channel.serving(), true, '刚发过指令，飞书这条路才该接题')
  assert.equal(p.channel.openAsk({ id: 'q1', kind: 'question', ...payload }), true)
  await flush()
  p.calls.replies.length = 0
}

test('入站：正等着拍板时，他发来的文字当答复解释，不进会话', async () => {
  const p = await makeChannel()
  await awaitOn(p)
  await p.channel.handleInbound(inbound({ event_id: 'ev_2', message: { message_id: 'om_2', content: JSON.stringify({ text: '2' }) } }))
  assert.deepEqual(p.handed, [{ kind: 'question', id: 'q1', answers: [{ id: 'q1', selected: ['乙'] }] }])
  assert.deepEqual(p.injected.map((one) => one.text), ['你好'], '答复不许再被当成一条新指令')
  assert.deepEqual(p.sent(), [ASK_DELIVERED_TEXT], '交回去了要说一声，不然他不知道算不算数')
})

test('入站：回「取消」＝不答，走现成的那条「把题还给电脑」的路', async () => {
  const p = await makeChannel()
  await awaitOn(p)
  await p.channel.handleInbound(inbound({ event_id: 'ev_2', message: { message_id: 'om_2', content: JSON.stringify({ text: '取消' }) } }))
  assert.deepEqual(p.handed, [{ kind: 'question', id: 'q1', cancel: true }])
  assert.deepEqual(p.injected.map((one) => one.text), ['你好'])
  assert.deepEqual(p.sent(), [ASK_CANCELLED_TEXT])
})

test('入站：答复看不懂时不吃掉这条消息，回一句怎么答，还在等', async () => {
  const p = await makeChannel()
  await awaitOn(p)
  await p.channel.handleInbound(inbound({ event_id: 'ev_2', message: { message_id: 'om_2', content: JSON.stringify({ text: 'emmm' }) } }))
  assert.deepEqual(p.handed, [], '看不懂就不该交回去')
  assert.deepEqual(p.injected.map((one) => one.text), ['你好'], '也不能硬塞进会话')
  assert.deepEqual(p.sent(), ['没看懂。回数字就行（回「取消」放回电脑）。'])
  assert.equal(p.channel.isWaiting('q1'), true, '还在等——接着回一句数字就该能答上')
  await p.channel.handleInbound(inbound({ event_id: 'ev_3', message: { message_id: 'om_3', content: JSON.stringify({ text: '1' }) } }))
  assert.equal(p.handed.length, 1)
  assert.deepEqual(p.handed[0].answers, [{ id: 'q1', selected: ['甲'] }])
})

test('入站：手机先拍了板（交回去被回 expired），如实说「这次提问已经过期了」', async () => {
  const p = await makeChannel({ onAnswer: () => ({ ok: false, error: 'expired' }) })
  await awaitOn(p)
  await p.channel.handleInbound(inbound({ event_id: 'ev_2', message: { message_id: 'om_2', content: JSON.stringify({ text: '1' }) } }))
  assert.deepEqual(p.sent(), [ASK_EXPIRED_TEXT])
  assert.deepEqual(p.injected.map((one) => one.text), ['你好'], '过期了也不许把他那句话当新指令发出去')
})

test('小票不进会话：只说一句，不替他发第二条指令', async () => {
  // 用户问过「这句会不会又变成会话里的一条消息」。答案是不会，凭据在这里：
  // 小票（收到/取消/过期/没看懂）走的是**这一层自己的一句普通回复**，从不经过
  // onInstruction 那条注入路。所以哪怕他刚回的就是答案本身，会话里也只有原话那一条。
  for (const [answer, 说, sent] of [
    [null, '收到', ASK_DELIVERED_TEXT],
    [{ ok: false, error: 'expired' }, '过期', ASK_EXPIRED_TEXT],
  ]) {
    const p = await makeChannel(answer ? { onAnswer: () => answer } : {})
    await awaitOn(p)
    await p.channel.handleInbound(inbound({ event_id: 'ev_2', message: { message_id: 'om_2', content: JSON.stringify({ text: '1' }) } }))
    assert.deepEqual(p.sent(), [sent], `${说}：小票就这一句`)
    assert.deepEqual(p.injected.map((one) => one.text), ['你好'],
      `${说}：小票一个字都不许进会话——会话里只该有他原来那条指令`)
  }
})

test('入站：过期之后只有「像答复的」那句被拦下，别的话照旧是新指令', async () => {
  const p = await makeChannel()
  await awaitOn(p)
  // 题被手机答掉了（电脑那边收尾），飞书这一格只留着说一句「过期了」。
  p.channel.expireAsk('q1')
  assert.equal(p.channel.isWaiting('q1'), false, 'expired 的不算还在等——电脑那边据此决定要不要还给电脑')
  // 晚一步的那句答复：讲清楚，别当成指令。
  await p.channel.handleInbound(inbound({ event_id: 'ev_2', message: { message_id: 'om_2', content: JSON.stringify({ text: '2' }) } }))
  assert.deepEqual(p.sent(), [ASK_EXPIRED_TEXT])
  assert.equal(p.injected.length, 1)
  // 紧接着一句真正的新指令：不能被那句「已经过期了」吃掉。
  await p.channel.handleInbound(inbound({ event_id: 'ev_3', message: { message_id: 'om_3', content: JSON.stringify({ text: '帮我看下日志' }) } }))
  assert.deepEqual(p.injected.map((one) => one.text), ['你好', '帮我看下日志'])
})

test('入站优先级：`/` 开头的命令永远当命令，哪怕此刻正等着拍板', async () => {
  const p = await makeChannel()
  await awaitOn(p)
  await p.channel.handleInbound(inbound({ event_id: 'ev_2', message: { message_id: 'om_2', content: JSON.stringify({ text: '/会话' }) } }))
  await flush()
  assert.deepEqual(p.handed, [], '命令不许被当成答复')
  assert.deepEqual(p.sent(), [LIST_FAILED_TEXT], '没接 listSessions 就如实说没取到')
  assert.equal(p.channel.isWaiting('q1'), true, '问句还挂着——看一眼列表不该把题作废')
})

test('问句：挂回**发起这一轮的那条消息**下面，发的是纯文本、内容就是那段话', async () => {
  const p = await makeChannel()
  await p.channel.handleInbound(inbound())
  assert.equal(p.channel.serving(), true)
  p.calls.replies.length = 0
  p.channel.openAsk({ id: 'q1', kind: 'question', payload: ONE_CHOICE })
  await flush()
  assert.equal(p.calls.replies.length, 1)
  assert.equal(p.calls.replies[0].path.message_id, 'om_1', '挂在原消息下，飞书里才看得出这是哪一轮在问')
  assert.equal(p.calls.replies[0].data.msg_type, 'text', '这一层只做普通文字，不做卡片')
  assert.equal(p.sent()[0], feishuQuestionText(ONE_CHOICE))
  assert.equal(p.channel.isWaiting('q1'), true)
})

test('问句：没人发起过轮次（手机发起的）就不接——不许抢掉电脑上的弹窗', async () => {
  const p = await makeChannel()
  assert.equal(p.channel.serving(), false)
  assert.equal(p.channel.openAsk({ id: 'q1', kind: 'question', payload: ONE_CHOICE }), false)
  await flush()
  assert.equal(p.calls.replies.length, 0)
  assert.equal(p.channel.isWaiting('q1'), false)
})

test('问句：发不出去就当场撤回「在等」，好让电脑那边照旧把题收回去', async () => {
  const p = await makeChannel({ reply: () => { throw new Error('没权限：99991672') } })
  await p.channel.handleInbound(inbound())
  p.channel.openAsk({ id: 'q1', kind: 'question', payload: ONE_CHOICE })
  assert.equal(p.channel.isWaiting('q1'), true, '先挂上再发——往返那一下不能算「没人等」')
  await flush()
  assert.equal(p.channel.isWaiting('q1'), false, '没发出去就是没人等：电脑那边 2 秒后把题收回去')
})

// ---------------------------------------------------------------------------
// 一轮回答的**归属**：这一轮从哪条飞书消息起跑，回答就回到那条消息下面
//
// 原来只认「指令原文」。那条凭据会被同一轮里后来的一句人话顶掉（累计器记的是
// 「这一轮最后那句人话」），于是发起它的那条消息永远等不到回答——用户看到的正是
// 「答完了，飞书里再没动静」。下面两条把这个缺口钉死。
// ---------------------------------------------------------------------------

/** 一轮归属的用例：让交回电脑的结果带上会话号，好把这一轮认成「从飞书起的跑」。 */
async function makeRoundChannel(opts = {}) {
  return makeChannel({ result: { ok: true, sessionId: 'sess-1' }, ...opts })
}

test('出站：这一轮从飞书起跑，后来原话被顶掉了也照样回到**发起它的那条消息**', async () => {
  const p = await makeRoundChannel()
  await p.channel.handleInbound(inbound())
  p.calls.replies.length = 0
  // 这一轮跑完时，累计器手里那句「这一轮的原话」已经不是发起它的那句了
  // （同一轮里用户又在别处跟了一句人话，或者别的注入改了它）。
  const out = await p.channel.reply('甲方案更合适，我按这个做了。', { userText: '等等，先别动', sessionId: 'sess-1' })
  assert.equal(out.ok, true, '归属是记下来的，不该因为对不上原文就静默不发')
  assert.equal(out.messageId, 'om_1', '要回到发起这一轮的那条消息下面')
  assert.equal(p.calls.replies.length, 1)
  assert.equal(p.calls.replies[0].path.message_id, 'om_1')
  assert.equal(p.sent()[0], '甲方案更合适，我按这个做了。')
})

test('出站：手机的轮次不许抢走飞书那条还没人认领的指令', async () => {
  const p = await makeRoundChannel()
  await p.channel.handleInbound(inbound()) // 飞书那条：起了跑，等着被回答
  const out = await p.channel.reply('手机那边跑完的一轮', { userText: '手机上发的那句', sessionId: 'sess-other' })
  assert.deepEqual(out, { ok: false, error: 'no-target' }, '会话对不上就不发，绝不把手机上的回答倒进飞书')
  assert.equal(p.calls.replies.length, 0)
  assert.equal(p.channel.serving(), true, '飞书那条还在等，没被抢掉')
})

test('出站：这一轮还没起跑（只是排着队）时，回答不认它', async () => {
  // 交回 ok:false = 这条指令压根没交给会话，它不该留在名单里，更不该被当成起跑过。
  const q = await makeChannel({ result: { ok: false, error: '电脑上还没有可遥控的会话。' } })
  await q.channel.handleInbound(inbound())
  assert.equal(q.channel.serving(), false, '没交出去的那条要从名单里撤掉')
  const out = await q.channel.reply('不该发出去的回答', { userText: '你好', sessionId: 'sess-1' })
  assert.deepEqual(out, { ok: false, error: 'no-target' })
  assert.equal(q.calls.replies.length, 0)

  // 交出去了的那条才认得出——同一个形状，差的就是「起跑标记」那一下。
  const p = await makeRoundChannel()
  await p.channel.handleInbound(inbound())
  const ok = await p.channel.reply('这一轮的回答', { userText: '你好', sessionId: 'sess-1' })
  assert.equal(ok.messageId, 'om_1')
})

// ---------------------------------------------------------------------------
// /会话：列会话、切会话
// ---------------------------------------------------------------------------

test('/会话 命令的解析：只认这一条，多敲几个斜杠也算手滑', () => {
  assert.deepEqual(parseFeishuCommand('/会话'), { kind: 'list' })
  assert.deepEqual(parseFeishuCommand('  /会话  '), { kind: 'list' })
  assert.deepEqual(parseFeishuCommand('//会话'), { kind: 'list' })
  assert.deepEqual(parseFeishuCommand('/会话 3'), { kind: 'switch', index: 3 })
  assert.deepEqual(parseFeishuCommand('/会话3'), { kind: 'switch', index: 3 })
  for (const bad of ['/帮助', '/session', '会话', '/会话 x', '/会话 -1', '/']) {
    assert.deepEqual(parseFeishuCommand(bad), { kind: 'unknown' }, bad)
  }
})

test('/会话 列表文案：编号 + 标题，标出当前那个，取不到标题就写「未命名会话」', () => {
  assert.equal(sessionPickText({
    rows: [{ id: 's1', title: '改登录按钮' }, { id: 's2', title: '' }],
    total: 2,
    bound: 's2',
  }), [
    '现在能切的会话：',
    '1. 改登录按钮',
    `2. ${SESSION_TAG_FALLBACK}（当前）`,
    '回「/会话 2」就切到第 2 个。',
  ].join('\n'))
  assert.equal(sessionPickText({ rows: [], total: 0 }), NO_SESSIONS_TEXT)
})

test('/会话 列表文案：条数截过就如实说还剩多少', () => {
  const text = sessionPickText({ rows: [{ id: 's1', title: '甲' }], total: 12 })
  assert.match(text, /（只列了最近 1 条，一共 12 条）/)
})

test('切会话的确认：写清新会话的标题，并说清手机页跟着一起变', () => {
  assert.equal(sessionSwitchedText('部署脚本'),
    '切到「部署脚本」了。手机页那边跟着一起变——两边用的是同一个会话。')
  assert.equal(sessionSwitchedText(''), `切到「${SESSION_TAG_FALLBACK}」了。手机页那边跟着一起变——两边用的是同一个会话。`)
})

test('/会话：列出来的是插件给的那份（标题来自手机页同一份缓存），当命令走、不进会话', async () => {
  const p = await makeChannel({
    listSessions: async () => ({ rows: [{ id: 's1', title: '甲' }, { id: 's2', title: '乙' }], total: 2, bound: 's1' }),
  })
  await p.channel.handleInbound(inbound({ message: { content: JSON.stringify({ text: '/会话' }) } }))
  await flush()
  assert.deepEqual(p.injected, [], '命令不是指令，一个字都不该进会话')
  assert.deepEqual(p.sent(), [[
    '现在能切的会话：',
    '1. 甲（当前）',
    '2. 乙',
    '回「/会话 2」就切到第 2 个。',
  ].join('\n')])
})

test('/会话 2：切的是插件那个全局绑定，回一句带标题的确认', async () => {
  const bound = []
  const p = await makeChannel({
    listSessions: async () => ({ rows: [{ id: 's1', title: '甲' }, { id: 's2', title: '乙' }], total: 2, bound: 's1' }),
    bindSession: async (id) => { bound.push(id); return '乙' },
  })
  await p.channel.handleInbound(inbound({ message: { content: JSON.stringify({ text: '/会话 2' }) } }))
  await flush()
  assert.deepEqual(bound, ['s2'], '传下去的是会话 id，不是那行界面上的编号')
  assert.deepEqual(p.sent(), [sessionSwitchedText('乙')])
  assert.deepEqual(p.injected, [])
})

test('/会话 编号越界：如实说没有第几个，不去猜他想切哪个', async () => {
  const p = await makeChannel({
    listSessions: async () => ({ rows: [{ id: 's1', title: '甲' }], total: 1, bound: 's1' }),
    bindSession: async () => { throw new Error('不该切') },
  })
  await p.channel.handleInbound(inbound({ message: { content: JSON.stringify({ text: '/会话 9' }) } }))
  await flush()
  assert.deepEqual(p.sent(), ['没有第 9 个。先发「/会话」看一眼有哪些。'])
})

test('/会话：列表没取到就说没取到，不装作「这台电脑上没有会话」', async () => {
  const p = await makeChannel({ listSessions: async () => { throw new Error('DSH 不在') } })
  await p.channel.handleInbound(inbound({ message: { content: JSON.stringify({ text: '/会话' }) } }))
  await flush()
  assert.deepEqual(p.sent(), [LIST_FAILED_TEXT])
})

test('/会话：切的时候出错就说切不过去，不装作切好了', async () => {
  const p = await makeChannel({
    listSessions: async () => ({ rows: [{ id: 's1', title: '甲' }], total: 1, bound: 's2' }),
    bindSession: async () => { throw new Error('写不进去') },
  })
  await p.channel.handleInbound(inbound({ message: { content: JSON.stringify({ text: '/会话 1' }) } }))
  await flush()
  assert.deepEqual(p.sent(), [BIND_FAILED_TEXT])
})

test('不认识的命令：回一句最简提示，只提那一条真有的', async () => {
  const p = await makeChannel()
  await p.channel.handleInbound(inbound({ message: { content: JSON.stringify({ text: '/帮助' }) } }))
  await flush()
  assert.deepEqual(p.sent(), [UNKNOWN_COMMAND_TEXT])
  assert.match(UNKNOWN_COMMAND_TEXT, /\/会话/)
  assert.equal(UNKNOWN_COMMAND_TEXT.split('\n').length, 1, '一屏能看完，不列一长串')
  assert.deepEqual(p.injected, [])
})

test('命令也只在白名单内的单聊生效：群聊、未授权来源照旧', async () => {
  const p = await makeChannel({ config: { openIds: 'ou_me' } })
  // 群聊
  await p.channel.handleInbound(inbound({ message: { chat_type: 'group', content: JSON.stringify({ text: '/会话' }) } }))
  // 未授权来源：被挡下时照旧回那句带编号的提示，而不是去列会话
  const stranger = await makeChannel({ config: { openIds: '' } })
  await stranger.channel.handleInbound(inbound({ openId: 'ou_x', message: { content: JSON.stringify({ text: '/会话' }) } }))
  await flush()
  assert.deepEqual(p.sent(), [], '群里一句话都不回')
  assert.match(stranger.sent()[0], /open_id=ou_x/, '未授权来源照旧收到那句带编号的提示')
  assert.ok(!stranger.sent()[0].includes('现在能切的会话'), '不许把列表发给他')
  assert.deepEqual(stranger.injected, [])
})

