/**
 * 斜杠指令那一套纯逻辑的离线用例。
 *
 * 这一层测的是「**判断**」，不是「接线」：哪一行算指令、名字怎么切、一次执行怎么
 * 从「开始」走到「结束」。接线（HTTP 接口、事件订阅）在 plugin.test.mjs 里测。
 *
 * 判据为什么要钉得这么死：这些判断全都**照抄 DSH 自己的语义**（见 lib/commands.js
 * 开头）。抄错一个字符，手机和电脑就会对「这行算不算指令」给出不同答案——比如
 * `/Model` 在电脑上不是指令，如果手机把它当指令执行，用户看到的是一条莫名其妙的
 * 报错；反过来，一条真指令被当成普通消息发给模型，就会白跑一轮。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSlashLine, describeCommands, commandRow, commandPatch, foldCommandEvent,
  invalidCommandMessage, unknownCommandMessage,
} from '../lib/commands.js'

test('拆指令行：名字和后面那段原样切开，分隔的那个空格不吞', () => {
  assert.deepEqual(parseSlashLine('/compact'), { name: 'compact', rawInput: '' })
  // 前导空格真的留着——DSH 的契约就是这样，指令自己 trim。
  assert.deepEqual(parseSlashLine('/goal clear'), { name: 'goal', rawInput: ' clear' })
  assert.deepEqual(parseSlashLine('/permission danger-full-access'), {
    name: 'permission', rawInput: ' danger-full-access',
  })
  // 换行、制表符都算分隔
  assert.deepEqual(parseSlashLine('/compact\n'), { name: 'compact', rawInput: '\n' })
  assert.deepEqual(parseSlashLine('/compact\t参数'), { name: 'compact', rawInput: '\t参数' })
})

test('拆指令行：不是指令形状的一律不给名字', () => {
  // 斜杠必须在第 0 个字节
  assert.equal(parseSlashLine('你好 /compact'), null)
  // 名字必须以**小写字母**打头（`/9x`、`/_x`、`/Model` 在 DSH 里都不是指令）
  assert.equal(parseSlashLine('/9x'), null)
  assert.equal(parseSlashLine('/_x'), null)
  assert.equal(parseSlashLine('/Model'), null)
  assert.equal(parseSlashLine('/'), null)
  assert.equal(parseSlashLine(''), null)
  assert.equal(parseSlashLine(undefined), null)
  assert.equal(parseSlashLine(null), null)
  // 名字后面只允许「结束或空白」：`/compact-中文` 里的 `-` 是名字的一部分，
  // 而中文字符不合法——这一条钉住"名字字符集"别被放宽。
  assert.equal(parseSlashLine('/compact-中文'), null)
})

test('拆指令行：名字写长了照样拆得出来，认不认识是账本的事', () => {
  // `/compactx` 在 DSH 那边也拆得出名字（`compactx`），然后因为账本里没有而被拒。
  // 拆行和"认不认识"是两件事，别混成一处判断。
  assert.deepEqual(parseSlashLine('/compactx'), { name: 'compactx', rawInput: '' })
})

test('指令名单：按名字排序，只搬手机要用的字段', () => {
  const rows = describeCommands([
    { name: 'goal', description: 'Set a goal', input: { hint: 'what to achieve', attachments: true } },
    { name: 'compact', description: 'Compact the context' },
  ])
  assert.deepEqual(rows.map((r) => r.name), ['compact', 'goal'])
  assert.equal(rows[0].description, 'Compact the context')
  assert.equal(rows[0].hint, null, '没有 input 时 hint 是 null，不是空字符串')
  assert.equal(rows[0].attachments, false)
  assert.equal(rows[1].hint, 'what to achieve')
  assert.equal(rows[1].attachments, true, '收不收附件要如实带给手机')
})

test('指令名单：脏数据不许把整份列表带崩', () => {
  const rows = describeCommands([
    null, 'x', 42, { description: '没名字' }, { name: '' }, { name: 'ok' },
    { name: 'ok2', input: { hint: '' }, description: null },
  ])
  assert.deepEqual(rows.map((r) => r.name), ['ok', 'ok2'])
  assert.equal(rows[1].description, '')
  assert.equal(rows[1].hint, null, '空 hint 当没有，别让界面显示一个空提示')
  assert.deepEqual(describeCommands(undefined), [])
  assert.deepEqual(describeCommands('不是数组'), [])
})

test('指令行：开始那条用事件自己的时间，缺字段的不硬造', () => {
  const row = commandRow({
    type: 'command/run', time: 1_700_000_000_123,
    data: { commandId: 'c1', name: 'goal', args: ' clear' },
  })
  assert.deepEqual(row, {
    role: 'command', commandId: 'c1', name: 'goal', args: ' clear',
    kind: 'running', text: null, timestamp: 1_700_000_000_123,
  })
  // args 缺了就是空串，不是 undefined——界面上要拼出「/名字 + args」这一行
  assert.equal(commandRow({ data: { commandId: 'c1', name: 'goal' } }).args, '')
  assert.equal(commandRow({ data: { commandId: 'c1', name: 'goal' } }).timestamp, null)
  // 少了 commandId 就没法和收尾那条配对，宁可不要这一条
  assert.equal(commandRow({ data: { name: 'goal' } }), null)
  assert.equal(commandRow({ data: { commandId: 'c1' } }), null)
  assert.equal(commandRow({}), null)
})

test('指令行：收尾那条把成功失败和原文带出来', () => {
  assert.deepEqual(commandPatch({ data: { commandId: 'c1', kind: 'success', text: '压好了' } }),
    { commandId: 'c1', kind: 'success', text: '压好了' })
  assert.deepEqual(commandPatch({ data: { commandId: 'c1', kind: 'error', text: '炸了' } }),
    { commandId: 'c1', kind: 'error', text: '炸了' })
  // 成功但没话说的指令（比如 /plan 切了模式）——text 是 null，界面自己写「完成」
  assert.deepEqual(commandPatch({ data: { commandId: 'c1', kind: 'success' } }),
    { commandId: 'c1', kind: 'success', text: null })
  assert.equal(commandPatch({ data: { kind: 'success' } }), null)
  assert.equal(commandPatch({}), null)
})

test('折叠：开始 + 收尾是同一条记录，靠 commandId 配对', () => {
  const rows = []
  assert.equal(foldCommandEvent(rows, {
    type: 'command/run', time: 100, data: { commandId: 'c1', name: 'compact' },
  }), true)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'running')

  assert.equal(foldCommandEvent(rows, {
    type: 'command/done', time: 200, data: { commandId: 'c1', kind: 'success', text: '压好了' },
  }), true)
  assert.equal(rows.length, 1, '收尾是改那一条，不是再加一条')
  assert.equal(rows[0].kind, 'success')
  assert.equal(rows[0].text, '压好了')
  assert.equal(rows[0].name, 'compact', '名字是开始那条带来的，收尾事件里没有名字')
})

test('折叠：同时跑两条同名指令也不会串行', () => {
  const rows = []
  foldCommandEvent(rows, { type: 'command/run', time: 1, data: { commandId: 'a', name: 'goal' } })
  foldCommandEvent(rows, { type: 'command/run', time: 2, data: { commandId: 'b', name: 'goal' } })
  foldCommandEvent(rows, { type: 'command/done', time: 3, data: { commandId: 'b', kind: 'error', text: '第二个炸了' } })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].kind, 'running', '按名字配对就会改错行——必须认 commandId')
  assert.equal(rows[1].kind, 'error')
  assert.equal(rows[1].text, '第二个炸了')
})

test('折叠：只看见收尾、没看见开始，也要留一条', () => {
  // 真实场景：插件的尾部读窗口从中间截断了，或者插件是中途起来的。
  // 用户会看到「/compact 失败了」——但要是把那一条丢了，他连"有过这么一回事"都不知道。
  const rows = []
  assert.equal(foldCommandEvent(rows, {
    type: 'command/done', time: 300, data: { commandId: 'c9', kind: 'error', text: '炸了' },
  }), true)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].role, 'command')
  assert.equal(rows[0].name, '', '名字确实不知道，就留空，别编')
  assert.equal(rows[0].kind, 'error')
  assert.equal(rows[0].timestamp, 300)
})

test('折叠：不是指令事件就原样放行（返回 false，不许动记录）', () => {
  const rows = []
  for (const type of ['user/message', 'assistant/message', 'turn/start', 'turn/end', 'request/header']) {
    assert.equal(foldCommandEvent(rows, { type, time: 1, data: {} }), false)
  }
  assert.equal(foldCommandEvent(rows, undefined), false)
  assert.equal(rows.length, 0)
})

test('不认识的指令：说清是哪一条，专有的两条指向手机上该去哪儿', () => {
  assert.equal(unknownCommandMessage('xyz'), '没有 /xyz 这条指令。')
  // `/model`、`/file` 是浏览器端自己的贡献，宿主账本里根本没有它们。
  // 只回一句「没有这条指令」会让用户以为是自己打错了——而电脑上明明有。
  assert.match(unknownCommandMessage('model'), /电脑网页端/)
  assert.match(unknownCommandMessage('model'), /顶栏/)
  assert.match(unknownCommandMessage('file'), /电脑网页端/)
  assert.match(unknownCommandMessage('file'), /回形针/)
})

test('不是指令形状：提示语法，而不是说「没这条指令」', () => {
  const msg = invalidCommandMessage()
  assert.match(msg, /小写字母/)
  assert.doesNotMatch(msg, /没有/)
})
