import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentClient, normalizeRoots, resolveInside, pairAgent } from '../lib/agent-client.js'

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-agent-client-'))
  const root = join(base, 'root')
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(join(root, 'a.txt'), '第一行\n第二行\n第三行')
  writeFileSync(join(root, 'sub', 'b.txt'), '乙')
  writeFileSync(join(base, 'outside.txt'), '外面')
  return { base, root, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('B 端路径只许落在授权文件夹里：相对、绝对、越界', () => {
  const f = fixture()
  try {
    const roots = normalizeRoots([f.root])
    assert.equal(resolveInside(roots, 'a.txt'), join(f.root, 'a.txt'))
    assert.equal(resolveInside(roots, join(f.root, 'sub', 'b.txt')), join(f.root, 'sub', 'b.txt'))
    assert.throws(() => resolveInside(roots, '../outside.txt'), /不在 B 端授权/)
    assert.throws(() => resolveInside(roots, f.base + '/outside.txt'), /不在 B 端授权/)
  } finally {
    f.cleanup()
  }
})

test('B 端只读：list 和 read 都走授权目录，read 支持行窗口', () => {
  const f = fixture()
  try {
    const client = createAgentClient({
      url: 'http://example.test', token: 't', roots: [f.root], fetchImpl: async () => { throw new Error('不该联网') },
    })
    const listed = client.execute({ op: 'list', args: { path: '.' } })
    assert.ok(listed.entries.some((e) => e.name === 'a.txt'))
    assert.ok(listed.entries.some((e) => e.name === 'sub' && e.type === 'dir'))

    const read = client.execute({ op: 'read', args: { path: 'a.txt', offset: 2, limit: 1 } })
    assert.equal(read.content, '第二行')
    assert.equal(read.totalLines, 3)
    assert.equal(read.truncated, true)

    assert.throws(() => client.execute({ op: 'read', args: { path: '../outside.txt' } }), /不在 B 端授权/)
    assert.throws(() => client.execute({ op: 'write', args: { path: 'a.txt', content: 'x' } }), /不支持/)
  } finally {
    f.cleanup()
  }
})

test('配对请求只把授权摘要交给 A，不交 token；A 返回的 token 才是长期凭据', async () => {
  const f = fixture()
  try {
    let seen = null
    const out = await pairAgent({
      url: 'http://example.test/', code: '123456', name: 'B', platform: 'win32', roots: [f.root],
      fetchImpl: async (url, init) => {
        seen = { url, body: JSON.parse(init.body) }
        return new Response(JSON.stringify({ ok: true, agentId: 'a1', token: 'long-token' }), { status: 200 })
      },
    })
    assert.equal(out.agentId, 'a1')
    assert.equal(out.token, 'long-token')
    assert.equal(seen.url, 'http://example.test/mini-remote/agent/pair')
    assert.deepEqual(seen.body.roots, [f.root])
    assert.equal('token' in seen.body, false, '配对请求里不该有 token')
  } finally {
    f.cleanup()
  }
})

test('没有授权文件夹时拒绝启动：不允许“默认整个盘”', () => {
  assert.throws(() => normalizeRoots([]), /还没有授权/)
  assert.throws(() => normalizeRoots(['C:\\不存在的路径\\dsh-agent-test']), /不存在/)
})
