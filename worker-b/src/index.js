import { CloudflareError, cloudflareApiOf } from './cloudflare.js'
import { requestPageHtml } from './request-page.js'

const ID_RE = /^[a-z2-7]{26}$/
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/
const MAX_BODY_BYTES = 4 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
const RELEASE_RETENTION_MS = 30 * DAY_MS
const TUNNEL_PREFIX = 'dsh-b-relay-'
const OPS_RETIRE_LIMIT = 10
const OPS_RECONCILE_LIMIT = 50
const OPS_FINDINGS_LIMIT = 500
const DEFAULT_MAX_LEASES = 900
const VERIFY_TTL_MS = 10 * 60 * 1000
const REVEAL_TTL_MS = 15 * 60 * 1000
const VERIFY_MAX_ATTEMPTS = 5
const FULFILL_RESERVATION_TTL_MS = 5 * 60 * 1000
const REQUEST_RESEND_MS = 60 * 1000
const REQUEST_DAILY_LIMIT = 100
const IP_REQUEST_LIMIT = 2
const IP_REQUEST_WINDOW_MS = 30 * DAY_MS

class ControlError extends Error {
  constructor(code, status = 409, retryable = false) {
    super(code)
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      ...headers,
    },
  })
}

function ok(requestId, data, status = 200) {
  return json({ ok: true, ...data, requestId }, status)
}

function fail(requestId, code, status, retryable = false, retryAfter) {
  return json(
    { ok: false, code, retryable, requestId, ...(retryAfter ? { retryAfter } : {}) },
    status,
    retryAfter ? { 'retry-after': String(retryAfter) } : {},
  )
}

function base64url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid reveal data')
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function randomId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const bytes = crypto.getRandomValues(new Uint8Array(26))
  return [...bytes].map((byte) => alphabet[byte & 31]).join('')
}

function randomSecret() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

function randomCode() {
  const value = new Uint32Array(1)
  crypto.getRandomValues(value)
  return String(value[0] % 1_000_000).padStart(6, '0')
}

async function hmac(env, purpose, value) {
  if (!env.B_PEPPER) throw new Error('B_PEPPER is not configured')
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.B_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(purpose + ':' + value))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function revealKey(env, applicationId, code) {
  const material = await hmac(env, 'reveal', applicationId + ':' + code)
  const materialBytes = Uint8Array.from(material.match(/../g), (byte) => parseInt(byte, 16))
  const digest = await crypto.subtle.digest('SHA-256', materialBytes)
  return await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function sealReveal(env, applicationId, code, inviteCode) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await revealKey(env, applicationId, code)
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(inviteCode))
  return { iv: base64url(iv), ct: base64url(new Uint8Array(encrypted)) }
}

async function openReveal(env, applicationId, code, iv, ciphertext) {
  const key = await revealKey(env, applicationId, code)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64urlBytes(iv) }, key, base64urlBytes(ciphertext),
  )
  return new TextDecoder().decode(decrypted)
}

async function digestHex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}

async function readJson(request) {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return { error: 'invalid_request' }
  if (!text.trim()) return {}
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { error: 'invalid_request' }
  } catch {
    return { error: 'invalid_request' }
  }
}

function suffixOf(env) {
  return String(env.B_SUFFIX || 'dsh-everywhere.com').replace(/^\.+/, '')
}

function hostnameOf(env, id) {
  return id + '.' + suffixOf(env)
}

function tunnelNameOf(id) {
  return TUNNEL_PREFIX + id
}

function dnsTargetOf(tunnelId) {
  return tunnelId + '.cfargotunnel.com'
}

function ingressOf(hostname, port) {
  return [
    { hostname, service: 'http://127.0.0.1:' + String(port) },
    { service: 'http_status:404' },
  ]
}

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}

function clientIp(request) {
  return (request.headers.get('cf-connecting-ip') || 'unknown').split(',')[0].trim()
}

function configValue(rows, key) {
  const row = (rows || []).find((item) => item.key === key)
  if (!row) return true
  return String(row.value) !== '0'
}

async function readBConfig(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM b_config').all()
  const maxLeasesRow = (rows.results || []).find((item) => item.key === 'maxLeases')
  const maxLeases = Number(maxLeasesRow?.value)
  return {
    registrationEnabled: configValue(rows.results, 'registrationEnabled'),
    inviteRequired: configValue(rows.results, 'inviteRequired'),
    maxLeases: Number.isInteger(maxLeases) && maxLeases > 0 ? Math.min(maxLeases, 1000) : DEFAULT_MAX_LEASES,
  }
}

async function spendRate(env, bucket, maximum, windowSeconds) {
  const now = Date.now()
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000
  const row = await env.DB.prepare(
    'INSERT INTO b_rate_limits (bucket, window_start, count) VALUES (?, ?, 1) '
    + 'ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count',
  ).bind(bucket, windowStart).first()
  if (Number(row?.count || 0) <= maximum) return 0
  return Math.max(1, Math.ceil((windowStart + windowSeconds * 1000 - now) / 1000))
}

function auditStatement(env, { actor, action, leaseId = null, codeId = null, requestId, before = null, after = null, result }) {
  return env.DB.prepare(
    'INSERT INTO b_admin_audit (actor, action, lease_id, code_id, request_id, before_state, after_state, result, created_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(actor, action, leaseId, codeId, requestId, before, after, result, Date.now())
}

function inventoryStatement(env, type, resourceId, leaseId, operationId, driftState = 'converged') {
  const now = Date.now()
  return env.DB.prepare(
    'INSERT INTO b_resource_inventory '
    + '(environment, resource_type, resource_id, lease_id, owning_operation_id, first_seen_at, last_reconciled_at, drift_state) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(environment, resource_type, resource_id) DO UPDATE SET '
    + 'lease_id = excluded.lease_id, owning_operation_id = excluded.owning_operation_id, '
    + 'last_reconciled_at = excluded.last_reconciled_at, drift_state = excluded.drift_state',
  ).bind(env.B_CONTROL_HOST || 'default', type, resourceId, leaseId, operationId, now, now, driftState)
}

async function leaseOf(env, id) {
  return await env.DB.prepare('SELECT * FROM b_leases WHERE lease_id = ?').bind(id).first()
}

async function authenticatedLease(env, id, clientSecret) {
  const lease = await leaseOf(env, id)
  if (!lease?.client_secret_hash) return undefined
  const hash = await hmac(env, 'client', id + ':' + clientSecret)
  return timingSafeEqual(lease.client_secret_hash, hash) ? lease : undefined
}

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'temp-mail.org',
  'yopmail.com', 'throwawaymail.com', 'getnada.com', 'sharklasers.com',
])

/** 归一化邮箱；只返回可入库的形状，不把原文写进数据库。 */
function normalizeEmail(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  const at = raw.lastIndexOf('@')
  if (at <= 0 || at === raw.length - 1 || raw.length > 254) return null
  let local = raw.slice(0, at)
  let domain = raw.slice(at + 1)
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return null
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return null
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.split('+')[0].replace(/\./g, '')
    domain = 'gmail.com'
  } else {
    local = local.split('+')[0]
  }
  if (!local) return null
  const normalized = local + '@' + domain
  const masked = local.slice(0, 1) + '***@' + domain
  return { normalized, masked }
}

async function sendMail(env, { to, subject, text }) {
  if (typeof env.MAIL_SEND === 'function') return await env.MAIL_SEND({ to, subject, text })
  if (!env.RESEND_API_KEY) return { ok: false, code: 'mail_not_configured' }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.B_MAIL_FROM || 'dsh-mini-remote <no-reply@dsh-everywhere.com>',
        to: [to],
        subject,
        text,
      }),
    })
    if (!response.ok) return { ok: false, code: 'mail_failed' }
    return { ok: true }
  } catch {
    return { ok: false, code: 'mail_failed' }
  }
}

async function verifyTurnstile(env, token, ip) {
  const secret = typeof env.TURNSTILE_SECRET === 'string' ? env.TURNSTILE_SECRET : ''
  if (!secret) return typeof env.MAIL_SEND === 'function' ? true : null
  if (typeof token !== 'string' || !token) return false
  try {
    const body = new URLSearchParams({ secret, response: token, remoteip: ip })
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body })
    const result = await response.json().catch(() => null)
    return result?.success === true
  } catch {
    return false
  }
}

async function retireExpiredInvites(env, { now, actor, requestId }) {
  const eligible = 'l.state = \'invited\' AND l.tunnel_id IS NULL AND l.dns_record_id IS NULL '
    + 'AND c.state = \'invited\' AND c.expires_at <= ?'
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO b_admin_audit (actor, action, lease_id, code_id, request_id, before_state, after_state, result, created_at) '
      + 'SELECT ?, \'invite.expire\', l.lease_id, c.code_id, ?, \'invited\', \'retired\', \'succeeded\', ? '
      + 'FROM b_leases l JOIN b_activation_codes c ON c.lease_id = l.lease_id WHERE ' + eligible,
    ).bind(actor, requestId, now, now),
    env.DB.prepare(
      'UPDATE b_leases SET state = \'retired\', retired_at = ?, row_version = row_version + 1 '
      + 'WHERE state = \'invited\' AND tunnel_id IS NULL AND dns_record_id IS NULL AND EXISTS ('
      + 'SELECT 1 FROM b_activation_codes c WHERE c.lease_id = b_leases.lease_id '
      + 'AND c.state = \'invited\' AND c.expires_at <= ?)',
    ).bind(now, now),
    env.DB.prepare(
      'UPDATE b_activation_codes SET state = \'revoked\', revoked_at = ? '
      + 'WHERE state = \'invited\' AND expires_at <= ? AND EXISTS ('
      + 'SELECT 1 FROM b_leases l WHERE l.lease_id = b_activation_codes.lease_id '
      + 'AND l.state = \'retired\' AND l.retired_at = ?)',
    ).bind(now, now, now),
  ])
}

async function createInvite(env, { note = null, days = 7, actor = 'admin-token', requestId, fulfillRequest = null }) {
  const now = Date.now()
  await retireExpiredInvites(env, { now, actor, requestId })
  const config = await readBConfig(env)
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM b_leases WHERE state IN (\'invited\', \'active\', \'claimed\', \'released\')',
  ).first()
  if (Number(count?.n || 0) >= config.maxLeases) return { ok: false, code: 'self_service_capacity' }
  const id = randomId()
  const code = randomSecret()
  const codeId = crypto.randomUUID()
  const expiresAt = now + days * DAY_MS
  const hostname = hostnameOf(env, id)
  const reveal = fulfillRequest ? await sealReveal(env, fulfillRequest.id, fulfillRequest.code, code) : null
  const statements = [
    env.DB.prepare('INSERT INTO b_leases (lease_id, hostname, state, tunnel_name, created_at) VALUES (?, ?, \'invited\', ?, ?)')
      .bind(id, hostname, tunnelNameOf(id), now),
    env.DB.prepare(
      'INSERT INTO b_activation_codes (code_id, code_hash, lease_id, state, note, created_at, expires_at) VALUES (?, ?, ?, \'invited\', ?, ?, ?)',
    ).bind(codeId, await hmac(env, 'activation', code), id, note, now, expiresAt),
    auditStatement(env, { actor, action: 'invite.create', leaseId: id, codeId, requestId, after: 'invited', result: 'succeeded' }),
  ]
  if (fulfillRequest) {
    statements.push(
      env.DB.prepare(
        'UPDATE b_invite_requests SET state = \'fulfilled\', lease_id = ?, code_id = ?, reveal_iv = ?, reveal_ct = ?, fulfilled_at = ? '
        + 'WHERE request_id = ? AND state = \'verified\' AND verified_at = ?',
      ).bind(id, codeId, reveal.iv, reveal.ct, now, fulfillRequest.id, fulfillRequest.verifiedAt),
      auditStatement(env, { actor, action: 'invite.request.fulfilled', leaseId: id, codeId, requestId, after: 'fulfilled', result: 'succeeded' }),
    )
  }
  await env.DB.batch(statements)
  return { ok: true, code, codeId, id, hostname, expiresAt }
}

async function handleInviteRequest(request, env, requestId) {
  if (request.method !== 'POST') return fail(requestId, 'method_not_allowed', 405)
  const body = await readJson(request)
  if (body.error) return fail(requestId, body.error, 400)
  const email = normalizeEmail(body.email)
  if (!email) return fail(requestId, 'invalid_email', 400)
  const ip = clientIp(request)
  const turnstile = await verifyTurnstile(env, body.turnstileToken, ip)
  if (turnstile === null) return fail(requestId, 'turnstile_not_configured', 503)
  if (!turnstile) return fail(requestId, 'turnstile_failed', 403)
  const emailHash = await hmac(env, 'email', email.normalized)
  const ipHash = await hmac(env, 'ip', ip)

  let retryAfter = await spendRate(env, 'invite-request:ip:' + ipHash, 3, 86400)
  if (!retryAfter) retryAfter = await spendRate(env, 'invite-request:global', REQUEST_DAILY_LIMIT, 86400)
  if (retryAfter) return fail(requestId, 'rate_limited', 429, true, retryAfter)

  const existing = await env.DB.prepare(
    'SELECT * FROM b_invite_requests WHERE email_hash = ? LIMIT 1',
  ).bind(emailHash).first()
  if (existing) {
    const staleVerification = existing.state === 'verified'
      && Number(existing.verified_at) + FULFILL_RESERVATION_TTL_MS <= Date.now()
    if (existing.state === 'pending' || staleVerification) {
      const retry = await spendRate(env, 'invite-resend:' + existing.request_id, 1, 60)
      if (retry) return fail(requestId, 'rate_limited', 429, true, retry)
      const code = randomCode()
      await env.DB.prepare('UPDATE b_invite_requests SET state = \'pending\', verify_hash = ?, verify_attempts = 0, last_sent_at = ?, expires_at = ?, verified_at = NULL WHERE request_id = ?')
        .bind(await hmac(env, 'verify:' + existing.request_id, code), Date.now(), Date.now() + VERIFY_TTL_MS, existing.request_id).run()
      const mailed = await sendMail(env, {
        to: email.normalized,
        subject: '固定地址邀请码：邮箱验证码',
        text: '你的验证码是：' + code + '\n10 分钟内有效。',
      })
      if (!mailed.ok) return fail(requestId, mailed.code || 'mail_failed', 503, true, 60)
      return ok(requestId, { applicationId: existing.request_id, expiresAt: Date.now() + VERIFY_TTL_MS, resent: true })
    }
    return fail(requestId, 'already_requested', 409)
  }

  const ipCount = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM b_invite_requests WHERE ip_hash = ? AND created_at > ?',
  ).bind(ipHash, Date.now() - IP_REQUEST_WINDOW_MS).first()
  if (Number(ipCount?.n || 0) >= IP_REQUEST_LIMIT) {
    return fail(requestId, 'ip_limit_reached', 409)
  }
  const ipQuotaRetry = await spendRate(
    env, 'invite-ip-30d:' + ipHash, IP_REQUEST_LIMIT, IP_REQUEST_WINDOW_MS / 1000,
  )
  if (ipQuotaRetry) return fail(requestId, 'ip_limit_reached', 409)

  const newRequestId = crypto.randomUUID()
  const code = randomCode()
  const now = Date.now()
  try {
    await env.DB.prepare(
      'INSERT INTO b_invite_requests (request_id, email_hash, email_masked, ip_hash, state, verify_hash, last_sent_at, created_at, expires_at) '
      + 'VALUES (?, ?, ?, ?, \'pending\', ?, ?, ?, ?)',
    ).bind(
      newRequestId, emailHash, email.masked, ipHash,
      await hmac(env, 'verify:' + newRequestId, code), now, now, now + VERIFY_TTL_MS,
    ).run()
  } catch {
    return fail(requestId, 'already_requested', 409)
  }
  const mailed = await sendMail(env, {
    to: email.normalized,
    subject: '固定地址邀请码：邮箱验证码',
    text: '你的验证码是：' + code + '\n10 分钟内有效。',
  })
  if (!mailed.ok) {
    await env.DB.prepare('DELETE FROM b_invite_requests WHERE request_id = ?').bind(newRequestId).run().catch(() => undefined)
    return fail(requestId, mailed.code || 'mail_failed', 503, true, 60)
  }
  return ok(requestId, { applicationId: newRequestId, expiresAt: now + VERIFY_TTL_MS })
}

async function handleInviteVerify(request, env, requestId) {
  if (request.method !== 'POST') return fail(requestId, 'method_not_allowed', 405)
  const body = await readJson(request)
  if (body.error) return fail(requestId, body.error, 400)
  const id = typeof body.applicationId === 'string' ? body.applicationId.trim() : (typeof body.requestId === 'string' ? body.requestId.trim() : '')
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^\d{6}$/.test(code)) return fail(requestId, 'invalid_request', 400)
  const row = await env.DB.prepare('SELECT * FROM b_invite_requests WHERE request_id = ?').bind(id).first()
  if (row?.state === 'fulfilled') {
    if (!row.fulfilled_at || Number(row.fulfilled_at) + REVEAL_TTL_MS <= Date.now()) return fail(requestId, 'request_expired', 410)
    if (Number(row.verify_attempts) >= VERIFY_MAX_ATTEMPTS) return fail(requestId, 'too_many_attempts', 429)
    let revealed
    try {
      revealed = await openReveal(env, id, code, row.reveal_iv, row.reveal_ct)
    } catch {
      await env.DB.prepare('UPDATE b_invite_requests SET verify_attempts = verify_attempts + 1 WHERE request_id = ?').bind(id).run()
      return fail(requestId, 'invalid_code', 403)
    }
    const lease = await leaseOf(env, row.lease_id)
    const activation = await env.DB.prepare('SELECT expires_at FROM b_activation_codes WHERE code_id = ?').bind(row.code_id).first()
    return ok(requestId, { code: revealed, hostname: lease?.hostname, expiresAt: activation?.expires_at })
  }
  if (!row || row.state !== 'pending') return fail(requestId, 'request_not_found', 404)
  if (Number(row.expires_at) <= Date.now()) return fail(requestId, 'request_expired', 410)
  if (Number(row.verify_attempts) >= VERIFY_MAX_ATTEMPTS) return fail(requestId, 'too_many_attempts', 429)
  const expected = await hmac(env, 'verify:' + id, code)
  if (!timingSafeEqual(expected, row.verify_hash)) {
    await env.DB.prepare('UPDATE b_invite_requests SET verify_attempts = verify_attempts + 1 WHERE request_id = ?').bind(id).run()
    return fail(requestId, 'invalid_code', 403)
  }
  const verifiedAt = Date.now()
  const reserved = await env.DB.prepare(
    'UPDATE b_invite_requests SET state = \'verified\', verified_at = ? '
    + 'WHERE request_id = ? AND state = \'pending\' AND verify_hash = ? AND expires_at > ? AND verify_attempts < ?',
  ).bind(verifiedAt, id, expected, verifiedAt, VERIFY_MAX_ATTEMPTS).run()
  if (Number(reserved?.meta?.changes || 0) !== 1) return fail(requestId, 'request_not_found', 404)
  const releaseReservation = () => env.DB.prepare(
    'UPDATE b_invite_requests SET state = \'pending\', verified_at = NULL WHERE request_id = ? AND state = \'verified\' AND verified_at = ?',
  ).bind(id, verifiedAt).run()
  let created
  try {
    created = await createInvite(env, {
      note: 'self-service:' + row.email_masked,
      days: 7,
      actor: 'self-service',
      requestId,
      fulfillRequest: { id, verifiedAt, code },
    })
  } catch (error) {
    await releaseReservation().catch(() => undefined)
    throw error
  }
  if (!created.ok) {
    await releaseReservation()
    return fail(requestId, created.code, 503)
  }
  // 邀请码直接回给刚通过邮箱验证的页面；不把明文邮箱落库，所以不再二次发信。
  return ok(requestId, { code: created.code, hostname: created.hostname, expiresAt: created.expiresAt })
}

async function recordOperationFailure(env, leaseId, operationId, step, code, requestId) {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE b_operations SET state = \'failed\', current_step = ?, retry_count = retry_count + 1, '
      + 'next_retry_at = ?, last_error_code = ?, updated_at = ? WHERE lease_id = ? AND operation_id = ?',
    ).bind(step, now + 5000, code, now, leaseId, operationId),
    auditStatement(env, { actor: 'plugin', action: 'operation.' + step, leaseId, requestId, result: code }),
  ]).catch(() => undefined)
}

function externalError(requestId, error) {
  if (error instanceof ControlError) return fail(requestId, error.code, error.status, error.retryable)
  if (error instanceof CloudflareError) return fail(requestId, 'cf_api_unavailable', 502, true, 5)
  return fail(requestId, 'storage_unavailable', 503, true, 5)
}

function ownedDnsRecord(records, dnsRecordId, target) {
  if (!records.length) return undefined
  if (records.length === 1 && records[0].type === 'CNAME') {
    const record = records[0]
    if (dnsRecordId && record.id === dnsRecordId) return record
    if (!dnsRecordId && target && record.content === target && record.proxied === true) return record
  }
  throw new ControlError('resource_conflict')
}

function claimData(env, lease, tunnelToken) {
  return {
    id: lease.lease_id,
    hostname: lease.hostname,
    publicUrl: 'https://' + lease.hostname,
    state: 'active',
    tunnelToken,
    configVersion: Number(lease.config_version),
    credentialVersion: Number(lease.credential_version),
    renewAfter: Date.now() + DAY_MS,
  }
}

async function convergeClaim(env, api, lease, operation, requestId) {
  const id = lease.lease_id
  const operationId = operation.operation_id
  let step = 'tunnel'
  try {
    const tunnelName = tunnelNameOf(id)
    let tunnel = await api.findTunnel(tunnelName)
    if (lease.tunnel_id && (!tunnel || tunnel.id !== lease.tunnel_id)) throw new ControlError('resource_conflict')

    // Refuse an unknown hostname occupant before creating a Tunnel. An exact
    // CNAME to our existing Tunnel is adoptable after a lost D1 checkpoint.
    ownedDnsRecord(await api.findDnsRecords(lease.hostname), lease.dns_record_id, tunnel ? dnsTargetOf(tunnel.id) : null)

    if (!tunnel) {
      tunnel = await api.createTunnel(tunnelName)
      if (!tunnel?.id) throw new CloudflareError()
      await env.DB.batch([
        env.DB.prepare('UPDATE b_leases SET tunnel_id = ?, row_version = row_version + 1 WHERE lease_id = ? AND state = \'claimed\'')
          .bind(tunnel.id, id),
        inventoryStatement(env, 'tunnel', tunnel.id, id, operationId),
        env.DB.prepare('UPDATE b_operations SET current_step = \'ingress\', updated_at = ? WHERE lease_id = ? AND operation_id = ?')
          .bind(Date.now(), id, operationId),
        auditStatement(env, { actor: 'plugin', action: 'tunnel.create', leaseId: id, requestId, before: 'claimed', after: 'claimed', result: 'succeeded' }),
      ])
      lease.tunnel_id = tunnel.id
    }
    const target = dnsTargetOf(tunnel.id)
    step = 'ingress'
    if (Number(lease.config_version) === 0) {
      await api.putTunnelConfiguration(tunnel.id, ingressOf(lease.hostname, Number(lease.origin_port)))
      await env.DB.batch([
        env.DB.prepare('UPDATE b_leases SET config_version = 1, row_version = row_version + 1 WHERE lease_id = ?').bind(id),
        inventoryStatement(env, 'ingress', tunnel.id, id, operationId),
        env.DB.prepare('UPDATE b_operations SET current_step = \'dns\', updated_at = ? WHERE lease_id = ? AND operation_id = ?')
          .bind(Date.now(), id, operationId),
        auditStatement(env, { actor: 'plugin', action: 'ingress.configure', leaseId: id, requestId, before: 'claimed', after: 'claimed', result: 'succeeded' }),
      ])
      lease.config_version = 1
    }

    step = 'dns'
    let record = ownedDnsRecord(await api.findDnsRecords(lease.hostname), lease.dns_record_id, target)
    if (!record) {
      record = await api.createDnsRecord({ type: 'CNAME', name: lease.hostname, content: target, proxied: true })
      if (!record?.id) throw new CloudflareError()
    } else if (record.content !== target || record.proxied !== true) {
      if (!lease.dns_record_id || record.id !== lease.dns_record_id) throw new ControlError('resource_conflict')
      await api.updateDnsRecord(record.id, { type: 'CNAME', name: lease.hostname, content: target, proxied: true })
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE b_leases SET dns_record_id = ?, dns_target = ?, row_version = row_version + 1 WHERE lease_id = ?')
        .bind(record.id, target, id),
      inventoryStatement(env, 'dns', record.id, id, operationId),
      env.DB.prepare('UPDATE b_operations SET current_step = \'token\', updated_at = ? WHERE lease_id = ? AND operation_id = ?')
        .bind(Date.now(), id, operationId),
      auditStatement(env, { actor: 'plugin', action: 'dns.converge', leaseId: id, requestId, before: 'claimed', after: 'claimed', result: 'succeeded' }),
    ])
    lease.dns_record_id = record.id
    lease.dns_target = target

    step = 'token'
    const tunnelToken = await api.getTunnelToken(tunnel.id)
    if (typeof tunnelToken !== 'string' || !tunnelToken) throw new CloudflareError()
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE b_leases SET state = \'active\', activated_at = ?, last_seen_at = ?, row_version = row_version + 1 WHERE lease_id = ? AND state = \'claimed\'',
      ).bind(now, now, id),
      env.DB.prepare('UPDATE b_operations SET state = \'succeeded\', current_step = \'complete\', next_retry_at = NULL, last_error_code = NULL, updated_at = ? WHERE lease_id = ? AND operation_id = ?')
        .bind(now, id, operationId),
      auditStatement(env, { actor: 'plugin', action: 'claim.complete', leaseId: id, requestId, before: 'claimed', after: 'active', result: 'succeeded' }),
    ])
    return ok(requestId, claimData(env, lease, tunnelToken))
  } catch (error) {
    const response = externalError(requestId, error)
    const body = await response.clone().json()
    await recordOperationFailure(env, id, operationId, step, body.code, requestId)
    return response
  }
}

async function selfServiceLeaseOf(env, claimRequestId) {
  return await env.DB.prepare(
    'SELECT * FROM b_leases WHERE claim_request_id = ? OR EXISTS ('
    + 'SELECT 1 FROM b_operations WHERE lease_id = b_leases.lease_id AND operation_id = ? AND type = \'claim\') LIMIT 1',
  ).bind(claimRequestId, claimRequestId).first()
}

/** 自服务 claim 的恢复路径：不消耗新名额，也不新建 Tunnel。 */
async function resumeSelfServiceClaim(env, api, lease, {
  clientSecret,
  claimRequestId,
  fingerprint,
  requestId,
}) {
  const secretHash = await hmac(env, 'client', lease.lease_id + ':' + clientSecret)
  if (!timingSafeEqual(lease.client_secret_hash, secretHash)) return fail(requestId, 'auth_failed', 403)
  if (lease.state === 'retired') return fail(requestId, 'lease_retired', 410)
  if (lease.state !== 'claimed' && lease.state !== 'active' && lease.state !== 'released') {
    return fail(requestId, 'state_conflict', 409)
  }
  const operation = await env.DB.prepare(
    'SELECT * FROM b_operations WHERE lease_id = ? AND operation_id = ? AND type = \'claim\'',
  ).bind(lease.lease_id, claimRequestId).first()
  if (!operation || operation.request_fingerprint !== fingerprint) {
    return fail(requestId, 'idempotency_conflict', 409)
  }

  if (lease.state === 'active' || lease.state === 'released') {
    if (!lease.tunnel_id) return fail(requestId, 'state_conflict', 409)
    try {
      const tunnelToken = await api.getTunnelToken(lease.tunnel_id)
      if (typeof tunnelToken !== 'string' || !tunnelToken) throw new CloudflareError()
      if (lease.state === 'released') {
        const now = Date.now()
        await env.DB.batch([
          env.DB.prepare(
            'UPDATE b_leases SET state = \'active\', released_at = NULL, last_seen_at = ?, row_version = row_version + 1 WHERE lease_id = ? AND state = \'released\'',
          ).bind(now, lease.lease_id),
          auditStatement(env, {
            actor: 'plugin',
            action: 'lease.reactivate',
            leaseId: lease.lease_id,
            requestId,
            before: 'released',
            after: 'active',
            result: 'succeeded',
          }),
        ])
        lease.state = 'active'
        lease.released_at = null
        lease.last_seen_at = now
      }
      return ok(requestId, claimData(env, lease, tunnelToken))
    } catch (error) {
      return externalError(requestId, error)
    }
  }
  return await convergeClaim(env, api, lease, operation, requestId)
}

async function handleSelfServiceClaim(env, {
  requestId,
  clientSecret,
  claimRequestId,
  originPort,
  ipHash,
  fingerprint,
}) {
  const existing = await selfServiceLeaseOf(env, claimRequestId)
  if (existing) {
    const api = cloudflareApiOf(env)
    if (!api) return fail(requestId, 'cf_api_unavailable', 503, true, 5)
    return await resumeSelfServiceClaim(env, api, existing, {
      clientSecret, claimRequestId, fingerprint, requestId,
    })
  }

  const config = await readBConfig(env)
  if (!config.registrationEnabled) return fail(requestId, 'registration_closed', 403)
  if (config.inviteRequired) return fail(requestId, 'invite_required', 403)

  const api = cloudflareApiOf(env)
  if (!api) return fail(requestId, 'cf_api_unavailable', 503, true, 5)

  let retryAfter = await spendRate(env, 'claim:self:ip:' + ipHash, 3, 3600)
  if (!retryAfter) retryAfter = await spendRate(env, 'claim:self:global', 50, 86400)
  if (retryAfter) return fail(requestId, 'rate_limited', 429, true, retryAfter)

  const id = randomId()
  const secretHash = await hmac(env, 'client', id + ':' + clientSecret)
  const hostname = hostnameOf(env, id)
  const tunnelName = tunnelNameOf(id)
  const now = Date.now()

  let inserted
  try {
    inserted = await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO b_leases '
        + '(lease_id, hostname, state, client_secret_hash, secret_version, origin_port, tunnel_name, claim_request_id, '
        + 'config_version, credential_version, created_at, claimed_at, last_seen_at, row_version) '
        + 'SELECT ?, ?, \'claimed\', ?, 1, ?, ?, ?, 0, 1, ?, ?, ?, 0 '
        + 'WHERE (SELECT COUNT(*) FROM b_leases WHERE state IN (\'active\', \'claimed\', \'released\')) < ?',
      ).bind(id, hostname, secretHash, originPort, tunnelName, claimRequestId, now, now, now, config.maxLeases),
      env.DB.prepare(
        'INSERT INTO b_operations (operation_id, lease_id, type, request_fingerprint, state, current_step, retry_count, created_at, updated_at) '
        + 'SELECT ?, ?, \'claim\', ?, \'running\', \'tunnel\', 0, ?, ? '
        + 'WHERE EXISTS (SELECT 1 FROM b_leases WHERE lease_id = ? AND claim_request_id = ? AND client_secret_hash = ?)',
      ).bind(claimRequestId, id, fingerprint, now, now, id, claimRequestId, secretHash),
      env.DB.prepare(
        'INSERT INTO b_admin_audit (actor, action, lease_id, request_id, before_state, after_state, result, created_at) '
        + 'SELECT \'plugin\', \'lease.self_register\', ?, ?, NULL, \'claimed\', \'succeeded\', ? '
        + 'WHERE EXISTS (SELECT 1 FROM b_leases WHERE lease_id = ? AND claim_request_id = ?)',
      ).bind(id, requestId, now, id, claimRequestId),
    ])
  } catch {
    // 同一个 claimRequestId 的并发请求可能刚被另一个请求插入；它已经是赢家。
    const raced = await selfServiceLeaseOf(env, claimRequestId)
    if (raced) {
      return await resumeSelfServiceClaim(env, api, raced, {
        clientSecret, claimRequestId, fingerprint, requestId,
      })
    }
    return fail(requestId, 'storage_unavailable', 503, true, 5)
  }

  if (inserted[0]?.meta?.changes !== 1) {
    const raced = await selfServiceLeaseOf(env, claimRequestId)
    if (raced) {
      return await resumeSelfServiceClaim(env, api, raced, {
        clientSecret, claimRequestId, fingerprint, requestId,
      })
    }
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM b_leases WHERE state IN (\'active\', \'claimed\', \'released\')',
    ).first()
    if (Number(count?.n || 0) >= config.maxLeases) {
      return fail(requestId, 'self_service_capacity', 503)
    }
    return fail(requestId, 'storage_unavailable', 503, true, 5)
  }

  const lease = await leaseOf(env, id)
  const operation = await env.DB.prepare(
    'SELECT * FROM b_operations WHERE lease_id = ? AND operation_id = ? AND type = \'claim\'',
  ).bind(id, claimRequestId).first()
  if (!lease || !operation) return fail(requestId, 'storage_unavailable', 503, true, 5)
  return await convergeClaim(env, api, lease, operation, requestId)
}

async function handleClaim(request, env, requestId) {
  if (request.method !== 'PUT') return fail(requestId, 'method_not_allowed', 405)
  const body = await readJson(request)
  if (body.error) return fail(requestId, body.error, 400)
  const { activationCode, clientSecret, claimRequestId, originPort } = body
  if (activationCode !== undefined && activationCode !== null && typeof activationCode !== 'string') {
    return fail(requestId, 'invalid_request', 400)
  }
  if (!SECRET_RE.test(clientSecret || '')
    || !REQUEST_ID_RE.test(claimRequestId || '') || !validPort(originPort)) {
    return fail(requestId, validPort(originPort) ? 'invalid_request' : 'invalid_origin_port', 400)
  }
  const activationProvided = typeof activationCode === 'string' && activationCode.length > 0
  if (activationProvided && !SECRET_RE.test(activationCode)) return fail(requestId, 'invalid_request', 400)

  const ipHash = await hmac(env, 'ip', clientIp(request))
  const fingerprint = await digestHex(claimRequestId + ':' + String(originPort))
  if (!activationProvided) {
    return await handleSelfServiceClaim(env, {
      requestId,
      clientSecret,
      claimRequestId,
      originPort,
      ipHash,
      fingerprint,
    })
  }

  const codeHash = await hmac(env, 'activation', activationCode)
  const bound = await selfServiceLeaseOf(env, claimRequestId)
  let retryAfter = await spendRate(env, (bound ? 'claim-recover:ip:' : 'claim:ip:') + ipHash, bound ? 30 : 5, 3600)
  if (!retryAfter) retryAfter = await spendRate(env, (bound ? 'claim-recover:code:' : 'claim:code:') + codeHash, bound ? 30 : 10, 900)
  if (retryAfter) return fail(requestId, 'rate_limited', 429, true, retryAfter)
  const api = cloudflareApiOf(env)
  if (!api) return fail(requestId, 'cf_api_unavailable', 503, true, 5)

  const invite = await env.DB.prepare('SELECT * FROM b_activation_codes WHERE code_hash = ?').bind(codeHash).first()
  if (!invite) return fail(requestId, 'auth_failed', 403)
  if (invite.state === 'invited' && Number(invite.expires_at) <= Date.now()) return fail(requestId, 'activation_expired', 410)
  let lease = await leaseOf(env, invite.lease_id)
  if (!lease) return fail(requestId, 'storage_unavailable', 503, true, 5)
  if (bound && bound.lease_id !== lease.lease_id) return fail(requestId, 'claim_request_conflict', 409)
  const secretHash = await hmac(env, 'client', lease.lease_id + ':' + clientSecret)

  if (lease.state === 'invited') {
    if (invite.state !== 'invited') return fail(requestId, 'activation_already_claimed', 409)
    const now = Date.now()
    const consumed = await env.DB.batch([
      env.DB.prepare('UPDATE b_activation_codes SET state = \'claimed\', claimed_at = ? WHERE code_id = ? AND state = \'invited\' AND expires_at > ?')
        .bind(now, invite.code_id, now),
      env.DB.prepare(
        'UPDATE b_leases SET state = \'claimed\', client_secret_hash = ?, secret_version = 1, origin_port = ?, claim_request_id = ?, '
        + 'claimed_at = ?, last_seen_at = ?, row_version = row_version + 1 WHERE lease_id = ? AND state = \'invited\'',
      ).bind(secretHash, originPort, claimRequestId, now, now, lease.lease_id),
      env.DB.prepare(
        'INSERT INTO b_operations (operation_id, lease_id, type, request_fingerprint, state, current_step, retry_count, created_at, updated_at) '
        + 'SELECT ?, ?, \'claim\', ?, \'running\', \'tunnel\', 0, ?, ? '
        + 'WHERE EXISTS (SELECT 1 FROM b_leases WHERE lease_id = ? AND state = \'claimed\' AND client_secret_hash = ?) '
        + 'AND NOT EXISTS (SELECT 1 FROM b_operations WHERE lease_id = ? AND type = \'claim\')',
      ).bind(claimRequestId, lease.lease_id, fingerprint, now, now, lease.lease_id, secretHash, lease.lease_id),
    ])
    if (consumed.every((result) => result.meta.changes === 1)) {
      await auditStatement(env, { actor: 'plugin', action: 'activation.claim', leaseId: lease.lease_id, codeId: invite.code_id, requestId, before: 'invited', after: 'claimed', result: 'succeeded' })
        .run().catch(() => undefined)
    }
    lease = await leaseOf(env, lease.lease_id)
  }

  if (!timingSafeEqual(lease.client_secret_hash, secretHash)) return fail(requestId, 'auth_failed', 403)
  if (lease.state === 'retired') return fail(requestId, 'lease_retired', 410)
  if (lease.state !== 'claimed' && lease.state !== 'active' && lease.state !== 'released') return fail(requestId, 'state_conflict', 409)
  const operation = await env.DB.prepare('SELECT * FROM b_operations WHERE lease_id = ? AND operation_id = ? AND type = \'claim\'')
    .bind(lease.lease_id, claimRequestId).first()
  if (!operation || operation.request_fingerprint !== fingerprint) return fail(requestId, 'idempotency_conflict', 409)

  if (lease.state === 'active') {
    try {
      const tunnelToken = await api.getTunnelToken(lease.tunnel_id)
      if (typeof tunnelToken !== 'string' || !tunnelToken) throw new CloudflareError()
      return ok(requestId, claimData(env, lease, tunnelToken))
    } catch (error) {
      return externalError(requestId, error)
    }
  }
  if (lease.state === 'released') {
    // released 只是产品层保留；资源仍在。同 clientSecret + 同 claimRequestId
    // 重新 claim 是“恢复”，不是新开通：不消费新邀请、不建新 Tunnel。
    if (!lease.tunnel_id) return fail(requestId, 'state_conflict', 409)
    try {
      const tunnelToken = await api.getTunnelToken(lease.tunnel_id)
      if (typeof tunnelToken !== 'string' || !tunnelToken) throw new CloudflareError()
      const now = Date.now()
      await env.DB.batch([
        env.DB.prepare(
          'UPDATE b_leases SET state = \'active\', released_at = NULL, last_seen_at = ?, row_version = row_version + 1 WHERE lease_id = ? AND state = \'released\'',
        ).bind(now, lease.lease_id),
        auditStatement(env, { actor: 'plugin', action: 'lease.reactivate', leaseId: lease.lease_id, requestId, before: 'released', after: 'active', result: 'succeeded' }),
      ])
      lease.state = 'active'
      lease.released_at = null
      lease.last_seen_at = now
      return ok(requestId, claimData(env, lease, tunnelToken))
    } catch (error) {
      return externalError(requestId, error)
    }
  }
  return await convergeClaim(env, api, lease, operation, requestId)
}

function publicLeaseData(lease) {
  return {
    id: lease.lease_id,
    state: lease.state,
    hostname: lease.hostname,
    publicUrl: 'https://' + lease.hostname,
    configVersion: Number(lease.config_version),
    credentialVersion: Number(lease.credential_version),
    renewAfter: Date.now() + DAY_MS,
    ...(lease.released_at ? { releasedAt: Number(lease.released_at), retainUntil: Number(lease.released_at) + RELEASE_RETENTION_MS } : {}),
    ...(lease.retired_at ? { retiredAt: Number(lease.retired_at) } : {}),
  }
}

async function pluginRequest(request, env, requestId, route) {
  if (request.method !== 'POST') return fail(requestId, 'method_not_allowed', 405)
  const body = await readJson(request)
  if (body.error) return fail(requestId, body.error, 400)
  const { id, clientSecret } = body
  if (!ID_RE.test(id || '') || !SECRET_RE.test(clientSecret || '')) return fail(requestId, 'invalid_request', 400)
  const limits = { status: [60, 3600], renew: [20, 86400], release: [10, 86400], retire: [10, 86400] }
  const [maximum, windowSeconds] = limits[route]
  const retryAfter = await spendRate(env, route + ':lease:' + id, maximum, windowSeconds)
  if (retryAfter) return fail(requestId, 'rate_limited', 429, true, retryAfter)
  const lease = await authenticatedLease(env, id, clientSecret)
  if (!lease) return fail(requestId, 'auth_failed', 403)

  if (route === 'status') return ok(requestId, publicLeaseData(lease))
  if (route === 'retire') return await retireLease(env, lease, requestId)
  if (lease.state === 'retired') return fail(requestId, 'lease_retired', 410)

  if (route === 'release') {
    const releasedAt = Number(lease.released_at) || Date.now()
    if (lease.state !== 'released') {
      await env.DB.batch([
        env.DB.prepare('UPDATE b_leases SET state = \'released\', released_at = ?, row_version = row_version + 1 WHERE lease_id = ?')
          .bind(releasedAt, id),
        auditStatement(env, { actor: 'plugin', action: 'lease.release', leaseId: id, requestId, before: lease.state, after: 'released', result: 'succeeded' }),
      ])
    }
    return ok(requestId, {
      id, state: 'released', hostname: lease.hostname, releasedAt,
      retainUntil: releasedAt + RELEASE_RETENTION_MS, resourcesRetained: true,
    })
  }

  if (route === 'renew') {
    if (lease.state !== 'active') return fail(requestId, 'state_conflict', 409)
    const port = body.originPort === undefined ? Number(lease.origin_port) : body.originPort
    if (!validPort(port)) return fail(requestId, 'invalid_origin_port', 400)
    const now = Date.now()
    if (port !== Number(lease.origin_port)) {
      const api = cloudflareApiOf(env)
      if (!api || !lease.tunnel_id) return fail(requestId, 'cf_api_unavailable', 503, true, 5)
      await env.DB.prepare(
        'INSERT INTO b_operations (operation_id, lease_id, type, state, current_step, retry_count, created_at, updated_at) '
        + 'VALUES (?, ?, \'renew\', \'running\', \'ingress\', 0, ?, ?)',
      ).bind(requestId, id, now, now).run()
      try {
        await api.putTunnelConfiguration(lease.tunnel_id, ingressOf(lease.hostname, port))
      } catch (error) {
        await recordOperationFailure(env, id, requestId, 'ingress', 'cf_api_unavailable', requestId)
        return externalError(requestId, error)
      }
      await env.DB.batch([
        env.DB.prepare('UPDATE b_leases SET origin_port = ?, config_version = config_version + 1, last_seen_at = ?, row_version = row_version + 1 WHERE lease_id = ?')
          .bind(port, now, id),
        inventoryStatement(env, 'ingress', lease.tunnel_id, id, requestId),
        env.DB.prepare('UPDATE b_operations SET state = \'succeeded\', current_step = \'complete\', updated_at = ? WHERE lease_id = ? AND operation_id = ?')
          .bind(now, id, requestId),
        auditStatement(env, { actor: 'plugin', action: 'lease.renew.port', leaseId: id, requestId, before: 'active', after: 'active', result: 'succeeded' }),
      ])
      lease.config_version = Number(lease.config_version) + 1
    } else {
      await env.DB.prepare('UPDATE b_leases SET last_seen_at = ?, row_version = row_version + 1 WHERE lease_id = ?').bind(now, id).run()
    }
    return ok(requestId, { ...publicLeaseData(lease), configVersion: Number(lease.config_version) })
  }

  return fail(requestId, 'not_found', 404)
}

async function retireLease(env, lease, requestId) {
  const id = lease.lease_id
  if (lease.state === 'retired') {
    return ok(requestId, { id, state: 'retired', hostname: lease.hostname, retiredAt: Number(lease.retired_at) })
  }
  const api = cloudflareApiOf(env)
  if (!api) return fail(requestId, 'cf_api_unavailable', 503, true, 5)
  const now = Date.now()
  await env.DB.prepare(
    'INSERT INTO b_operations (operation_id, lease_id, type, state, current_step, retry_count, created_at, updated_at) '
    + 'VALUES (\'retire\', ?, \'retire\', \'running\', \'dns\', 0, ?, ?) '
    + 'ON CONFLICT(lease_id, operation_id) DO UPDATE SET state = \'running\', current_step = \'dns\', '
    + 'next_retry_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at',
  ).bind(id, now, now).run()
  let step = 'dns'
  try {
    const target = lease.tunnel_id ? dnsTargetOf(lease.tunnel_id) : null
    const record = ownedDnsRecord(await api.findDnsRecords(lease.hostname), lease.dns_record_id, target)
    if (record) await api.deleteDnsRecord(record.id)
    const remaining = await api.findDnsRecords(lease.hostname)
    const ownedRemaining = ownedDnsRecord(remaining, lease.dns_record_id, target)
    if (ownedRemaining || remaining.length) throw new ControlError('provisioning_incomplete', 503, true)
    const dnsCheckpoint = [
      env.DB.prepare('UPDATE b_operations SET current_step = \'tunnel\', updated_at = ? WHERE lease_id = ? AND operation_id = \'retire\'').bind(Date.now(), id),
      auditStatement(env, { actor: 'plugin', action: 'retire.dns.delete', leaseId: id, requestId, before: lease.state, after: lease.state, result: 'succeeded' }),
    ]
    if (record) dnsCheckpoint.push(inventoryStatement(env, 'dns', record.id, id, 'retire', 'deleted'))
    await env.DB.batch(dnsCheckpoint)

    step = 'tunnel'
    const tunnel = await api.findTunnel(tunnelNameOf(id))
    if (lease.tunnel_id && tunnel && tunnel.id !== lease.tunnel_id) throw new ControlError('resource_conflict')
    if (tunnel) await api.deleteTunnel(tunnel.id)
    if (await api.findTunnel(tunnelNameOf(id))) throw new ControlError('provisioning_incomplete', 503, true)
    const retiredAt = Date.now()
    const finalStatements = [
      env.DB.prepare('UPDATE b_leases SET state = \'retired\', retired_at = ?, row_version = row_version + 1 WHERE lease_id = ?').bind(retiredAt, id),
      env.DB.prepare('UPDATE b_operations SET state = \'succeeded\', current_step = \'complete\', updated_at = ? WHERE lease_id = ? AND operation_id = \'retire\'').bind(retiredAt, id),
      auditStatement(env, { actor: 'plugin', action: 'retire.complete', leaseId: id, requestId, before: lease.state, after: 'retired', result: 'succeeded' }),
    ]
    if (tunnel) finalStatements.push(inventoryStatement(env, 'tunnel', tunnel.id, id, 'retire', 'deleted'))
    await env.DB.batch(finalStatements)
    return ok(requestId, { id, state: 'retired', hostname: lease.hostname, retiredAt })
  } catch (error) {
    const response = externalError(requestId, error)
    const body = await response.clone().json()
    await recordOperationFailure(env, id, 'retire', step, body.code, requestId)
    return response
  }
}

function findingIdOf(runId, finding) {
  return [
    runId,
    finding.kind,
    finding.leaseId ?? '-',
    finding.resourceType ?? '-',
    finding.resourceId ?? '-',
  ].join(':')
}

async function recordFinding(env, runId, finding, createdAt = Date.now()) {
  const findingId = findingIdOf(runId, finding)
  await env.DB.prepare(
    'INSERT INTO b_reconcile_findings '
    + '(finding_id, run_id, lease_id, resource_type, resource_id, kind, detail, created_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(finding_id) DO UPDATE SET '
    + 'lease_id = excluded.lease_id, resource_type = excluded.resource_type, '
    + 'resource_id = excluded.resource_id, detail = excluded.detail',
  ).bind(
    findingId,
    runId,
    finding.leaseId ?? null,
    finding.resourceType,
    finding.resourceId ?? null,
    finding.kind,
    String(finding.detail ?? '').slice(0, 500),
    createdAt,
  ).run()
}

/** 对一条 active/released lease 做只读核对；任何 Cloudflare 写操作都不在这里发生。 */
async function reconcileLease(env, api, lease, runId) {
  const tunnelName = lease.tunnel_name || tunnelNameOf(lease.lease_id)
  const tunnel = await api.findTunnel(tunnelName)

  if (!lease.tunnel_id && tunnel) {
    await recordFinding(env, runId, {
      kind: 'tunnel_mismatch',
      leaseId: lease.lease_id,
      resourceType: 'tunnel',
      resourceId: tunnel.id,
      detail: `D1 没有 tunnel_id，但 Cloudflare 上已有同名 Tunnel ${tunnelName}`,
    })
  } else if (!tunnel) {
    await recordFinding(env, runId, {
      kind: 'tunnel_missing',
      leaseId: lease.lease_id,
      resourceType: 'tunnel',
      resourceId: lease.tunnel_id || tunnelName,
      detail: `Cloudflare 上找不到 Tunnel ${tunnelName}`,
    })
  } else if (lease.tunnel_id && tunnel.id !== lease.tunnel_id) {
    await recordFinding(env, runId, {
      kind: 'tunnel_mismatch',
      leaseId: lease.lease_id,
      resourceType: 'tunnel',
      resourceId: lease.tunnel_id,
      detail: `D1 tunnel_id=${lease.tunnel_id}，Cloudflare 同名 Tunnel id=${tunnel.id}`,
    })
  }

  const records = await api.findDnsRecords(lease.hostname)
  if (!records.length) {
    await recordFinding(env, runId, {
      kind: 'cname_missing',
      leaseId: lease.lease_id,
      resourceType: 'dns',
      resourceId: lease.dns_record_id || lease.hostname,
      detail: `Cloudflare 上找不到 ${lease.hostname} 的同名记录`,
    })
    return
  }

  const cnames = records.filter((record) => record.type === 'CNAME')
  if (records.length !== 1 || cnames.length !== 1) {
    await recordFinding(env, runId, {
      kind: 'dns_conflict',
      leaseId: lease.lease_id,
      resourceType: 'dns',
      resourceId: lease.dns_record_id || lease.hostname,
      detail: `同名记录 ${records.length} 条，类型=${records.map((record) => record.type).join(',')}`,
    })
    return
  }

  const target = lease.dns_target || (tunnel ? dnsTargetOf(tunnel.id) : null)
  const record = cnames[0]
  if (!target) {
    await recordFinding(env, runId, {
      kind: 'cname_mismatch',
      leaseId: lease.lease_id,
      resourceType: 'dns',
      resourceId: record.id,
      detail: `D1 没有记录 CNAME 目标，当前内容=${record.content ?? ''}`,
    })
    return
  }
  if (record.content !== target || record.proxied !== true) {
    await recordFinding(env, runId, {
      kind: 'cname_mismatch',
      leaseId: lease.lease_id,
      resourceType: 'dns',
      resourceId: record.id,
      detail: `期望 ${target}（proxied=true），实际 ${record.content ?? ''}（proxied=${record.proxied === true}）`,
    })
  }
}

function parseSummary(text) {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/**
 * 每日运维：自动退休过期 released，并只读对账 Tunnel/CNAME/孤儿。
 * 所有删除只发生在 retireLease；对账与孤儿检查不会调用任何 Cloudflare 写接口。
 */
export async function runOps(env, options = {}) {
  const runId = typeof options.runId === 'string' && options.runId ? options.runId : crypto.randomUUID()
  const kind = typeof options.kind === 'string' && options.kind ? options.kind : 'daily'
  const startedAt = Number.isFinite(options.now) ? options.now : Date.now()
  const summary = {
    retired: 0,
    retireFailures: [],
    reconcileChecked: 0,
    reconcileFailures: [],
    orphanTunnels: 0,
    findings: 0,
    findingKinds: {},
    errors: [],
  }
  let status = 'succeeded'

  await env.DB.prepare(
    'INSERT INTO b_ops_runs (run_id, kind, started_at, status) VALUES (?, ?, ?, \'running\') '
    + 'ON CONFLICT(run_id) DO UPDATE SET status = \'running\', finished_at = NULL, summary = NULL',
  ).bind(runId, kind, startedAt).run()

  try {
    const stale = await env.DB.prepare(
      'SELECT * FROM b_leases WHERE state = \'released\' AND released_at IS NOT NULL AND released_at < ? '
      + 'ORDER BY released_at ASC LIMIT ?',
    ).bind(startedAt - RELEASE_RETENTION_MS, OPS_RETIRE_LIMIT).all()

    for (const lease of stale.results || []) {
      try {
        const response = await retireLease(env, lease, `ops:${runId}:retire:${lease.lease_id}`)
        const payload = await response.json().catch(() => null)
        if (response.ok && payload?.state === 'retired') {
          summary.retired += 1
        } else {
          summary.retireFailures.push({ leaseId: lease.lease_id, code: payload?.code || 'retire_failed' })
        }
      } catch {
        summary.retireFailures.push({ leaseId: lease.lease_id, code: 'retire_failed' })
      }
    }

    const api = cloudflareApiOf(env)
    if (!api) {
      summary.errors.push('cf_api_unavailable')
    } else {
      const candidates = await env.DB.prepare(
        'SELECT * FROM b_leases WHERE state IN (\'active\', \'released\') '
        + 'ORDER BY COALESCE(last_seen_at, created_at) ASC LIMIT ?',
      ).bind(OPS_RECONCILE_LIMIT).all()

      for (const lease of candidates.results || []) {
        summary.reconcileChecked += 1
        try {
          await reconcileLease(env, api, lease, runId)
        } catch {
          summary.reconcileFailures.push({ leaseId: lease.lease_id, code: 'reconcile_failed' })
        }
      }

      try {
        const tunnels = await api.listTunnels()
        const known = await env.DB.prepare('SELECT tunnel_name, tunnel_id FROM b_leases').all()
        const knownNames = new Set((known.results || []).map((row) => row.tunnel_name).filter(Boolean))
        const knownIds = new Set((known.results || []).map((row) => row.tunnel_id).filter(Boolean))
        for (const tunnel of tunnels) {
          if (!tunnel?.name?.startsWith(TUNNEL_PREFIX)) continue
          if (knownNames.has(tunnel.name) || knownIds.has(tunnel.id)) continue
          await recordFinding(env, runId, {
            kind: 'orphan_tunnel',
            leaseId: null,
            resourceType: 'tunnel',
            resourceId: tunnel.id,
            detail: `Cloudflare Tunnel ${tunnel.name} 没有对应 D1 lease；只记录，不删除`,
          }, startedAt)
          summary.orphanTunnels += 1
        }
      } catch {
        summary.errors.push('orphan_list_failed')
      }
    }

    const counts = await env.DB.prepare(
      'SELECT kind, COUNT(*) AS n FROM b_reconcile_findings WHERE run_id = ? GROUP BY kind',
    ).bind(runId).all()
    for (const row of counts.results || []) {
      summary.findingKinds[row.kind] = Number(row.n)
      summary.findings += Number(row.n)
    }
    if (summary.retireFailures.length || summary.reconcileFailures.length || summary.errors.length) {
      status = 'partial'
    }
  } catch {
    summary.errors.push('ops_failed')
    status = 'failed'
  }

  await env.DB.prepare(
    'UPDATE b_ops_runs SET finished_at = ?, status = ?, summary = ? WHERE run_id = ?',
  ).bind(Date.now(), status, JSON.stringify(summary), runId).run()

  return { runId, status, summary }
}

async function adminUnauthorized(request, env, requestId) {
  const retryAfter = await spendRate(env, 'admin:' + clientIp(request), 60, 60)
  if (retryAfter) return fail(requestId, 'rate_limited', 429, true, retryAfter)
  const token = typeof env.ADMIN_TOKEN === 'string' ? env.ADMIN_TOKEN : ''
  if (!token) return fail(requestId, 'admin_not_configured', 503)
  const header = request.headers.get('authorization') || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  return timingSafeEqual(bearer, token) ? undefined : fail(requestId, 'auth_failed', 401)
}

async function handleAdmin(request, env, url, requestId) {
  const unauthorized = await adminUnauthorized(request, env, requestId)
  if (unauthorized) return unauthorized
  if (url.pathname === '/admin/b/v1/config') {
    if (request.method === 'GET') return ok(requestId, await readBConfig(env))
    if (request.method !== 'POST') return fail(requestId, 'method_not_allowed', 405)

    const body = await readJson(request)
    if (body.error) return fail(requestId, body.error, 400)
    const patch = {}
    for (const key of ['registrationEnabled', 'inviteRequired']) {
      if (body[key] === undefined) continue
      if (typeof body[key] !== 'boolean') return fail(requestId, 'invalid_request', 400)
      patch[key] = body[key]
    }
    if (body.maxLeases !== undefined) {
      if (!Number.isInteger(body.maxLeases) || body.maxLeases < 1 || body.maxLeases > 1000) return fail(requestId, 'invalid_request', 400)
      patch.maxLeases = body.maxLeases
    }
    if (!Object.keys(patch).length) return fail(requestId, 'invalid_request', 400)

    const before = await readBConfig(env)
    const after = { ...before, ...patch }
    const now = Date.now()
    const statements = Object.entries(patch).map(([key, value]) => env.DB.prepare(
      'INSERT INTO b_config (key, value, updated_at) VALUES (?, ?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).bind(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value), now))
    statements.push(auditStatement(env, {
      actor: 'admin-token',
      action: 'config.update',
      requestId,
      before: JSON.stringify(before),
      after: JSON.stringify(after),
      result: 'succeeded',
    }))
    await env.DB.batch(statements)
    return ok(requestId, after)
  }
  if (url.pathname === '/admin/b/v1/invites') {
    if (request.method !== 'POST') return fail(requestId, 'method_not_allowed', 405)
    const body = await readJson(request)
    if (body.error) return fail(requestId, body.error, 400)
    const days = body.expiresInDays === undefined ? 7 : body.expiresInDays
    if (!Number.isInteger(days) || days < 1 || days > 90 || (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 200))) {
      return fail(requestId, 'invalid_request', 400)
    }
    const created = await createInvite(env, {
      note: body.note ?? null,
      days,
      actor: 'admin-token',
      requestId,
    })
    if (!created.ok) return fail(requestId, created.code, 503)
    return ok(requestId, {
      code: created.code,
      codeId: created.codeId,
      id: created.id,
      hostname: created.hostname,
      expiresAt: created.expiresAt,
    })
  }
  if (url.pathname === '/admin/b/v1/leases') {
    if (request.method !== 'GET') return fail(requestId, 'method_not_allowed', 405)
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50))
    const rows = await env.DB.prepare(
      'SELECT lease_id AS id, hostname, state, origin_port AS originPort, tunnel_name AS tunnelName, tunnel_id AS tunnelId, '
      + 'dns_record_id AS dnsRecordId, dns_target AS dnsTarget, config_version AS configVersion, credential_version AS credentialVersion, '
      + 'created_at AS createdAt, claimed_at AS claimedAt, activated_at AS activatedAt, last_seen_at AS lastSeenAt, '
      + 'released_at AS releasedAt, retired_at AS retiredAt, row_version AS rowVersion FROM b_leases ORDER BY created_at DESC LIMIT ?',
    ).bind(limit).all()
    return ok(requestId, { leases: rows.results || [] })
  }
  if (url.pathname === '/admin/b/v1/requests') {
    if (request.method !== 'GET') return fail(requestId, 'method_not_allowed', 405)
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50))
    const rows = await env.DB.prepare(
      'SELECT request_id AS id, email_masked AS email, state, lease_id AS leaseId, code_id AS codeId, '
      + 'created_at AS createdAt, expires_at AS expiresAt, verified_at AS verifiedAt, fulfilled_at AS fulfilledAt '
      + 'FROM b_invite_requests ORDER BY created_at DESC LIMIT ?',
    ).bind(limit).all()
    return ok(requestId, { requests: rows.results || [] })
  }
  if (url.pathname.startsWith('/admin/b/v1/requests/')) {
    if (request.method !== 'DELETE') return fail(requestId, 'method_not_allowed', 405)
    const requestKey = url.pathname.slice('/admin/b/v1/requests/'.length)
    if (!/^[0-9a-f-]{36}$/i.test(requestKey)) return fail(requestId, 'invalid_request', 400)
    const result = await env.DB.prepare('DELETE FROM b_invite_requests WHERE request_id = ?').bind(requestKey).run()
    if (Number(result?.meta?.changes || 0) !== 1) return fail(requestId, 'not_found', 404)
    return ok(requestId, { deleted: true })
  }
  if (url.pathname === '/admin/b/v1/ops/run') {
    if (request.method !== 'POST') return fail(requestId, 'method_not_allowed', 405)
    const result = await runOps(env, { kind: 'manual' })
    return ok(requestId, result)
  }
  if (url.pathname === '/admin/b/v1/ops') {
    if (request.method !== 'GET') return fail(requestId, 'method_not_allowed', 405)
    const run = await env.DB.prepare(
      'SELECT run_id AS runId, kind, started_at AS startedAt, finished_at AS finishedAt, status, summary '
      + 'FROM b_ops_runs ORDER BY started_at DESC, run_id DESC LIMIT 1',
    ).first()
    if (!run) return ok(requestId, { run: null, findings: [] })
    const findings = await env.DB.prepare(
      'SELECT finding_id AS findingId, run_id AS runId, lease_id AS leaseId, resource_type AS resourceType, '
      + 'resource_id AS resourceId, kind, detail, created_at AS createdAt, resolved_at AS resolvedAt '
      + 'FROM b_reconcile_findings WHERE run_id = ? ORDER BY created_at, finding_id LIMIT ?',
    ).bind(run.runId, OPS_FINDINGS_LIMIT).all()
    return ok(requestId, {
      run: { ...run, summary: parseSummary(run.summary) },
      findings: findings.results || [],
    })
  }
  return fail(requestId, 'not_found', 404)
}

export async function handleRequest(request, env) {
  const requestId = crypto.randomUUID()
  try {
    const url = new URL(request.url)
    if (url.hostname !== (env.B_CONTROL_HOST || 'control.dsh-everywhere.com')) return fail(requestId, 'not_found', 404)
    if (url.pathname === '/request') {
      return new Response(requestPageHtml({ turnstileSiteKey: env.B_TURNSTILE_SITE_KEY || '' }), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; connect-src 'self' https://challenges.cloudflare.com; img-src 'self' data:; base-uri 'none'",
        },
      })
    }
    if (url.pathname.startsWith('/api/b/v1/')) {
      const retryAfter = await spendRate(env, 'api:ip:' + clientIp(request), 120, 60)
      if (retryAfter) return fail(requestId, 'rate_limited', 429, true, retryAfter)
    }
    if (url.pathname === '/api/b/v1/invite-request') return await handleInviteRequest(request, env, requestId)
    if (url.pathname === '/api/b/v1/invite-verify') return await handleInviteVerify(request, env, requestId)
    if (url.pathname === '/api/b/v1/claim') return await handleClaim(request, env, requestId)
    for (const route of ['status', 'renew', 'release', 'retire']) {
      if (url.pathname === '/api/b/v1/' + route) return await pluginRequest(request, env, requestId, route)
    }
    if (url.pathname.startsWith('/admin/b/v1/')) return await handleAdmin(request, env, url, requestId)
    return fail(requestId, 'not_found', 404)
  } catch {
    return fail(requestId, 'storage_unavailable', 503, true, 5)
  }
}

export async function scheduled(event, env) {
  return await runOps(env, { kind: 'cron' })
}

export default { fetch: handleRequest, scheduled }
