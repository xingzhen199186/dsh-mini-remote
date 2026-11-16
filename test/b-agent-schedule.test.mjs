import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/b-agent-schedule.js'

function harness() {
  const defs = new Map()
  const calls = []
  const record = {
    id: 's1', kind: 'rrule', title: '旧标题', prompt: '旧指令',
    rrule: 'DTSTART;TZID=Asia/Shanghai:20261013T090000\nRRULE:FREQ=DAILY',
    scheduledAt: '2026-10-23T00:00:10Z', updatedAt: '2026-10-22T00:00:00Z',
  }
  const schedule = {
    create: async (request, actorSessionId, signal) => {
      calls.push({ op: 'create', request, actorSessionId, signal })
      return { ...record, ...request, id: 's1' }
    },
    list: async (request) => {
      calls.push({ op: 'list', request })
      return { items: [record], shown: 1, total: 1, limit: 100, offset: 0 }
    },
    view: async (request) => {
      calls.push({ op: 'view', request })
      return record
    },
    edit: async (request, actorSessionId, signal) => {
      calls.push({ op: 'edit', request, actorSessionId, signal })
      return request.action === 'delete'
        ? { id: request.id, deleted: true }
        : { ...record, ...request.patch }
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

const exec = { agent: { id: 'sess-1' }, signal: null }
const RRULE = 'DTSTART;TZID=Asia/Shanghai:20261013T090000\nRRULE:FREQ=DAILY'

test('B 预设日程工具：注册 create/list/view/edit 四个工具', () => {
  const h = harness()
  apply(h.ctx)
  assert.deepEqual([...h.defs.keys()].sort(), ['schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view'])
})

test('创建使用 RRULE + 目标，并按新版参数顺序传当前会话', async () => {
  const h = harness()
  apply(h.ctx)
  const created = await h.defs.get('schedule_create').execute({
    title: '测试提醒', prompt: '到点了', rrule: RRULE, target: 'this_session',
  }, exec)
  assert.match(created, /s1/)
  assert.deepEqual(h.calls[0], {
    op: 'create',
    request: {
      title: '测试提醒', prompt: '到点了',
      timing: { kind: 'rrule', rrule: RRULE },
      target: { kind: 'session', sessionId: 'sess-1' },
    },
    actorSessionId: 'sess-1', signal: null,
  })
})

test('列表保留分页对象，读取按 id 调用 view', async () => {
  const h = harness()
  apply(h.ctx)
  const list = await h.defs.get('schedule_list').execute({ active: true, limit: 20, offset: 0 }, exec)
  const parsed = JSON.parse(list)
  assert.equal(parsed.items[0].title, '旧标题')
  assert.equal(parsed.total, 1)
  assert.deepEqual(h.calls[0], { op: 'list', request: { active: true, limit: 20, offset: 0 } })

  const viewed = await h.defs.get('schedule_view').execute({ id: 's1' }, exec)
  assert.match(viewed, /旧标题/)
  assert.deepEqual(h.calls[1], { op: 'view', request: { id: 's1' } })
})

test('修改和删除都走 edit，并保留修订号与当前会话', async () => {
  const h = harness()
  apply(h.ctx)
  const updated = await h.defs.get('schedule_edit').execute({
    id: 's1', action: 'update', title: '新标题', rrule: RRULE,
    target: 'new_once', active: false, expectedUpdatedAt: '2026-10-22T00:00:00Z',
  }, exec)
  assert.match(updated, /新标题/)
  assert.deepEqual(h.calls[0], {
    op: 'edit',
    request: {
      id: 's1', action: 'update',
      patch: {
        title: '新标题', timing: { kind: 'rrule', rrule: RRULE },
        target: { kind: 'new_once' }, active: false,
      },
      expectedUpdatedAt: '2026-10-22T00:00:00Z',
    },
    actorSessionId: 'sess-1', signal: null,
  })

  const deleted = await h.defs.get('schedule_edit').execute({ id: 's1', action: 'delete' }, exec)
  assert.match(deleted, /deleted/)
  assert.deepEqual(h.calls[1].request, { id: 's1', action: 'delete' })
  assert.equal(h.calls[1].actorSessionId, 'sess-1')
})
