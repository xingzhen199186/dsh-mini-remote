import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MULTI_RELAY_TIMEOUT_MS,
  createMultiRelayClient,
  multiRelayErrorMessage,
  normalizeControlUrl,
} from '../lib/multi-relay-client.js'

const CONTROL = 'https://admin.relay.example.com'
const SECRET = 'a'.repeat(43)
const IDENTITY = {
  controlUrl: CONTROL,
  clientSecret: SECRET,
  claimRequestId: 'claim-request-0001',
  id: 'abcdefghijklmnopqrstuvwxyz',
  publicHost: 'abcdefghijklmnopqrstuvwxyz.relay.example.com',
  controlHost: 'frp-abcdefghijklmnopqrstuvwxyz.relay.example.com',
  frpsPort: 443,
  transport: 'wss',
  frpToken: 'frp-token-test-value-1234567890',
}

function response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => payload,
  }
}

test('normalizeControlUrl 只接受不带路径的 https origin', () => {
  assert.equal(normalizeControlUrl('https://admin.relay.example.com'), CONTROL)
  assert.equal(normalizeControlUrl('https://admin.relay.example.com/'), CONTROL)
  assert.equal(normalizeControlUrl(' https://admin.relay.example.com:8443/ '), 'https://admin.relay.example.com:8443')
  assert.equal(normalizeControlUrl('http://admin.relay.example.com'), null)
  assert.equal(normalizeControlUrl('https://admin.relay.example.com/control'), null)
  assert.equal(normalizeControlUrl('https://admin.relay.example.com/?x=1'), null)
  assert.equal(normalizeControlUrl('https://user:pass@admin.relay.example.com'), null)
  assert.equal(normalizeControlUrl('not a url'), null)
})

test('claim 使用固定契约、8 秒超时，不在请求里带额外路径', async () => {
  assert.equal(MULTI_RELAY_TIMEOUT_MS, 8000)
  let seen = null
  const client = createMultiRelayClient({
    identity: IDENTITY,
    controlUrl: CONTROL,
    fetchFn: async (url, init) => {
      seen = { url, init }
      return response(200, {
        ok: true,
        id: IDENTITY.id,
        publicHost: IDENTITY.publicHost,
        controlHost: IDENTITY.controlHost,
        frpsPort: 443,
        transport: 'wss',
        frpToken: IDENTITY.frpToken,
        tokenIssued: true,
      })
    },
  })
  const result = await client.claim({ inviteCode: ' invite-code ', originPort: 3090 })
  assert.equal(result.ok, true)
  assert.equal(result.frpToken, IDENTITY.frpToken)
  assert.equal(seen.url, CONTROL + '/api/claim')
  assert.equal(seen.init.method, 'POST')
  assert.deepEqual(JSON.parse(seen.init.body), {
    inviteCode: 'invite-code',
    clientSecret: SECRET,
    originPort: 3090,
    claimRequestId: IDENTITY.claimRequestId,
  })
})

test('status/release 走对应路径，错误码映射中文并保留重试信息', async () => {
  const paths = []
  let mode = 'status'
  const client = createMultiRelayClient({
    identity: IDENTITY,
    controlUrl: CONTROL,
    fetchFn: async (url) => {
      paths.push(new URL(url).pathname)
      if (mode === 'status') {
        return response(200, { ok: true, tenant: { id: IDENTITY.id, state: 'active' } })
      }
      return response(429, { ok: false, error: 'rate_limited' }, { 'retry-after': '12' })
    },
  })
  const status = await client.status()
  assert.equal(status.ok, true)
  assert.equal(status.tenant.state, 'active')
  mode = 'release'
  const release = await client.release()
  assert.equal(release.ok, false)
  assert.equal(release.code, 'rate_limited')
  assert.equal(release.retryable, true)
  assert.equal(release.retryAfter, 12)
  assert.equal(release.message, '开通请求太频繁，请稍后再试。')
  assert.deepEqual(paths, ['/api/status', '/api/release'])
  assert.equal(multiRelayErrorMessage('invite_used'), '这个邀请码已经用过了。')
})

test('网络错误和非法控制台地址返回可读错误', async () => {
  const client = createMultiRelayClient({
    identity: IDENTITY,
    controlUrl: CONTROL,
    fetchFn: async () => { throw new Error('offline') },
  })
  const offline = await client.claim({ inviteCode: 'code', originPort: 3090 })
  assert.equal(offline.code, 'network_error')
  assert.match(offline.message, /连不上中继控制台/)

  const invalid = createMultiRelayClient({
    identity: { ...IDENTITY, controlUrl: 'http://bad.example.com' },
    controlUrl: 'http://bad.example.com',
    fetchFn: async () => { throw new Error('should not fetch') },
  })
  const bad = await invalid.status()
  assert.equal(bad.code, 'invalid_control_url')
  assert.match(bad.message, /只填 https/)
})

test('管理员密码先创建自用邀请，再 claim；密码只用于 Basic Auth', async () => {
  const calls = []
  const client = createMultiRelayClient({
    identity: { ...IDENTITY, id: null, publicHost: null, controlHost: null, frpToken: null },
    controlUrl: CONTROL,
    fetchFn: async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/admin/api/invites')) {
        return response(200, { ok: true, code: 'self-use-code-1234567890' })
      }
      return response(200, {
        ok: true,
        id: IDENTITY.id,
        publicHost: IDENTITY.publicHost,
        controlHost: IDENTITY.controlHost,
        frpsPort: 443,
        transport: 'wss',
        frpToken: IDENTITY.frpToken,
        tokenIssued: true,
      })
    },
  })
  const result = await client.claimAsAdmin({ adminPassword: 'admin-secret', originPort: 3090 })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 2)
  assert.match(calls[0].init.headers.authorization, /^Basic /)
  assert.equal(JSON.parse(calls[1].init.body).inviteCode, 'self-use-code-1234567890')
})
