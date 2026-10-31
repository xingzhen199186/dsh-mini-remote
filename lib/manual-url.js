/**
 * 手动公网地址的归一化。
 *
 * 只接受完整的 https:// 地址；只保留 origin（域名 + 端口）。
 * 路径由配对页统一补 /mini。
 *
 * 为什么不再支持“只填端口”：这个字段是通用的外部入口，不应该默认
 * 用户想用当前 Tailscale 域名。那样会把通用配置偷偷绑到一条特定路径上。
 */
export function normalizeManualPublicUrl(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
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
