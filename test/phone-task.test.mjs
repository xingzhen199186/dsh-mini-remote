import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createPhoneTaskTracker } from '../lib/phone-task.js'

function tracker() {
  return createPhoneTaskTracker({ processId: () => 'proc-A' })
}

const rootEvent = (sessionId, turn) => ({ type: 'turn/start', data: { turn } })

test('任务编号：进程代次 + 根会话 + 本轮编号', () => {
  const t = tracker()
  t.track({ id: 'root-1', header: { origin: 'user' } }, rootEvent('root-1', 7))
  assert.equal(t.taskIdOf({ session: { id: 'root-1', header: { origin: 'user' } } }), 'proc-A:root-1:7')
})

test('任务编号：子代理继承根任务编号，不会用自己的轮次覆盖', () => {
  const t = tracker()
  t.track({ id: 'root-1', header: { origin: 'user' } }, rootEvent('root-1', 7))
  // 子代理被派出去，它的 turn/start 是 1——若写回根轮次，根任务就成了第 1 轮。
  t.track({ id: 'child-1', header: { origin: 'subagent', parentSession: 'root-1' } }, rootEvent('child-1', 1))
  const child = { session: { id: 'child-1', header: { origin: 'subagent', parentSession: 'root-1' } } }
  assert.equal(t.taskIdOf(child), 'proc-A:root-1:7')
  // 根会话自己后面的调用也不能被改写成第 1 轮。
  assert.equal(t.taskIdOf({ session: { id: 'root-1', header: { origin: 'user' } } }), 'proc-A:root-1:7')
})

test('任务编号：下一轮换了编号，上一轮的调用不再沿用', () => {
  const t = tracker()
  t.track({ id: 'root-1', header: { origin: 'user' } }, rootEvent('root-1', 7))
  t.track({ id: 'root-1', header: { origin: 'user' } }, rootEvent('root-1', 8))
  assert.equal(t.taskIdOf({ session: { id: 'root-1', header: { origin: 'user' } } }), 'proc-A:root-1:8')
})

test('任务编号：还没见到轮次时返回空串，由手机按单次询问处理', () => {
  const t = tracker()
  assert.equal(t.taskIdOf({ session: { id: 'root-1', header: { origin: 'user' } } }), '')
  const child = { session: { id: 'orphan', header: { origin: 'subagent', parentSession: 'root-1' } } }
  assert.equal(t.taskIdOf(child), '')
})
