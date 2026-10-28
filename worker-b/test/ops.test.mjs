import test from 'node:test'
import assert from 'node:assert/strict'

import { createCloudflareRelayApi } from '../src/cloudflare.js'
import { runOps, scheduled } from '../src/index.js'
import { activate, createEnv, request } from './helpers.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const OLD = 31 * DAY_MS
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

function makeLeaseId(index) {
  let value = index
  let tail = ''
  for (let i = 0; i < 6; i += 1) {
    tail = ID_ALPHABET[value % 32] + tail
    value = Math.floor(value / 32)
  }
  return 'a'.repeat(20) + tail
}

function seedLease(db, {
  index,
  state = 'released',
  releasedAt = null,
  tunnelId = null,
  dnsRecordId = null,
  dnsTarget = null,
} = {}) {
  const id = makeLeaseId(index)
  const hostname = `${id}.dsh-everywhere.com`
  db.prepare(
    'INSERT INTO b_leases '
    + '(lease_id, hostname, state, origin_port, tunnel_name, tunnel_id, dns_record_id, dns_target, created_at, released_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    hostname,
    state,
    3090,
    `dsh-b-relay-${id}`,
    tunnelId,
    dnsRecordId,
    dnsTarget,
    Date.now() - 40 * DAY_MS,
    releasedAt,
  )
  return { id, hostname }
}

async function releaseOld(context, id) {
  await request(context.env, 'POST', '/api/b/v1/release', {
    id,
    clientSecret: 'a'.repeat(43),
  })
  const releasedAt = Date.now() - OLD
  context.db.prepare('UPDATE b_leases SET released_at = ? WHERE lease_id = ?').run(releasedAt, id)
  return releasedAt
}

function readRun(db, runId) {
  return db.prepare('SELECT * FROM b_ops_runs WHERE run_id = ?').get(runId)
}

function readFindings(db, runId) {
  return db.prepare('SELECT * FROM b_reconcile_findings WHERE run_id = ? ORDER BY kind, finding_id').all(runId)
}

test('cloudflare listTunnels 是只读的一页请求', async () => {
  const previous = globalThis.fetch
  let seen = null
  globalThis.fetch = async (url, init) => {
    seen = { url, init }
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: [{ id: 't1', name: 'one' }] }),
    }
  }
  try {
    const api = createCloudflareRelayApi({ token: 'test-token', accountId: 'acc', zoneId: 'zone' })
    const tunnels = await api.listTunnels()
    assert.equal(seen.init.method, 'GET')
    assert.equal(seen.url, 'https://api.cloudflare.com/client/v4/accounts/acc/cfd_tunnel?is_deleted=false&per_page=100')
    assert.deepEqual(tunnels, [{ id: 't1', name: 'one' }])
  } finally {
    globalThis.fetch = previous
  }
})

test('自动退休：超过 30 天的 released 被删除资源并转 retired，run 写汇总', async () => {
  const context = createEnv()
  const { id } = await activate(context.env)
  const releasedAt = await releaseOld(context, id)
  const result = await runOps(context.env, { runId: 'run-retire-ok', now: Date.now() })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.summary.retired, 1)
  assert.equal(result.summary.retireFailures.length, 0)
  assert.equal(context.cf.tunnels.size, 0)
  assert.equal(context.cf.dnsRecords.size, 0)
  const lease = context.db.prepare('SELECT state, released_at FROM b_leases WHERE lease_id = ?').get(id)
  assert.equal(lease.state, 'retired')
  assert.equal(lease.released_at, releasedAt)

  const run = readRun(context.db, 'run-retire-ok')
  assert.equal(run.status, 'succeeded')
  assert.ok(run.finished_at)
  const summary = JSON.parse(run.summary)
  assert.equal(summary.retired, 1)
  assert.equal(summary.findings, 0)
})

test('自动退休单条失败不停整批，失败项下一轮可重试成功', async () => {
  const context = createEnv()
  const failing = await activate(context.env)
  const succeeding = await activate(context.env)
  await releaseOld(context, failing.id)
  await releaseOld(context, succeeding.id)
  // 失败那条排在最前；同一批里第二条仍应完成退休。
  context.db.prepare('UPDATE b_leases SET released_at = ? WHERE lease_id = ?')
    .run(Date.now() - OLD - 60_000, failing.id)
  context.cf.failNext('deleteTunnel')

  const first = await runOps(context.env, { runId: 'run-retire-fail', now: Date.now() })
  assert.equal(first.status, 'partial')
  assert.equal(first.summary.retired, 1, '一条失败不该拦住同批其它 lease')
  assert.equal(first.summary.retireFailures.length, 1)
  assert.equal(first.summary.retireFailures[0].leaseId, failing.id)
  assert.notEqual(context.db.prepare('SELECT state FROM b_leases WHERE lease_id = ?').get(failing.id).state, 'retired')
  assert.equal(context.db.prepare('SELECT state FROM b_leases WHERE lease_id = ?').get(succeeding.id).state, 'retired')

  const second = await runOps(context.env, { runId: 'run-retire-retry', now: Date.now() })
  assert.equal(second.status, 'succeeded')
  assert.equal(second.summary.retired, 1)
  assert.equal(context.db.prepare('SELECT state FROM b_leases WHERE lease_id = ?').get(failing.id).state, 'retired')
  assert.equal(context.cf.tunnels.size, 0)
})

test('自动退休每次最多 10 条，剩余 released 留到下一轮', async () => {
  const context = createEnv()
  for (let index = 0; index < 11; index += 1) {
    seedLease(context.db, { index, releasedAt: Date.now() - OLD })
  }
  const first = await runOps(context.env, { runId: 'run-limit-1', now: Date.now() })
  assert.equal(first.summary.retired, 10)
  assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM b_leases WHERE state = 'retired'").get().n, 10)
  assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM b_leases WHERE state = 'released'").get().n, 1)

  const second = await runOps(context.env, { runId: 'run-limit-2', now: Date.now() })
  assert.equal(second.summary.retired, 1)
  assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM b_leases WHERE state = 'retired'").get().n, 11)
})

test('对账：Tunnel 缺失、CNAME 不符、CNAME 缺失、未知 DNS 都只写 finding', async () => {
  const context = createEnv()
  const missingTunnel = await activate(context.env)
  const driftedCname = await activate(context.env)
  const missingCname = await activate(context.env)
  const unknownDns = await activate(context.env)

  const missingRow = context.db.prepare('SELECT * FROM b_leases WHERE lease_id = ?').get(missingTunnel.id)
  context.cf.tunnels.delete(missingRow.tunnel_id)

  const driftRow = context.db.prepare('SELECT * FROM b_leases WHERE lease_id = ?').get(driftedCname.id)
  const driftDns = [...context.cf.dnsRecords.values()].find((record) => record.name === driftRow.hostname)
  context.cf.dnsRecords.set(driftDns.id, { ...driftDns, content: 'wrong-tunnel.cfargotunnel.com' })

  const missingRowDns = context.db.prepare('SELECT * FROM b_leases WHERE lease_id = ?').get(missingCname.id)
  const missingDns = [...context.cf.dnsRecords.values()].find((record) => record.name === missingRowDns.hostname)
  context.cf.dnsRecords.delete(missingDns.id)

  const conflictRow = context.db.prepare('SELECT * FROM b_leases WHERE lease_id = ?').get(unknownDns.id)
  const conflictDns = [...context.cf.dnsRecords.values()].find((record) => record.name === conflictRow.hostname)
  context.cf.dnsRecords.set(conflictDns.id, {
    id: conflictDns.id, type: 'A', name: conflictRow.hostname, content: '192.0.2.55',
  })

  context.cf.calls = []
  const result = await runOps(context.env, { runId: 'run-reconcile', now: Date.now() })
  const findings = readFindings(context.db, 'run-reconcile')
  const kinds = new Set(findings.map((finding) => finding.kind))
  assert.equal(result.status, 'succeeded')
  assert.equal(result.summary.reconcileChecked, 4)
  assert.equal(result.summary.findings, 4)
  for (const kind of ['tunnel_missing', 'cname_mismatch', 'cname_missing', 'dns_conflict']) {
    assert.ok(kinds.has(kind), `缺少 finding: ${kind}`)
  }
  assert.equal(context.cf.dnsRecords.get(conflictDns.id).type, 'A', '未知 DNS 不许被覆盖')
  assert.equal(context.cf.calls.includes('deleteDnsRecord'), false)
  assert.equal(context.cf.calls.includes('deleteTunnel'), false)
})

test('对账最多检查 50 条 active/released', async () => {
  const context = createEnv()
  for (let index = 0; index < 51; index += 1) {
    seedLease(context.db, { index, state: 'active' })
  }
  const result = await runOps(context.env, { runId: 'run-reconcile-limit', now: Date.now() })
  assert.equal(result.summary.reconcileChecked, 50)
  assert.equal(readFindings(context.db, 'run-reconcile-limit').length, 100,
    '前 50 条每条的 Tunnel 与 CNAME 缺失各一条 finding')
})

test('孤儿 Tunnel 只记 finding，绝不删除', async () => {
  const context = createEnv()
  const orphanId = makeLeaseId(900)
  const orphanTunnelId = 'orphan-tunnel-1'
  context.cf.tunnels.set(orphanTunnelId, {
    id: orphanTunnelId,
    name: `dsh-b-relay-${orphanId}`,
  })
  context.cf.calls = []

  const result = await runOps(context.env, { runId: 'run-orphan', now: Date.now() })
  const findings = readFindings(context.db, 'run-orphan')
  assert.equal(result.summary.orphanTunnels, 1)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'orphan_tunnel')
  assert.equal(findings[0].resource_id, orphanTunnelId)
  assert.ok(context.cf.tunnels.has(orphanTunnelId), '孤儿 Tunnel 必须保留')
  assert.equal(context.cf.calls.includes('deleteTunnel'), false)
  assert.equal(context.cf.calls.includes('deleteDnsRecord'), false)
})

test('同一个 run 重复执行：run 只有一条，findings 不重复；管理端能读到汇总', async () => {
  const context = createEnv()
  seedLease(context.db, { index: 700, state: 'active' })
  const first = await runOps(context.env, { runId: 'run-idempotent', now: Date.now() })
  const second = await runOps(context.env, { runId: 'run-idempotent', now: Date.now() })
  assert.equal(first.summary.findings, 2)
  assert.equal(second.summary.findings, 2)
  assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM b_ops_runs').get().n, 1)
  assert.equal(readFindings(context.db, 'run-idempotent').length, 2)

  const denied = await request(context.env, 'GET', '/admin/b/v1/ops')
  assert.equal(denied.status, 401)
  const shown = await request(context.env, 'GET', '/admin/b/v1/ops', undefined, { admin: true })
  assert.equal(shown.status, 200)
  assert.equal(shown.body.run.runId, 'run-idempotent')
  assert.equal(shown.body.run.summary.findings, 2)
  assert.deepEqual(shown.body.findings.map((finding) => finding.kind).sort(), ['cname_missing', 'tunnel_missing'])
  assert.equal(JSON.stringify(shown.body).includes('tunnelToken'), false)
  assert.equal(JSON.stringify(shown.body).includes('clientSecret'), false)
})

test('每日 cron 连跑两次：第二次不会重复删除已退休资源', async () => {
  const context = createEnv()
  const { id } = await activate(context.env)
  await releaseOld(context, id)
  context.cf.calls = []

  const first = await scheduled({ scheduledTime: Date.now() }, context.env, {})
  const second = await scheduled({ scheduledTime: Date.now() }, context.env, {})
  assert.equal(first.status, 'succeeded')
  assert.equal(second.status, 'succeeded')
  const runs = context.db.prepare('SELECT kind, status FROM b_ops_runs ORDER BY started_at').all()
  assert.equal(runs.length, 2)
  assert.ok(runs.every((run) => run.kind === 'cron'))
  assert.equal(context.cf.calls.filter((call) => call === 'deleteDnsRecord').length, 1)
  assert.equal(context.cf.calls.filter((call) => call === 'deleteTunnel').length, 1)
  assert.equal(context.db.prepare('SELECT state FROM b_leases WHERE lease_id = ?').get(id).state, 'retired')
})
