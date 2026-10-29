/**
 * 自建多用户中继控制面的插件端客户端。
 *
 * 控制台地址由用户填写，但只接受 HTTPS origin，不允许路径、查询和账号信息。
 * 客户端只做 HTTP，不碰 frpc，也不把邀请码或 token 写日志。
 */
export const MULTI_RELAY_TIMEOUT_MS = 8_000

const RETRYABLE = new Set([
  'rate_limited',
  'timeout',
  'network_error',
  'helper_failed',
  'provisioning_incomplete',
])

export const MULTI_RELAY_ERROR_MESSAGES = {
  invalid_control_url: '控制台地址不对：只填 https:// 开头的地址，不带路径。',
  invite_required: '这个中继需要邀请码。',
  registration_closed: '这个中继没有开放自助注册，需要邀请码。',
  invite_invalid: '邀请码无效，请向中继管理员确认。',
  invite_used: '这个邀请码已经用过了。',
  invite_expired: '这个邀请码已经过期。',
  auth_failed: '本机身份不对，可能身份文件已被换过。',
  capacity_exhausted: '中继的租户名额已经用完。',
  rate_limited: '开通请求太频繁，请稍后再试。',
  helper_failed: '中继服务器创建实例失败，请联系管理员。',
  provisioning_incomplete: '中继实例还在创建中，稍后再试。',
  tenant_failed: '中继实例创建失败，请联系管理员。',
  tenant_revoked: '这个中继实例已经被管理员撤销。',
  not_found: '控制台找不到这个接口，请确认地址填的是管理后台域名。',
  timeout: '连中继控制台超时（8 秒）。',
  network_error: '连不上中继控制台，检查地址和这台电脑的网络。',
  identity_incomplete: '本地中继身份不完整，先重新开通。',
  control_url_mismatch: '控制台地址和本地已保存的身份不一致。要换服务器，请先备份并删除 multi-relay.json。',
  invite_token_missing: '服务端没有返回 frp token，无法启动。请让中继管理员撤销后重新发邀请码。',
  frpc_not_found: '找不到 frpc。请把 frpc 放进插件数据目录的 bin/ 下。',
  frpc_start_failed: 'frpc 没有启动成功。',
  reconnect_unavailable: '没有可重连的本地身份，请先开通。',
  http_error: '中继控制台返回了错误。',
}

export function multiRelayErrorMessage(code, fallback) {
  if (code && MULTI_RELAY_ERROR_MESSAGES[code]) return MULTI_RELAY_ERROR_MESSAGES[code]
  if (typeof fallback === 'string' && fallback.trim()) return fallback.trim()
  return code ? `中继控制台返回：${code}` : '中继控制台操作失败。'
}

/** 只接受 https origin；路径、查询、hash、用户名密码都不接受。 */
export function normalizeControlUrl(value) {
  let parsed
  try {
    parsed = new URL(String(value ?? '').trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null
  if (parsed.search || parsed.hash) return null
  return parsed.origin
}

function failure(status, code, retryable, retryAfter, fallbackMessage) {
  return {
    ok: false,
    status,
    code,
    retryable: retryable ?? RETRYABLE.has(code),
    ...(Number(retryAfter) > 0 ? { retryAfter: Number(retryAfter) } : {}),
    ...(Number(retryAfter) > 0 ? { retryAfterMs: Number(retryAfter) * 1000 } : {}),
    message: multiRelayErrorMessage(code, fallbackMessage),
  }
}

async function postJson(endpoint, path, body, fetchFn) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MULTI_RELAY_TIMEOUT_MS)
  timer.unref?.()
  try {
    const response = await fetchFn(endpoint + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => undefined)
    if (!response.ok || payload?.ok !== true) {
      const code = typeof payload?.error === 'string' ? payload.error : 'http_error'
      const retryAfter = Number(payload?.retryAfter)
        || Number(response.headers.get('retry-after'))
        || undefined
      return failure(response.status, code, payload?.retryable, retryAfter, payload?.message)
    }
    return { ok: true, status: response.status, ...payload }
  } catch (error) {
    if (error?.name === 'AbortError') return failure(0, 'timeout')
    return failure(0, 'network_error')
  } finally {
    clearTimeout(timer)
  }
}

export function createMultiRelayClient({
  identity,
  controlUrl,
  fetchFn = fetch,
} = {}) {
  if (!identity?.clientSecret) throw new Error('缺少多用户中继本地身份')

  const endpointOf = () => normalizeControlUrl(controlUrl || identity.controlUrl)
  const requireEndpoint = () => {
    const endpoint = endpointOf()
    if (!endpoint) throw Object.assign(new Error('invalid_control_url'), { code: 'invalid_control_url' })
    return endpoint
  }

  return {
    async claim({ inviteCode, originPort }) {
      let endpoint
      try { endpoint = requireEndpoint() } catch { return failure(0, 'invalid_control_url') }
      if (!identity.claimRequestId) return failure(0, 'identity_incomplete')
      return await postJson(endpoint, '/api/claim', {
        inviteCode: typeof inviteCode === 'string' ? inviteCode.trim() : '',
        clientSecret: identity.clientSecret,
        originPort,
        claimRequestId: identity.claimRequestId,
      }, fetchFn)
    },

    async status() {
      let endpoint
      try { endpoint = requireEndpoint() } catch { return failure(0, 'invalid_control_url') }
      if (!identity.id) return failure(0, 'identity_incomplete')
      return await postJson(endpoint, '/api/status', {
        id: identity.id,
        clientSecret: identity.clientSecret,
      }, fetchFn)
    },

    async release() {
      let endpoint
      try { endpoint = requireEndpoint() } catch { return failure(0, 'invalid_control_url') }
      if (!identity.id) return failure(0, 'identity_incomplete')
      return await postJson(endpoint, '/api/release', {
        id: identity.id,
        clientSecret: identity.clientSecret,
      }, fetchFn)
    },
  }
}
