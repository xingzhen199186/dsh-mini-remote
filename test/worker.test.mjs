import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { handleRequest } from '../worker/src/index.js'

const MIGRATION = readFileSync(new URL('../worker/migrations/0001_init.sql', import.meta.url), 'utf8')
const ADMIN = 'test-admin-token'
const PEPPER = 'test-pepper'

function makeD1() {
  const db = new DatabaseSync(':memory:')
  db.exec(MIGRATION)
  const wrap = (sql) => {
    const stmt = db.prepare(sql)
    const run = (params) => {
      const result = stmt.run(...params)
      return { success: true, meta: { changes: Number(result.changes) } }
    }
    const all = (params) => ({ results: stmt.all(...params) })
    const first = (params) => stmt.get(...params) ?? null
    return {
      bind: (...params) => ({
        first: async () => first(params),
        run: async () => run(params),
        all: async () => all(params),
      }),
      first: async () => first([]),
      run: async () => run([]),
      all: async () => all([]),
    }
  }
  return {
    prepare: wrap,
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  }
}

function makeKv() {
  const map = new Map()
  return {
    async get(key, type) {
      const value = map.get(key)
      if (value === undefined) return null
      return type === 'json' ? JSON.parse(value) : value
    },
    async put(key, value) { map.set(key, value) },
    async delete(key) { map.delete(key) },
    dump: () => map,
  }
}

function makeEnv() {
  return {
    DB: makeD1(),
    RELAY_KV: makeKv(),
    RELAY_PEPPER: PEPPER,
    ADMIN_TOKEN: ADMIN,
    RELAY_INVITE_REQUIRED: '1',
    RELAY_PUBLIC_SUFFIX: '.relay.example.com',
  }
}

function req(path, { method = 'GET', body, token, ip = '203.0.113.9' } = {}) {
  const headers = { 'cf-connecting-ip': ip }
  if (token) headers.authorization = 'Bearer ' + token
  if (body !== undefined) headers['content-type'] = 'application/json'
  return new Request('https://relay.example.com' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const id = 'abcdefghijklmnopqrstuvwxyz'
const secret = 'A'.repeat(43)
const target = 'https://quick-one.trycloudflare.com'

async function createInvite(env) {
  const response = await handleRequest(req('/admin/relay/v1/invites', {
    method: 'POST', token: ADMIN, body: { note: 'test' },
  }), env)
  assert.equal(response.status, 200)
  return (await response.json()).code
}

test('health 公开，不泄露配置', async () => {
  const response = await handleRequest(req('/health'), makeEnv())
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, service: 'dsh-mini-relay', version: 1 })
})

test('没有邀请不能创建身份', async () => {
  const env = makeEnv()
  const response = await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target },
  }), env)
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error, 'invite-required')
})

test('邀请只能消费一次，登记成功返回固定地址和 target TTL', async () => {
  const env = makeEnv()
  const code = await createInvite(env)
  const first = await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target, inviteCode: code },
  }), env)
  assert.equal(first.status, 200)
  const body = await first.json()
  assert.equal(body.ok, true)
  assert.equal(body.publicUrl, 'https://' + id + '.relay.example.com')
  assert.ok(body.expiresAt > Date.now())
  assert.ok(env.RELAY_KV.dump().has('relay-target:' + id))

  const secondId = 'zyxwvutsrqponmlkjihgfedcba'
  const second = await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id: secondId, secret, target, inviteCode: code },
  }), env)
  assert.equal(second.status, 403)
  assert.equal((await second.json()).error, 'invite-invalid')
})

test('同 id + 同 secret 可以刷新 target，不需要新邀请', async () => {
  const env = makeEnv()
  const code = await createInvite(env)
  await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target, inviteCode: code },
  }), env)
  const nextTarget = 'https://quick-two.trycloudflare.com'
  const response = await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target: nextTarget },
  }), env)
  assert.equal(response.status, 200)
  const stored = JSON.parse(env.RELAY_KV.dump().get('relay-target:' + id))
  assert.equal(stored.target, nextTarget)
})

test('错误 secret 被拒绝，且不覆盖原 target', async () => {
  const env = makeEnv()
  const code = await createInvite(env)
  await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target, inviteCode: code },
  }), env)
  const before = env.RELAY_KV.dump().get('relay-target:' + id)
  const response = await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret: 'B'.repeat(43), target: 'https://evil.trycloudflare.com' },
  }), env)
  assert.equal(response.status, 403)
  assert.equal(env.RELAY_KV.dump().get('relay-target:' + id), before)
})

test('撤销后同 secret 也不能恢复，KV 留下 revoked 标记', async () => {
  const env = makeEnv()
  const code = await createInvite(env)
  await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target, inviteCode: code },
  }), env)
  const revoked = await handleRequest(req('/admin/relay/v1/revoke', {
    method: 'POST', token: ADMIN, body: { id, reason: 'test' },
  }), env)
  assert.equal(revoked.status, 200)
  const response = await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target },
  }), env)
  assert.equal(response.status, 403)
  assert.equal(JSON.parse(env.RELAY_KV.dump().get('relay-target:' + id)).state, 'revoked')
})

test('unregister 只停 target，同 secret 可以恢复，不消耗邀请', async () => {
  const env = makeEnv()
  const code = await createInvite(env)
  await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target, inviteCode: code },
  }), env)
  const off = await handleRequest(req('/api/relay/v1/unregister', {
    method: 'POST', body: { id, secret },
  }), env)
  assert.equal(off.status, 200)
  assert.equal(env.RELAY_KV.dump().has('relay-target:' + id), false)
  const back = await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target },
  }), env)
  assert.equal(back.status, 200)
})

test('target 白名单拒绝 http、端口、路径、query、IP 和二级子域', async () => {
  const env = makeEnv()
  const code = await createInvite(env)
  const bad = [
    'http://quick.trycloudflare.com',
    'https://quick.trycloudflare.com:8443',
    'https://quick.trycloudflare.com/path',
    'https://quick.trycloudflare.com/?x=1',
    'https://1.2.3.4',
    'https://a.b.trycloudflare.com',
    'https://quick.trycloudflare.com.evil.example',
  ]
  for (const value of bad) {
    const response = await handleRequest(req('/api/relay/v1/register', {
      method: 'PUT', body: { id, secret, target: value, inviteCode: code },
    }), env)
    assert.equal(response.status, 400, value)
  }
})

test('关闭注册只挡新身份，已有身份仍可心跳', async () => {
  const env = makeEnv()
  const code = await createInvite(env)
  await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target, inviteCode: code },
  }), env)
  const off = await handleRequest(req('/admin/relay/v1/config', {
    method: 'POST', token: ADMIN, body: { registrationEnabled: false },
  }), env)
  assert.equal(off.status, 200)
  const existing = await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target },
  }), env)
  assert.equal(existing.status, 200)
  const newId = 'zyxwvutsrqponmlkjihgfedcba'
  const fresh = await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id: newId, secret, target, inviteCode: code },
  }), env)
  assert.equal(fresh.status, 403)
})

test('同一 id 一分钟超过 6 次登记会被 429', async () => {
  const env = makeEnv()
  const code = await createInvite(env)
  const first = await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target, inviteCode: code },
  }), env)
  assert.equal(first.status, 200)
  let last
  for (let i = 0; i < 6; i += 1) {
    last = await handleRequest(req('/api/relay/v1/register', {
      method: 'PUT', body: { id, secret, target },
    }), env)
  }
  assert.equal(last.status, 429)
})

test('admin 无 token 被拒绝，列表不返回 secret', async () => {
  const env = makeEnv()
  const unauthorized = await handleRequest(req('/admin/relay/v1/identities'), env)
  assert.equal(unauthorized.status, 401)
  const code = await createInvite(env)
  await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target, inviteCode: code },
  }), env)
  const response = await handleRequest(req('/admin/relay/v1/identities', { token: ADMIN }), env)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.identities.length, 1)
  assert.equal(JSON.stringify(body).includes(secret), false)
})
