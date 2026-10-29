import test from 'node:test'
import assert from 'node:assert/strict'

import { activate, createEnv, request, CLIENT_SECRET, OTHER_SECRET } from './helpers.mjs'

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

function makeLeaseId(index) {
  let value = index
  let tail = ''
  for (let i = 0; i < 6; i += 1) {
    tail = ID_ALPHABET[value % 32] + tail
    value = Math.floor(value / 32)
  }
  return 'a'.repeat(20) + tail
}

async function selfClaim(env, {
  requestId,
  secret = CLIENT_SECRET,
  originPort = 3090,
  ip = '198.51.100.10',
  activationCode,
} = {}) {
  const body = { clientSecret: secret, claimRequestId: requestId, originPort }
  if (activationCode !== undefined) body.activationCode = activationCode
  return await request(env, 'PUT', '/api/b/v1/claim', body, { ip })
}

async function openSelfService(env) {
  const result = await request(env, 'POST', '/admin/b/v1/config', {
    registrationEnabled: true,
    inviteRequired: false,
  }, { admin: true })
  assert.equal(result.status, 200)
  assert.equal(result.body.registrationEnabled, true)
  assert.equal(result.body.inviteRequired, false)
}

function seedActiveLeases(db, count) {
  const statement = db.prepare(
    'INSERT INTO b_leases '
    + '(lease_id, hostname, state, origin_port, tunnel_name, created_at, last_seen_at) '
    + 'VALUES (?, ?, \'active\', ?, ?, ?, ?)',
  )
  const now = Date.now()
  for (let index = 0; index < count; index += 1) {
    const id = makeLeaseId(index)
    statement.run(id, `${id}.dsh-everywhere.com`, 3090, `dsh-b-relay-${id}`, now, now)
  }
}

test('admin config：默认 true，可切换，非法值拒绝并留下审计', async () => {
  const { env, db } = createEnv()
  const denied = await request(env, 'GET', '/admin/b/v1/config')
  assert.equal(denied.status, 401)

  const first = await request(env, 'GET', '/admin/b/v1/config', undefined, { admin: true })
  assert.equal(first.status, 200)
  assert.equal(first.body.registrationEnabled, true)
  assert.equal(first.body.inviteRequired, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_config').get().n, 2)

  const changed = await request(env, 'POST', '/admin/b/v1/config', {
    registrationEnabled: true,
    inviteRequired: false,
  }, { admin: true })
  assert.equal(changed.status, 200)
  assert.equal(changed.body.registrationEnabled, true)
  assert.equal(changed.body.inviteRequired, false)

  const again = await request(env, 'GET', '/admin/b/v1/config', undefined, { admin: true })
  assert.equal(again.body.inviteRequired, false)
  assert.equal(db.prepare("SELECT value FROM b_config WHERE key = 'inviteRequired'").get().value, '0')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM b_admin_audit WHERE action = 'config.update'").get().n, 1)

  const invalid = await request(env, 'POST', '/admin/b/v1/config', {
    registrationEnabled: 'yes',
  }, { admin: true })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.code, 'invalid_request')
  const empty = await request(env, 'POST', '/admin/b/v1/config', {}, { admin: true })
  assert.equal(empty.status, 400)
  const wrongMethod = await request(env, 'PUT', '/admin/b/v1/config', {}, { admin: true })
  assert.equal(wrongMethod.status, 405)
})

test('无激活码且默认 inviteRequired=true：返回 invite_required，不创建资源', async () => {
  const { env, cf } = createEnv()
  const result = await selfClaim(env, { requestId: 'self-default-0001' })
  assert.equal(result.status, 403)
  assert.equal(result.body.code, 'invite_required')
  assert.equal(result.body.retryable, false)
  assert.equal(cf.createdTunnelCount, 0)
  assert.equal(cf.calls.length, 0)
})

test('自服务开通：成功落 claim_request_id，同 claimRequestId 幂等且不重复建 Tunnel', async () => {
  const { env, db, cf } = createEnv()
  await openSelfService(env)

  const first = await selfClaim(env, { requestId: 'self-open-0001' })
  assert.equal(first.status, 200)
  assert.equal(first.body.state, 'active')
  assert.match(first.body.id, /^[a-z2-7]{26}$/)
  assert.equal(first.body.hostname, `${first.body.id}.dsh-everywhere.com`)
  assert.equal(cf.createdTunnelCount, 1)
  const lease = db.prepare('SELECT state, claim_request_id, client_secret_hash FROM b_leases').get()
  assert.equal(lease.state, 'active')
  assert.equal(lease.claim_request_id, 'self-open-0001')
  assert.notEqual(lease.client_secret_hash, CLIENT_SECRET)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM b_operations WHERE type = 'claim'").get().n, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM b_admin_audit WHERE action = 'lease.self_register'").get().n, 1)

  const retry = await selfClaim(env, { requestId: 'self-open-0001' })
  assert.equal(retry.status, 200)
  assert.equal(retry.body.id, first.body.id)
  assert.equal(retry.body.hostname, first.body.hostname)
  assert.equal(retry.body.tunnelToken, first.body.tunnelToken)
  assert.equal(cf.createdTunnelCount, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_leases').get().n, 1)

  const wrongSecret = await selfClaim(env, { requestId: 'self-open-0001', secret: OTHER_SECRET })
  assert.equal(wrongSecret.status, 403)
  assert.equal(wrongSecret.body.code, 'auth_failed')

  const changedPort = await selfClaim(env, { requestId: 'self-open-0001', originPort: 3091 })
  assert.equal(changedPort.status, 409)
  assert.equal(changedPort.body.code, 'idempotency_conflict')
  assert.equal(cf.createdTunnelCount, 1)
})

test('registrationEnabled=false：无码拒绝；已有激活码路径仍照常可用', async () => {
  const { env } = createEnv()
  await request(env, 'POST', '/admin/b/v1/config', {
    registrationEnabled: false,
    inviteRequired: true,
  }, { admin: true })

  const closed = await selfClaim(env, { requestId: 'self-closed-0001' })
  assert.equal(closed.status, 403)
  assert.equal(closed.body.code, 'registration_closed')

  const active = await activate(env)
  assert.equal(active.claim.body.state, 'active')
  assert.equal(active.claim.status, 200)

  // 注册关闭时，即使 Worker 没配 Cloudflare API，也应先明确说“注册关闭”。
  delete env.CF_RELAY_API
  const closedWithoutApi = await selfClaim(env, { requestId: 'self-closed-0002' })
  assert.equal(closedWithoutApi.status, 403)
  assert.equal(closedWithoutApi.body.code, 'registration_closed')
})

test('自服务每 IP 每小时最多 3 次：第 4 次返回 429', async () => {
  const { env, cf } = createEnv()
  await openSelfService(env)
  for (let index = 0; index < 3; index += 1) {
    const result = await selfClaim(env, {
      requestId: `self-ip-000${index}`,
      ip: '198.51.100.77',
    })
    assert.equal(result.status, 200, `第 ${index + 1} 次应成功`)
  }
  const limited = await selfClaim(env, {
    requestId: 'self-ip-0004',
    ip: '198.51.100.77',
  })
  assert.equal(limited.status, 429)
  assert.equal(limited.body.code, 'rate_limited')
  assert.equal(limited.body.retryable, true)
  assert.ok(Number(limited.body.retryAfter) > 0)
  assert.equal(cf.createdTunnelCount, 3)
})

test('自服务全局每天最多 50 次：计数已满时拒绝', async () => {
  const { env, db, cf } = createEnv()
  await openSelfService(env)
  const windowStart = Math.floor(Date.now() / 86_400_000) * 86_400_000
  db.prepare('INSERT INTO b_rate_limits (bucket, window_start, count) VALUES (?, ?, ?)')
    .run('claim:self:global', windowStart, 50)

  const limited = await selfClaim(env, {
    requestId: 'self-global-0001',
    ip: '198.51.100.88',
  })
  assert.equal(limited.status, 429)
  assert.equal(limited.body.code, 'rate_limited')
  assert.equal(cf.createdTunnelCount, 0)
})

test('容量上限 900：active+claimed+released 已满时拒绝 self_service_capacity', async () => {
  const { env, db, cf } = createEnv()
  await openSelfService(env)
  seedActiveLeases(db, 900)

  const result = await selfClaim(env, {
    requestId: 'self-capacity-0001',
    ip: '198.51.100.99',
  })
  assert.equal(result.status, 503)
  assert.equal(result.body.code, 'self_service_capacity')
  assert.equal(result.body.retryable, false)
  assert.equal(cf.createdTunnelCount, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_leases').get().n, 900)
})

test('缺激活码但带着无效激活码形状：仍按 invalid_request 拒绝，不落到自服务', async () => {
  const { env, cf } = createEnv()
  await openSelfService(env)
  const result = await selfClaim(env, {
    requestId: 'self-invalid-code-1',
    activationCode: 'short',
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'invalid_request')
  assert.equal(cf.createdTunnelCount, 0)
})
