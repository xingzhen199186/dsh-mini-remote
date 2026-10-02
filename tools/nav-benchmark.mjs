/**
 * 导航只读基准：测量工作区列表、强制刷新和最大工作区展开。
 *
 *   node tools/nav-benchmark.mjs
 *   node tools/nav-benchmark.mjs --runs 10
 *
 * 这个脚本只发 GET 请求，不会切换会话、创建会话或修改 DSH 状态。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const home = process.env.USERPROFILE || homedir()
const dataDir = join(process.env.DSH_HOME || join(home, '.dsh'), 'dsh-mini-remote')
const token = readFileSync(join(dataDir, 'token'), 'utf8').trim()
const port = Number(arg('--port', 3090))
const runs = Math.max(3, Number(arg('--runs', 7)) || 7)
const base = `http://127.0.0.1:${port}`

async function get(path) {
  const started = performance.now()
  const response = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`)
  const body = await response.json().catch(() => ({}))
  return { ms: performance.now() - started, status: response.status, body }
}

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[index]
}

function summary(label, values) {
  return {
    label,
    runs: values.length,
    minMs: Math.round(Math.min(...values)),
    p50Ms: Math.round(percentile(values, 0.5)),
    p95Ms: Math.round(percentile(values, 0.95)),
    maxMs: Math.round(Math.max(...values)),
  }
}

const first = await get('/mini/api/workspaces')
if (first.status !== 200) throw new Error(`工作区接口失败：HTTP ${first.status}`)
const workspaces = first.body?.workspaces ?? []
const largest = workspaces.filter((item) => !item.empty).sort((a, b) => (b.count || 0) - (a.count || 0))[0]
if (!largest) throw new Error('没有可展开的非空工作区')

const normal = []
for (let i = 0; i < runs; i += 1) normal.push((await get('/mini/api/workspaces')).ms)

const refresh = []
for (let i = 0; i < runs; i += 1) refresh.push((await get('/mini/api/workspaces?refresh=1')).ms)

const sessions = []
const pending = []
for (let i = 0; i < runs; i += 1) {
  const result = await get(`/mini/api/workspaces/${encodeURIComponent(largest.id)}/sessions`)
  sessions.push(result.ms)
  pending.push(Number(result.body?.pending ?? 0))
}

console.log(JSON.stringify({
  workspaceCount: workspaces.length,
  largestWorkspace: { title: largest.title, count: largest.count },
  metrics: [
    summary('workspaces', normal),
    summary('workspaces?refresh=1', refresh),
    summary('largest-workspace-sessions', sessions),
  ],
  pending,
}, null, 2))
