import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentHub } from '../lib/agent-hub.js'
import { createAgentClient, pairAgent } from '../lib/agent-client.js'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function waitFor(fn, timeoutMs = 4000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (fn()) return true
    await sleep(25)
  }
  return false
}

test('A/B 真实 HTTP 闭环：配对 → 只读 → 写 → 命令', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-agent-e2e-'))
  const root = join(base, 'work')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'a.txt'), '甲')
  const hub = createAgentHub({ enabled: () => true })
  const srv = createServer((req, res) => {
    hub.handle(req, res, new URL(req.url || '/', 'http://localhost').pathname)
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}`
  const code = hub.issuePairCode()
  assert.equal(code.ok, true)

  let client = null
  let ac = null
  try {
    const paired = await pairAgent({ url, code: code.code, name: '测试 B', platform: process.platform, roots: [root] })
    client = createAgentClient({
      url, token: paired.token, roots: [root], allowWrite: true, allowShell: true,
    })
    ac = new AbortController()
    client.run({ signal: ac.signal }).catch(() => { /* 测试结束会 abort */ })

    assert.equal(await waitFor(() => hub.list()[0]?.online), true, 'B 轮询后应在线')

    const list = await hub.call('list', { path: '.' })
    assert.ok(list.entries.some((e) => e.name === 'a.txt'))

    const read = await hub.call('read', { path: 'a.txt' })
    assert.equal(read.content, '甲')

    await hub.call('write', { path: 'a.txt', content: '乙' })
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), '乙')

    const shell = await hub.call('shell', { command: 'echo dsh-e2e-ok' })
    assert.equal(shell.code, 0)
    assert.match(shell.stdout, /dsh-e2e-ok/)
  } finally {
    if (ac) ac.abort()
    if (client) client.stop()
    await new Promise((r) => srv.close(r))
    rmSync(base, { recursive: true, force: true })
  }
})
