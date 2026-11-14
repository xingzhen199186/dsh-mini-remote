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
  assert.match(src, /source\?\.kind === 'user'\) phoneLock\.onHumanMessage\(Date\.now\(\), sessionId\)/)
})

test('会话 id 要从 agent.session 里认（认错锁就等于没有）', async () => {
  const { sessionKeyOf } = await import('../lib/phone-lock.js')
  // 宿主真实形状：exec.agent.session.id（2026-11-14 真机抓到的）
  assert.equal(sessionKeyOf({ agent: { session: { id: 'A' } } }), 'A')
  assert.equal(sessionKeyOf({ session: { id: 'B' } }), 'B')
  assert.equal(sessionKeyOf({ sessionId: 'C' }), 'C')
  assert.equal(sessionKeyOf(null), '')
  assert.equal(sessionKeyOf({}), '')
})

test('两个不同会话不允许同时在手机上动手', async () => {
  const { createPhoneLock, sessionKeyOf } = await import('../lib/phone-lock.js')
  const lock = createPhoneLock()
  const a = { agent: { session: { id: 'A' } } }
  const b = { agent: { session: { id: 'B' } } }
  assert.equal(lock.acquire(sessionKeyOf(a)).ok, true, 'A 先到，拿到')
  const deny = lock.acquire(sessionKeyOf(b))
  assert.equal(deny.ok, false, 'B 后到，必须被挡')
  assert.ok(deny.error && deny.error.length > 0, '要告诉用户为什么')
})

test('别的会话来了新指令，不许把当前这把锁放掉（真机抓到过的漏洞）', async () => {
  const { createPhoneLock } = await import('../lib/phone-lock.js')
  const lock = createPhoneLock()
  assert.equal(lock.acquire('A').ok, true)
  // B 被叫醒去做事——这条消息也算"人发的"，第一版就在这里把锁放掉了。
  lock.onHumanMessage(Date.now(), 'B')
  assert.equal(lock.snapshot().holder?.sessionId, 'A', '锁还应该在 A 手里')
  const deny = lock.acquire('B')
  assert.equal(deny.ok, false, 'B 必须被挡')

  // 人在 A 里发新指令：这才算 A 的活结束了。等在后面的 B 会被顺位接手（这是排队设计的本意）。
  lock.onHumanMessage(Date.now(), 'A')
  assert.notEqual(lock.snapshot().holder?.sessionId, 'A', 'A 的锁要放掉')
})

test('不传会话号时行为照旧：全都放（老调用不倒退）', async () => {
  const { createPhoneLock } = await import('../lib/phone-lock.js')
  const lock = createPhoneLock()
  lock.acquire('A')
  lock.onHumanMessage()
  assert.equal(lock.snapshot().holder, null)
})
