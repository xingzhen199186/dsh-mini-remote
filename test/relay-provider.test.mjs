import test from 'node:test'
import assert from 'node:assert/strict'

import { RelayProvider } from '../lib/relay-provider.js'

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
    get delays() { return [...pending.values()].map((one) => one.ms) },
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

function makeProvider(handler, extra = {}) {
  const timer = makeTimer()
  const calls = []
  const unregisters = []
  const provider = new RelayProvider({
    timer,
    register: async (input) => {
      calls.push(input)
      return handler(input, calls.length)
    },
    unregister: async (input) => { unregisters.push(input) },
    ...extra,
  })
  return { provider, timer, calls, unregisters }
}

test('登记成功后进入 active，并暴露固定地址', async () => {
  const { provider, calls } = makeProvider(async () => ({ ok: true, publicUrl: 'https://abc.relay.example' }))
  await provider.attach('https://one.trycloudflare.com')
  assert.equal(provider.snapshot().state, 'active')
  assert.equal(provider.snapshot().publicUrl, 'https://abc.relay.example')
  assert.equal(calls.length, 1)
})

test('同一个 quick URL 不重复登记', async () => {
  const { provider, calls } = makeProvider(async () => ({ ok: true, publicUrl: 'https://abc.relay.example' }))
  await provider.attach('https://one.trycloudflare.com')
  await provider.attach('https://one.trycloudflare.com')
  assert.equal(calls.length, 1)
})

test('新 URL 会作废旧代次，迟到的旧响应不能覆盖新地址', async () => {
  let resolveA
  const { provider, calls } = makeProvider(async ({ quickUrl }) => {
    if (quickUrl === 'https://a.trycloudflare.com') {
      return await new Promise((resolve) => { resolveA = resolve })
    }
    return { ok: true, publicUrl: 'https://b.relay.example' }
  })
  const pendingA = provider.attach('https://a.trycloudflare.com')
  await flush()
  await provider.attach('https://b.trycloudflare.com')
  assert.equal(provider.snapshot().publicUrl, 'https://b.relay.example')
  resolveA({ ok: true, publicUrl: 'https://a.relay.example' })
  await pendingA
  assert.equal(provider.snapshot().publicUrl, 'https://b.relay.example')
  assert.equal(calls.length, 2)
})

test('5xx 会退避重试，成功后退避清零', async () => {
  const { provider, timer, calls } = makeProvider(async (_input, n) => (
    n === 1 ? { ok: false, status: 503, error: 'storage unavailable' } : { ok: true, publicUrl: 'https://abc.relay.example' }
  ), { baseDelayMs: 100, random: () => 0.5 })
  await provider.attach('https://one.trycloudflare.com')
  assert.equal(provider.snapshot().state, 'degraded')
  assert.equal(provider.snapshot().attempts, 1)
  assert.ok(provider.snapshot().nextRetryAt > 0)
  timer.runNext()
  await flush()
  assert.equal(provider.snapshot().state, 'active')
  assert.equal(provider.snapshot().attempts, 0)
  assert.equal(calls.length, 2)
})

test('401/403 直接 paused，不安排重试', async () => {
  const { provider, timer } = makeProvider(async () => ({ ok: false, status: 403, error: 'auth-failed' }))
  await provider.attach('https://one.trycloudflare.com')
  assert.equal(provider.snapshot().state, 'paused')
  assert.equal(provider.snapshot().publicUrl, null)
  assert.equal(timer.delays.length, 0)
})

test('429 遵守 Retry-After', async () => {
  const { provider, timer } = makeProvider(async () => ({ ok: false, status: 429, error: 'rate-limited', retryAfterMs: 7000 }))
  await provider.attach('https://one.trycloudflare.com')
  assert.equal(provider.snapshot().state, 'degraded')
  assert.ok(timer.delays.includes(7000))
})

test('心跳会重新登记当前 URL', async () => {
  const { provider, timer, calls } = makeProvider(async () => ({ ok: true, publicUrl: 'https://abc.relay.example' }))
  await provider.attach('https://one.trycloudflare.com')
  assert.equal(calls.length, 1)
  assert.ok(timer.delays.includes(15 * 60_000))
  timer.runNext()
  await flush()
  assert.equal(calls.length, 2)
})

test('detach 会注销，并阻止迟到的登记响应复活', async () => {
  let resolveAttach
  const { provider, unregisters } = makeProvider(async () => await new Promise((resolve) => { resolveAttach = resolve }))
  const pending = provider.attach('https://one.trycloudflare.com')
  await flush()
  await provider.detach({ unregister: true })
  assert.equal(provider.snapshot().state, 'off')
  resolveAttach({ ok: true, publicUrl: 'https://abc.relay.example' })
  await pending
  assert.equal(provider.snapshot().state, 'off')
  assert.equal(unregisters.length, 0, '首次登记尚未成功，没有地址可注销')
})

test('已 active 后 detach 会尽力注销固定地址', async () => {
  const { provider, unregisters } = makeProvider(async () => ({ ok: true, publicUrl: 'https://abc.relay.example' }))
  await provider.attach('https://one.trycloudflare.com')
  await provider.detach({ unregister: true })
  assert.equal(provider.snapshot().state, 'off')
  assert.equal(unregisters.length, 1)
  assert.equal(unregisters[0].publicUrl, 'https://abc.relay.example')
})

test('快照不包含 secret 或 register 输入之外的敏感值', async () => {
  const { provider } = makeProvider(async () => ({ ok: true, publicUrl: 'https://abc.relay.example' }))
  await provider.attach('https://one.trycloudflare.com')
  const snapshot = provider.snapshot()
  assert.equal(Object.hasOwn(snapshot, 'secret'), false)
  assert.equal(Object.hasOwn(snapshot, 'token'), false)
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|token|invite/i)
  assert.equal(snapshot.quickUrl, 'https://one.trycloudflare.com')
})
