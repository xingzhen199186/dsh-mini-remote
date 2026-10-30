#!/usr/bin/env node
/**
 * 只读运维日报。
 *
 * 只调用 /admin/relay/v1/ops/snapshot，不写任何云端资源；--archive 只写本地报告文件。
 * token 从环境变量 OPS_READ_TOKEN 读；没有就退回本机文件。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import dns from 'node:dns'
import { homedir } from 'node:os'
import { join } from 'node:path'

dns.setDefaultResultOrder('ipv4first')

const BASE = process.env.OPS_BASE_URL || 'https://relay.dsh-mini-remote.com'
const ARCHIVE = process.argv.includes('--archive')
const ARCHIVE_DIR = process.env.OPS_ARCHIVE_DIR || 'D:/X/X/16-DSH/运维/固定地址运维/日报'
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

let response
try {
  response = await fetch(BASE + '/ops/v1/snapshot', {
    headers: { authorization: 'Bearer ' + TOKEN },
    signal: AbortSignal.timeout(20_000),
  })
} catch (error) {
  const text = '# 固定地址运维日报\n\n生成失败：读不到运维快照。\n\n' + String(error?.message ?? error)
  if (ARCHIVE) archiveText(text)
  console.error(text)
  process.exit(1)
}
const body = await response.json().catch(() => ({}))
if (!response.ok || body.ok !== true) {
  console.error('读取快照失败：HTTP ' + response.status + ' ' + (body.error || ''))
  process.exit(1)
}

const snap = body.snapshot
if (!snap) {
  const text = '# 固定地址运维日报\n\n还没有采集快照。先到运维台“可视化”页点“立即采集”。'
  if (ARCHIVE) archiveText(text)
  console.log(text)
  process.exit(0)
}

const a = snap.a || {}
const b = snap.b || {}
const usage = a.usage || {}
const ac = a.counts || {}
const bc = b.counts || {}
const pct = (value, limit) => limit ? (Number(value || 0) / limit * 100).toFixed(1) + '%' : '—'

function archiveText(text) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  mkdirSync(ARCHIVE_DIR, { recursive: true })
  const file = join(ARCHIVE_DIR, date + '.md')
  writeFileSync(file, text.endsWith('\n') ? text : text + '\n', 'utf8')
  console.error('已归档：' + file)
}

const lines = []
const out = (line = '') => lines.push(line)
out('# 固定地址运维日报')
out('')
out('采集时间：' + time(snap.collectedAt))
out('')
out('## 共享固定地址')
out('')
out('| 项目 | 数值 |')
out('|---|---|')
out('| 活跃实例 | ' + (ac.active ?? '—') + ' |')
out('| 已撤销 | ' + (ac.revoked ?? '—') + ' |')
out('| 未用邀请 | ' + (ac.unusedInvites ?? '—') + ' |')
out('| Workers 请求 | ' + (usage.workers?.requests ?? 0) + ' / 100000（' + pct(usage.workers?.requests, 100000) + '） |')
out('| KV 请求 | ' + (usage.kv?.requests ?? 0) + ' / 100000（' + pct(usage.kv?.requests, 100000) + '） |')
out('| D1 读取行 | ' + (usage.d1?.rowsRead ?? 0) + ' / 5000000 |')
out('| D1 写入行 | ' + (usage.d1?.rowsWritten ?? 0) + ' / 100000 |')
out('')
out('## 专属固定地址')
out('')
out('| 项目 | 数值 |')
out('|---|---|')
out('| 租约总数 | ' + (bc.total ?? '—') + ' |')
out('| 已连接 | ' + (bc.active ?? '—') + ' |')
out('| 已释放 | ' + (bc.released ?? '—') + ' |')
out('| 已退休 | ' + (bc.retired ?? '—') + ' |')
out('| 控制面 | ' + (b.ok ? '正常' : (b.error || '读不到')) + ' |')
out('')
out('## 异常')
out('')
const anomalies = snap.anomalies || []
if (!anomalies.length) out('没有异常。')
else for (const item of anomalies) out('- [' + item.level + '] ' + item.text)
out('')
out('> 只读日报，没有修改任何资源。')


const report = lines.join('\n')
if (ARCHIVE) archiveText(report)
console.log(report)
