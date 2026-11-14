import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { listDirectory, MAX_FILES } from '../lib/browse.js'

/**
 * 工作区文件树（2026-11-14 用户拍板放开）。
 *
 * 放开不等于不设限。这组测试盯三条边界：
 * **默认仍只列文件夹**、**要文件时才给文件且带大小**、**每层有上限**。
 */

// 项目根：它下面既有文件夹也有文件，正好能验"两种都列得对"。
const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('不传 files 时只列文件夹，一个文件名都不给', async () => {
  const got = await listDirectory(ROOT)
  assert.equal(got.ok, true)
  assert.deepEqual(got.files, [], '默认口径必须还是"只列文件夹"')
  assert.ok(got.dirs.length > 0)
})

test('files=1 时列出文件，并带上大小', async () => {
  const got = await listDirectory(ROOT, { files: true })
  assert.equal(got.ok, true)
  const names = got.files.map((f) => f.name)
  assert.ok(names.includes('package.json'), '项目根里应该有 package.json')
  const one = got.files.find((f) => f.name === 'package.json')
  assert.ok(one.size > 0, '每个文件都要带大小，界面上要标出来')
  assert.ok(one.path.startsWith(ROOT.replace(/[\\/]$/, '')), '给出的路径要能直接交给预览')
})

test('每层有上限：多到离谱时只列前面那些，并说清楚被截了', async () => {
  assert.equal(MAX_FILES, 300)
  const got = await listDirectory(ROOT, { files: true })
  assert.ok(got.files.length <= MAX_FILES)
  assert.equal(typeof got.truncated, 'boolean')
})

test('路径不合法时如实拒绝，不猜一个目录', async () => {
  const bad = await listDirectory('C:\\不存在\\的\\路径\\呵呵', { files: true })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'unreadable')
})

test('页面与路由都接上了：入口、面板、只读预览', () => {
  const nav = readFileSync(new URL('../lib/page-nav.js', import.meta.url), 'utf8')
  assert.match(nav, /data-ws-files="/)
  assert.match(nav, /openFileTree\(/)
  const files = readFileSync(new URL('../lib/page-files.js', import.meta.url), 'utf8')
  assert.match(files, /\/mini\/api\/browse\?files=1&path=/)
  assert.match(files, /data-tree-file/)
  assert.match(files, /openFileView\(file\.getAttribute\('data-tree-file'\)\)/)
  const server = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')
  assert.match(server, /files: url\.searchParams\.get\('files'\) === '1'/)
})
