import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadOrCreateRelayIdentity, validateRelayIdentity } from '../lib/relay-identity.js'
import { createRelayClient } from '../lib/relay-client.js'

test('A 中继身份：生成 26 位 id / 43 位 secret，并复用同一文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-identity-'))
  try {
    const first = loadOrCreateRelayIdentity(dir)
    assert.equal(validateRelayIdentity(first), true)
    assert.match(first.id, /^[a-z2-7]{26}$/)
    assert.match(first.secret, /^[A-Za-z0-9_-]{43}$/)
    const second = loadOrCreateRelayIdentity(dir)
    assert.equal(second.id, first.id)
    assert.equal(second.secret, first.secret)
    assert.equal(JSON.parse(readFileSync(join(dir, 'relay-identity.json'), 'utf8')).id, first.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A 中继身份损坏时抛错，不悄悄换 id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-identity-'))
  try {
    writeFileSync(join(dir, 'relay-identity.json'), '{"id":"bad"}')
    assert.throws(() => loadOrCreateRelayIdentity(dir), /格式不对/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('注册用 PUT、带 inviteCode；注销用 POST', async () => {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/register')) {
      return new Response(JSON.stringify({ ok: true, publicUrl: 'https://abc.dsh-mini-remote.com' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = createRelayClient({
    identity: { id: 'abcdefghijklmnopqrstuvwxyz', secret: 'A'.repeat(43) },
    inviteCode: 'invite-1',
    fetchFn,
  })
  const registered = await client.register({ quickUrl: 'https://one.trycloudflare.com' })
  assert.equal(registered.ok, true)
  assert.equal(registered.publicUrl, 'https://abc.dsh-mini-remote.com')
  assert.equal(calls[0].init.method, 'PUT')
  assert.equal(JSON.parse(calls[0].init.body).inviteCode, 'invite-1')
  await client.unregister()
  assert.equal(calls[1].init.method, 'POST')
})

test('注册失败保留状态码和错误，不抛异常', async () => {
  const fetchFn = async () => new Response(JSON.stringify({ ok: false, error: 'rate-limited' }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '7' },
  })
  const client = createRelayClient({
    identity: { id: 'abcdefghijklmnopqrstuvwxyz', secret: 'A'.repeat(43) },
    fetchFn,
  })
  const result = await client.register({ quickUrl: 'https://one.trycloudflare.com' })
  assert.equal(result.ok, false)
  assert.equal(result.status, 429)
  assert.equal(result.error, 'rate-limited')
  assert.equal(result.retryAfterMs, 7000)
})
