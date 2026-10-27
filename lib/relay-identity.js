/**
 * A 固定中继的本机身份：26 位 base32 id + 43 位 base64url secret。
 *
 * id 会出现在固定域名里，公开；secret 只用于向 Worker 证明“这个 id 是我的”。
 * 两者都不进二维码、不进浏览器状态、不进日志。
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const ID_RE = /^[a-z2-7]{26}$/
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

export function base32(bytes) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function createRelayIdentity() {
  return {
    version: 1,
    id: base32(randomBytes(16)),
    secret: randomBytes(32).toString('base64url'),
    createdAt: Date.now(),
  }
}

export function validateRelayIdentity(value) {
  return Boolean(value)
    && value.version === 1
    && typeof value.id === 'string' && ID_RE.test(value.id)
    && typeof value.secret === 'string' && SECRET_RE.test(value.secret)
}

export function relayIdentityPath(dir) {
  return join(dir, 'relay-identity.json')
}

/** 读身份；不存在就生成并落盘；损坏时抛错，不悄悄换 id。 */
export function loadOrCreateRelayIdentity(dir, log) {
  const path = relayIdentityPath(dir)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!validateRelayIdentity(parsed)) throw new Error('relay-identity.json 格式不对')
    return parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const created = createRelayIdentity()
  mkdirSync(dir, { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(created, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
  log?.info?.(`A 固定中继身份已生成：${created.id}`)
  return created
}
