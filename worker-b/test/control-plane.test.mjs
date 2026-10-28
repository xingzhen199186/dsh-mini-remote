import test from 'node:test'
import assert from 'node:assert/strict'
import { activate, CLAIM_ID, claimBody, CLIENT_SECRET, createEnv, invite, OTHER_SECRET, request } from './helpers.mjs'

const CLAIM_PATH = '/api/b/v1/claim'

async function claim(env, code, extra) {
  return await request(env, 'PUT', CLAIM_PATH, claimBody(code, extra))
}

test('admin creates one-time code; claim converges one Tunnel, ingress and CNAME', async () => {
  const { env, db, cf } = createEnv()
  const denied = await request(env, 'POST', '/admin/b/v1/invites', {})
  assert.equal(denied.status, 401)
  assert.deepEqual(Object.keys(denied.body).sort(), ['code', 'ok', 'requestId', 'retryable'].sort())

  const invitation = await invite(env, { note: 'one laptop', expiresInDays: 3 })
  assert.match(invitation.id, /^[a-z2-7]{26}$/)
  assert.equal(invitation.hostname, invitation.id + '.dsh-everywhere.com')
  const codeRow = db.prepare('SELECT code_hash, note, state FROM b_activation_codes').get()
  assert.equal(codeRow.note, 'one laptop')
  assert.equal(codeRow.state, 'invited')
  assert.notEqual(codeRow.code_hash, invitation.code)
  assert.equal(JSON.stringify(codeRow).includes(invitation.code), false)

  const result = await claim(env, invitation.code)
  assert.equal(result.status, 200)
  assert.equal(result.body.state, 'active')
  assert.equal(result.body.id, invitation.id)
  assert.equal(result.body.hostname, invitation.hostname)
  assert.equal(result.body.tunnelToken, 'test-tunnel-token:tunnel-1')
  assert.equal(cf.createdTunnelCount, 1)
  const tunnel = cf.tunnels.get('tunnel-1')
  assert.deepEqual(tunnel.ingress, [
    { hostname: invitation.hostname, service: 'http://127.0.0.1:3090' },
    { service: 'http_status:404' },
  ])
  const dns = [...cf.dnsRecords.values()][0]
  assert.equal(dns.content, 'tunnel-1.cfargotunnel.com')
  assert.equal(dns.proxied, true)

  const lease = db.prepare('SELECT * FROM b_leases').get()
  assert.equal(lease.state, 'active')
  assert.equal(lease.origin_port, 3090)
  assert.equal(lease.client_secret_hash.includes(CLIENT_SECRET), false)
  assert.equal(db.prepare("SELECT state FROM b_operations WHERE type = 'claim'").get().state, 'succeeded')
  const listed = await request(env, 'GET', '/admin/b/v1/leases', undefined, { admin: true })
  assert.equal(listed.body.leases.length, 1)
  assert.equal(listed.body.leases[0].state, 'active')
  assert.equal('clientSecretHash' in listed.body.leases[0], false)
  assert.equal('tunnelToken' in listed.body.leases[0], false)
})

test('same claim retry is idempotent and does not create another Tunnel', async () => {
  const { env, db, cf } = createEnv()
  const invitation = await invite(env)
  const first = await claim(env, invitation.code)
  const retry = await claim(env, invitation.code)
  assert.equal(first.body.ok, true)
  assert.equal(retry.body.ok, true)
  assert.equal(retry.body.tunnelToken, first.body.tunnelToken)
  assert.equal(cf.createdTunnelCount, 1)
  assert.equal(cf.createTunnelCalls, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM b_operations WHERE type = 'claim'").get().n, 1)
  assert.equal(db.prepare('SELECT state FROM b_activation_codes').get().state, 'claimed')
})

test('same activation code cannot be rebound to a different clientSecret', async () => {
  const { env, cf } = createEnv()
  const invitation = await invite(env)
  await claim(env, invitation.code)
  const result = await claim(env, invitation.code, { clientSecret: OTHER_SECRET })
  assert.equal(result.status, 403)
  assert.equal(result.body.code, 'auth_failed')
  assert.equal('tunnelToken' in result.body, false)
  assert.equal(cf.createdTunnelCount, 1)
})

test('concurrent claims with different secrets have exactly one winner', async () => {
  const { env, db, cf } = createEnv()
  const invitation = await invite(env)
  const results = await Promise.all([
    claim(env, invitation.code),
    claim(env, invitation.code, { clientSecret: OTHER_SECRET }),
  ])
  assert.equal(results.filter((result) => result.body.ok).length, 1)
  assert.equal(results.filter((result) => result.status === 403).length, 1)
  assert.equal(cf.createdTunnelCount, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM b_operations WHERE type = 'claim'").get().n, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM b_admin_audit WHERE action = 'activation.claim'").get().n, 1)
})

test('same claimRequestId with a different port is an idempotency conflict', async () => {
  const { env, cf } = createEnv()
  const invitation = await invite(env)
  await claim(env, invitation.code)
  const result = await claim(env, invitation.code, { originPort: 3091 })
  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'idempotency_conflict')
  assert.equal(cf.createdTunnelCount, 1)
  assert.equal(cf.tunnels.get('tunnel-1').ingress[0].service, 'http://127.0.0.1:3090')
})

test('failure after Tunnel creation stays claimed and retry converges the same Tunnel', async () => {
  const { env, db, cf } = createEnv()
  const invitation = await invite(env)
  cf.failNext('putTunnelConfiguration')
  const failed = await claim(env, invitation.code)
  assert.equal(failed.status, 502)
  assert.equal(failed.body.code, 'cf_api_unavailable')
  assert.equal(db.prepare('SELECT state FROM b_leases').get().state, 'claimed')
  assert.equal(cf.createdTunnelCount, 1)

  const retry = await claim(env, invitation.code)
  assert.equal(retry.body.ok, true)
  assert.equal(cf.createdTunnelCount, 1)
  assert.equal(cf.tunnels.size, 1)
  assert.equal(db.prepare('SELECT state FROM b_leases').get().state, 'active')
})

test('lost createTunnel response is recovered by deterministic name', async () => {
  const { env, cf } = createEnv()
  const invitation = await invite(env)
  cf.failNext('createTunnel', 'after')
  const failed = await claim(env, invitation.code)
  assert.equal(failed.status, 502)
  assert.equal(cf.createdTunnelCount, 1)

  const retry = await claim(env, invitation.code)
  assert.equal(retry.body.ok, true)
  assert.equal(cf.createTunnelCalls, 1)
  assert.equal(cf.createdTunnelCount, 1)
  assert.equal(cf.tunnels.size, 1)
})

test('unknown DNS record is never overwritten and returns resource_conflict', async () => {
  const { env, db, cf } = createEnv()
  const invitation = await invite(env)
  cf.dnsRecords.set('external-dns', { id: 'external-dns', type: 'A', name: invitation.hostname, content: '192.0.2.20' })
  const result = await claim(env, invitation.code)
  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'resource_conflict')
  assert.equal(cf.createdTunnelCount, 0)
  assert.equal(cf.dnsRecords.get('external-dns').content, '192.0.2.20')
  assert.equal(db.prepare('SELECT state FROM b_leases').get().state, 'claimed')
  assert.equal('tunnelToken' in result.body, false)
})

test('status and renew authenticate without returning a token; port renewal updates ingress', async () => {
  const { env, cf, id } = await (async () => {
    const context = createEnv()
    const active = await activate(context.env)
    return { ...context, ...active }
  })()
  cf.calls = []
  const status = await request(env, 'POST', '/api/b/v1/status', { id, clientSecret: CLIENT_SECRET })
  assert.equal(status.body.state, 'active')
  assert.equal('tunnelToken' in status.body, false)

  const renewed = await request(env, 'POST', '/api/b/v1/renew', { id, clientSecret: CLIENT_SECRET, originPort: 3090 })
  assert.equal(renewed.body.ok, true)
  assert.equal('tunnelToken' in renewed.body, false)
  assert.equal(cf.calls.includes('getTunnelToken'), false)
  assert.equal(cf.calls.includes('putTunnelConfiguration'), false)

  const moved = await request(env, 'POST', '/api/b/v1/renew', { id, clientSecret: CLIENT_SECRET, originPort: 3091 })
  assert.equal(moved.body.ok, true)
  assert.equal(moved.body.configVersion, 2)
  assert.equal('tunnelToken' in moved.body, false)
  assert.equal(cf.tunnels.get('tunnel-1').ingress[0].service, 'http://127.0.0.1:3091')

  const denied = await request(env, 'POST', '/api/b/v1/status', { id, clientSecret: OTHER_SECRET })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.code, 'auth_failed')
  assert.equal('hostname' in denied.body, false)
})

test('release is reentrant, retains resources for 30 days and blocks renew', async () => {
  const context = createEnv()
  const { id } = await activate(context.env)
  const { env, cf } = context
  const first = await request(env, 'POST', '/api/b/v1/release', { id, clientSecret: CLIENT_SECRET })
  assert.equal(first.body.state, 'released')
  assert.equal(first.body.retainUntil - first.body.releasedAt, 30 * 24 * 60 * 60 * 1000)
  assert.equal(first.body.resourcesRetained, true)
  const second = await request(env, 'POST', '/api/b/v1/release', { id, clientSecret: CLIENT_SECRET })
  assert.equal(second.body.releasedAt, first.body.releasedAt)
  assert.equal(cf.tunnels.size, 1)
  assert.equal(cf.dnsRecords.size, 1)
  const renewed = await request(env, 'POST', '/api/b/v1/renew', { id, clientSecret: CLIENT_SECRET })
  assert.equal(renewed.status, 409)
  assert.equal(renewed.body.code, 'state_conflict')
})

test('retire deletes DNS before Tunnel, is reentrant and leaves a tombstone', async () => {
  const context = createEnv()
  const { id, hostname } = await activate(context.env)
  const { env, cf, db } = context
  await request(env, 'POST', '/api/b/v1/release', { id, clientSecret: CLIENT_SECRET })
  cf.calls = []
  const retired = await request(env, 'POST', '/api/b/v1/retire', { id, clientSecret: CLIENT_SECRET })
  assert.equal(retired.body.ok, true)
  assert.equal(retired.body.state, 'retired')
  assert.ok(cf.calls.indexOf('deleteDnsRecord') < cf.calls.indexOf('deleteTunnel'))
  assert.equal(cf.dnsRecords.size, 0)
  assert.equal(cf.tunnels.size, 0)
  const tombstone = db.prepare('SELECT state, lease_id, tunnel_id FROM b_leases').get()
  assert.equal(tombstone.state, 'retired')
  assert.equal(tombstone.lease_id, id)
  assert.equal(tombstone.tunnel_id, 'tunnel-1')

  const callCount = cf.calls.length
  const repeated = await request(env, 'POST', '/api/b/v1/retire', { id, clientSecret: CLIENT_SECRET })
  assert.equal(repeated.body.state, 'retired')
  assert.equal(cf.calls.length, callCount)
  const status = await request(env, 'POST', '/api/b/v1/status', { id, clientSecret: CLIENT_SECRET })
  assert.equal(status.body.state, 'retired')
  assert.equal(status.body.hostname, hostname)
  const renewed = await request(env, 'POST', '/api/b/v1/renew', { id, clientSecret: CLIENT_SECRET })
  assert.equal(renewed.status, 410)
  assert.equal(renewed.body.code, 'lease_retired')
})

test('retire retry resumes after DNS deletion without repeating that delete', async () => {
  const context = createEnv()
  const { id } = await activate(context.env)
  const { env, cf, db } = context
  cf.failNext('deleteTunnel')
  const failed = await request(env, 'POST', '/api/b/v1/retire', { id, clientSecret: CLIENT_SECRET })
  assert.equal(failed.status, 502)
  assert.equal(cf.dnsRecords.size, 0)
  assert.equal(cf.tunnels.size, 1)
  assert.notEqual(db.prepare('SELECT state FROM b_leases').get().state, 'retired')

  const retry = await request(env, 'POST', '/api/b/v1/retire', { id, clientSecret: CLIENT_SECRET })
  assert.equal(retry.body.state, 'retired')
  assert.equal(cf.calls.filter((call) => call === 'deleteDnsRecord').length, 1)
  assert.equal(cf.tunnels.size, 0)
  assert.equal(db.prepare('SELECT state FROM b_leases').get().state, 'retired')
})

test('expired and unknown activation codes create no Cloudflare resources', async () => {
  const { env, db, cf } = createEnv()
  const invitation = await invite(env)
  db.prepare('UPDATE b_activation_codes SET expires_at = ?').run(Date.now() - 1)
  const expired = await claim(env, invitation.code)
  assert.equal(expired.status, 410)
  assert.equal(expired.body.code, 'activation_expired')
  const unknown = await claim(env, 'c'.repeat(43))
  assert.equal(unknown.status, 403)
  assert.equal(cf.createdTunnelCount, 0)
  assert.equal(cf.dnsRecords.size, 0)
})

test('rate limit and error envelope are machine readable', async () => {
  const context = createEnv()
  const { id } = await activate(context.env)
  const { env } = context
  for (let index = 0; index < 60; index += 1) {
    const result = await request(env, 'POST', '/api/b/v1/status', { id, clientSecret: CLIENT_SECRET })
    assert.equal(result.status, 200)
  }
  const limited = await request(env, 'POST', '/api/b/v1/status', { id, clientSecret: CLIENT_SECRET })
  assert.equal(limited.status, 429)
  assert.equal(limited.body.ok, false)
  assert.equal(limited.body.code, 'rate_limited')
  assert.equal(limited.body.retryable, true)
  assert.equal(typeof limited.body.requestId, 'string')
  assert.ok(Number(limited.response.headers.get('retry-after')) > 0)
  assert.equal('tunnelToken' in limited.body, false)
  assert.equal(CLAIM_ID.length >= 8, true)
})
