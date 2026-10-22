import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentHub } from '../lib/agent-hub.js'

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agent-hub-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('B 端配对：码一次性、token 只认对的、名册能落盘再读回', async () => {
  const t = tempDir()
  try {
    let clock = 1_700_000_000_000
    const hub = createAgentHub({ file: join(t.dir, 'agents.json'), enabled: () => true, now: () => clock })
    const issued = hub.issuePairCode()
    assert.equal(issued.ok, true)
    assert.match(issued.code, /^\d{6}$/)

    assert.equal(hub.pair({ code: '000000', name: 'B' }).ok, false, '错的码不许配')
    const paired = hub.pair({ code: issued.code, name: 'B 电脑', platform: 'win32', roots: ['C:\\work'] })
    assert.equal(paired.ok, true)
    assert.equal(hub.pair({ code: issued.code, name: '再来一次' }).ok, false, '码用过就作废')

    assert.equal(hub.authenticate('nope'), null)
    const agent = hub.authenticate(paired.token)
    assert.ok(agent)
    assert.equal(agent.name, 'B 电脑')

    const again = createAgentHub({ file: join(t.dir, 'agents.json'), enabled: () => true, now: () => clock })
    const restored = again.authenticate(paired.token)
    assert.ok(restored, 'A 重启后长期 token 仍要认')
    assert.equal(restored.roots[0], 'C:\\work')
    assert.equal(again.list()[0].online, false, '刚重启还没轮询，不算在线')
  } finally {
    t.cleanup()
  }
})

test('B 端配对码十分钟过期；总开关关着时配对和生成码都不接', () => {
  let clock = 1_700_000_000_000
  let enabled = true
  const hub = createAgentHub({ enabled: () => enabled, now: () => clock })
  const issued = hub.issuePairCode()
  clock += 10 * 60 * 1000 + 1
  assert.equal(hub.pair({ code: issued.code }).ok, false, '过期码不许配')

  enabled = false
  assert.equal(hub.issuePairCode().ok, false)
  assert.equal(hub.pair({ code: '123456' }).ok, false)
})

test('任务队列：长轮询拿到任务、结果带回同一个 taskId、超时会拒', async () => {
  const hub = createAgentHub({ enabled: () => true })
  const issued = hub.issuePairCode()
  const paired = hub.pair({ code: issued.code, name: 'B' })
  const agent = hub.authenticate(paired.token)
  assert.ok(agent)

  // 先轮询一次：online 由轮询点亮
  assert.equal(await hub.poll(agent, 0), null)
  assert.equal(hub.list()[0].online, true)

  const pending = hub.call('read', { path: 'a.txt' }, { agentId: agent.id, timeoutMs: 1000 })
  const task = await hub.poll(agent, 10)
  assert.ok(task)
  assert.equal(task.op, 'read')
  assert.equal(task.args.path, 'a.txt')
  assert.equal(hub.result(agent, task.id, { ok: true, output: { content: '甲' } }), true)
  assert.deepEqual(await pending, { content: '甲' })

  // 超时
  const slow = hub.call('read', { path: 'b.txt' }, { agentId: agent.id, timeoutMs: 30 })
  await assert.rejects(slow, /超时/)

  // 撤销之后，在途任务被拒
  const inFlight = hub.call('read', { path: 'c.txt' }, { agentId: agent.id, timeoutMs: 1000 })
  assert.equal(hub.revoke(agent.id).ok, true)
  await assert.rejects(inFlight, /撤销/)
  assert.equal(hub.list().length, 0)
})

test('多台 B 在线时不指定 agent 会拒绝，指定了才走那一台', async () => {
  const hub = createAgentHub({ enabled: () => true })
  const pairOne = () => {
    const issued = hub.issuePairCode()
    const p = hub.pair({ code: issued.code, name: 'B' })
    const a = hub.authenticate(p.token)
    return a
  }
  const a = pairOne()
  const b = pairOne()
  await hub.poll(a, 0)
  await hub.poll(b, 0)
  assert.equal(hub.list().length, 2)
  assert.throws(() => hub.call('read', { path: 'x' }, { timeoutMs: 10 }), /指定/)
  const pending = hub.call('read', { path: 'x' }, { agentId: a.id, timeoutMs: 1000 })
  const task = await hub.poll(a, 10)
  hub.result(a, task.id, { ok: true, output: 'a' })
  assert.equal(await pending, 'a')
  assert.equal(await hub.poll(b, 0), null, '另一台不该拿到这台的任务')
})
