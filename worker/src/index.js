/**
 * A 固定中继 Worker 的 Phase 1 控制面。
 *
 * 只做身份、邀请、target 登记和运营开关；不代理手机流量（数据面在 Phase 2）。
 * 不照抄参考项目：这里把邀请准入、撤销墓碑、审计和运营开关放在第一版，
 * 因为插件是公开下载的，不能假设第一次注册的人一定是正常用户。
 *
 * 绑定：
 *   DB          D1（migrations/0001_init.sql）
 *   RELAY_KV    KV：target 与运营配置
 *   RELAY_PEPPER   HMAC pepper（Workers Secret）
 *   ADMIN_TOKEN    管理 API 的 service token（Phase 1；生产前置 Cloudflare Access）
 */

const ID_RE = /^[a-z2-7]{26}$/
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/
const TARGET_HOST_RE = /^[a-z0-9-]+\.trycloudflare\.com$/
const TARGET_TTL_SECONDS = 45 * 60
const MAX_BODY_BYTES = 8 * 1024
const RATE_WINDOW_MS = 60_000
const RATE_PER_IP = 30
const RATE_PER_ID = 6

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function fail(error, status = 400) {
  return json({ ok: false, error }, status)
}

function suffixOf(env) {
  const value = typeof env.RELAY_PUBLIC_SUFFIX === 'string' && env.RELAY_PUBLIC_SUFFIX
    ? env.RELAY_PUBLIC_SUFFIX
    : '.relay.example.com'
  return value.startsWith('.') ? value : '.' + value
}

function publicUrlOf(env, id) {
  return 'https://' + id + suffixOf(env)
}

function isTargetAllowed(target) {
  let url
  try { url = new URL(target) } catch { return false }
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  if (url.port) return false
  if (url.pathname !== '/' || url.search || url.hash) return false
  if (!TARGET_HOST_RE.test(url.hostname)) return false
  if (url.hostname.length <= '.trycloudflare.com'.length) return false
  return true
}

function base64url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmac(env, purpose, value) {
  if (typeof env.RELAY_PEPPER !== 'string' || !env.RELAY_PEPPER) throw new Error('relay pepper is not configured')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.RELAY_PEPPER),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(purpose + ':' + value))
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function readJson(request) {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return { error: 'body-too-large' }
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { error: 'invalid-json' }
  } catch {
    return { error: 'invalid-json' }
  }
}

async function configOf(env) {
  const raw = await env.RELAY_KV.get('relay-config', 'json').catch(() => null)
  return {
    registrationEnabled: raw?.registrationEnabled !== false,
    proxyEnabled: raw?.proxyEnabled !== false,
  }
}

async function setConfig(env, patch) {
  const current = await configOf(env)
  const next = { ...current, ...patch }
  await env.RELAY_KV.put('relay-config', JSON.stringify(next))
  return next
}

function clientIp(request) {
  const raw = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || ''
  return raw.split(',')[0].trim() || 'unknown'
}

async function spendRate(env, bucket, max) {
  const windowStart = Math.floor(Date.now() / RATE_WINDOW_MS) * RATE_WINDOW_MS
  const row = await env.DB.prepare('SELECT count FROM relay_rate_limit WHERE bucket = ? AND window_start = ?')
    .bind(bucket, windowStart).first()
  const count = Number(row?.count ?? 0) + 1
  await env.DB.prepare(
    'INSERT INTO relay_rate_limit (bucket, window_start, count) VALUES (?, ?, 1) '
    + 'ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1',
  ).bind(bucket, windowStart).run()
  return count <= max
}

async function audit(env, actor, action, target, reason) {
  await env.DB.prepare('INSERT INTO relay_audit (actor, action, target, reason, at) VALUES (?, ?, ?, ?, ?)')
    .bind(actor, action, target ?? null, reason ?? null, Date.now()).run().catch(() => undefined)
}

async function requireAdmin(request, env) {
  const token = typeof env.ADMIN_TOKEN === 'string' ? env.ADMIN_TOKEN : ''
  const header = request.headers.get('authorization') || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return { ok: false, response: fail('admin-not-configured', 503) }
  if (!timingSafeEqual(bearer, token)) return { ok: false, response: fail('admin-unauthorized', 401) }
  return { ok: true, actor: 'admin-token' }
}

async function handleRegister(request, env) {
  if (request.method !== 'PUT') return fail('method-not-allowed', 405)
  const body = await readJson(request)
  if (body.error) return fail(body.error, 400)
  const id = typeof body.id === 'string' ? body.id : ''
  const secret = typeof body.secret === 'string' ? body.secret : ''
  const target = typeof body.target === 'string' ? body.target : ''
  if (!ID_RE.test(id) || !SECRET_RE.test(secret) || !isTargetAllowed(target)) return fail('invalid-params', 400)

  const ip = clientIp(request)
  const ipOk = await spendRate(env, 'ip:' + ip, RATE_PER_IP)
  const idOk = await spendRate(env, 'id:' + id, RATE_PER_ID)
  if (!ipOk || !idOk) return fail('rate-limited', 429)

  let secretHash
  try { secretHash = await hmac(env, 'identity', id + ':' + secret) } catch { return fail('storage-unavailable', 503) }

  const existing = await env.DB.prepare('SELECT id, secret_hash, state FROM relay_identities WHERE id = ?').bind(id).first()
  if (existing) {
    if (existing.state === 'revoked') return fail('revoked', 403)
    if (!timingSafeEqual(existing.secret_hash, secretHash)) return fail('auth-failed', 403)
  } else {
    const config = await configOf(env)
    if (!config.registrationEnabled) return fail('registration-disabled', 403)
    if (env.RELAY_INVITE_REQUIRED !== '0') {
      const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode : ''
      if (!inviteCode) return fail('invite-required', 403)
      let inviteHash
      try { inviteHash = await hmac(env, 'invite', inviteCode) } catch { return fail('storage-unavailable', 503) }
      const invite = await env.DB.prepare(
        'SELECT code_hash FROM relay_invites WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?',
      ).bind(inviteHash, Date.now()).first()
      if (!invite) return fail('invite-invalid', 403)
      const consumed = await env.DB.prepare('UPDATE relay_invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
        .bind(Date.now(), inviteHash).run()
      if (!consumed?.meta?.changes) return fail('invite-invalid', 403)
    }
    await env.DB.prepare(
      'INSERT INTO relay_identities (id, secret_hash, state, created_at, last_seen_at) VALUES (?, ?, \'active\', ?, ?)',
    ).bind(id, secretHash, Date.now(), Date.now()).run()
  }

  const now = Date.now()
  const expiresAt = now + TARGET_TTL_SECONDS * 1000
  try {
    await env.RELAY_KV.put('relay-target:' + id, JSON.stringify({
      state: 'active', target, updatedAt: now, expiresAt,
    }), { expirationTtl: TARGET_TTL_SECONDS })
  } catch {
    return fail('storage-unavailable', 503)
  }
  await env.DB.prepare('UPDATE relay_identities SET last_seen_at = ? WHERE id = ?').bind(now, id).run().catch(() => undefined)
  return json({ ok: true, id, publicUrl: publicUrlOf(env, id), expiresAt })
}

async function handleUnregister(request, env) {
  if (request.method !== 'POST') return fail('method-not-allowed', 405)
  const body = await readJson(request)
  if (body.error) return fail(body.error, 400)
  const id = typeof body.id === 'string' ? body.id : ''
  const secret = typeof body.secret === 'string' ? body.secret : ''
  if (!ID_RE.test(id) || !SECRET_RE.test(secret)) return fail('invalid-params', 400)
  const existing = await env.DB.prepare('SELECT id, secret_hash, state FROM relay_identities WHERE id = ?').bind(id).first()
  if (!existing || existing.state === 'revoked') return fail('auth-failed', 403)
  let secretHash
  try { secretHash = await hmac(env, 'identity', id + ':' + secret) } catch { return fail('storage-unavailable', 503) }
  if (!timingSafeEqual(existing.secret_hash, secretHash)) return fail('auth-failed', 403)
  await env.RELAY_KV.delete('relay-target:' + id).catch(() => undefined)
  await env.DB.prepare('UPDATE relay_identities SET last_seen_at = ? WHERE id = ?').bind(Date.now(), id).run().catch(() => undefined)
  return json({ ok: true })
}


/** `<id>.dsh-mini-remote.com` 的 id；只认一层，避免二级子域绕过。 */
function relayIdOf(host, suffix) {
  if (typeof host !== 'string' || !host.endsWith(suffix)) return null
  const id = host.slice(0, -suffix.length)
  if (!id || id.includes('.')) return null
  return ID_RE.test(id) ? id : null
}

const OFFLINE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>实例离线</title></head><body style="font-family:system-ui,sans-serif;padding:24px;max-width:32em;margin:0 auto;line-height:1.6">
<p><strong>这台 DSH 当前离线。</strong></p>
<p>隧道尚未启动或地址已更换，稍等片刻后刷新本页即可；本页地址固定不变，无需重新配对。</p>
<hr style="border:none;border-top:1px solid #ccc;margin:16px 0">
<p><strong>This DSH instance is offline.</strong></p>
<p>The tunnel is not running right now. Refresh in a moment — this address never changes, so no re-pairing is needed.</p>
</body></html>`

function offlineResponse(status = 503, detail = 'offline') {
  return new Response(OFFLINE_HTML, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'referrer-policy': 'no-referrer',
      'x-relay-offline': detail,
    },
  })
}

/** 把 target 的绝对 Location 换回固定 Origin；外部 Location 不跟着跳。 */
function rewriteLocation(location, targetOrigin, publicOrigin) {
  if (!location) return location
  try {
    const parsed = new URL(location, targetOrigin)
    if (parsed.origin === targetOrigin) return publicOrigin + parsed.pathname + parsed.search + parsed.hash
    return location
  } catch {
    return location
  }
}

async function handleProxy(request, env, id) {
  let record
  try {
    record = await env.RELAY_KV.get('relay-target:' + id, 'json')
  } catch {
    return new Response('relay storage unavailable', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }
  if (!record) return offlineResponse(503, 'no-target')
  if (record.state === 'revoked') return offlineResponse(410, 'revoked')
  if (record.state !== 'active' || typeof record.target !== 'string') return offlineResponse(503, 'no-target')

  let target
  try { target = new URL(record.target) } catch { return offlineResponse(502, 'bad-target') }
  const targetOrigin = target.origin
  const publicOrigin = 'https://' + id + suffixOf(env)

  const url = new URL(request.url)
  url.protocol = 'https:'
  url.hostname = target.hostname
  url.port = ''

  const headers = new Headers(request.headers)
  headers.set('host', target.host)
  for (const name of ['cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip']) {
    headers.delete(name)
  }
  // Origin/Referer 保留固定 Origin，应用层看到的就是手机实际访问的源。
  const upgrade = request.headers.get('upgrade') === 'websocket'
  const init = {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' || upgrade ? undefined : request.body,
    redirect: 'manual',
    ...(upgrade ? {} : { duplex: 'half' }),
  }
  let response
  try {
    response = await fetch(url.toString(), init)
  } catch (error) {
    return new Response('relay upstream unavailable', { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }
  if (response.status === 101) return response

  const location = rewriteLocation(response.headers.get('location'), targetOrigin, publicOrigin)
  if (location !== response.headers.get('location')) {
    const next = new Headers(response.headers)
    next.set('location', location)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: next })
  }
  return response
}

async function handleAdmin(request, env, url) {
  const auth = await requireAdmin(request, env)
  if (!auth.ok) return auth.response
  const path = url.pathname

  if (request.method === 'GET' && path === '/admin/relay/v1/identities') {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50))
    const rows = await env.DB.prepare(
      'SELECT id, state, created_at, last_seen_at, revoked_at FROM relay_identities ORDER BY last_seen_at DESC LIMIT ?',
    ).bind(limit).all()
    return json({ ok: true, identities: rows.results ?? [] })
  }

  if (request.method === 'GET' && path === '/admin/relay/v1/audit') {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50))
    const rows = await env.DB.prepare(
      'SELECT seq, actor, action, target, reason, at FROM relay_audit ORDER BY seq DESC LIMIT ?',
    ).bind(limit).all()
    return json({ ok: true, audit: rows.results ?? [] })
  }

  if (request.method === 'POST' && path === '/admin/relay/v1/invites') {
    const body = await readJson(request)
    if (body.error) return fail(body.error, 400)
    const code = typeof body.code === 'string' && body.code ? body.code : base64url(crypto.getRandomValues(new Uint8Array(24)))
    const days = Math.max(1, Math.min(90, Number(body.expiresInDays) || 7))
    let hash
    try { hash = await hmac(env, 'invite', code) } catch { return fail('storage-unavailable', 503) }
    await env.DB.prepare('INSERT INTO relay_invites (code_hash, created_at, expires_at, note) VALUES (?, ?, ?, ?)')
      .bind(hash, Date.now(), Date.now() + days * 86_400_000, typeof body.note === 'string' ? body.note : null).run()
    await audit(env, auth.actor, 'invite.create', null, body.note ?? null)
    return json({ ok: true, code, expiresInDays: days })
  }

  if (request.method === 'POST' && path === '/admin/relay/v1/revoke') {
    const body = await readJson(request)
    if (body.error) return fail(body.error, 400)
    const id = typeof body.id === 'string' ? body.id : ''
    if (!ID_RE.test(id)) return fail('invalid-params', 400)
    const result = await env.DB.prepare(
      'UPDATE relay_identities SET state = \'revoked\', revoked_at = ? WHERE id = ?',
    ).bind(Date.now(), id).run()
    if (!result?.meta?.changes) return fail('unknown-id', 404)
    await env.RELAY_KV.put('relay-target:' + id, JSON.stringify({ state: 'revoked' }), { expirationTtl: TARGET_TTL_SECONDS })
    await audit(env, auth.actor, 'identity.revoke', id, typeof body.reason === 'string' ? body.reason : null)
    return json({ ok: true })
  }

  if (request.method === 'POST' && path === '/admin/relay/v1/config') {
    const body = await readJson(request)
    if (body.error) return fail(body.error, 400)
    const patch = {}
    if (typeof body.registrationEnabled === 'boolean') patch.registrationEnabled = body.registrationEnabled
    if (typeof body.proxyEnabled === 'boolean') patch.proxyEnabled = body.proxyEnabled
    if (!Object.keys(patch).length) return fail('invalid-params', 400)
    const next = await setConfig(env, patch)
    await audit(env, auth.actor, 'config.update', null, JSON.stringify(patch))
    return json({ ok: true, config: next })
  }

  return fail('not-found', 404)
}

async function handleControl(request, env, url) {
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ ok: true, service: 'dsh-mini-relay', version: 1 })
  }
  if (url.pathname === '/api/relay/v1/register') return handleRegister(request, env)
  if (url.pathname === '/api/relay/v1/unregister') return handleUnregister(request, env)
  if (url.pathname.startsWith('/admin/relay/v1/')) return handleAdmin(request, env, url)
  return fail('not-found', 404)
}

export async function handleRequest(request, env) {
  const url = new URL(request.url)
  const suffix = suffixOf(env)
  const controlHost = typeof env.RELAY_CONTROL_HOST === 'string' && env.RELAY_CONTROL_HOST
    ? env.RELAY_CONTROL_HOST
    : 'relay' + suffix
  if (url.hostname === controlHost) return handleControl(request, env, url)
  const id = relayIdOf(url.hostname, suffix)
  if (id) return handleProxy(request, env, id)
  return fail('not-found', 404)
}

export default { fetch: handleRequest }
