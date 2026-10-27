#!/usr/bin/env node
/**
 * A 中继每日用量快照。
 *
 * 数据来自 Cloudflare GraphQL Analytics，只读。
 * token 优先取 CLOUDFLARE_API_TOKEN；没设时读本机 wrangler 的 OAuth token。
 * 不打印 token，不写任何 Cloudflare 资源。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || 'c388ee35863086d5ffbcee0bb4b63e0b'
const LIMITS = {
  workersRequests: 100_000,
  d1RowsRead: 5_000_000,
  d1RowsWritten: 100_000,
  kvRequests: 100_000,
}

function wranglerToken() {
  const candidates = [
    join(homedir(), '.wrangler', 'config', 'default.toml'),
    join(process.env.APPDATA || '', 'xdg.config', '.wrangler', 'config', 'default.toml'),
  ]
  for (const path of candidates) {
    try {
      const match = readFileSync(path, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)
      if (match) return match[1]
    } catch {
      // 试下一个位置
    }
  }
  return ''
}

const token = process.env.CLOUDFLARE_API_TOKEN || wranglerToken()
if (!token) {
  console.error('缺少 Cloudflare token：设 CLOUDFLARE_API_TOKEN，或先 wrangler login。')
  process.exit(2)
}

const day = new Date().toISOString().slice(0, 10)
const query = `query {
  viewer {
    accounts(filter: {accountTag: "${ACCOUNT_ID}"}) {
      workersInvocationsAdaptive(limit: 1, filter: {date_geq: "${day}", date_leq: "${day}"}) {
        sum { requests errors }
      }
      d1AnalyticsAdaptiveGroups(limit: 1, filter: {date_geq: "${day}", date_leq: "${day}"}) {
        sum { readQueries writeQueries rowsRead rowsWritten }
      }
      kvOperationsAdaptiveGroups(limit: 1, filter: {date_geq: "${day}", date_leq: "${day}"}) {
        sum { requests objectBytes }
      }
    }
  }
}`

const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify({ query }),
})
const payload = await response.json().catch(() => ({}))
if (!response.ok || payload.errors?.length) {
  console.error('Cloudflare 查询失败：', JSON.stringify(payload.errors || payload).slice(0, 800))
  process.exit(1)
}

const account = payload.data?.viewer?.accounts?.[0] || {}
const workers = account.workersInvocationsAdaptive?.[0]?.sum || { requests: 0, errors: 0 }
const d1 = account.d1AnalyticsAdaptiveGroups?.[0]?.sum || { readQueries: 0, writeQueries: 0, rowsRead: 0, rowsWritten: 0 }
const kv = account.kvOperationsAdaptiveGroups?.[0]?.sum || { requests: 0, objectBytes: 0 }

const rows = [
  ['Workers 请求', workers.requests, LIMITS.workersRequests],
  ['D1 读取行', d1.rowsRead, LIMITS.d1RowsRead],
  ['D1 写入行', d1.rowsWritten, LIMITS.d1RowsWritten],
  ['KV 请求', kv.requests, LIMITS.kvRequests],
]

console.log(`A 中继用量 ${day}`)
let warn = false
for (const [label, value, limit] of rows) {
  const pct = limit ? (Number(value) / limit) * 100 : 0
  const flag = pct >= 80 ? '  ⚠ 超过 80%' : pct >= 50 ? '  · 超过 50%' : ''
  if (pct >= 80) warn = true
  console.log(`${label.padEnd(12)} ${String(value).padStart(10)} / ${String(limit).padStart(10)}  ${pct.toFixed(1)}%${flag}`)
}
console.log(`Workers 错误   ${workers.errors}`)
console.log(`D1 查询       read=${d1.readQueries} write=${d1.writeQueries}`)
console.log(`KV 数据量     ${kv.objectBytes} bytes`)

if (warn) process.exitCode = 1
