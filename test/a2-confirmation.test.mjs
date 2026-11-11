import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createBridge } from '../lib/bridge.js'

const DEVICE = 'dev-a2'
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('A2：默认档保留原调用时限，只附带任务编号', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1, confirmExtended: false })
  bridge.setArmed(DEVICE, true)
  const waiting = bridge.call(DEVICE, 'phone_tap', { index: 1 }, 15_000, { taskId: 'proc:root:3' })
  const taken = await bridge.poll(DEVICE, { waitMs: 0 })
  assert.equal(taken.calls[0].taskId, 'proc:root:3')
  assert.equal(taken.calls[0].expiresAt, 15_000)
  bridge.settle(DEVICE, taken.calls[0].id, { ok: true, result: 'ok' })
  assert.equal(await waiting, 'ok')
  bridge.close()
})

test('A2：非默认档才延长到 45 秒，状态工具不受影响', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1, confirmExtended: true })
  bridge.setArmed(DEVICE, true)
  const tap = bridge.call(DEVICE, 'phone_tap', {}, 15_000, { taskId: 'proc:root:4' })
  const taken = await bridge.poll(DEVICE, { waitMs: 0 })
  assert.equal(taken.calls[0].expiresAt, 130_000)
  bridge.settle(DEVICE, taken.calls[0].id, { ok: true, result: 'ok' })
  await tap

  const status = bridge.call(DEVICE, 'phone_status', {}, 10_000, { taskId: 'proc:root:4' })
  const statusTaken = await bridge.poll(DEVICE, { waitMs: 0 })
  assert.equal(statusTaken.calls[0].expiresAt, 10_000)
  bridge.settle(DEVICE, statusTaken.calls[0].id, { ok: true, result: 'ok' })
  await status
  bridge.close()
})

test('A2：电脑进程代次不同，旧任务编号不能复用', () => {
  const first = createBridge()
  const second = createBridge()
  assert.notEqual(first.processId(), second.processId())
  first.close()
  second.close()
})

test('A2：确认超时保留 confirm_timeout 与 executed=false', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1 })
  bridge.setArmed(DEVICE, true)
  const waiting = bridge.call(DEVICE, 'phone_open', {}, 130_000, { taskId: 'proc:root:5' })
  const taken = await bridge.poll(DEVICE, { waitMs: 0 })
  bridge.settle(DEVICE, taken.calls[0].id, {
    ok: false,
    result: { ok: false, executed: false, reason: 'confirm_timeout', error: '90 秒内未确认，动作未执行' },
  })
  await assert.rejects(waiting, (err) => {
    assert.equal(err.reason, 'confirm_timeout')
    assert.equal(err.executed, false)
    assert.match(err.message, /90 秒内未确认/)
    return true
  })
  bridge.close()
})

test('A2：非默认档的等待计时器与过期时间同一个上限', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1, confirmExtended: true })
  bridge.setArmed(DEVICE, true)
  const waiting = bridge.call(DEVICE, 'phone_open', {}, 15_000)
  const taken = await bridge.poll(DEVICE, { waitMs: 0 })
  const call = taken.calls[0]
  // 130 秒到期的调用，承诺必须也等到 130 秒；否则第 91 秒的结果送不回来。
  assert.equal(call.expiresAt, 130_000)
  bridge.settle(DEVICE, call.id, { ok: true, result: 'ok' })
  assert.equal(await waiting, 'ok')
  bridge.close()
})

test('A2：默认档不建待确认卡，不起计时器', () => {
  const control = read('android/app/src/main/java/com/dsh/miniremote/ConfirmationControl.java')
  assert.match(control, /if \(ConfirmationState\.OFF\.equals\(selected\) && !state\.needsExtendedDeadline\(selected\)\)/)
  assert.match(control, /if \(mode == ConfirmationState\.OFF\) return allow\(\)/)
  assert.match(control, /if \(pending == null\)/)
  assert.match(control, /CONFIRM_MS = 90_000L/)
  assert.match(control, /private static final ConfirmationState state/)
})

test('A2：任务档只记住当前 taskId，下一轮重新问', () => {
  const state = read('android/app/src/main/java/com/dsh/miniremote/ConfirmationState.java')
  assert.match(state, /if \(!taskId\.equals\(activeTaskId\)\)/)
  assert.match(state, /taskGranted = false/)
  assert.match(state, /if \(taskId == null \|\| taskId\.isEmpty\(\)\)/)
  assert.match(state, /return selected/)
})

test('A2：同一时刻一张卡，撤权唤醒并终止等待', () => {
  const control = read('android/app/src/main/java/com/dsh/miniremote/ConfirmationControl.java')
  assert.match(control, /awaitSlot\(occupied, deadline\)/)
  assert.match(control, /static void cancelPending\(\)/)
  assert.match(control, /epoch\+\+/)
  assert.match(control, /state\.clear\(\)/)
})

test('A2：复用现有轮询与结果回投，没有新增确认网络路由', () => {
  const server = read('lib/server.js')
  const poller = read('android/app/src/main/java/com/dsh/miniremote/BridgePoller.java')
  assert.doesNotMatch(server, /\/mini\/api\/bridge\/confirm/)
  assert.match(server, /confirmExtended: url\.searchParams\.get\('confirm'\) === '1'/)
  assert.match(poller, /&confirm=/)
  assert.match(poller, /reportRaw\(id, false, confirmationFailure\(decision\)\)/)
})
