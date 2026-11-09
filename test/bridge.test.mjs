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
