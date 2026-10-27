import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TunnelSupervisor,
  backoffDelay,
  classifyTunnelFailure,
  targetFingerprint,
} from '../lib/tunnel-supervisor.js'

function makeTimer() {
  let nextId = 0
  const pending = new Map()
  return {
    setTimeout(fn, ms) {
      const id = ++nextId
      pending.set(id, { id, fn, ms })
      return { id }
    },
    clearTimeout(timer) {
      if (timer) pending.delete(timer.id)
    },
    runNext() {
      const first = [...pending.values()].sort((a, b) => (a.ms - b.ms) || (a.id - b.id))[0]
      if (!first) return false
      pending.delete(first.id)
      first.fn()
      return true
    },
    get size() { return pending.size },
    get delays() { return [...pending.values()].map((one) => one.ms) },
  }
}

function makeStart() {
  const calls = []
  const handles = []
  const start = async (target) => {
    calls.push(target)
    const handle = {
      url: target.mode === 'named' ? target.publicUrl : 'https://quick.example',
      stopped: false,
      exitCb: null,
      stop() { this.stopped = true },
      onExit(cb) { this.exitCb = cb },
    }
    handles.push(handle)
    return handle
  }
  return { start, calls, handles }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('目标指纹不包含明文 token，但 token 变化会改变指纹', () => {
  const one = targetFingerprint({ mode: 'named', port: 3090, publicUrl: 'https://dsh.example.com', token: 'aaa' })
  const two = targetFingerprint({ mode: 'named', port: 3090, publicUrl: 'https://dsh.example.com', token: 'bbb' })
  assert.notEqual(one, two)
  assert.match(one, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(one, /aaa/)
})

test('失败分类：token 错不重试，DNS 和本机服务不重启隧道', () => {
  assert.equal(classifyTunnelFailure(new Error('Invalid tunnel secret')), 'auth')
  assert.equal(classifyTunnelFailure(new Error('getaddrinfo ENOTFOUND dsh.example.com')), 'dns')
  assert.equal(classifyTunnelFailure(new Error('HTTP 502 Bad Gateway')), 'origin')
  assert.equal(classifyTunnelFailure(new Error('HTTP 404 Not Found')), 'hostname')
  assert.equal(classifyTunnelFailure(new Error('TLS handshake with edge error: EOF')), 'edge')
  assert.equal(classifyTunnelFailure(new Error('TLS handshake with edge error: EOF ip=198.18.0.41')), 'proxy')
})

test('退避有上限，并带抖动', () => {
  assert.equal(backoffDelay(1, { baseDelayMs: 5000, maxDelayMs: 60000, random: () => 0.5 }), 5000)
  assert.equal(backoffDelay(5, { baseDelayMs: 5000, maxDelayMs: 60000, random: () => 0.5 }), 60000)
  assert.ok(backoffDelay(3, { baseDelayMs: 5000, maxDelayMs: 60000, random: () => 0 }) >= 8000)
})

test('同一个目标重复 start 不会起第二个进程', async () => {
  const timer = makeTimer()
  const fake = makeStart()
  const sup = new TunnelSupervisor({ start: fake.start, probe: async () => ({ ok: true }), timer })
  const target = { mode: 'named', port: 3090, publicUrl: 'https://dsh.example.com', token: 'tok' }
  await sup.start(target)
  await sup.start(target)
  assert.equal(fake.calls.length, 1)
  assert.equal(sup.snapshot().phase, 'running')
  assert.equal(sup.snapshot().url, 'https://dsh.example.com')
  sup.stop()
})

test('进程异常退出后按退避重启', async () => {
  const timer = makeTimer()
  const fake = makeStart()
  const sup = new TunnelSupervisor({ start: fake.start, probe: async () => ({ ok: true }), timer, baseDelayMs: 10 })
  await sup.start({ mode: 'named', port: 3090, publicUrl: 'https://dsh.example.com', token: 'tok' })
  fake.handles[0].exitCb(1)
  assert.equal(sup.snapshot().phase, 'restarting')
  assert.equal(sup.snapshot().attempts, 1)
  assert.ok(timer.size > 0)
  timer.runNext()
  await flush()
  assert.equal(fake.calls.length, 2)
  assert.equal(sup.snapshot().phase, 'running')
  sup.stop()
})

test('连续失败达到预算后暂停，不再自动重试', async () => {
  const timer = makeTimer()
  const fake = makeStart()
  const sup = new TunnelSupervisor({
    start: fake.start, probe: async () => ({ ok: true }), timer, maxAttempts: 2, baseDelayMs: 1,
  })
  await sup.start({ mode: 'named', port: 3090, publicUrl: 'https://dsh.example.com', token: 'tok' })
  fake.handles[0].exitCb(1)
  timer.runNext(); await flush()
  fake.handles[1].exitCb(1)
  assert.equal(sup.snapshot().phase, 'paused')
  assert.equal(sup.snapshot().attempts, 2)
  assert.equal(fake.calls.length, 2)
  sup.retryNow()
  await flush()
  assert.equal(sup.snapshot().phase, 'running')
  assert.equal(fake.calls.length, 3, '立即重试要真的再起一次')
  sup.stop()
})

test('token 错直接 failed，不进入重试', async () => {
  const timer = makeTimer()
  const start = async () => { throw new Error('Invalid tunnel secret') }
  const sup = new TunnelSupervisor({ start, probe: async () => ({ ok: true }), timer })
  await sup.start({ mode: 'named', port: 3090, publicUrl: 'https://dsh.example.com', token: 'tok' })
  assert.equal(sup.snapshot().phase, 'failed')
  assert.equal(sup.snapshot().lastErrorKind, 'auth')
  assert.equal(timer.size, 0)
  sup.stop()
})

test('本机 DNS 探测失败只降级，不重启隧道', async () => {
  const timer = makeTimer()
  const fake = makeStart()
  let probes = 0
  const sup = new TunnelSupervisor({
    start: fake.start,
    probe: async () => { probes += 1; return { ok: false, kind: 'dns', detail: '本机解析不了' } },
    timer,
    probeIntervalMs: 1,
  })
  await sup.start({ mode: 'named', port: 3090, publicUrl: 'https://dsh.example.com', token: 'tok' })
  timer.runNext(); await flush()
  timer.runNext(); await flush()
  assert.equal(probes, 2)
  assert.equal(sup.snapshot().phase, 'degraded')
  assert.equal(fake.calls.length, 1, 'DNS 失败不能重启隧道')
  sup.stop()
})

test('本机 DNS 坏但公共 DNS 正常：降级，不重启', async () => {
  const timer = makeTimer()
  const fake = makeStart()
  const sup = new TunnelSupervisor({
    start: fake.start,
    probe: async () => ({ ok: false, kind: 'dns-local', detail: '公共 DNS 能解析' }),
    timer,
    probeIntervalMs: 1,
  })
  await sup.start({ mode: 'named', port: 3090, publicUrl: 'https://dsh.example.com', token: 'tok' })
  timer.runNext(); await flush()
  timer.runNext(); await flush()
  assert.equal(sup.snapshot().phase, 'degraded')
  assert.equal(sup.snapshot().lastErrorKind, 'dns-local')
  assert.equal(fake.calls.length, 1)
  sup.stop()
})

test('边缘探测连续失败会走重启', async () => {
  const timer = makeTimer()
  const fake = makeStart()
  let probes = 0
  const sup = new TunnelSupervisor({
    start: fake.start,
    probe: async () => { probes += 1; return { ok: false, kind: 'edge', detail: 'TLS 握手失败' } },
    timer,
    probeIntervalMs: 1,
    baseDelayMs: 1,
  })
  await sup.start({ mode: 'named', port: 3090, publicUrl: 'https://dsh.example.com', token: 'tok' })
  timer.runNext(); await flush()
  timer.runNext(); await flush()
  assert.equal(probes, 2)
  assert.equal(sup.snapshot().phase, 'restarting')
  timer.runNext(); await flush()
  assert.equal(fake.calls.length, 2)
  sup.stop()
})

test('stop 之后不再重启', async () => {
  const timer = makeTimer()
  const fake = makeStart()
  const sup = new TunnelSupervisor({ start: fake.start, probe: async () => ({ ok: true }), timer, baseDelayMs: 1 })
  await sup.start({ mode: 'named', port: 3090, publicUrl: 'https://dsh.example.com', token: 'tok' })
  fake.handles[0].exitCb(1)
  sup.stop()
  timer.runNext(); await flush()
  assert.equal(fake.calls.length, 1)
  assert.equal(sup.snapshot().phase, 'stopped')
})
