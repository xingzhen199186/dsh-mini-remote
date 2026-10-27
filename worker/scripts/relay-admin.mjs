#!/usr/bin/env node
/**
 * Phase 1 运营 CLI：不替代 Cloudflare Access，只是管理 API 的薄封装。
 *
 * 用法：
 *   RELAY_ADMIN_URL=https://relay.example.com \
 *   RELAY_ADMIN_TOKEN=... \
 *   node worker/scripts/relay-admin.mjs list
 *   ... invite --note "首批"
 *   ... revoke <id> --reason "abuse"
 *   ... config --registration=false
 *   ... audit
 */
const base = (process.env.RELAY_ADMIN_URL || '').replace(/\/+$/, '')
const token = process.env.RELAY_ADMIN_TOKEN || ''
const accessId = process.env.RELAY_ACCESS_CLIENT_ID || ''
const accessSecret = process.env.RELAY_ACCESS_CLIENT_SECRET || ''

if (!base || !token) {
  console.error('需要 RELAY_ADMIN_URL 和 RELAY_ADMIN_TOKEN')
  process.exit(2)
}

async function call(method, path, body) {
  const headers = {
    authorization: 'Bearer ' + token,
    ...(body ? { 'content-type': 'application/json' } : {}),
  }
  // 如果 /admin/* 前面套了 Cloudflare Access，命令行也要带服务令牌。
  if (accessId && accessSecret) {
    headers['CF-Access-Client-Id'] = accessId
    headers['CF-Access-Client-Secret'] = accessSecret
  }
  const response = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  if (!response.ok) {
    console.error(JSON.stringify({ status: response.status, error: parsed }, null, 2))
    process.exit(1)
  }
  return parsed
}

const [command, ...rest] = process.argv.slice(2)
const flag = (name) => {
  const index = rest.indexOf('--' + name)
  return index >= 0 ? rest[index + 1] : undefined
}

try {
  if (command === 'list') {
    console.log(JSON.stringify(await call('GET', '/admin/relay/v1/identities?limit=100'), null, 2))
  } else if (command === 'audit') {
    console.log(JSON.stringify(await call('GET', '/admin/relay/v1/audit?limit=100'), null, 2))
  } else if (command === 'invite') {
    console.log(JSON.stringify(await call('POST', '/admin/relay/v1/invites', {
      note: flag('note'), expiresInDays: Number(flag('days')) || 7,
    }), null, 2))
  } else if (command === 'revoke') {
    const id = rest[0]
    if (!id) throw new Error('revoke 需要 id')
    console.log(JSON.stringify(await call('POST', '/admin/relay/v1/revoke', { id, reason: flag('reason') || 'manual' }), null, 2))
  } else if (command === 'config') {
    const registration = flag('registration')
    const proxy = flag('proxy')
    console.log(JSON.stringify(await call('POST', '/admin/relay/v1/config', {
      ...(registration === undefined ? {} : { registrationEnabled: registration === 'true' }),
      ...(proxy === undefined ? {} : { proxyEnabled: proxy === 'true' }),
    }), null, 2))
  } else {
    console.error('命令：list | invite | revoke | config | audit')
    process.exit(2)
  }
} catch (error) {
  console.error(error?.message ?? String(error))
  process.exit(1)
}
