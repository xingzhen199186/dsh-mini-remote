import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendAction, logFile, logDir } from '../lib/phone-log.js'

/**
 * 动作日志（2026-11-14）。
 *
 * 这条日志的用途只有一个：**出事之后能说清它干了什么**。
 * 所以测的重点不是"能写进去"，而是：一条动作一行、被拒绝的也要落、
 * 日期换了要换文件、目录不存在时自己建。
 */

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'phone-log-test-'))
}

test('一条动作一行，落在 scratch/phone-log 下', () => {
  const root = tempRoot()
  try {
    const at = new Date(2026, 10, 14, 9, 30)
    const file = appendAction({ tool: 'phone_tap_at', x: 10, y: 20, ok: true }, { root, at })
    assert.equal(file, join(root, 'scratch', 'phone-log', '2026-11-14.jsonl'))
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const one = JSON.parse(lines[0])
    assert.equal(one.tool, 'phone_tap_at')
    assert.equal(one.x, 10)
    assert.equal(one.ok, true)
    assert.match(one.at, /^2026-11-14T/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('被拒绝的动作也要记：它是复盘时最想知道的那一条', () => {
  const root = tempRoot()
  try {
    const file = appendAction(
      { tool: 'phone_tap_at', x: 5, y: 6, ok: false, refused: 'privacy', why: '屏幕上出现了「付款」' },
      { root, at: new Date(2026, 10, 14, 10, 0) },
    )
    const one = JSON.parse(readFileSync(file, 'utf8').trim())
    assert.equal(one.ok, false)
    assert.equal(one.refused, 'privacy')
    assert.match(one.why, /付款/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('跨天要换文件，不能越写越大', () => {
  const root = tempRoot()
  try {
    appendAction({ tool: 'a' }, { root, at: new Date(2026, 10, 14, 23, 59) })
    appendAction({ tool: 'b' }, { root, at: new Date(2026, 10, 15, 0, 1) })
    const d1 = readFileSync(join(logDir(root), '2026-11-14.jsonl'), 'utf8').trim().split('\n')
    const d2 = readFileSync(join(logDir(root), '2026-11-15.jsonl'), 'utf8').trim().split('\n')
    assert.equal(d1.length, 1)
    assert.equal(d2.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('日志文件名可预测，方便事后直接去看', () => {
  assert.equal(logFile(new Date(2026, 0, 5), 'X:'), join('X:', 'scratch', 'phone-log', '2026-01-05.jsonl'))
})

test('坐标动作真的会写日志、也会给回执：接线不许漏', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 成功时：补一张回执图 + 记一行。
  assert.match(src, /appendAction\(\{ \.\.\.base, ok: true, after:/)
  assert.match(src, /capture\(armed, taskId, 'phone-receipt'\)/)
  // 失败与拒绝：同样记一行，否则事后只看得见"点成了"的那些。
  assert.match(src, /appendAction\(\{ \.\.\.base, ok: false, failed:/)
  assert.match(src, /const refuse = \(why, extra = \{\}\) =>/)
  // 回执要交回给模型看，光存盘没用。
  assert.match(src, /receipt: after \? after\.file : null/)
})
