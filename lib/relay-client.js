/**
 * A 固定中继的 Worker 客户端。只做 HTTP 登记，不碰 cloudflared 生命周期。
 * endpoint 固定随插件发布，不开放任意地址，避免 secret 被送到恶意服务器。
 */
export const RELAY_CONTROL_URL = 'https://relay.dsh-mini-remote.com'
const TIMEOUT_MS = 8_000

async function postJson(url, body, fetchFn, method = 'POST') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  timer.unref?.()
  try {
    const response = await fetchFn(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => undefined)
    return { response, payload }
  } finally {
    clearTimeout(timer)
  }
}

export function createRelayClient({ identity, inviteCode = '', endpoint = RELAY_CONTROL_URL, fetchFn = fetch, log } = {}) {
  if (!identity?.id || !identity?.secret) throw new Error('缺少 A 中继身份')

  return {
    async register({ quickUrl }) {
      const body = {
        id: identity.id,
        secret: identity.secret,
        target: quickUrl,
        ...(inviteCode ? { inviteCode } : {}),
      }
      let result
      try {
        result = await postJson(endpoint + '/api/relay/v1/register', body, fetchFn, 'PUT')
      } catch (error) {
        return { ok: false, status: 0, error: error?.message ?? String(error) }
      }
      const { response, payload } = result
      if (!response.ok || payload?.ok !== true) {
        return {
          ok: false,
          status: response.status,
          error: payload?.error ?? `HTTP ${response.status}`,
          retryAfterMs: Number(response.headers.get('retry-after')) * 1000 || undefined,
        }
      }
      return { ok: true, publicUrl: payload.publicUrl, status: response.status }
    },

    async unregister() {
      try {
        await postJson(endpoint + '/api/relay/v1/unregister', {
          id: identity.id,
          secret: identity.secret,
        }, fetchFn)
      } catch (error) {
        log?.warn?.(`A 中继注销失败：${error?.message ?? error}`)
      }
    },
  }
}
