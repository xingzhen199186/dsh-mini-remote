/**
 * 「把会话记录重放成聊天记录」的离线用例。
 *
 * 这一段是手机点开一个老会话时看到的那一串的来源，而它错起来是**安静的**：
 * 多一条旁白、少一条回复、顺序反了，都不会报错，只是手机上看着不对。
 * 所以判据一条条钉在这里：谁算回答、谁不算、顺序、时间、按停的那半句。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replayHistory, lastReply } from '../lib/history.js'

/** 造一条会话事件。time 用递增的假时间，方便断言时间戳有没有带对。 */
let clock = 1_700_000_000_000
const ev = (type, data) => ({ type, seq: 0, time: (clock += 1000), data })
const text = (t) => [{ type: 'text', text: t }]
const userMsg = (t) => ev('user/message', { id: `m${t}`, source: { kind: 'user' }, content: text(t) })

/** 一轮完整对话：用户说一句，模型答一句。 */
function turn(ask, answer) {
  return [
    ev('turn/start', { turn: 1 }),
    userMsg(ask),
    ev('assistant/message', { message: { content: text(answer) } }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

test('重放：一轮完整对话就是「你一句、我一句」，顺序不乱', () => {
  const out = replayHistory([
    ...turn('第一问', '第一答'),
    ...turn('第二问', '第二答'),
  ])

  assert.deepEqual(out.map((m) => [m.role, m.text]), [
    ['user', '第一问'],
    ['assistant', '第一答'],
    ['user', '第二问'],
    ['assistant', '第二答'],
  ])
})

test('重放：时间戳用事件自己的时间，不是「现在」', () => {
  const events = turn('问', '答')
  const out = replayHistory(events)

  // 每条都要带上它那件事发生的时间，手机上才显示得出正确的时刻
  for (const m of out) {
    assert.equal(typeof m.timestamp, 'number')
  }
  assert.ok(out[0].timestamp < out[1].timestamp, '用户那条在前，时间要更早')
  // 用事件里的 time 原值，不是重新取的系统时间
  assert.equal(out[0].timestamp, events[1].time)
  assert.equal(out[1].timestamp, events[3].time)
})

test('重放：带工具调用的中间步骤不是回答，只有最后那条才算', () => {
  const out = replayHistory([
    ev('turn/start', { turn: 1 }),
    userMsg('帮我改一下'),
    // 模型先说了句旁白，同时发起工具调用——这是中间步骤
    ev('assistant/message', {
      message: { content: [...text('我先看看这个文件'), { type: 'tool-call', id: 't1', name: 'read' }] },
    }),
    ev('assistant/message', { message: { content: text('改好了。') } }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ])

  assert.deepEqual(out.filter((m) => m.role === 'assistant').map((m) => m.text), ['改好了。'],
    '那句「我先看看这个文件」是旁白，不能当成回答')
})

test('重放：被按停的那一轮标出来，但内容留着', () => {
  const out = replayHistory([
    ev('turn/start', { turn: 1 }),
    userMsg('写一篇长的'),
    ev('assistant/message', { interrupted: true, message: { content: text('写到一半就被停了') } }),
    ev('turn/end', { turn: 1, reason: { kind: 'aborted' } }),
  ])

  const reply = out.find((m) => m.role === 'assistant')
  assert.equal(reply.text, '写到一半就被停了')
  assert.equal(reply.interrupted, true, '得让手机知道这是半句，不是完整的回答')
  assert.equal(reply.reason, 'aborted')
})

test('重放：插件注入的上下文不算「用户说的话」', () => {
  const out = replayHistory([
    ev('turn/start', { turn: 1 }),
    // agent.inject() 塞进来的合成上下文（文件变更通知之类），source.kind 是 plugin
    ev('user/message', { source: { kind: 'plugin' }, content: text('<文件变更通知>') }),
    ...turn('真正的人话', '回答'),
  ])

  assert.deepEqual(out.filter((m) => m.role === 'user').map((m) => m.text), ['真正的人话'],
    '合成上下文不能冒充用户指令，否则手机上会冒出莫名其妙的消息')
})

test('重放：一轮没跑出回答就什么都不记（不能拿旁白顶替）', () => {
  const out = replayHistory([
    ev('turn/start', { turn: 1 }),
    userMsg('问了一句'),
    ev('assistant/message', {
      message: { content: [...text('我调个工具'), { type: 'tool-call', id: 't1', name: 'x' }] },
    }),
    ev('turn/end', { turn: 1, reason: { kind: 'error' } }),
  ])

  assert.deepEqual(out.map((m) => m.role), ['user'], '只有用户那条，回答那条宁可不显示')
})

test('重放：文字里夹着工具调用原始标记的，也不算回答', () => {
  const out = replayHistory([
    ...turn('问', '正常回答'),
    ev('turn/start', { turn: 2 }),
    userMsg('再问'),
    ev('assistant/message', { message: { content: text('好的<parameter name="edit">…') } }),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ])

  const replies = out.filter((m) => m.role === 'assistant').map((m) => m.text)
  assert.deepEqual(replies, ['正常回答'], '协议原文不是给人读的话，不能推到手机上')
})

test('重放：空事件、坏数据都不炸', () => {
  assert.deepEqual(replayHistory([]), [])
  assert.deepEqual(replayHistory(null), [])
  assert.deepEqual(replayHistory([null, {}, { type: 'unknown' }]), [])
})

test('取最后一条回复：单帧模式要的就是它', () => {
  const entries = replayHistory([
    ...turn('第一问', '第一答'),
    ...turn('第二问', '第二答'),
  ])
  const latest = lastReply(entries, 'sess-1')

  assert.equal(latest.text, '第二答')
  assert.equal(latest.sessionId, 'sess-1')
  assert.equal(typeof latest.timestamp, 'number')
})

test('取最后一条回复：只有用户说过话时给 null，不能拿用户那句顶上', () => {
  const entries = replayHistory([ev('turn/start', { turn: 1 }), userMsg('你还在吗')])

  assert.equal(lastReply(entries, 'sess-1'), null,
    '单帧模式宁可显示空，也不能把用户自己的话当成 AI 的回复')
  assert.equal(lastReply([], 'sess-1'), null)
  assert.equal(lastReply(null, 'sess-1'), null)
})

// ---------------------------------------------------------------------------
// 斜杠指令也在会话记录里——重放的时候不能把它丢了，也不能把它当成一轮对话
// ---------------------------------------------------------------------------

const cmdRun = (id, name, args = '') => ev('command/run', { commandId: id, name, args })
const cmdDone = (id, kind, text) => ev('command/done', { commandId: id, kind, text })

test('重放：斜杠指令单独成条，夹在两轮对话中间不串位', () => {
  const rows = replayHistory([
    ...turn('第一问', '第一答'),
    cmdRun('c1', 'compact'),
    cmdDone('c1', 'success', '压好了'),
    ...turn('第二问', '第二答'),
  ])

  assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant', 'command', 'user', 'assistant'])
  assert.equal(rows[2].name, 'compact')
  assert.equal(rows[2].kind, 'success')
  assert.equal(rows[2].text, '压好了')
  // 时间戳取事件自己的，不是「现在」——它要和手机上实时记的那一份按时间合成
  assert.equal(typeof rows[2].timestamp, 'number')
})

test('重放：只重放出「开始」没重放出「收尾」的指令，还挂着「执行中」', () => {
  // 真实场景：日志尾部窗口正好截在两条事件中间，或者那条指令跑的时候插件还没起来。
  const rows = replayHistory([...turn('问', '答'), cmdRun('c1', 'goal', ' clear')])

  const row = rows.at(-1)
  assert.equal(row.role, 'command')
  assert.equal(row.name, 'goal')
  assert.equal(row.args, ' clear', '名字后面那段原样留着，指令自己解释')
  assert.equal(row.kind, 'running')
})

test('重放：指令不是回答，单帧模式拿的还是模型那句', () => {
  const rows = replayHistory([
    ...turn('问一句', '答一句'),
    cmdRun('c1', 'compact'),
    cmdDone('c1', 'error', '压不动'),
  ])

  assert.equal(lastReply(rows, 'sess-1').text, '答一句',
    '指令的结果是系统动作，不是 AI 的回答——单帧模式显示它会让用户以为模型说了这句')
})

// ---------------------------------------------------------------------------
// 子智能体完工的通知（2026-10-03）
//
// 这条通知在电脑端是一张可展开的卡片，在手机端原来是**整条不见了**：
// 它挂在 `user/message` 上，而提取器只认 `source.kind === 'user'`，它就被一起挡掉了。
// 下面几条钉住「它现在进得来」和「它没有被冒充成别的东西」这两件事。
// ---------------------------------------------------------------------------

/** 子智能体跑完，DSH 往父会话里追加的那条通知。 */
const settledMsg = (summary, closing) => ev('user/message', {
  id: 'notice-1',
  source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: 'session-child' },
  // 通知的正文是**几个 text 块**（先说为什么结束，再接它的收尾原话），不是一整段。
  content: [...text(summary), ...text('Its closing message:'), ...text(closing)],
})

test('重放：子智能体完工的通知进得来，而且不是「用户说的话」', () => {
  // 原来它被过滤掉了（手机上从来没见过这张卡片）。现在要进得来，
  // 而且**不能**是 role:'user'——那会变成「我说过这句话」，是假的。
  const rows = replayHistory([
    ...turn('派个活', '派出去了'),
    settledMsg('Background subagent session-child finished.', '两条依赖重复，已经删掉一条。'),
  ])

  const row = rows.at(-1)
  assert.equal(row.role, 'notice')
  assert.notEqual(row.role, 'user', '通知不是用户说的话')
  assert.equal(row.senderSessionId, 'session-child')
  assert.match(row.summary, /finished/)
  // 正文是**转述**：DSH 说清「谁、为什么结束」，再把它自己的收尾原话接上。
  // 用户要读到的就是这段，一个字都不该在我们这边被加工掉。
  assert.match(row.text, /Background subagent session-child finished\./)
  assert.match(row.text, /Its closing message:/)
  assert.match(row.text, /两条依赖重复，已经删掉一条。/)
})

test('重放：通知不抢「最新的回答」那个位置', () => {
  // 单帧模式显示的是模型的回答。通知占了那个位置，用户会以为模型说了这串英文。
  const rows = replayHistory([
    ...turn('问一句', '答一句'),
    settledMsg('Background subagent session-child finished.', '做完了'),
  ])

  assert.equal(lastReply(rows, 'sess-1').text, '答一句',
    '完工通知不是回答——它是一件事的结局，不是模型对你说的话')
})

test('重放：没有内容的通知不占位（宁可没有，也不给一张空卡片）', () => {
  const rows = replayHistory([
    ...turn('问', '答'),
    ev('user/message', { id: 'n', source: { kind: 'subagent-settled', senderSessionId: 'c' }, content: [] }),
  ])

  assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant'])
})

test('重放：插件注入的合成上下文照旧丢掉，没被这条新规则带进来', () => {
  // 新加的分支只管 subagent-settled 那一种。别的 source.kind（plugin 等）
  // 还是得挡在外面——否则手机上会冒出「文件变更通知」这类莫名其妙的消息。
  const rows = replayHistory([
    ...turn('问', '答'),
    ev('user/message', { id: 'p1', source: { kind: 'plugin' }, content: text('文件变了：a.js') }),
  ])

  assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant'])
  assert.deepEqual(rows.map((r) => r.text), ['问', '答'])
})
