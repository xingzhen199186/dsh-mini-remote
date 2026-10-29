/**
 * B 固定地址控制面的插件端客户端。
 *
 * endpoint 随插件发布写死，不让设置项改：clientSecret 只会送到这个地址。
 * 客户端只做 HTTP，不碰 cloudflared，也不把 token 写日志或本地文件。
 */
export const B_CONTROL_URL = 'https://control.dsh-everywhere.com'
export const B_REQUEST_TIMEOUT_MS = 8_000

function failure(status, code, retryable = false, retryAfter) {
  return {
    ok: false,
    status,
    code,
    retryable: Boolean(retryable),
    ...(Number(retryAfter) > 0 ? { retryAfter: Number(retryAfter) } : {}),
    ...(Number(retryAfter) > 0 ? { retryAfterMs: Number(retryAfter) * 1000 } : {}),
  }
}

async function postJson(endpoint, path, body, fetchFn, method = 'POST') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), B_REQUEST_TIMEOUT_MS)
  timer.unref?.()
  try {
    const response = await fetchFn(endpoint + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => undefined)
    const retryAfter = Number(payload?.retryAfter)
      || Number(response.headers.get('retry-after'))
      || undefined
    if (!response.ok || payload?.ok !== true) {
      return failure(
        response.status,
        typeof payload?.code === 'string' ? payload.code : 'http_error',
        payload?.retryable === true,
        retryAfter,
      )
    }
    return { ok: true, status: response.status, ...payload }
  } catch (error) {
    if (error?.name === 'AbortError') return failure(0, 'timeout', true)
    return failure(0, 'network_error', true)
  } finally {
    clearTimeout(timer)
  }
}

export function createBRelayClient({ identity, endpoint = B_CONTROL_URL, fetchFn = fetch } = {}) {
  if (!identity?.clientSecret) throw new Error('缺少 B 本地身份')

  const credential = () => ({ id: identity.id, clientSecret: identity.clientSecret })

  return {
    async claim({ activationCode, originPort }) {
      if (!identity.claimRequestId) return failure(0, 'identity_incomplete')
      return await postJson(endpoint, '/api/b/v1/claim', {
        activationCode: typeof activationCode === 'string' ? activationCode : '',
        clientSecret: identity.clientSecret,
        claimRequestId: identity.claimRequestId,
        originPort,
      }, fetchFn, 'PUT')
    },

    async status() {
      if (!identity.id) return failure(0, 'identity_incomplete')
      return await postJson(endpoint, '/api/b/v1/status', credential(), fetchFn)
    },

    async renew({ originPort } = {}) {
      if (!identity.id) return failure(0, 'identity_incomplete')
      return await postJson(endpoint, '/api/b/v1/renew', {
        ...credential(),
        ...(originPort === undefined ? {} : { originPort }),
      }, fetchFn)
    },

    async release() {
      if (!identity.id) return failure(0, 'identity_incomplete')
      return await postJson(endpoint, '/api/b/v1/release', credential(), fetchFn)
    },

    async retire() {
      if (!identity.id) return failure(0, 'identity_incomplete')
      return await postJson(endpoint, '/api/b/v1/retire', credential(), fetchFn)
    },
  }
}
