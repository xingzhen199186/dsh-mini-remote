import test from 'node:test'
import assert from 'node:assert/strict'
import { createPhoneLock, STALE_MS } from '../lib/phone-lock.js'

/**
 * 一台手机只能一个人操作（2026-11-14）。
 *
 * 要挡住的真实事故：两个会话同时发指令，A 点开设置、B 的"点发送"落在设置页上，
 * 于是点到了完全不相干的东西。这组测试按"抢、排队、接管"三件事写。
 */

test('没人用时，第一个来的直接拿到', () => {
  const lock = createPhoneLock()
  assert.equal(lock.acquire('A', { now: 1000 }).ok, true)
  assert.equal(lock.snapshot().holder.sessionId, 'A')
})

test('第二个会话来抢，得到"正忙"和排队第 1 位', () => {
  const lock = createPhoneLock()
  lock.acquire('A', { now: 1000 })
  const r = lock.acquire('B', { now: 1100 })
  assert.equal(r.ok, false)
  assert.match(r.error, /手机正忙/)
  assert.match(r.error, /排队第 1 位/)
  assert.equal(lock.snapshot().queue.join(), 'B')
})

test('同一个会话反复申请不算抢，也不会把自己排进队', () => {
  const lock = createPhoneLock()
  lock.acquire('A', { now: 1000 })
  assert.equal(lock.acquire('A', { now: 1100 }).ok, true)
  assert.equal(lock.acquire('A', { now: 1200 }).ok, true)
  assert.deepEqual(lock.snapshot().queue, [])
})

test('人一发新指令，锁放掉，排队的第一个顶上', () => {
  const lock = createPhoneLock()
  lock.acquire('A', { now: 1000 })
  lock.acquire('B', { now: 1100 })
  lock.onHumanMessage(2000)
  assert.equal(lock.snapshot().holder.sessionId, 'B')
  assert.deepEqual(lock.snapshot().queue, [])
  assert.equal(lock.acquire('A', { now: 2100 }).ok, false, '原来的持有者不该还能直接用')
})

test('持有者掉线太久要能被接管，否则手机永久"正忙"', () => {
  const lock = createPhoneLock({ staleMs: 1000 })
  lock.acquire('A', { now: 0 })
  lock.acquire('B', { now: 500 })
  const r = lock.acquire('B', { now: 5000 })
  assert.equal(r.ok, true, '超过掉线阈值后，B 应该拿到，而不是一直排队')
  assert.equal(lock.snapshot().holder.sessionId, 'B')
})

test('持有者一直在动，就不算掉线', () => {
  const lock = createPhoneLock({ staleMs: 1000 })
  lock.acquire('A', { now: 0 })
  lock.touch('A', 900)
  lock.touch('A', 1800)
  assert.equal(lock.acquire('B', { now: 2000 }).ok, false)
})

test('主动放掉之后，排队的人立刻可用', () => {
  const lock = createPhoneLock()
  lock.acquire('A', { now: 0 })
  lock.acquire('B', { now: 10 })
  lock.release('A', 20)
  assert.equal(lock.snapshot().holder.sessionId, 'B')
})

test('拿不到会话信息时不锁：宁可不管，也不许把整条能力废掉', () => {
  const lock = createPhoneLock()
  assert.equal(lock.acquire('', { now: 0 }).ok, true)
  assert.equal(lock.snapshot().holder, null)
})

test('掉线阈值是个明确的数，别偷偷变成 0 或无限大', () => {
  assert.ok(STALE_MS >= 60_000 && STALE_MS <= 10 * 60_000, `阈值 ${STALE_MS} 不合理`)
})

test('接线不许漏：三个动手入口都过闸，人发新指令会放锁', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 会改变手机状态的动作必须排队；只读的不排。
  for (const tool of ['phone_tap', 'phone_swipe', 'phone_input', 'phone_back', 'phone_open', 'phone_wake']) {
    assert.match(src, new RegExp(`'${tool}'`), `${tool} 应该在 LOCKED_TOOLS 里`)
  }
  assert.match(src, /if \(LOCKED_TOOLS\.has\(tool\)\) \{\n\s+const busy = lockGate\(exec\)/)
  // 按坐标动作与按序号点按走的是另外两条路，也要各自过闸。
  assert.match(src, /const tapBusy = lockGate\(exec\)/)
  assert.match(src, /const lockBusy = lockGate\(exec\)/)
  // 人发新指令 = 上一个任务结束。
  assert.match(src, /source\?\.kind === 'user'\) phoneLock\.onHumanMessage\(\)/)
})
