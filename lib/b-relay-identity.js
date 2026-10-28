/**
 * B 固定地址的本机身份。
 *
 * clientSecret 由插件本地生成，服务端只登记它的哈希。身份文件损坏时抛错，
 * 绝不悄悄换一份：换了之后旧固定地址就再也认领不回来。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const B_ID_RE = /^[a-z2-7]{26}$/
export const B_CLIENT_SECRET_RE = /^[A-Za-z0-9_-]{43}$/
export const B_HOSTNAME_RE = /^[a-z2-7]{26}\.dsh-everywhere\.com$/
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/

export function createBRelayIdentity() {
  return {
    version: 1,
    clientSecret: randomBytes(32).toString('base64url'),
    claimRequestId: randomUUID(),
    id: null,
    hostname: null,
    originPort: null,
    createdAt: Date.now(),
  }
}

export function validateBRelayIdentity(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return false
  if (!B_CLIENT_SECRET_RE.test(value.clientSecret ?? '')) return false
  if (!REQUEST_ID_RE.test(value.claimRequestId ?? '')) return false
  if (value.id !== null && !B_ID_RE.test(value.id ?? '')) return false
  if (value.hostname !== null && !B_HOSTNAME_RE.test(value.hostname ?? '')) return false
  if ((value.id === null) !== (value.hostname === null)) return false
  if (value.originPort !== null
    && (!Number.isInteger(value.originPort) || value.originPort < 1 || value.originPort > 65_535)) return false
  return true
}

export function bRelayIdentityPath(dir) {
  return join(dir, 'b-identity.json')
}

export function saveBRelayIdentity(dir, identity) {
  if (!validateBRelayIdentity(identity)) throw new Error('B 本地身份格式不对，拒绝写入')
  mkdirSync(dir, { recursive: true })
  const path = bRelayIdentityPath(dir)
  const tmp = path + '.tmp'
  writeFileSync(tmp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* Windows 上不总能改权限；mode 已尽量收窄 */ }
  renameSync(tmp, path)
  return identity
}

/** 读身份；不存在才生成；JSON 损坏或字段不对时抛错，不覆盖原文件。 */
export function loadOrCreateBRelayIdentity(dir, log) {
  const path = bRelayIdentityPath(dir)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!validateBRelayIdentity(parsed)) throw new Error('b-identity.json 格式不对')
    return parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`B 本地身份文件读不出来：${path}。请修复或备份后手动删除，不能自动换一份。`, { cause: error })
    }
  }
  const created = createBRelayIdentity()
  saveBRelayIdentity(dir, created)
  log?.info?.(`B 固定地址本地身份已生成（clientSecret 只在本机）`)
  return created
}
