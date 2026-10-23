import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerAgentTools } from '../lib/agent-tools.js'

function harness() {
  const defs = new Map()
  const calls = []
  const ctx = { tools: { register: (def) => { defs.set(def.name, def) } } }
  const hub = {
    call: async (op, args, opts) => {
      calls.push({ op, args, opts })
      if (op === 'list') return { path: 'C:\\work', entries: [{ name: 'a.txt', type: 'file', size: 3 }], truncated: false }
      if (op === 'write') return { path: 'C:\\work\\a.txt', bytes: 3 }
      if (op === 'shell') return { stdout: '甲\n', stderr: '', code: 0, cwd: 'C:\\work' }
      return { path: 'C:\\work\\a.txt', content: '甲', offset: 1, totalLines: 1, truncated: false }
    },
  }
  return { ctx, hub, defs, calls }
}

test('B 端工具只注册 b_ 前缀的新工具，不碰本地 read/list', async () => {
  const h = harness()
  await registerAgentTools(h.ctx, { hub: h.hub, defineTool: (d) => d })
  assert.deepEqual([...h.defs.keys()].sort(), ['b_list', 'b_read', 'b_shell', 'b_write'])
  assert.equal(h.defs.has('read'), false)
  assert.equal(h.defs.has('list'), false)
})

test('b_list / b_read 通过 hub 转给 B，并把结果整理成模型可读文本', async () => {
  const h = harness()
  await registerAgentTools(h.ctx, { hub: h.hub, defineTool: (d) => d })
  const list = await h.defs.get('b_list').execute({ path: '.' }, { signal: null })
  assert.match(list, /C:\\work/)
  assert.match(list, /a\.txt/)
  assert.equal(h.calls[0].op, 'list')
  assert.equal(h.calls[0].args.path, '.')

  const read = await h.defs.get('b_read').execute({ path: 'a.txt', offset: 1 }, { signal: null })
  assert.match(read, /第 1 行起/)
  assert.match(read, /甲/)
  assert.equal(h.calls[1].op, 'read')

  const wrote = await h.defs.get('b_write').execute({ path: 'a.txt', content: '甲乙' }, { signal: null })
  assert.match(wrote, /已写入/)
  assert.equal(h.calls[2].op, 'write')

  const shell = await h.defs.get('b_shell').execute({ command: 'echo 甲' }, { signal: null })
  assert.match(shell, /退出码：0/)
  assert.match(shell, /甲/)
  assert.equal(h.calls[3].op, 'shell')
})

test('真实的 @deepseek-ai/dsh-tools 能加载并注册四个工具', async () => {
  // 这一条专门防「软链插件按真实路径解析、仓库里没有 dsh-tools」那个坑：
  // 桩对象能过，真实 defineTool 过不了，上一版就是被桩测漏掉的。
  const defs = []
  const ctx = { tools: { register: (d) => { defs.push(d); return () => {} } } }
  await registerAgentTools(ctx, { hub: { call: async () => ({}) }, log: console })
  assert.deepEqual(defs.map((d) => d.name).sort(), ['b_list', 'b_read', 'b_shell', 'b_write'])
})
