import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/b-agent-schedule.js'

function harness() {
  const defs = new Map()
  const calls = []
  const schedule = {
    create: async (sessionId, request) => {
      calls.push({ op: 'create', sessionId, request })
      return { id: 's1', kind: 'after', title: request.title, prompt: request.prompt, afterSeconds: request.after_seconds, scheduledAt: '2026-10-23T00:00:10Z' }
    },
    list: async (request) => {
      calls.push({ op: 'list', request })
      return [{ id: 's1', kind: 'after', title: '旧标题', scheduledAt: '2026-10-23T00:00:10Z' }]
    },
    delete: async (request) => {
      calls.push({ op: 'delete', request })
      return { id: request.id, deleted: true }
    },
    update: async (request) => {
      calls.push({ op: 'update', request })
      return { id: request.id, updated: true, record: { id: request.id, kind: 'after', title: request.title || '旧标题' } }
    },
  }
  const ctx = {
    tools: { register: (d) => { defs.set(d.name, d) } },
    inject: (names, cb) => {
      if (names.includes('schedule')) cb({ ...ctx, schedule })
    },
  }
  return { ctx, defs, calls, schedule }
}

test('B 预设日程工具：注册 create/list/delete/update 四个工具', () => {
  const h = harness()
  apply(h.ctx)
  assert.deepEqual([...h.defs.keys()].sort(), ['schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update'])
})

test('日程工具把提醒绑到当前会话，并走宿主 schedule 服务', async () => {
  const h = harness()
  apply(h.ctx)
  const exec = { agent: { id: 'sess-1' }, signal: null }
  const created = await h.defs.get('schedule_create').execute({ title: '测试提醒', prompt: '到点了', after_seconds: 10 }, exec)
  assert.match(created, /s1/)
  assert.deepEqual(h.calls[0], {
    op: 'create', sessionId: 'sess-1',
    request: { title: '测试提醒', prompt: '到点了', after_seconds: 10 },
  })

  const list = await h.defs.get('schedule_list').execute({}, exec)
  assert.match(list, /旧标题/)
  assert.equal(h.calls[1].request.sessionId, 'sess-1')

  const deleted = await h.defs.get('schedule_delete').execute({ id: 's1' }, exec)
  assert.match(deleted, /deleted/)
  assert.deepEqual(h.calls[2].request, { sessionId: 'sess-1', id: 's1' })

  const updated = await h.defs.get('schedule_update').execute({ id: 's1', title: '新标题', after_seconds: 20 }, exec)
  assert.match(updated, /updated/)
  assert.equal(h.calls[4].request.sessionId, 'sess-1')
  assert.equal(h.calls[4].request.expected.id, 's1')
  assert.equal(h.calls[4].request.title, '新标题')
  assert.deepEqual(h.calls[4].request.change, { kind: 'after', after_seconds: 20 })
})
