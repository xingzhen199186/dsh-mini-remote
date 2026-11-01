import test from 'node:test'
import assert from 'node:assert/strict'
import { claimBody, createEnv, request } from './helpers.mjs'

const REQUEST_PATH = '/api/b/v1/invite-request'
const VERIFY_PATH = '/api/b/v1/invite-verify'

function mailRecorder() {
  const mails = []
  return {
    mails,
    async send(message) {
      mails.push(message)
      return { ok: true }
    },
  }
}

function codeFrom(mail) {
  const match = /\b(\d{6})\b/.exec(mail?.text || '')
  assert.ok(match, '验证码邮件里要有 6 位数字')
  return match[1]
}

async function application(env, email = 'verify@example.com') {
  const mail = mailRecorder()
  env.MAIL_SEND = mail.send
  const requested = await request(env, 'POST', REQUEST_PATH, { email }, { ip: '198.51.100.60' })
  assert.equal(requested.status, 200)
  return { id: requested.body.applicationId, code: codeFrom(mail.mails[0]) }
}

function makeLeaseId(index) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let value = index
  let tail = ''
  for (let position = 0; position < 6; position += 1) {
    tail = alphabet[value % 32] + tail
    value = Math.floor(value / 32)
  }
  return 'a'.repeat(20) + tail
}

function seedInvitedLeases(db, count, expiresAt) {
  const lease = db.prepare(
    'INSERT INTO b_leases (lease_id, hostname, state, tunnel_name, created_at) VALUES (?, ?, \'invited\', ?, ?)',
  )
  const code = db.prepare(
    'INSERT INTO b_activation_codes (code_id, code_hash, lease_id, state, created_at, expires_at) VALUES (?, ?, ?, \'invited\', ?, ?)',
  )
  const now = Date.now()
  for (let index = 0; index < count; index += 1) {
    const id = makeLeaseId(index)
    lease.run(id, `${id}.dsh-everywhere.com`, `dsh-b-relay-${id}`, now)
    code.run(`code-${index}`, `hash-${index}`, id, now, expiresAt)
  }
}

test('自助申请：一个邮箱只能申请一次，验证后能拿到邀请码并 claim', async () => {
  const { env, db } = createEnv()
  const mail = mailRecorder()
  env.MAIL_SEND = mail.send

  const first = await request(env, 'POST', REQUEST_PATH, { email: 'Alice+test@gmail.com' }, { ip: '198.51.100.10' })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(mail.mails.length, 1)
  const requestId = first.body.applicationId
  const code = codeFrom(mail.mails[0])

  const wrong = await request(env, 'POST', VERIFY_PATH, { requestId, code: '000000' }, { ip: '198.51.100.10' })
  assert.equal(wrong.status, 403)
  assert.equal(wrong.body.code, 'invalid_code')

  const verified = await request(env, 'POST', VERIFY_PATH, { requestId, code }, { ip: '198.51.100.10' })
  assert.equal(verified.status, 200, JSON.stringify(verified.body))
  assert.equal(verified.body.ok, true)
  assert.match(verified.body.code, /^[A-Za-z0-9_-]{43}$/)
  assert.match(verified.body.hostname, /\.dsh-everywhere\.com$/)

  const row = db.prepare('SELECT * FROM b_invite_requests').get()
  assert.equal(row.state, 'fulfilled')
  assert.equal(JSON.stringify(row).includes('Alice'), false, '不能存明文邮箱')
  assert.equal(JSON.stringify(row).includes('198.51.100.10'), false, '不能存明文 IP')

  const claimed = await request(env, 'PUT', '/api/b/v1/claim', claimBody(verified.body.code))
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body))
  assert.equal(claimed.body.ok, true)
  assert.equal(claimed.body.state, 'active')

  const again = await request(env, 'POST', REQUEST_PATH, { email: 'alice@gmail.com' }, { ip: '198.51.100.11' })
  assert.equal(again.status, 409)
  assert.equal(again.body.code, 'already_requested')
})

test('自助申请：验证后 15 分钟内可重取同一邀请码和地址，错码和超时不可取', async () => {
  const { env, db } = createEnv()
  const pending = await application(env, 'reveal@example.com')
  const verified = await request(env, 'POST', VERIFY_PATH, { applicationId: pending.id, code: pending.code })
  assert.equal(verified.status, 200)
  const again = await request(env, 'POST', VERIFY_PATH, { applicationId: pending.id, code: pending.code })
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.equal(again.body.code, verified.body.code)
  assert.equal(again.body.hostname, verified.body.hostname)

  const wrongCode = String((Number(pending.code) + 1) % 1_000_000).padStart(6, '0')
  const wrong = await request(env, 'POST', VERIFY_PATH, { applicationId: pending.id, code: wrongCode })
  assert.equal(wrong.status, 403)
  assert.equal(wrong.body.code, 'invalid_code')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_activation_codes').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_leases').get().n, 1)
  const stored = db.prepare('SELECT reveal_ct FROM b_invite_requests WHERE request_id = ?').get(pending.id)
  assert.ok(stored.reveal_ct)
  assert.equal(stored.reveal_ct.includes(verified.body.code), false)

  db.prepare('UPDATE b_invite_requests SET fulfilled_at = ? WHERE request_id = ?')
    .run(Date.now() - 15 * 60 * 1000, pending.id)
  const expired = await request(env, 'POST', VERIFY_PATH, { applicationId: pending.id, code: pending.code })
  assert.equal(expired.status, 410)
  assert.equal(expired.body.code, 'request_expired')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_activation_codes').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_leases').get().n, 1)
})

test('自助申请：过期验证码可复用原申请重发，旧码失效', async () => {
  const { env, db } = createEnv()
  const mail = mailRecorder()
  env.MAIL_SEND = mail.send
  const first = await request(env, 'POST', REQUEST_PATH, { email: 'expired@example.com' }, { ip: '198.51.100.15' })
  assert.equal(first.status, 200)
  const applicationId = first.body.applicationId
  const oldCode = codeFrom(mail.mails[0])
  db.prepare('UPDATE b_invite_requests SET expires_at = ?, verify_attempts = 4 WHERE request_id = ?')
    .run(Date.now() - 1, applicationId)

  const resent = await request(env, 'POST', REQUEST_PATH, { email: 'expired@example.com' }, { ip: '198.51.100.15' })
  assert.equal(resent.status, 200, JSON.stringify(resent.body))
  assert.equal(resent.body.applicationId, applicationId)
  assert.equal(mail.mails.length, 2)
  const newCode = codeFrom(mail.mails[1])
  assert.equal(db.prepare('SELECT verify_attempts FROM b_invite_requests WHERE request_id = ?').get(applicationId).verify_attempts, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_invite_requests').get().n, 1)

  const oldResult = await request(env, 'POST', VERIFY_PATH, { applicationId, code: oldCode })
  assert.equal(oldResult.status, 403)
  assert.equal(oldResult.body.code, 'invalid_code')
  const newResult = await request(env, 'POST', VERIFY_PATH, { applicationId, code: newCode })
  assert.equal(newResult.status, 200, JSON.stringify(newResult.body))
})

test('自助申请：无 MAIL_SEND 且未配置 Turnstile 时失败关闭', async () => {
  const { env, db } = createEnv()
  const result = await request(env, 'POST', REQUEST_PATH, { email: 'turnstile@example.com' })
  assert.equal(result.status, 503)
  assert.equal(result.body.code, 'turnstile_not_configured')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_invite_requests').get().n, 0)
})

test('自助申请：同一 IP 30 天内最多 2 个邮箱', async () => {
  const { env } = createEnv()
  env.MAIL_SEND = async () => ({ ok: true })
  const first = await request(env, 'POST', REQUEST_PATH, { email: 'one@example.com' }, { ip: '198.51.100.20' })
  assert.equal(first.status, 200)
  const second = await request(env, 'POST', REQUEST_PATH, { email: 'two@example.com' }, { ip: '198.51.100.20' })
  assert.equal(second.status, 200)
  const third = await request(env, 'POST', REQUEST_PATH, { email: 'three@example.com' }, { ip: '198.51.100.20' })
  assert.equal(third.status, 409)
  assert.equal(third.body.code, 'ip_limit_reached')
})

test('自助申请：一次性邮箱被拒绝', async () => {
  const { env } = createEnv()
  env.MAIL_SEND = async () => ({ ok: true })
  const result = await request(env, 'POST', REQUEST_PATH, { email: 'x@mailinator.com' }, { ip: '198.51.100.30' })
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'invalid_email')
})

test('自助申请：邮件服务未配置时明确失败，不留下申请记录', async () => {
  const { env, db } = createEnv()
  env.TURNSTILE_SECRET = 'test-secret'
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true }), { headers: { 'content-type': 'application/json' } })
  try {
    const result = await request(env, 'POST', REQUEST_PATH, { email: 'no-mail@example.com', turnstileToken: 'test-token' }, { ip: '198.51.100.40' })
    assert.equal(result.status, 503)
    assert.equal(result.body.code, 'mail_not_configured')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_invite_requests').get().n, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('自助申请页和申请管理接口', async () => {
  const { env, db } = createEnv()
  env.MAIL_SEND = async () => ({ ok: true })
  const page = await (await import('../src/index.js')).handleRequest(new Request('https://control.dsh-everywhere.com/request'), env)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /申请固定地址邀请码/)
  assert.match(html, /invite-request/)
  assert.match(html, /invite-verify/)
  assert.match(html, /localStorage\.getItem\('bRelayApplicationId'\)/)
  assert.match(html, /localStorage\.setItem\('bRelayApplicationId', requestId\)/)

  const first = await request(env, 'POST', REQUEST_PATH, { email: 'admin-list@example.com' }, { ip: '198.51.100.50' })
  assert.equal(first.status, 200)
  const listed = await request(env, 'GET', '/admin/b/v1/requests', undefined, { admin: true })
  assert.equal(listed.status, 200)
  assert.equal(listed.body.requests.length, 1)
  assert.equal(listed.body.requests[0].email, 'a***@example.com')

  const removed = await request(env, 'DELETE', '/admin/b/v1/requests/' + first.body.applicationId, undefined, { admin: true })
  assert.equal(removed.status, 200)
  assert.equal(removed.body.deleted, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_invite_requests').get().n, 0)
})

test('邮箱验证并发提交：只占住一次 pending，创建一份邀请和一份租约', async () => {
  const { env, db } = createEnv()
  const pending = await application(env, 'concurrent@example.com')
  const results = await Promise.all([
    request(env, 'POST', VERIFY_PATH, { applicationId: pending.id, code: pending.code }),
    request(env, 'POST', VERIFY_PATH, { applicationId: pending.id, code: pending.code }),
  ])
  assert.equal(results.filter((result) => result.status === 200).length, 1)
  const rejected = results.find((result) => result.status !== 200)
  assert.equal(rejected.status, 404)
  assert.equal(rejected.body.code, 'request_not_found')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_activation_codes').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_leases').get().n, 1)
  assert.equal(db.prepare('SELECT state FROM b_invite_requests WHERE request_id = ?').get(pending.id).state, 'fulfilled')
})

test('邀请创建失败：申请回到 pending，不留下邀请或租约', async () => {
  const { env, db } = createEnv()
  const pending = await application(env, 'create-failure@example.com')
  const prepare = env.DB.prepare.bind(env.DB)
  env.DB.prepare = (sql) => {
    if (sql.startsWith('INSERT INTO b_activation_codes')) {
      return { bind: () => ({ run: async () => { throw new Error('injected invite failure') } }) }
    }
    return prepare(sql)
  }
  const result = await request(env, 'POST', VERIFY_PATH, { applicationId: pending.id, code: pending.code })
  assert.equal(result.status, 503)
  assert.equal(result.body.code, 'storage_unavailable')
  assert.equal(db.prepare('SELECT state FROM b_invite_requests WHERE request_id = ?').get(pending.id).state, 'pending')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_activation_codes').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_leases').get().n, 0)
})

test('900 条已过期未认领邀请会退休并留审计，不再挡住新邀请', async () => {
  const { env, db, cf } = createEnv()
  seedInvitedLeases(db, 900, Date.now() - 1000)
  const created = await request(env, 'POST', '/admin/b/v1/invites', { note: 'after expiry cleanup' }, { admin: true })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.equal(created.body.ok, true)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM b_leases WHERE state = 'retired'").get().n, 900)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM b_leases WHERE state = 'invited'").get().n, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM b_activation_codes WHERE state = 'revoked'").get().n, 900)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM b_admin_audit WHERE action = 'invite.expire'").get().n, 900)
  assert.equal(cf.calls.length, 0)
})

test('900 条未过期 invited 租约仍计入容量', async () => {
  const { env, db, cf } = createEnv()
  seedInvitedLeases(db, 900, Date.now() + 86400000)
  const created = await request(env, 'POST', '/admin/b/v1/invites', { note: 'must stay full' }, { admin: true })
  assert.equal(created.status, 503)
  assert.equal(created.body.code, 'self_service_capacity')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM b_leases WHERE state = 'invited'").get().n, 900)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM b_admin_audit WHERE action = 'invite.expire'").get().n, 0)
  assert.equal(cf.calls.length, 0)
})
