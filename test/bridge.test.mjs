import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBridge } from '../lib/bridge.js'

const DEVICE = 'dev-1'

test('手机桥：没上报过就是离线，上报了才算在线', () => {
  let clock = 1_000
  const bridge = createBridge({ now: () => clock })
  assert.equal(bridge.status().online, false, '什么都没来时不该显示在线')

  bridge.hello(DEVICE, { protocol: 1, appVersion: '0.1.0' })
  assert.equal(bridge.status().online, true)
  assert.equal(bridge.status().armed, false, '上线不等于武装：武装要手机上单独打开')
})

test('手机桥：武装只能由手机改，关掉立刻失效', () => {
  const bridge = createBridge({ now: () => 0 })
  assert.equal(bridge.setArmed(DEVICE, true).armed, true)
  assert.equal(bridge.status().armed, true)
  assert.equal(bridge.setArmed(DEVICE, false).armed, false)
  assert.equal(bridge.status().armed, false)
})

test('手机桥：90 秒没来问就算离线（不是"连过就一直在线"）', () => {
  let clock = 0
  const bridge = createBridge({ now: () => clock })
  bridge.hello(DEVICE, { protocol: 1 })
  assert.equal(bridge.status().online, true)

  clock = 89_999
  assert.equal(bridge.status().online, true, '89 秒还算在线')

  clock = 90_000
  assert.equal(bridge.status().online, false, '到 90 秒就该判离线')
})

test('手机桥：长轮询会被"武装状态变化"立刻唤醒', async () => {
  const bridge = createBridge({ now: () => 0 })
  const started = Date.now()
  const pending = bridge.poll(DEVICE, { waitMs: 5_000 })
  // 让 poll 先挂上，再改状态
  await new Promise((r) => setTimeout(r, 10))
  bridge.setArmed(DEVICE, true)
  const result = await pending
  const waited = Date.now() - started
  assert.equal(result.armed, true, '唤醒后要带回最新状态')
  assert.ok(waited < 1_000, `应该在百毫秒级被唤醒，实际等了 ${waited}ms`)
})

test('手机桥：到时间没变化也要回一次（客户端据此判断还连着）', async () => {
  const bridge = createBridge({ now: () => 0 })
  const started = Date.now()
  const result = await bridge.poll(DEVICE, { waitMs: 60 })
  assert.equal(result.ok, true)
  assert.ok(Date.now() - started >= 50, '要压够时间再回，不能立刻返回')
})

test('手机桥：wait=0 立刻返回（排障与测试用）', async () => {
  const bridge = createBridge({ now: () => 0 })
  const started = Date.now()
  const result = await bridge.poll(DEVICE, { waitMs: 0 })
  assert.equal(result.armed, false)
  assert.ok(Date.now() - started < 50)
})

test('手机桥：第一步还不提供任何工具', () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1, tools: [] })
  const status = bridge.status()
  assert.deepEqual(status.rows[0].tools, [], 'P2 第一步不该冒然出现工具名')
  assert.equal(status.onlineDevices, 1)
})

test('手机桥：一次调用会被手机取走，回报后电脑拿到结果', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1 })
  bridge.setArmed(DEVICE, true)

  const waiting = bridge.call(DEVICE, 'phone_notify', { title: '喝水' }, 5_000)
  // 手机来取：poll 的返回里应带着那条调用
  const taken = await bridge.poll(DEVICE, { waitMs: 0 })
  assert.equal(taken.calls.length, 1, '手机应取到一条待执行的动作')
  assert.equal(taken.calls[0].tool, 'phone_notify')
  assert.equal(taken.calls[0].args.title, '喝水')

  // 取走即清空：**不重投**，否则会重复打扰
  const again = await bridge.poll(DEVICE, { waitMs: 0 })
  assert.equal(again.calls.length, 0, '取走之后不该再给一遍')

  bridge.settle(DEVICE, taken.calls[0].id, { ok: true, result: '已显示通知' })
  assert.equal(await waiting, '已显示通知')
})

test('手机桥：没武装时不许调用（电脑不能自己打开开关）', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1 })
  await assert.rejects(() => bridge.call(DEVICE, 'phone_notify', {}, 100), /没打开|不在线/)
})

test('手机桥：手机不回话就按时失败，不无限等', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1 })
  bridge.setArmed(DEVICE, true)
  const started = Date.now()
  await assert.rejects(() => bridge.call(DEVICE, 'phone_status', {}, 150), /超时|预期时间/)
  assert.ok(Date.now() - started >= 120, '要等够超时时间再失败')
})

test('手机桥：别的设备不能替它回话（结果绑定发起方）', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1 })
  bridge.setArmed(DEVICE, true)
  const waiting = bridge.call(DEVICE, 'phone_status', {}, 300)
  const taken = await bridge.poll(DEVICE, { waitMs: 0 })
  const id = taken.calls[0].id

  assert.equal(bridge.settle('另一台设备', id, { ok: true, result: '假结果' }), false,
    '不属于这台设备的结果必须被拒')
  bridge.settle(DEVICE, id, { ok: true, result: '真结果' })
  assert.equal(await waiting, '真结果')
})

test('手机桥：超时的调用不会被手机在之后取走执行（延迟执行）', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1 })
  bridge.setArmed(DEVICE, true)

  // 没人取的调用，等到超时
  await assert.rejects(() => bridge.call(DEVICE, 'phone_send_file', { name: 'x' }, 120), /预期时间/)
  // 之后手机才来取：**不该**再拿到这条早已没人等的动作
  const taken = await bridge.poll(DEVICE, { waitMs: 0 })
  assert.equal(taken.calls.length, 0, '过期的动作不能再发给手机')
})

test('手机桥：hello 不能把待执行的调用顺手取走', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1 })
  bridge.setArmed(DEVICE, true)
  const waiting = bridge.call(DEVICE, 'phone_status', {}, 500)

  // 手机每次轮询都会先 hello 一次；这一步不该动队列
  const greeted = bridge.hello(DEVICE, { protocol: 1 })
  assert.deepEqual(greeted.calls ?? [], [], 'hello 的返回里不该有动作')

  const taken = await bridge.poll(DEVICE, { waitMs: 0 })
  assert.equal(taken.calls.length, 1, '动作必须留给真正的轮询')
  bridge.settle(DEVICE, taken.calls[0].id, { ok: true, result: 'ok' })
  assert.equal(await waiting, 'ok')
})

test('手机桥：arm 的响应不是取件通道', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1 })
  bridge.setArmed(DEVICE, true)
  const waiting = bridge.call(DEVICE, 'phone_status', {}, 500)

  const reply = bridge.setArmed(DEVICE, true)
  assert.deepEqual(reply.calls, [], '重复武装也不能把动作藏在 arm 响应里取走')
  const taken = await bridge.poll(DEVICE, { waitMs: 0 })
  assert.equal(taken.calls.length, 1)
  bridge.settle(DEVICE, taken.calls[0].id, { ok: true, result: 'ok' })
  assert.equal(await waiting, 'ok')
})

test('手机桥：撤销武装后，排队动作不再交付', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1 })
  bridge.setArmed(DEVICE, true)
  const waiting = bridge.call(DEVICE, 'phone_notify', {}, 40)

  const reply = bridge.setArmed(DEVICE, false)
  assert.equal(reply.armed, false)
  assert.deepEqual(reply.calls, [])
  // 直接重新武装，中间不能先 poll：旧任务也不许借复活。
  bridge.setArmed(DEVICE, true)
  const taken = await bridge.poll(DEVICE, { waitMs: 0 })
  assert.deepEqual(taken.calls, [])
  await assert.rejects(() => waiting, /已关闭/)
})

test('手机桥：已有调用时，长轮询必须立即取件而不是等到超时', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1 })
  bridge.setArmed(DEVICE, true)
  const waiting = bridge.call(DEVICE, 'phone_status', {}, 500)

  const started = Date.now()
  const taken = await bridge.poll(DEVICE, { waitMs: 5_000 })
  assert.ok(Date.now() - started < 200, '已有动作不该再压一个长轮询周期')
  assert.equal(taken.calls.length, 1)
  bridge.settle(DEVICE, taken.calls[0].id, { ok: true, result: 'ok' })
  assert.equal(await waiting, 'ok')
})

test('手机桥：跨进程的旧结果不能认领新调用', async () => {
  const oldBridge = createBridge({ now: () => 0 })
  const newBridge = createBridge({ now: () => 0 })
  for (const bridge of [oldBridge, newBridge]) {
    bridge.hello(DEVICE, { protocol: 1 })
    bridge.setArmed(DEVICE, true)
  }
  const oldWaiting = oldBridge.call(DEVICE, 'phone_status', {}, 500)
  const oldTaken = await oldBridge.poll(DEVICE, { waitMs: 0 })
  const newWaiting = newBridge.call(DEVICE, 'phone_observe', {}, 500)
  const newTaken = await newBridge.poll(DEVICE, { waitMs: 0 })
  const oldId = oldTaken.calls[0].id
  const newId = newTaken.calls[0].id
  assert.notEqual(oldId, newId, '不同进程不能从同一个顺序号重新编号')

  assert.equal(newBridge.settle(DEVICE, oldId, { ok: true, result: '旧结果' }), false)
  newBridge.settle(DEVICE, newId, { ok: true, result: '新结果' })
  assert.equal(await newWaiting, '新结果')
  oldBridge.settle(DEVICE, oldId, { ok: true, result: '旧结果' })
  assert.equal(await oldWaiting, '旧结果')
})

test('手机桥：已经取走的调用，过期结果也不能被接受', async () => {
  let clock = 0
  const bridge = createBridge({ now: () => clock })
  bridge.hello(DEVICE, { protocol: 1 })
  bridge.setArmed(DEVICE, true)
  const waiting = bridge.call(DEVICE, 'phone_status', {}, 100)
  const taken = await bridge.poll(DEVICE, { waitMs: 0 })

  clock = 101
  assert.equal(bridge.settle(DEVICE, taken.calls[0].id, { ok: true, result: '迟到' }), false)
  await assert.rejects(() => waiting, /过期/)
})

test('手机桥：手机失败时要把具体原因传给电脑', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1 })
  bridge.setArmed(DEVICE, true)
  const waiting = bridge.call(DEVICE, 'phone_send_file', {}, 500)
  const taken = await bridge.poll(DEVICE, { waitMs: 0 })
  bridge.settle(DEVICE, taken.calls[0].id, { ok: false, result: '存文件失败：空间不足' })
  await assert.rejects(() => waiting, /存文件失败：空间不足/)
})

test('手机桥：关闭授权后，手机迟到的成功回执不算数', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1 })
  bridge.setArmed(DEVICE, true)
  const waiting = bridge.call(DEVICE, 'phone_set_clipboard', {}, 60_000)
  const taken = await bridge.poll(DEVICE, { waitMs: 0 })

  // 用户关掉了开关，随后才点了那张旧通知。
  bridge.setArmed(DEVICE, false)
  await assert.rejects(() => waiting, /已关闭/)
  assert.equal(bridge.settle(DEVICE, taken.calls[0].id, { ok: true, result: '已复制' }), false)
})

test('手机桥：设备被撤销时，挂着的长轮询立刻作废，不再交付动作', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1 })
  bridge.setArmed(DEVICE, true)

  // 先挂起一条长轮询；撤销必须把这条等待也放掉，而不是让它继续等。
  const waitingPoll = bridge.poll(DEVICE, { waitMs: 5_000 })
  await new Promise((r) => setTimeout(r, 10))
  bridge.dropDevice(DEVICE)
  const snapshot = await waitingPoll
  assert.equal(snapshot.revoked, true)
  assert.deepEqual(snapshot.calls, [])
  assert.equal(bridge.isArmed(DEVICE), false)

  // 队列里已经排好的动作也必须一并作废。
  bridge.setArmed(DEVICE, true)
  const waitingCall = bridge.call(DEVICE, 'phone_status', {}, 60_000)
  bridge.dropDevice(DEVICE)
  await assert.rejects(() => waitingCall, /撤销/)
})

test('手机桥：每条调用都带序号与消息号（供手机端挡重放）', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1 })
  bridge.setArmed(DEVICE, true)
  const waiting = bridge.call(DEVICE, 'phone_status', {}, 500)
  const taken = await bridge.poll(DEVICE, { waitMs: 0 })
  const call = taken.calls[0]
  assert.ok(call.seq >= 1, '必须有单调序号')
  assert.ok(call.msgId && call.msgId.length >= 8, '必须有消息号')
  bridge.settle(DEVICE, call.id, { ok: true, result: 'ok' })
  await waiting
})

test('手机桥：失败时要把手机的原始返回带出来，不能只说一句执行失败', async () => {
  const bridge = createBridge({ now: () => 0 })
  bridge.hello(DEVICE, { protocol: 1 })
  bridge.setArmed(DEVICE, true)
  const waiting = bridge.call(DEVICE, 'phone_tap', { index: 13 }, 500)
  const taken = await bridge.poll(DEVICE, { waitMs: 0 })
  bridge.settle(DEVICE, taken.calls[0].id, { ok: false, result: { ok: false, error: '没有第 13 个控件' } })
  await assert.rejects(() => waiting, /没有第 13 个控件/)
})
