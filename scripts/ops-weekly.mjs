#!/usr/bin/env node
/**
 * 只读每周运维清单。
 *
 * 只调用 /ops/v1/weekly，不写任何资源。
 * token 从 OPS_READ_TOKEN 或本机文件读。
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.OPS_BASE_URL || 'https://relay.dsh-mini-remote.com'
const TOKEN = process.env.OPS_READ_TOKEN
  || (existsSync(join(homedir(), '.dsh', 'dsh-mini-remote', 'ops-read-token.txt'))
    ? readFileSync(join(homedir(), '.dsh', 'dsh-mini-remote', 'ops-read-token.txt'), 'utf8').trim()
    : '')

if (!TOKEN) {
  console.error('缺少 OPS_READ_TOKEN，或本机没有 ops-read-token.txt')
  process.exit(1)
}

function time(ms) {
  if (!ms) return '—'
  try { return new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false }) } catch { return '—' }
}

const response = await fetch(BASE + '/ops/v1/weekly', {
  headers: { authorization: 'Bearer ' + TOKEN },
})
const body = await response.json().catch(() => ({}))
if (!response.ok || body.ok !== true) {
  console.error('读取每周清单失败：HTTP ' + response.status + ' ' + (body.error || ''))
  process.exit(1)
}

const a = body.a || {}
const b = body.b || {}
const usage = a.usage || {}
const ac = a.counts || {}
const bc = b.counts || {}
const pct = (value, limit) => limit ? (Number(value || 0) / limit * 100).toFixed(1) + '%' : '—'

console.log('# 固定地址每周运维清单')
console.log('')
console.log('生成时间：' + time(body.generatedAt))
console.log('')
console.log('## 容量')
console.log('')
console.log('| 项目 | 当前 | 观察线 |')
console.log('|---|---|---|')
console.log('| 共享活跃实例 | ' + (ac.active ?? '—') + ' | 40 |')
console.log('| 共享 Workers 请求 | ' + (usage.workers?.requests ?? 0) + '（' + pct(usage.workers?.requests, 100000) + '） | 60% |')
console.log('| 共享 KV 请求 | ' + (usage.kv?.requests ?? 0) + '（' + pct(usage.kv?.requests, 100000) + '） | 60% |')
console.log('| 专属租约总数 | ' + (bc.total ?? '—') + ' | 700 |')
console.log('')
console.log('## 待处理')
console.log('')
const aStale = a.staleActive || []
const releasedOld = b.releasedOld || []
const activeStale = b.activeStale || []
const invites = a.unusedInvites || []
let count = 0
if (aStale.length) {
  console.log('### 共享固定地址：长期不活跃')
  for (const x of aStale) { count += 1; console.log('- [ ] `' + x.id + '`，最近登记 ' + time(x.lastSeenAt) + '，创建 ' + time(x.createdAt) + '，建议确认后撤销') }
  console.log('')
}
if (releasedOld.length) {
  console.log('### 专属固定地址：释放超过 30 天')
  for (const x of releasedOld) { count += 1; console.log('- [ ] `' + x.hostname + '`，释放于 ' + time(x.releasedAt) + '，建议确认后退休') }
  console.log('')
}
if (activeStale.length) {
  console.log('### 专属固定地址：超过 7 天没有登记')
  for (const x of activeStale) { count += 1; console.log('- [ ] `' + x.hostname + '`，最近登记 ' + time(x.lastSeenAt) + '，建议联系用户') }
  console.log('')
}
if (invites.length) {
  console.log('### 共享固定地址：超过 7 天未使用的邀请')
  for (const x of invites) { count += 1; console.log('- [ ] 备注「' + (x.note || '无') + '」，创建 ' + time(x.createdAt) + '，到期 ' + time(x.expiresAt) + '，可考虑清理') }
  console.log('')
}
if (!count) console.log('没有需要人工处理的条目。')
console.log('')
console.log('> 只读清单，没有修改任何资源。勾选后由人执行。')
