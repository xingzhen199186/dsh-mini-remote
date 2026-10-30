/**
 * 邀请票：把控制台地址和邀请码打包成一条用户不需要理解的不透明字符串。
 *
 * 票里没有秘密签名；它的安全性来自“一次性 + 短有效期 + 只发给被邀请人”。
 * 插件只负责拆票，真正的准入仍由控制台校验邀请码。
 */
import { normalizeControlUrl } from './multi-relay-client.js'

export const MULTI_RELAY_TICKET_PREFIX = 'relay1.'
const CODE_RE = /^[A-Za-z0-9_-]{20,128}$/

function decodeBase64Url(text) {
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4)
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

export function parseMultiRelayTicket(value) {
  const raw = String(value ?? '').trim()
  if (!raw.startsWith(MULTI_RELAY_TICKET_PREFIX)) {
    return { ok: false, code: 'ticket_invalid', message: '邀请票格式不对。' }
  }
  let payload
  try {
    payload = JSON.parse(decodeBase64Url(raw.slice(MULTI_RELAY_TICKET_PREFIX.length)))
  } catch {
    return { ok: false, code: 'ticket_invalid', message: '邀请票读不出来。' }
  }
  if (!payload || payload.v !== 1) {
    return { ok: false, code: 'ticket_invalid', message: '邀请票版本不支持。' }
  }
  const controlUrl = normalizeControlUrl(payload.u)
  if (!controlUrl) {
    return { ok: false, code: 'ticket_invalid', message: '邀请票里的控制台地址不对。' }
  }
  const inviteCode = typeof payload.c === 'string' ? payload.c.trim() : ''
  if (!CODE_RE.test(inviteCode)) {
    return { ok: false, code: 'ticket_invalid', message: '邀请票里的邀请码不对。' }
  }
  const expiresAt = Number(payload.e)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { ok: false, code: 'ticket_expired', message: '邀请票已经过期，请让管理员重新生成。' }
  }
  return { ok: true, controlUrl, inviteCode, expiresAt }
}


/** 邀请链接：https://admin.example.com/join/<code>。 */
export function parseMultiRelayJoinUrl(value) {
  let url
  try { url = new URL(String(value ?? '').trim()) } catch {
    return { ok: false, code: 'ticket_invalid', message: '邀请链接格式不对。' }
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    return { ok: false, code: 'ticket_invalid', message: '邀请链接必须是 https，且不能带查询参数。' }
  }
  const match = url.pathname.match(/^\/join\/([A-Za-z0-9_-]{20,128})\/?$/)
  if (!match) return { ok: false, code: 'ticket_invalid', message: '邀请链接里没有有效邀请码。' }
  const controlUrl = normalizeControlUrl(url.origin)
  if (!controlUrl) return { ok: false, code: 'ticket_invalid', message: '邀请链接里的控制台地址不对。' }
  return { ok: true, controlUrl, inviteCode: match[1], expiresAt: null }
}

/** 同时接受邀请票和邀请链接。 */
export function parseMultiRelayInvite(value) {
  const raw = String(value ?? '').trim()
  if (raw.startsWith(MULTI_RELAY_TICKET_PREFIX)) return parseMultiRelayTicket(raw)
  if (/^https:\/\//i.test(raw)) return parseMultiRelayJoinUrl(raw)
  return { ok: false, code: 'ticket_invalid', message: '请粘贴邀请链接或邀请票。' }
}
