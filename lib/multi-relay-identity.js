/**
 * 自建多用户中继的本机身份。
 *
 * frpToken 只在这里和 0600 的 frpc 配置里出现；不写 settings、不回显界面、不日志。
 * 身份文件损坏时读取函数返回错误对象，不向 UI 抛异常。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeControlUrl } from './multi-relay-client.js'

export const MULTI_RELAY_ID_RE = /^[a-z2-7]{26}$/
export const MULTI_RELAY_HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/
const CLIENT_SECRET_RE = /^[A-Za-z0-9_-]{43}$/
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/

export function createMultiRelayIdentity(controlUrl) {
  return {
    version: 1,
    controlUrl,
    clientSecret: randomBytes(32).toString('base64url'),
    claimRequestId: randomUUID(),
    id: null,
    publicHost: null,
    controlHost: null,
    frpsPort: 443,
    transport: 'wss',
    frpToken: null,
    createdAt: Date.now(),
  }
}

export function validateMultiRelayIdentity(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return false
  if (normalizeControlUrl(value.controlUrl) !== value.controlUrl) return false
  if (!CLIENT_SECRET_RE.test(value.clientSecret ?? '')) return false
  if (!REQUEST_ID_RE.test(value.claimRequestId ?? '')) return false
  if (value.id !== null && !MULTI_RELAY_ID_RE.test(value.id ?? '')) return false
  if (value.publicHost !== null && !MULTI_RELAY_HOST_RE.test(value.publicHost ?? '')) return false
  if (value.controlHost !== null && !MULTI_RELAY_HOST_RE.test(value.controlHost ?? '')) return false
  if ((value.id === null) !== (value.publicHost === null)) return false
  if ((value.publicHost === null) !== (value.controlHost === null)) return false
  if (!Number.isInteger(value.frpsPort) || value.frpsPort < 1 || value.frpsPort > 65535) return false
  if (value.transport !== 'wss') return false
  if (value.frpToken !== null && (typeof value.frpToken !== 'string' || value.frpToken.length < 20)) return false
  return true
}

export function multiRelayIdentityPath(dir) {
  return join(dir, 'multi-relay.json')
}

export function saveMultiRelayIdentity(dir, identity) {
  if (!validateMultiRelayIdentity(identity)) throw new Error('多用户中继身份格式不对，拒绝写入')
  mkdirSync(dir, { recursive: true })
  const path = multiRelayIdentityPath(dir)
  const tmp = path + '.tmp'
  writeFileSync(tmp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* Windows 上不总是能改权限 */ }
  renameSync(tmp, path)
  return identity
}

/** 不抛异常：身份缺失返回 identity:null；损坏返回 error 文案，交给 UI 显示。 */
export function loadMultiRelayIdentity(dir) {
  const path = multiRelayIdentityPath(dir)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!validateMultiRelayIdentity(parsed)) {
      return { identity: null, error: '本地多用户中继身份文件格式不对；不会自动换身份，请备份后手动处理。' }
    }
    return { identity: parsed, error: null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { identity: null, error: null }
    return { identity: null, error: '本地多用户中继身份文件读不出来；不会自动换身份，请检查文件权限。' }
  }
}
