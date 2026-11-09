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
