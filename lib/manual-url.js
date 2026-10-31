/**
 * 手动公网地址的归一化。
 *
 * 支持两种输入：
 *   1. 完整地址：https://host:8443
 *   2. 只填端口：8443 或 :8443 —— 用 fallbackBase 的域名补成完整地址
 *
 * 只允许 https，且只保留 origin（域名 + 端口）；路径由配对页统一补 /mini。
 */
export function normalizeManualPublicUrl(value, fallbackBase = '') {
  const raw = String(value ?? '').trim()
  if (!raw) return ''

  const portOnly = /^:?(\d{1,5})$/.exec(raw)
  if (portOnly) {
    const port = Number(portOnly[1])
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    const base = originOf(fallbackBase)
    if (!base) return null
    const url = new URL(base)
    const suffix = port === 443 ? '' : ':' + String(port)
    return url.protocol + '//' + url.hostname + suffix
  }

  return originOf(raw)
}

function originOf(value) {
  try {
    const parsed = new URL(String(value ?? '').trim())
    if (parsed.protocol !== 'https:' || !parsed.hostname) return null
    if (parsed.username || parsed.password) return null
    return parsed.protocol + '//' + parsed.host
  } catch {
    return null
  }
}
