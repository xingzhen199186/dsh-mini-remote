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

async function makeChannel({ config = {}, result = { ok: true }, reply } = {}) {
  const { calls, mod } = fakeSdk({ reply })
  const { live, timers } = fakeTimers()
  const logs = []
  const injected = []
  const channel = await createFeishuChannel({
    config: { enabled: true, appId: APP_ID, appSecret: 'app-secret', openIds: 'ou_me', chatIds: '', ...config },
    log: { info: (m) => logs.push(`info:${m}`), warn: (m) => logs.push(`warn:${m}`) },
    onInstruction: async (text, uploadIds) => {
      injected.push({ text, uploadIds })
      return typeof result === 'function' ? result(text) : result
    },
    sdk: mod,
    timers,
  })
  return {
    channel, calls, live, logs, injected,
    warns: () => logs.filter((line) => line.startsWith('warn:')),
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
