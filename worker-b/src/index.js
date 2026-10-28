import { CloudflareError, cloudflareApiOf } from './cloudflare.js'

const ID_RE = /^[a-z2-7]{26}$/
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/
const MAX_BODY_BYTES = 4 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
const RELEASE_RETENTION_MS = 30 * DAY_MS
const TUNNEL_PREFIX = 'dsh-b-relay-'

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
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
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

function randomId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const bytes = crypto.getRandomValues(new Uint8Array(26))
  return [...bytes].map((byte) => alphabet[byte & 31]).join('')
}

function randomSecret() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

async function hmac(env, purpose, value) {
  if (!env.B_PEPPER) throw new Error('B_PEPPER is not configured')
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.B_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(purpose + ':' + value))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
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

async function spendRate(env, bucket, maximum, windowSeconds) {
  const now = Date.now()
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000
  await env.DB.prepare(
    'INSERT INTO b_rate_limits (bucket, window_start, count) VALUES (?, ?, 1) '
    + 'ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1',
  ).bind(bucket, windowStart).run()
  const row = await env.DB.prepare('SELECT count FROM b_rate_limits WHERE bucket = ? AND window_start = ?')
    .bind(bucket, windowStart).first()
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

async function handleClaim(request, env, requestId) {
  if (request.method !== 'PUT') return fail(requestId, 'method_not_allowed', 405)
  const body = await readJson(request)
  if (body.error) return fail(requestId, body.error, 400)
  const { activationCode, clientSecret, claimRequestId, originPort } = body
  if (!SECRET_RE.test(activationCode || '') || !SECRET_RE.test(clientSecret || '')
    || !REQUEST_ID_RE.test(claimRequestId || '') || !validPort(originPort)) {
    return fail(requestId, validPort(originPort) ? 'invalid_request' : 'invalid_origin_port', 400)
  }
  const codeHash = await hmac(env, 'activation', activationCode)
  const ipHash = await hmac(env, 'ip', clientIp(request))
  let retryAfter = await spendRate(env, 'claim:ip:' + ipHash, 5, 3600)
  if (!retryAfter) retryAfter = await spendRate(env, 'claim:code:' + codeHash, 10, 900)
  if (retryAfter) return fail(requestId, 'rate_limited', 429, true, retryAfter)
  const api = cloudflareApiOf(env)
  if (!api) return fail(requestId, 'cf_api_unavailable', 503, true, 5)

  const invite = await env.DB.prepare('SELECT * FROM b_activation_codes WHERE code_hash = ?').bind(codeHash).first()
  if (!invite) return fail(requestId, 'auth_failed', 403)
  if (invite.state === 'invited' && Number(invite.expires_at) <= Date.now()) return fail(requestId, 'activation_expired', 410)
  let lease = await leaseOf(env, invite.lease_id)
  if (!lease) return fail(requestId, 'storage_unavailable', 503, true, 5)
  const secretHash = await hmac(env, 'client', lease.lease_id + ':' + clientSecret)
  const fingerprint = await digestHex(claimRequestId + ':' + String(originPort))

  if (lease.state === 'invited') {
    if (invite.state !== 'invited') return fail(requestId, 'activation_already_claimed', 409)
    const now = Date.now()
    const consumed = await env.DB.batch([
      env.DB.prepare('UPDATE b_activation_codes SET state = \'claimed\', claimed_at = ? WHERE code_id = ? AND state = \'invited\' AND expires_at > ?')
        .bind(now, invite.code_id, now),
      env.DB.prepare(
        'UPDATE b_leases SET state = \'claimed\', client_secret_hash = ?, secret_version = 1, origin_port = ?, '
        + 'claimed_at = ?, last_seen_at = ?, row_version = row_version + 1 WHERE lease_id = ? AND state = \'invited\'',
      ).bind(secretHash, originPort, now, now, lease.lease_id),
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
  if (lease.state !== 'claimed' && lease.state !== 'active') return fail(requestId, 'state_conflict', 409)
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

function adminUnauthorized(request, env, requestId) {
  const token = typeof env.ADMIN_TOKEN === 'string' ? env.ADMIN_TOKEN : ''
  if (!token) return fail(requestId, 'admin_not_configured', 503)
  const header = request.headers.get('authorization') || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  return timingSafeEqual(bearer, token) ? undefined : fail(requestId, 'auth_failed', 401)
}

async function handleAdmin(request, env, url, requestId) {
  const unauthorized = adminUnauthorized(request, env, requestId)
  if (unauthorized) return unauthorized
  if (url.pathname === '/admin/b/v1/invites') {
    if (request.method !== 'POST') return fail(requestId, 'method_not_allowed', 405)
    const body = await readJson(request)
    if (body.error) return fail(requestId, body.error, 400)
    const days = body.expiresInDays === undefined ? 7 : body.expiresInDays
    if (!Number.isInteger(days) || days < 1 || days > 90 || (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 200))) {
      return fail(requestId, 'invalid_request', 400)
    }
    const id = randomId()
    const code = randomSecret()
    const codeId = crypto.randomUUID()
    const now = Date.now()
    const expiresAt = now + days * DAY_MS
    const hostname = hostnameOf(env, id)
    await env.DB.batch([
      env.DB.prepare('INSERT INTO b_leases (lease_id, hostname, state, tunnel_name, created_at) VALUES (?, ?, \'invited\', ?, ?)')
        .bind(id, hostname, tunnelNameOf(id), now),
      env.DB.prepare(
        'INSERT INTO b_activation_codes (code_id, code_hash, lease_id, state, note, created_at, expires_at) VALUES (?, ?, ?, \'invited\', ?, ?, ?)',
      ).bind(codeId, await hmac(env, 'activation', code), id, body.note ?? null, now, expiresAt),
      auditStatement(env, { actor: 'admin-token', action: 'invite.create', leaseId: id, codeId, requestId, after: 'invited', result: 'succeeded' }),
    ])
    return ok(requestId, { code, codeId, id, hostname, expiresAt })
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
  return fail(requestId, 'not_found', 404)
}

export async function handleRequest(request, env) {
  const requestId = crypto.randomUUID()
  try {
    const url = new URL(request.url)
    if (url.hostname !== (env.B_CONTROL_HOST || 'control.dsh-everywhere.com')) return fail(requestId, 'not_found', 404)
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

export default { fetch: handleRequest }
