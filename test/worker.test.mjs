import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { handleRequest } from '../worker/src/index.js'
import { dashboardHtml } from '../worker/src/dashboard.js'

const MIGRATIONS = [
  readFileSync(new URL('../worker/migrations/0001_init.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../worker/migrations/0002_invite_code.sql', import.meta.url), 'utf8'),
]
const ADMIN = 'test-admin-token'
const PEPPER = 'test-pepper'

function makeD1() {
  const db = new DatabaseSync(':memory:')
  for (const sql of MIGRATIONS) db.exec(sql)
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
    RELAY_CONTROL_HOST: 'relay.example.com',
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

test('Cloudflare Access 邮箱可打开运维台和总览，非白名单仍拒绝', async () => {
  const env = makeEnv()
  env.ACCESS_ADMIN = '1'
  env.ADMIN_EMAILS = 'owner@example.com'
  const page = await handleRequest(new Request('https://relay.example.com/admin', {
    headers: { 'cf-access-authenticated-user-email': 'owner@example.com' },
  }), env)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /固定地址运维台/)

  const overview = await handleRequest(new Request('https://relay.example.com/admin/relay/v1/overview', {
    headers: { 'cf-access-authenticated-user-email': 'owner@example.com' },
  }), env)
  assert.equal(overview.status, 200)
  const body = await overview.json()
  assert.equal(body.ok, true)
  assert.equal(body.counts.active, 0)
  assert.equal(body.config.dailyReportEnabled, false)

  const denied = await handleRequest(new Request('https://relay.example.com/admin/relay/v1/overview', {
    headers: { 'cf-access-authenticated-user-email': 'other@example.com' },
  }), env)
  assert.equal(denied.status, 401)
})

test('未使用的邀请码可在运维台回看', async () => {
  const env = makeEnv()
  const code = await createInvite(env)
  const response = await handleRequest(req('/admin/relay/v1/invites', { token: ADMIN }), env)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.invites.length, 1)
  assert.equal(body.invites[0].code, code)
  assert.equal(body.invites[0].used_at, undefined)
})

test('关闭邀请码要求后，自服务注册无需邀请码', async () => {
  const env = makeEnv()
  const closed = await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target },
  }), env)
  assert.equal(closed.status, 403)
  assert.equal((await closed.json()).error, 'invite-required')

  const saved = await handleRequest(req('/admin/relay/v1/config', {
    method: 'POST', token: ADMIN, body: { inviteRequired: false },
  }), env)
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).config.inviteRequired, false)

  const opened = await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target },
  }), env)
  assert.equal(opened.status, 200)
  assert.equal((await opened.json()).ok, true)
})

test('运维台总览会合并 B 控制面的租约摘要', async () => {
  const env = makeEnv()
  env.B_CONTROL_URL = 'https://control.example.com'
  env.B_ADMIN_TOKEN = 'b-admin'
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://control.example.com/admin/b/v1/leases')
    assert.equal(init.headers.authorization, 'Bearer b-admin')
    return new Response(JSON.stringify({
      ok: true,
      leases: [{ id: 'abc', hostname: 'abc.dsh-everywhere.com', state: 'active', lastSeenAt: 1, createdAt: 2 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const response = await handleRequest(req('/admin/relay/v1/overview', { token: ADMIN }), env)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.b.ok, true)
    assert.equal(body.b.leases[0].hostname, 'abc.dsh-everywhere.com')
  } finally {
    globalThis.fetch = original
  }
})

test('B 控制面代理：租约和激活码走 A 的服务端凭据', async () => {
  const env = makeEnv()
  env.B_CONTROL_URL = 'https://control.example.com'
  env.B_ADMIN_TOKEN = 'b-admin'
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/admin/b/v1/leases')) {
      return new Response(JSON.stringify({ ok: true, leases: [{ id: 'x', hostname: 'x.dsh-everywhere.com', state: 'active' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: true, code: 'new-code', id: 'x', hostname: 'x.dsh-everywhere.com' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const leases = await handleRequest(req('/admin/relay/v1/b/leases', { token: ADMIN }), env)
    assert.equal(leases.status, 200)
    assert.equal((await leases.json()).leases[0].hostname, 'x.dsh-everywhere.com')
    const invite = await handleRequest(req('/admin/relay/v1/b/invites', { method: 'POST', token: ADMIN, body: { expiresInDays: 7 } }), env)
    assert.equal(invite.status, 200)
    assert.equal((await invite.json()).code, 'new-code')
    assert.equal(calls.length, 2)
    assert.equal(calls[0].init.headers.authorization, 'Bearer b-admin')
    assert.equal(calls[1].init.headers.authorization, 'Bearer b-admin')
  } finally {
    globalThis.fetch = original
  }
})

test('运维台有左侧两条路径导航，不再把所有卡片堆在一个页面', () => {
  assert.match(dashboardHtml, /共享固定地址/)
  assert.match(dashboardHtml, /专属固定地址/)
  assert.match(dashboardHtml, /data-page="overview"/)
  assert.match(dashboardHtml, /data-page="shared"/)
  assert.match(dashboardHtml, /data-page="dedicated"/)
  assert.match(dashboardHtml, /id="page-shared"/)
  assert.match(dashboardHtml, /id="page-dedicated"/)
})

test('运维快照会记录容量、租约和异常，并保留趋势', async () => {
  const env = makeEnv()
  env.B_CONTROL_URL = 'https://control.example.com'
  env.B_ADMIN_TOKEN = 'b-admin'
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    leases: [
      { id: 'a', hostname: 'a.dsh-everywhere.com', state: 'active', lastSeenAt: Date.now() },
      { id: 'b', hostname: 'b.dsh-everywhere.com', state: 'released', releasedAt: Date.now() - 31 * 86400000 },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const response = await handleRequest(req('/admin/relay/v1/ops/refresh', { method: 'POST', token: ADMIN }), env)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.snapshot.b.counts.total, 2)
    assert.equal(body.snapshot.b.counts.active, 1)
    assert.equal(body.snapshot.b.counts.released, 1)
    assert.ok(body.snapshot.anomalies.some((x) => x.code === 'b_released_old'))
    assert.equal(body.history.length, 1)
    const read = await handleRequest(req('/admin/relay/v1/ops/snapshot', { token: ADMIN }), env)
    assert.equal((await read.json()).history.length, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('只读 ops token 可以读快照，但打不开管理页', async () => {
  const env = makeEnv()
  env.OPS_READ_TOKEN = 'ops-read-token'
  const read = await handleRequest(new Request('https://relay.example.com/ops/v1/snapshot', {
    headers: { authorization: 'Bearer ops-read-token' },
  }), env)
  assert.equal(read.status, 200)
  assert.equal((await read.json()).ok, true)
  const page = await handleRequest(new Request('https://relay.example.com/admin', {
    headers: { authorization: 'Bearer ops-read-token' },
  }), env)
  assert.equal(page.status, 401)
})

test('每周清单只读接口会列出 stale / released / invites', async () => {
  const env = makeEnv()
  env.OPS_READ_TOKEN = 'ops-read-token'
  env.B_CONTROL_URL = 'https://control.example.com'
  env.B_ADMIN_TOKEN = 'b-admin'
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    leases: [
      { id: 'a', hostname: 'a.dsh-everywhere.com', state: 'active', lastSeenAt: Date.now() - 8 * 86400000 },
      { id: 'b', hostname: 'b.dsh-everywhere.com', state: 'released', releasedAt: Date.now() - 31 * 86400000 },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const response = await handleRequest(new Request('https://relay.example.com/ops/v1/weekly', {
      headers: { authorization: 'Bearer ops-read-token' },
    }), env)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.b.counts.total, 2)
    assert.equal(body.b.releasedOld.length, 1)
    assert.equal(body.b.activeStale.length, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('A 调 B 管理接口会带 Access 服务令牌头', async () => {
  const env = makeEnv()
  env.B_CONTROL_URL = 'https://control.example.com'
  env.B_ADMIN_TOKEN = 'b-admin'
  env.B_ACCESS_CLIENT_ID = 'access-id'
  env.B_ACCESS_CLIENT_SECRET = 'access-secret'
  const original = globalThis.fetch
  let seen
  globalThis.fetch = async (url, init) => {
    seen = init.headers
    return new Response(JSON.stringify({ ok: true, leases: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const response = await handleRequest(req('/admin/relay/v1/b/leases', { token: ADMIN }), env)
    assert.equal(response.status, 200)
    assert.equal(seen['cf-access-client-id'], 'access-id')
    assert.equal(seen['cf-access-client-secret'], 'access-secret')
    assert.equal(seen.authorization, 'Bearer b-admin')
  } finally {
    globalThis.fetch = original
  }
})

test('每日用量开关可写可读', async () => {
  const env = makeEnv()
  env.ACCESS_ADMIN = '1'
  env.ADMIN_EMAILS = 'owner@example.com'
  const headers = { 'cf-access-authenticated-user-email': 'owner@example.com', 'content-type': 'application/json' }
  const saved = await handleRequest(new Request('https://relay.example.com/admin/relay/v1/config', {
    method: 'POST', headers, body: JSON.stringify({ dailyReportEnabled: true }),
  }), env)
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).config.dailyReportEnabled, true)
  const overview = await handleRequest(new Request('https://relay.example.com/admin/relay/v1/overview', {
    headers: { 'cf-access-authenticated-user-email': 'owner@example.com' },
  }), env)
  assert.equal((await overview.json()).config.dailyReportEnabled, true)
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

test('数据面按 Host 解析 id，转发路径/查询并清理转发头', async () => {
  const env = makeEnv()
  const code = await createInvite(env)
  await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target, inviteCode: code },
  }), env)
  const original = globalThis.fetch
  let seen
  globalThis.fetch = async (url, init) => {
    seen = { url, init }
    return new Response('proxied', { status: 200, headers: { 'content-type': 'text/plain' } })
  }
  try {
    const response = await handleRequest(new Request('https://' + id + '.relay.example.com/mini/api/state?a=1&b=2', {
      headers: {
        'cf-connecting-ip': '1.2.3.4',
        'x-forwarded-for': '5.6.7.8',
        'x-real-ip': '9.9.9.9',
        origin: 'https://' + id + '.relay.example.com',
      },
    }), env)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'proxied')
    assert.equal(seen.url, 'https://quick-one.trycloudflare.com/mini/api/state?a=1&b=2')
    assert.equal(seen.init.headers.get('host'), 'quick-one.trycloudflare.com')
    assert.equal(seen.init.headers.get('cf-connecting-ip'), null)
    assert.equal(seen.init.headers.get('x-forwarded-for'), null)
    assert.equal(seen.init.headers.get('origin'), 'https://' + id + '.relay.example.com')
  } finally {
    globalThis.fetch = original
  }
})

test('数据面无 target 返回离线页，撤销返回 410，不调用上游', async () => {
  const env = makeEnv()
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return new Response('should not') }
  try {
    const missing = await handleRequest(new Request('https://' + id + '.relay.example.com/mini'), env)
    assert.equal(missing.status, 503)
    assert.match(await missing.text(), /当前离线/)
    const code = await createInvite(env)
    await handleRequest(req('/api/relay/v1/register', {
      method: 'PUT', body: { id, secret, target, inviteCode: code },
    }), env)
    await handleRequest(req('/admin/relay/v1/revoke', {
      method: 'POST', token: ADMIN, body: { id, reason: 'test' },
    }), env)
    const revoked = await handleRequest(new Request('https://' + id + '.relay.example.com/mini'), env)
    assert.equal(revoked.status, 410)
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('全局停代理后数据面不转发，管理面仍可恢复', async () => {
  const env = makeEnv()
  const code = await createInvite(env)
  await handleRequest(req('/api/relay/v1/register', {
    method: 'PUT', body: { id, secret, target, inviteCode: code },
  }), env)
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return new Response('should not') }
  try {
    const off = await handleRequest(req('/admin/relay/v1/config', {
      method: 'POST', token: ADMIN, body: { proxyEnabled: false },
    }), env)
    assert.equal(off.status, 200)
    const blocked = await handleRequest(new Request('https://' + id + '.relay.example.com/mini'), env)
    assert.equal(blocked.status, 503)
    assert.equal(blocked.headers.get('x-relay-offline'), 'disabled')
    assert.equal(calls, 0)
    const on = await handleRequest(req('/admin/relay/v1/config', {
      method: 'POST', token: ADMIN, body: { proxyEnabled: true },
    }), env)
    assert.equal(on.status, 200)
    const allowed = await handleRequest(new Request('https://' + id + '.relay.example.com/mini'), env)
    assert.equal(allowed.status, 200)
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('未知 Host 和非法 id 不代理', async () => {
  const env = makeEnv()
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return new Response('no') }
  try {
    const bad = await handleRequest(new Request('https://dsh.relay.example.com/mini'), env)
    assert.equal(bad.status, 404)
    const unknown = await handleRequest(new Request('https://foo.example.com/mini'), env)
    assert.equal(unknown.status, 404)
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = original
  }
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
