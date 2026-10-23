import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    assert.throws(() => client.execute({ op: 'write', args: { path: 'a.txt', content: 'x' } }), /没有授予写文件权限/)
  } finally {
    f.cleanup()
  }
})

test('B 端写文件：只有 allowWrite=true 才落盘，越界一律拒绝', () => {
  const f = fixture()
  try {
    const writer = createAgentClient({
      url: 'http://example.test', token: 't', roots: [f.root], allowWrite: true,
      fetchImpl: async () => { throw new Error('不该联网') },
    })
    const out = writer.execute({ op: 'write', args: { path: 'a.txt', content: '新的内容' } })
    assert.equal(out.bytes, 12)
    assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), '新的内容')
    assert.throws(() => writer.execute({ op: 'write', args: { path: '../outside.txt', content: 'x' } }), /不在 B 端授权/)
  } finally {
    f.cleanup()
  }
})

test('B 端命令：没有 allowShell 就不许跑；开了以后只默认在授权目录里跑', async () => {
  const f = fixture()
  try {
    const denied = createAgentClient({
      url: 'http://example.test', token: 't', roots: [f.root], allowShell: false,
      fetchImpl: async () => { throw new Error('不该联网') },
    })
    await assert.rejects(denied.execute({ op: 'shell', args: { command: 'echo x' } }), /没有授予执行命令权限/)

    const allowed = createAgentClient({
      url: 'http://example.test', token: 't', roots: [f.root], allowShell: true,
      fetchImpl: async () => { throw new Error('不该联网') },
    })
    const out = await allowed.execute({ op: 'shell', args: { command: 'echo dsh-shell-ok' } })
    assert.equal(out.code, 0)
    assert.match(out.stdout, /dsh-shell-ok/)
    assert.equal(out.cwd, f.root)
    await assert.rejects(allowed.execute({ op: 'shell', args: { command: 'echo x', cwd: '../' } }), /不在 B 端授权/)
  } finally {
    f.cleanup()
  }
})

test('配对请求只把授权摘要交给 A，不交 token；A 返回的 token 才是长期凭据', async () => {
  const f = fixture()
  try {
    let seen = null
    const out = await pairAgent({
      url: 'http://example.test/', code: '123456', name: 'B', platform: 'win32', roots: [f.root], machineId: 'm-1',
      fetchImpl: async (url, init) => {
        seen = { url, body: JSON.parse(init.body) }
        return new Response(JSON.stringify({ ok: true, agentId: 'a1', token: 'long-token' }), { status: 200 })
      },
    })
    assert.equal(out.agentId, 'a1')
    assert.equal(out.token, 'long-token')
    assert.equal(seen.url, 'http://example.test/mini-remote/agent/pair')
    assert.deepEqual(seen.body.roots, [f.root])
    assert.equal(seen.body.machineId, 'm-1')
    assert.equal('token' in seen.body, false, '配对请求里不该有 token')
  } finally {
    f.cleanup()
  }
})

test('没有授权文件夹时拒绝启动：不允许“默认整个盘”', () => {
  assert.throws(() => normalizeRoots([]), /还没有授权/)
  assert.throws(() => normalizeRoots(['C:\\不存在的路径\\dsh-agent-test']), /不存在/)
})

test('B 端搜索和文件夹管理：glob/grep/mkdir/copy/move/delete 都走授权根和 manage 开关', () => {
  const f = fixture()
  try {
    const c = createAgentClient({
      url: 'http://example.test', token: 't', roots: [f.root], allowManage: true,
      fetchImpl: async () => { throw new Error('不该联网') },
    })
    const found = c.execute({ op: 'glob', args: { path: '.', pattern: '**/*.txt' } })
    assert.ok(found.matches.some((m) => m.path.endsWith('a.txt')))
    const grepped = c.execute({ op: 'grep', args: { path: '.', pattern: '第二' } })
    assert.ok(grepped.matches.some((m) => m.path.endsWith('a.txt') && m.line === 2))

    assert.equal(c.execute({ op: 'mkdir', args: { path: 'newdir/sub' } }).created, true)
    c.execute({ op: 'copy', args: { from: 'a.txt', to: 'newdir/a-copy.txt' } })
    assert.equal(readFileSync(join(f.root, 'newdir', 'a-copy.txt'), 'utf8'), '第一行\n第二行\n第三行')
    c.execute({ op: 'move', args: { from: 'newdir/a-copy.txt', to: 'newdir/b.txt', confirm: true } })
    assert.equal(existsSync(join(f.root, 'newdir', 'a-copy.txt')), false)
    assert.equal(readFileSync(join(f.root, 'newdir', 'b.txt'), 'utf8'), '第一行\n第二行\n第三行')
    c.execute({ op: 'delete', args: { path: 'newdir/b.txt', confirm: true } })
    assert.equal(existsSync(join(f.root, 'newdir', 'b.txt')), false)

    assert.throws(() => c.execute({ op: 'delete', args: { path: 'a.txt' } }), /confirm/)
    assert.throws(() => c.execute({ op: 'move', args: { from: 'a.txt', to: 'x.txt' } }), /confirm/)
    assert.throws(() => c.execute({ op: 'mkdir', args: { path: '../outside-dir' } }), /不在 B 端授权/)

    const ro = createAgentClient({
      url: 'http://example.test', token: 't', roots: [f.root],
      fetchImpl: async () => { throw new Error('不该联网') },
    })
    assert.throws(() => ro.execute({ op: 'mkdir', args: { path: 'no' } }), /管理文件夹权限/)
  } finally {
    f.cleanup()
  }
})

test('B 端持久终端：开、发命令、读、关；没有命令权限就拒绝', async () => {
  const f = fixture()
  try {
    const c = createAgentClient({
      url: 'http://example.test', token: 't', roots: [f.root], allowShell: true,
      fetchImpl: async () => { throw new Error('不该联网') },
    })
    const opened = c.execute({ op: 'terminal_open', args: {} })
    assert.ok(opened.id)
    const out = await c.execute({ op: 'terminal_send', args: { sessionId: opened.id, text: 'echo dsh-term-ok', waitMs: 3000 } })
    assert.match(out.output, /dsh-term-ok/)
    const read = c.execute({ op: 'terminal_read', args: { sessionId: opened.id } })
    assert.match(read.output, /dsh-term-ok/)
    const listed = c.execute({ op: 'terminal_list', args: {} })
    assert.ok(listed.terminals.some((t) => t.id === opened.id && !t.closed))
    await c.execute({ op: 'terminal_close', args: { sessionId: opened.id } })
    assert.equal(c.execute({ op: 'terminal_list', args: {} }).terminals.length, 0)

    const noShell = createAgentClient({
      url: 'http://example.test', token: 't', roots: [f.root],
      fetchImpl: async () => { throw new Error('不该联网') },
    })
    assert.throws(() => noShell.execute({ op: 'terminal_open', args: {} }), /执行命令权限/)
  } finally {
    f.cleanup()
  }
})
