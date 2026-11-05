/**
 * 执行轨迹（「完整」模式）的离线用例。
 *
 * 这一段错起来是**安静的**：少一条思考、多一条空壳、把成功标成失败、把两条不同的思考
 * 认成同一条，都不会报错，只是手机上的过程区看着不对。所以判据一条条钉在这里。
 *
 * 最要紧的一条是「实时那份和重放那份必须能对上」：同一个事件在两条路上算出的 id 一样，
 * 合并时才会认成同一条。算不出来的话就会**一行变两行**（插件亲眼看见的那份 + 日志里
 * 重放的那份各占一行），这是这次改动最容易出、又最难在真机上发现的一种错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TRAJECTORY_MAX_CHARS,
  TRAJECTORY_MAX_ENTRIES,
  applyTrajectoryPatch,
  argSummary,
  capTrajectory,
  clipForTrajectory,
  createTrajectoryTracker,
  mergeTrajectory,
  replayTrajectory,
  turnStateOf,
  finalizeTrajectory,
} from '../lib/trajectory.js'
import { createStore } from '../lib/store.js'

/** time 与 seq 都用递增的假值，方便断言「有没有带对」。 */
let clock = 1_700_000_000_000
let seqNo = 0
const ev = (type, data) => ({ type, seq: (seqNo += 1), time: (clock += 1000), data })
const text = (t) => [{ type: 'text', text: t }]

/** 一轮：一步里先想、再调一次工具，工具返回结果，然后给最终回答。 */
function turnWithTool({ turn = 1, output = 'done', failed = false, reasoning = '我先看看这个文件' } = {}) {
  return [
    ev('turn/start', { turn }),
    ev('user/message', { id: 'm' + turn, source: { kind: 'user' }, content: text('帮我改一下') }),
    ev('step/start', { turn, step: 1 }),
    ev('assistant/message', {
      turn,
      step: 1,
      message: {
        content: [
          { type: 'reasoning', text: reasoning },
          { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a.txt"}' },
        ],
      },
    }),
    ev('tool/call', { turn, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.txt"}' }),
    ev('tool/result', {
      turn,
      step: 1,
      message: { role: 'tool', toolCallId: 'c1', isError: failed, content: text(output) },
    }),
    ev('step/end', { turn, step: 1 }),
    ev('assistant/message', { turn, step: 2, message: { content: text('改好了。') } }),
    ev('turn/end', { turn, reason: { kind: 'completed' } }),
  ]
}

// ---------------------------------------------------------------------------
// 提取
// ---------------------------------------------------------------------------

test('提取：一轮 2 步 1 次工具调用 → 3 条轨迹（2 条思考 + 1 条工具）', () => {
  const events = [
    ev('turn/start', { turn: 1 }),
    ev('step/start', { turn: 1, step: 1 }),
    ev('assistant/message', {
      turn: 1, step: 1,
      message: {
        content: [
          { type: 'reasoning', text: '先看一下文件' },
          { type: 'tool-call', id: 'c1', name: 'read' },
        ],
      },
    }),
    ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.txt"}' }),
    ev('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: text('文件内容') } }),
    ev('step/end', { turn: 1, step: 1 }),
    ev('step/start', { turn: 1, step: 2 }),
    ev('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'reasoning', text: '改完了' }] } }),
    ev('step/end', { turn: 1, step: 2 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  const groups = replayTrajectory(events)

  assert.equal(groups.length, 1, '一轮就是一组')
  const g = groups[0]
  assert.equal(g.turn, 1)
  assert.equal(g.state, 'done', 'completed = 完成')
  assert.deepEqual(g.entries.map((e) => [e.kind, e.step]), [
    ['think', 1],
    ['tool', 1],
    ['think', 2],
  ], '组内顺序就是发生顺序：先想、再调工具、再想')
  assert.equal(g.entries[0].output, '先看一下文件', '思考的正文只在这里出现')
  assert.equal(g.entries[1].name, 'read')
  assert.equal(g.entries[1].state, 'ok', '结果回来了就是 ok')
  assert.equal(g.entries[1].output, '文件内容')
  assert.equal(g.entries[1].summary, 'a.txt', '参数摘要取的是常用字段')
  assert.equal(g.entries[1].args, '{"path":"a.txt"}', '原始参数一个字都不动')
  assert.equal(g.entries[0].name, null, '思考没有工具名')
})

test('提取：旁白进轨迹（kind=say），用户那句话进轨迹，收尾回答不进', () => {
  // 用户 2026-10-04 裁决推翻旧口径「旁白不进轨迹」：完整模式把鲸鱼娘气泡藏了，
  // 旁白（对用户说的话）没处去，塞回执行轨迹——照 PC，它是过程里的一段正文。
  // 收尾那条回答照旧不进：回答区已经有它，进轨迹就是重复。
  const events = [
    ev('turn/start', { turn: 1 }),
    ev('user/message', { id: 'm1', source: { kind: 'user' }, content: text('帮我改一下') }),
    ev('step/start', { turn: 1, step: 1 }),
    ev('assistant/message', {
      turn: 1, step: 1,
      message: {
        content: [
          { type: 'reasoning', text: '先看一下文件' },
          { type: 'text', text: '我先看一下这个文件' },
          { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a.txt"}' },
        ],
      },
    }),
    ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.txt"}' }),
    ev('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: text('文件内容') } }),
    ev('assistant/message', { turn: 1, step: 2, message: { content: text('改好了。') } }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  const g = replayTrajectory(events)[0]
  assert.deepEqual(g.entries.map((e) => e.kind), ['user', 'think', 'say', 'tool'],
    '带工具调用那一步的正文 = 旁白，按发生顺序排在中间')
  assert.equal(g.entries[2].output, '我先看一下这个文件', '旁白的正文原样进轨迹')
  assert.ok(!g.entries.some((e) => e.output === '改好了。'), '收尾回答不进轨迹——回答区已经有它')
  assert.ok(g.entries.some((e) => e.kind === 'user' && e.output === '帮我改一下'), '用户那句话进轨迹（2026-11-03 对齐本体）')
})

test('提取：工具失败 → error，原因是事件里那个，取不到就是 null（不编）', () => {
  const withReason = replayTrajectory([
    ev('turn/start', { turn: 1 }),
    ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
    ev('tool/result', {
      turn: 1, step: 1,
      message: { role: 'tool', toolCallId: 'c1', isError: true, content: text('命令没找到') },
      error: { name: 'ToolError', code: 'ENOENT', reason: '找不到那个文件' },
    }),
  ])
  const failed = withReason[0].entries[0]
  assert.equal(failed.state, 'error')
  assert.deepEqual(failed.error, { name: 'ToolError', code: 'ENOENT', reason: '找不到那个文件' })
  assert.equal(failed.output, '命令没找到', '失败了也要留着它说的话')

  const bare = replayTrajectory([
    ev('turn/start', { turn: 1 }),
    ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
    ev('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', isError: true, content: text('') } }),
  ])
  assert.deepEqual(bare[0].entries[0].error, { name: null, code: null, reason: null },
    '事件里没给原因就不编一个——页面那边写「失败」')
})

test('提取：时间戳用事件自己的 time，没有就是 null（不编「现在」）', () => {
  const events = turnWithTool()
  const groups = replayTrajectory(events)
  const byKind = (k) => groups[0].entries.find((e) => e.kind === k)
  assert.equal(byKind('tool').timestamp, events.find((e) => e.type === 'tool/call').time)
  assert.equal(byKind('think').timestamp, events.find((e) => e.type === 'assistant/message').time)
  assert.equal(byKind('user').timestamp, events.find((e) => e.type === 'user/message').time)

  const noTime = replayTrajectory([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } },
  ])
  assert.equal(noTime[0].entries[0].timestamp, null)
})

test('时间：endedAt 只认工具结果，非工具条目不借下一条时间', () => {
  const events = [
    ev('turn/start', { turn: 1 }),
    ev('user/message', { id: 'm1', source: { kind: 'user' }, content: text('看一眼') }),
    ev('assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'reasoning', text: '先想' }] },
    }),
    ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }),
    ev('tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'c1', content: text('看完了') },
    }),
    ev('assistant/message', {
      turn: 1,
      step: 2,
      message: { content: [{ type: 'reasoning', text: '再想' }] },
    }),
  ]
  const group = replayTrajectory(events)[0]
  assert.equal(group.entries[0].endedAt, null)
  assert.equal(group.entries[1].endedAt, null)
  assert.equal(group.entries[2].endedAt, events.find((e) => e.type === 'tool/result').time)
  assert.equal(group.entries[3].endedAt, null)
  assert.equal(group.startedAt, group.entries[0].timestamp, '组的开始时间保留')
  assert.equal(group.endedAt, group.entries[3].timestamp, '组的结束时间保留')
})

test('提取：轮状态四种——正在跑 / 已停 / 失败 / 完成', () => {
  assert.equal(turnStateOf('completed'), 'done')
  assert.equal(turnStateOf('error'), 'error')
  assert.equal(turnStateOf('aborted'), 'stopped')
  assert.equal(turnStateOf('interrupted'), 'stopped')
  // blocked / max-tokens 不是「失败」：那一轮是被挡下、或者太长被截了，和「出错了」是两件事。
  assert.equal(turnStateOf('blocked'), 'stopped')
  assert.equal(turnStateOf('max-tokens'), 'stopped')

  // 没有 turn/end 的那一轮（会话就断在这儿）：如实说「正在跑」，不替它收尾。
  const open = replayTrajectory([ev('turn/start', { turn: 1 }), ev('step/start', { turn: 1, step: 1 })])
  assert.equal(open[0].state, 'running')
})

test('提取：被按停的一轮里，没回结果的工具步标成「停了」，不留在转圈', () => {
  const groups = replayTrajectory([
    ev('turn/start', { turn: 1 }),
    ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
    ev('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{}' }),
    ev('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: text('第一条回来了') } }),
    ev('turn/end', { turn: 1, reason: { kind: 'aborted' } }),
  ])
  const [first, second] = groups[0].entries
  assert.equal(first.state, 'ok')
  assert.equal(second.state, 'stopped', '结果永远不会来了，如实说停了')
  assert.equal(groups[0].state, 'stopped')
})

test('提取：被按停的那条消息，思考留着但状态是「停了」', () => {
  const groups = replayTrajectory([
    ev('turn/start', { turn: 1 }),
    ev('assistant/message', {
      turn: 1, step: 1, interrupted: true,
      message: { content: [{ type: 'reasoning', text: '想到一半就被按住了' }] },
    }),
    ev('turn/end', { turn: 1, reason: { kind: 'aborted' } }),
  ])
  assert.equal(groups[0].entries[0].output, '想到一半就被按住了')
  assert.equal(groups[0].entries[0].state, 'stopped')
})

test('提取：一条没编号的工具结果不硬塞成一条空壳', () => {
  const groups = replayTrajectory([
    ev('turn/start', { turn: 1 }),
    ev('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: text('不知道是谁的结果') } }),
  ])
  assert.deepEqual(groups[0].entries, [])
})

// ---------------------------------------------------------------------------
// 截断与摘要
// ---------------------------------------------------------------------------

test('截断：4000 字符这一档是钉死的，超了才截，措辞与桌面端一致', () => {
  // 这两个数不是随手写的：4000 是手机上一条条目正文的上限（实测单条输出最大 49,930
  // 字符），120 是每个会话保留的条目数。**值本身也要钉住**——只按常量算期望的话，
  // 把常量改成一百万，下面的用例照样全绿，等于没测。
  assert.equal(TRAJECTORY_MAX_CHARS, 4000)
  assert.equal(TRAJECTORY_MAX_ENTRIES, 120)

  assert.deepEqual(clipForTrajectory('短内容'), { text: '短内容', truncated: null })

  const exact = clipForTrajectory('字'.repeat(4000))
  assert.equal(exact.truncated, null, '正好 4000 不该被截')
  assert.equal(exact.text.length, 4000)

  const clipped = clipForTrajectory('字'.repeat(5234))
  assert.deepEqual(clipped.truncated, { chars: 4000, total: 5234 })
  assert.ok(clipped.text.startsWith('字'.repeat(4000)))
  assert.ok(clipped.text.endsWith('… 已截断，共 5234 字符'), '原始长度要如实写在里面')
  assert.equal(clipForTrajectory('字'.repeat(4000)).text.includes('已截断'), false, '没超就不许写这句话')
})

test('截断：只兜极端值，正常长度一个字都不砍', () => {
  // 实测 p50 的单轮轨迹才 9,250 字符，单条正文远在 4000 以下——截断不该碰到它们。
  const groups = replayTrajectory(turnWithTool({ output: '一段平常长度的工具输出' }))
  const tool = groups[0].entries.find((e) => e.kind === 'tool')
  assert.equal(tool.output, '一段平常长度的工具输出')
  assert.equal(tool.truncated, null)
})

test('截断：工具步的原始参数也会截，和输出的截断信息各记一份', () => {
  const longArgs = JSON.stringify({ command: 'x'.repeat(4010) })
  const groups = replayTrajectory([
    ev('turn/start', { turn: 1 }),
    ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: longArgs }),
    ev('tool/result', {
      turn: 1, step: 1,
      message: { role: 'tool', toolCallId: 'c1', content: text('y'.repeat(4005)) },
    }),
  ])
  const tool = groups[0].entries[0]
  assert.deepEqual(tool.truncated.args, { chars: 4000, total: longArgs.length })
  assert.deepEqual(tool.truncated.output, { chars: 4000, total: 4005 })
  assert.deepEqual(tool.summary.slice(-1), '…', '折叠行也收着点，但原始参数在 args 里')
})

test('参数摘要：照抄 PC 的取值顺序（SUMMARY_KEYS）——说明优先、一行、不铺原文', () => {
  // PC（dsh-client-ui-tool 的 SUMMARY_KEYS / deriveSummary）折叠行右边取的是「说明」，
  // 不是原始命令：bash → description, command；read → path/file_path/url；
  // search → query/pattern/url；write/edit → path/file_path；code → description；
  // 认不出的工具 → 第一个非空字符串；都没有就原样一行。
  // 2026-10-04 用户真机报「词条右边把整条命令铺出来」——根因就是手机把 command 排了第一。
  assert.equal(
    argSummary('{"description":"找活体检查失败项","command":"node tools/live-check.mjs --port 3090 2>&1"}', 'pwsh'),
    '找活体检查失败项', '命令类：人写的说明优先，命令原文收在展开里')
  assert.equal(argSummary('{"command":"npm test","cwd":"I:\\\\a"}', 'bash'), 'npm test', '没说明才退到命令')
  assert.equal(argSummary('{"path":"a.txt","limit":10}', 'read'), 'a.txt')
  assert.equal(argSummary('{"query":"foo","pattern":"b*"}', 'grep'), 'foo')
  assert.equal(argSummary('{"path":"a.txt","content":"一大篇"}', 'write'), 'a.txt')
  assert.equal(argSummary('{"description":"验一遍"}', 'run_code'), '验一遍')
  assert.equal(argSummary('{"title":"小活","x":1}', 'mystery_tool'), '小活', '认不出的工具：第一个非空字符串（照 PC）')
  assert.equal(argSummary('{"limit":10,"force":true}', 'mystery_tool'), '{"limit":10,"force":true}',
    '一个字符串都没有：原样一行（照 PC，不自造「key: value」的拼法）')
  assert.equal(argSummary(JSON.stringify({ todos: [
    { content: '甲', status: 'completed' },
    { content: '乙', status: 'in_progress' },
    { content: '丙', status: 'pending' },
  ] }), 'todo_write'), '3 项 · 1 进行中', '待办清单给计数摘要，不贴原始 JSON')
  assert.equal(argSummary(JSON.stringify({ todos: [
    { content: '甲', status: 'completed' },
    { content: '乙', status: 'completed' },
  ] }), 'todo_write'), '2 项全部完成')
  assert.equal(argSummary(JSON.stringify({ todos: [
    { content: '甲', status: 'completed' },
    { content: '乙', status: 'pending' },
  ] }), 'todo_write'), '2 项 · 1 已完成')
  assert.equal(argSummary(JSON.stringify({ todos: [{ content: '甲', status: 'pending' }] }), 'todo_write'), '1 项')
  assert.equal(argSummary('{"todos":[]}', 'todo_write'), '{"todos":[]}', '空清单回落原始 JSON，不假装有摘要')
  assert.equal(argSummary('{\n  "path": "a\\nb.txt"\n}', 'read'), 'a b.txt', '摘要是一行，不留换行')
  assert.equal(argSummary('{"broken":'), '{"broken":')
  assert.equal(argSummary('[]'), '[]', '不是对象的 JSON 就原样')
  assert.equal(argSummary(''), '')
  assert.equal(argSummary(undefined), '')
  const long = argSummary(JSON.stringify({ description: 'z'.repeat(500) }), 'pwsh')
  assert.ok(long.length <= 201, '折叠行有个长度上限——原始参数在 args 里，不丢内容')
})

// ---------------------------------------------------------------------------
// 上限与合并
// ---------------------------------------------------------------------------

test('上限：从尾部留、整轮优先、新起的那一轮哪怕没条目也留着', () => {
  const mk = (turn, n) => ({
    turn,
    state: 'done',
    reason: 'completed',
    entries: Array.from({ length: n }, (_, i) => ({ id: `t${turn}-${i}` })),
  })
  const turns = [mk(1, 100), mk(2, 50), { turn: 3, state: 'running', reason: null, entries: [] }]

  const capped = capTrajectory(turns, 120)
  assert.equal(capped.dropped, 30, '砍掉的是条数：150 - 120')
  assert.deepEqual(capped.turns.map((g) => [g.turn, g.entries.length]), [
    [1, 70],   // 这一轮整个放不下，从尾部留 70 条
    [2, 50],
    [3, 0],    // 新一轮一条条目都没有，但必须还在（手机上那一组靠它立起来）
  ])

  assert.equal(capTrajectory(turns, 0).dropped, 150)
  // 额度是 0 也一样：空轮不占额度，所以它还在（真实上限从来不是 0，这只是把规则钉住）。
  assert.deepEqual(capTrajectory(turns, 0).turns.map((g) => g.turn), [3])
  assert.equal(capTrajectory(turns, 1000).turns.length, 3, '装得下就原样给')
})

test('合并：同一个事件在实时和重放两条路上必须算成同一条（否则一行变两行）', () => {
  const events = turnWithTool()
  const tracker = createTrajectoryTracker()
  const live = []
  const groupOf = (turn) => {
    let group = live.find((g) => g.turn === turn)
    if (!group) {
      group = { turn, state: 'running', reason: null, entries: [] }
      live.push(group)
    }
    return group
  }
  for (const event of events) {
    const change = tracker.feed('s1', event)
    if (!change) continue
    const group = groupOf(change.turn)
    for (const entry of change.entries) group.entries.push(entry)
    for (const patch of change.updates) {
      const hit = group.entries.find((e) => e.id === patch.id)
      if (hit) applyTrajectoryPatch(hit, patch)
    }
    if (change.state) {
      group.state = change.state
      group.reason = change.reason ?? null
    }
  }

  finalizeTrajectory(live)
  const replay = replayTrajectory(events)
  assert.deepEqual(live, replay, '实时那份和重放那份必须一模一样')

  const merged = mergeTrajectory(live, replay)
  assert.equal(merged.length, 1, '同一轮只许有一组')
  assert.deepEqual(merged[0].entries.map((e) => e.id), replay[0].entries.map((e) => e.id),
    '同一个 id 只许出现一次——这是「不重复」的全部依据')
})

test('合并：事件没带 seq 时也要有稳定身份（否则老日志重放出来会一行变两行）', () => {
  // 事件的 `seq` 是「同一条思考在两条路上算出同一个 id」的第一选择，但它不是永远都在：
  // 老格式的日志、别处造出来的事件都可能没有。那时退回「轮 + 步 + 块序号」，仍然稳定。
  const noSeq = (type, data) => ({ type, time: (clock += 1000), data })
  const events = turnWithTool().map((e) => noSeq(e.type, e.data))
  const first = replayTrajectory(events)
  const second = replayTrajectory(events)
  assert.deepEqual(first[0].entries.map((e) => e.id), second[0].entries.map((e) => e.id),
    '同一条思考两次重放必须算出同一个 id')
  assert.equal(first[0].entries[0].id, first[0].entries[0].id)
  const merged = mergeTrajectory(first, second)
  assert.equal(merged[0].entries.length, first[0].entries.length, '同一个事件不许算成两条')
})

test('合并：无 seq 时用户与上下文条目在同一轮内也不会撞号', () => {
  const noSeq = (type, data) => ({ type, time: (clock += 1000), data })
  const groups = replayTrajectory([
    noSeq('turn/start', { turn: 1 }),
    noSeq('user/message', { id: 'message-a', source: { kind: 'user' }, content: text('第一句') }),
    noSeq('request/context', { model: 'model-a' }),
    noSeq('user/message', { source: { kind: 'user' }, content: text('第二句') }),
    noSeq('request/context', { id: 'context-a', model: 'model-b' }),
    noSeq('request/context', { model: 'model-c' }),
  ])
  const ids = groups[0].entries.map((e) => e.id)
  assert.deepEqual(ids, ['u:id:message-a', 'c:auto:1:1', 'u:auto:1:1', 'c:id:context-a', 'c:auto:1:2'])
  assert.equal(new Set(ids).size, ids.length, '同一轮里每条用户与上下文条目的 id 都必须唯一')
})

test('合并：状态以内心里那份为准（它是亲眼看见的、更新的），条目按轮号排', () => {
  const replay = [
    { turn: 1, state: 'done', reason: 'completed', entries: [{ id: 'a', state: 'ok' }] },
    { turn: 2, state: 'running', reason: null, entries: [{ id: 'b', state: 'running' }] },
  ]
  const live = [
    { turn: 2, state: 'done', reason: 'completed', entries: [{ id: 'b', state: 'ok' }] },
    { turn: 3, state: 'running', reason: null, entries: [{ id: 'c', state: 'running' }] },
  ]
  const merged = mergeTrajectory(live, replay)
  assert.deepEqual(merged.map((g) => g.turn), [1, 2, 3])
  assert.equal(merged[1].state, 'done', '实时那份说这一轮跑完了')
  assert.deepEqual(merged[1].entries.map((e) => e.id), ['b'], 'b 只出现一次')
  assert.equal(merged[1].entries[0].state, 'ok')
})

test('合并：重放底稿还在跑时，实时补丁带回的结束与用量字段也要留下', () => {
  const replay = [{ turn: 1, state: 'running', reason: null, entries: [{ id: 'a', state: 'running' }] }]
  const live = [{
    turn: 1,
    state: 'running',
    reason: null,
    entries: [{ id: 'a', state: 'running', endedAt: 2000, ttft: 100, genMs: 900, tokens: 42 }],
  }]
  const entry = mergeTrajectory(live, replay)[0].entries[0]
  assert.equal(entry.endedAt, 2000)
  assert.equal(entry.ttft, 100)
  assert.equal(entry.genMs, 900)
  assert.equal(entry.tokens, 42)
})

test('合并：给出的是副本——往上贴补丁不能回头污染重放缓存', () => {
  const replay = [{ turn: 1, state: 'running', reason: null, entries: [{ id: 'a', state: 'running', output: null }] }]
  const merged = mergeTrajectory([], replay)
  merged[0].entries[0].state = 'ok'
  merged[0].entries[0].output = '改过了'
  assert.equal(replay[0].entries[0].state, 'running', '缓存里那份一个字都不该变')
  assert.equal(replay[0].entries[0].output, null)
})

test('补丁：只改补丁里真有的字段，截断信息是合并不是替换', () => {
  const entry = { id: 'a', state: 'running', output: null, error: null, truncated: { args: { chars: 1, total: 9 } } }
  applyTrajectoryPatch(entry, { id: 'a', state: 'stopped' })
  assert.deepEqual(entry, {
    id: 'a', state: 'stopped', output: null, error: null, truncated: { args: { chars: 1, total: 9 } },
  }, '「停了」那条补丁不该顺手把输出清空')

  applyTrajectoryPatch(entry, {
    id: 'a',
    state: 'error',
    output: '出错了',
    error: { name: null, code: null, reason: null },
    truncated: { output: { chars: 4, total: 9 } },
  })
  assert.equal(entry.output, '出错了')
  assert.deepEqual(entry.truncated, { args: { chars: 1, total: 9 }, output: { chars: 4, total: 9 } })
})

// ---------------------------------------------------------------------------
// 内存缓冲（store）
// ---------------------------------------------------------------------------

function tempStore() {
  return createStore({ file: join(mkdtempSync(join(tmpdir(), 'dsh-traj-')), 'state.json'), maxHistory: 50 })
}

test('完整轨迹：同会话并发只读一次，结果缓存只留一个会话', async () => {
  const store = tempStore()
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  store.setFullTrajectorySource(async () => {
    calls += 1
    await gate
    return { turns: [] }
  })
  const first = store.fullTrajectoryOf('s1')
  const second = store.fullTrajectoryOf('s1')
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls, 1, '同一会话的在途请求必须合并')
  assert.equal(a, b)

  await store.fullTrajectoryOf('s1')
  assert.equal(calls, 1, '已缓存的会话不再读')
  await store.fullTrajectoryOf('s2')
  assert.equal(calls, 2)
  await store.fullTrajectoryOf('s1')
  assert.equal(calls, 3, '切到另一个会话后，旧缓存已被替换')
})

test('缓冲：增量帧只带这一批的变化，seq 一次一格', () => {
  const store = tempStore()
  store.bind('s1')
  const tracker = createTrajectoryTracker()

  const frames = []
  for (const event of turnWithTool()) {
    const change = tracker.feed('s1', event)
    if (!change) continue
    const frame = store.applyTrajectory('s1', change)
    if (frame) frames.push(frame)
  }

  assert.deepEqual(frames.map((f) => [f.state, f.add.length, f.update.length]), [
    ['running', 0, 0],   // turn/start：新的一轮立起来
    [null, 1, 0],        // 用户那句话
    [null, 1, 0],        // 思考
    [null, 1, 0],        // 工具步（正在跑）
    [null, 0, 1],        // 结果回来，只补那一笔
    ['done', 0, 0],      // 收尾
  ])
  assert.deepEqual(frames.map((f) => f.seq), [1, 2, 3, 4, 5, 6], '帧序号一格一格走，客户端靠它认出漏帧')
  assert.equal(frames[4].update[0].state, 'ok')
  assert.equal(frames[4].update[0].id, frames[3].add[0].id, '补丁认的就是那条工具步的 id')
  assert.equal(frames[0].turn, 1)
})

test('缓冲：与轨迹无关的事件一口都不吃', () => {
  const tracker = createTrajectoryTracker()
  for (const type of ['step/start', 'step/end', 'request/header', 'session/title', 'assistant/message', 'user/message']) {
    assert.equal(tracker.feed('s1', ev(type, {})), null, `${type} 不该产出条目`)
  }
  const store = tempStore()
  assert.equal(store.applyTrajectory('s1', null), null)
  assert.equal(store.applyTrajectory('s1', { turn: 1, entries: [], updates: [], state: null }), null)
  assert.equal(store.applyTrajectory('', { turn: 1, entries: [], updates: [], state: 'running' }), null)
})

test('缓冲：上限 120 条从尾部留，被砍掉的条数如实记着', () => {
  const store = tempStore()
  store.bind('s1')
  for (let i = 0; i < 150; i += 1) {
    store.applyTrajectory('s1', {
      turn: 1,
      entries: [{
        id: 'e' + i, turn: 1, step: 1, kind: 'tool', name: 'x', args: null, summary: null,
        output: null, state: 'ok', error: null, truncated: null, timestamp: 1,
      }],
      updates: [],
      state: i === 0 ? 'running' : null,
    })
  }
  const view = store.trajectoryOf('s1')
  const ids = view.turns.flatMap((g) => g.entries.map((e) => e.id))
  assert.equal(ids.length, TRAJECTORY_MAX_ENTRIES)
  assert.equal(ids[0], 'e30', '最早的那 30 条先走')
  assert.equal(ids.at(-1), 'e149')
  assert.equal(view.truncated, true)
  assert.match(view.note, /轨迹只显示最近一段/)
  // 视图那份截断是给人看的，**内存里那份才是真占地方**：缓冲本身也得收着。
  assert.equal(store.state.trajectoryBySession.s1.entries.length, TRAJECTORY_MAX_ENTRIES)
  assert.equal(store.state.trajectoryBySession.s1.dropped, 30, '被砍掉多少条要如实记着')
})

test('缓冲：没亲眼看见 tool/call 的那种补丁，等重放那份来了再认领', () => {
  // 插件中途起来时就是这个情形：那一次调用的 tool/call 在日志里，结果却被实时看见了。
  // 直接丢掉的话，手机上那一行会一直停在「正在跑」。
  const store = tempStore()
  store.bind('s1')
  store.setReplaySource(() => ({
    entries: null,
    latest: null,
    pending: false,
    trajectory: [{
      turn: 4,
      state: 'running',
      reason: null,
      entries: [{
        id: 'c9', turn: 4, step: 1, kind: 'tool', name: 'bash', args: '{}', summary: 'x',
        output: null, state: 'running', error: null, truncated: null, timestamp: 1,
      }],
    }],
    trajectoryDropped: 0,
  }))
  store.applyTrajectory('s1', { turn: 4, entries: [], updates: [{ id: 'c9', state: 'ok', output: '回来了', error: null }], state: null })

  const view = store.trajectoryOf('s1')
  assert.equal(view.turns[0].entries[0].state, 'ok')
  assert.equal(view.turns[0].entries[0].output, '回来了')
  assert.equal(view.turns[0].entries[0].name, 'bash', '重放那份给的字段一个都没丢')
})

test('缓冲：视图把内存那份和重放那份合成一张表，读取中如实说 loading', () => {
  const store = tempStore()
  store.bind('s1')
  store.setReplaySource(() => ({ entries: null, latest: null, pending: true }))
  // 还没读过任何会话记录、内存里也什么都没有：说「正在读」，不说「没有过程」
  assert.equal(store.trajectoryOf('s1').loading, true)
  assert.deepEqual(store.trajectoryOf('s1').turns, [])

  store.applyTrajectory('s1', {
    turn: 1,
    entries: [{ id: 'a', turn: 1, step: 1, kind: 'think', output: '想了' }],
    updates: [],
    state: 'running',
  })
  store.setReplaySource(() => ({
    entries: null,
    latest: null,
    pending: false,
    trajectory: [{
      turn: 1,
      state: 'done',
      reason: 'completed',
      entries: [{ id: 'a', turn: 1, step: 1, kind: 'think', output: '想了' }],
    }],
    trajectoryDropped: 0,
  }))
  const view = store.trajectoryOf('s1')
  assert.equal(view.loading, false)
  assert.equal(view.turns.length, 1, '同一轮只算一组')
  assert.equal(view.turns[0].entries.length, 1, '同一条思考不许算两遍')
  assert.equal(view.turns[0].state, 'done',
    '重放那份说这一轮已经完了，就不许内存那份的「正在跑」把它改回去——正在跑不是结论，是还不知道')

  // 反过来才对：内存那份说完了（它是后发生的），重放那份还停在「正在跑」→ 以内存那份为准。
  store.setReplaySource(() => ({
    entries: null,
    latest: null,
    pending: false,
    trajectory: [{
      turn: 1,
      state: 'running',
      reason: null,
      entries: [{ id: 'a', turn: 1, step: 1, kind: 'think', output: '想了' }],
    }],
    trajectoryDropped: 0,
  }))
  store.applyTrajectory('s1', { turn: 1, entries: [], updates: [], state: 'done' })
  assert.equal(store.trajectoryOf('s1').turns[0].state, 'done')
})

test('缓冲：轨迹不落盘（体积是回答正文的 90.7 倍，落盘那份每 500 毫秒重写整份）', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-traj-disk-')), 'state.json')
  const store = createStore({ file, maxHistory: 50 })
  store.bind('s1')
  store.pushReply({ text: '一条回答', sessionId: 's1', reason: 'completed' })
  store.applyTrajectory('s1', {
    turn: 1,
    entries: [{ id: 'a', turn: 1, step: 1, kind: 'think', output: '轨迹里的那句话不该落盘' }],
    updates: [],
    state: 'running',
  })
  // 落盘是 500 毫秒合并一次的（见 persist）。
  await new Promise((r) => setTimeout(r, 700))

  const disk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(disk.historyBySession.s1.length, 1, '聊天记录照旧落盘')
  assert.equal(disk.trajectoryBySession, undefined)
  assert.ok(!readFileSync(file, 'utf8').includes('轨迹里的那句话'), '轨迹一个字都不该进盘上那份')
})

test('附件：不透明的 id 与整份引用都留着（手机点得开原件）', () => {
  const imgRef = {
    attachmentId: 'sha256:abc123', mediaType: 'image/png',
    bytes: 4321, width: 120, height: 80, name: '截图.png',
  }
  const fileRef = { attachmentId: 'sha256:def456', bytes: 99, name: 'notes.txt' }
  const groups = replayTrajectory([
    ev('turn/start', { turn: 1 }),
    ev('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: 'reasoning', text: '看一眼这两份' },
          { type: 'image', attachment: imgRef },
          { type: 'file', attachment: fileRef },
        ],
      },
    }),
  ])
  const att = groups[0].entries[0].attachments
  assert.equal(att.length, 2, '图片与文件各留一条')
  assert.equal(att[0].kind, 'image')
  assert.equal(att[0].id, 'sha256:abc123', '手机只认这个不透明 id')
  assert.equal(att[0].ref.attachmentId, 'sha256:abc123', '整份引用要留着，服务端读取时要核对尺寸')
  assert.equal(att[0].name, '截图.png')
  assert.equal(att[1].kind, 'file')
  assert.equal(att[1].id, 'sha256:def456')
  assert.equal(att[1].ref.bytes, 99)
})

test('附件：用户只传文件、一个字不写，也要留一条记录', () => {
  const ref = { attachmentId: 'sha256:u1', bytes: 2048, name: '手机拍的.png' }
  const groups = replayTrajectory([
    ev('turn/start', { turn: 1 }),
    ev('user/message', {
      turn: 1, id: 'm1', source: { kind: 'user' },
      content: [{ type: 'image', attachment: ref }],
    }),
  ])
  const e = groups[0].entries[0]
  assert.equal(e.kind, 'user', '以前这种消息整条被丢掉，现在要留一行')
  assert.equal(e.output, '', '没有文字就是没有')
  assert.match(e.summary, /手机拍的\.png/, '摘要用附件名，列表上才认得出')
  assert.equal(e.attachments[0].id, 'sha256:u1')
})

test('附件：用户发了文字又带文件，两样都在', () => {
  const ref = { attachmentId: 'sha256:u2', bytes: 10, name: 'a.txt' }
  const groups = replayTrajectory([
    ev('turn/start', { turn: 1 }),
    ev('user/message', {
      turn: 1, id: 'm2', source: { kind: 'user' },
      content: [{ type: 'text', text: '你看这个' }, { type: 'file', attachment: ref }],
    }),
  ])
  const e = groups[0].entries[0]
  assert.equal(e.output, '你看这个')
  assert.equal(e.summary, '你看这个')
  assert.equal(e.attachments.length, 1)
  assert.equal(e.attachments[0].kind, 'file')
})

test('子工具：PTC 派发记下父子与结果，别当顶层工具行', () => {
  const groups = replayTrajectory([
    ev('turn/start', { turn: 1 }),
    ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'run_code', arguments: '{}' }),
    ev('tool/ptc-dispatch-start', {
      turn: 1, step: 1, parentCallId: 'c1', subCallId: 's1', name: 'read', arguments: { path: 'a.txt' },
    }),
    ev('tool/ptc-dispatch', {
      turn: 1, step: 1, parentCallId: 'c1', subCallId: 's1', name: 'read',
      content: [{ type: 'text', text: '读到了甲' }], isError: false,
    }),
    ev('tool/result', {
      turn: 1, step: 1,
      message: { role: 'tool', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'done' }] },
    }),
  ])
  const es = groups[0].entries
  const sub = es.find((e) => e.kind === 'subtool')
  assert.ok(sub, 'run_code 派发的子工具要留一条')
  assert.equal(sub.parentCallId, 'c1', '父子关系是手机缩进的唯一依据')
  assert.equal(sub.state, 'ok', '结果回来要落定，别一直转')
  assert.equal(sub.output, '读到了甲')
  assert.equal(es.filter((e) => e.kind === 'tool').length, 1, '父工具仍是一条，不重复')
})
