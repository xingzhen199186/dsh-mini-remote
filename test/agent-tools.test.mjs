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
      return { path: 'C:\\work\\a.txt', content: '甲', offset: 1, totalLines: 1, truncated: false }
    },
  }
  return { ctx, hub, defs, calls }
}

test('B 端工具只注册 b_ 前缀的新工具，不碰本地 read/list', async () => {
  const h = harness()
  await registerAgentTools(h.ctx, { hub: h.hub, defineTool: (d) => d })
  assert.deepEqual([...h.defs.keys()].sort(), ['b_list', 'b_read', 'b_write'])
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
})
