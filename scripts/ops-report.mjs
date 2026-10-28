#!/usr/bin/env node
/**
 * 只读运维日报。
 *
 * 只调用 /admin/relay/v1/ops/snapshot，不写任何资源。
 * token 从环境变量 OPS_READ_TOKEN 读；没有就退回本机文件。
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

const response = await fetch(BASE + '/ops/v1/snapshot', {
  headers: { authorization: 'Bearer ' + TOKEN },
})
const body = await response.json().catch(() => ({}))
if (!response.ok || body.ok !== true) {
  console.error('读取快照失败：HTTP ' + response.status + ' ' + (body.error || ''))
  process.exit(1)
}

const snap = body.snapshot
if (!snap) {
  console.log('# 固定地址运维日报\n\n还没有采集快照。先到运维台“可视化”页点“立即采集”。')
  process.exit(0)
}

const a = snap.a || {}
const b = snap.b || {}
const usage = a.usage || {}
const ac = a.counts || {}
const bc = b.counts || {}
const pct = (value, limit) => limit ? (Number(value || 0) / limit * 100).toFixed(1) + '%' : '—'

console.log('# 固定地址运维日报')
console.log('')
console.log('采集时间：' + time(snap.collectedAt))
console.log('')
console.log('## 共享固定地址')
console.log('')
console.log('| 项目 | 数值 |')
console.log('|---|---|')
console.log('| 活跃实例 | ' + (ac.active ?? '—') + ' |')
console.log('| 已撤销 | ' + (ac.revoked ?? '—') + ' |')
console.log('| 未用邀请 | ' + (ac.unusedInvites ?? '—') + ' |')
console.log('| Workers 请求 | ' + (usage.workers?.requests ?? 0) + ' / 100000（' + pct(usage.workers?.requests, 100000) + '） |')
console.log('| KV 请求 | ' + (usage.kv?.requests ?? 0) + ' / 100000（' + pct(usage.kv?.requests, 100000) + '） |')
console.log('| D1 读取行 | ' + (usage.d1?.rowsRead ?? 0) + ' / 5000000 |')
console.log('| D1 写入行 | ' + (usage.d1?.rowsWritten ?? 0) + ' / 100000 |')
console.log('')
console.log('## 专属固定地址')
console.log('')
console.log('| 项目 | 数值 |')
console.log('|---|---|')
console.log('| 租约总数 | ' + (bc.total ?? '—') + ' |')
console.log('| 已连接 | ' + (bc.active ?? '—') + ' |')
console.log('| 已释放 | ' + (bc.released ?? '—') + ' |')
console.log('| 已退休 | ' + (bc.retired ?? '—') + ' |')
console.log('| 控制面 | ' + (b.ok ? '正常' : (b.error || '读不到')) + ' |')
console.log('')
console.log('## 异常')
console.log('')
const anomalies = snap.anomalies || []
if (!anomalies.length) console.log('没有异常。')
else for (const item of anomalies) console.log('- [' + item.level + '] ' + item.text)
console.log('')
console.log('> 只读日报，没有修改任何资源。')
