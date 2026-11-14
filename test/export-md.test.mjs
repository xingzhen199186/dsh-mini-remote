import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { exportMarkdown, exportFileName } from '../lib/export-md.js'

/**
 * 导出对话（2026-11-14）。
 *
 * 导出物是给人看、给人存的：**标题要有、是谁说的要有、时间要有**，
 * 而且**一条都不许丢**——导出时截断等于把记录弄残。
 */

test('标题、时间、条数、三个角色都排进去', () => {
  const md = exportMarkdown({
    title: '修 PDF 预览',
    at: '2026-11-14T11:00:00.000Z',
    entries: [
      { role: 'user', text: '帮我看看这个 PDF', timestamp: 1763120000000 },
      { role: 'assistant', text: '在，我先量一下它的结构。' },
      { role: 'notice', text: '子智能体完工了' },
    ],
  })
  assert.match(md, /^# 修 PDF 预览/m)
  assert.match(md, /共 3 条/)
  assert.match(md, /## 我/)
  assert.match(md, /## AI/)
  assert.match(md, /## 通知/)
  assert.match(md, /帮我看看这个 PDF/)
})

test('多少条就写多少条，不偷偷截断', () => {
  const entries = Array.from({ length: 260 }, (_, i) => ({ role: 'assistant', text: `第 ${i} 条` }))
  const md = exportMarkdown({ title: '长会话', at: 'x', entries })
  assert.match(md, /共 260 条/)
  assert.match(md, /第 259 条/)
})

test('文件名去掉系统不认的字符，太长就截断', () => {
  assert.equal(exportFileName('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i.md')
  assert.equal(exportFileName(''), '会话.md')
  assert.equal(exportFileName('长'.repeat(200)).length, 63, '60 个字符 + .md')
})

test('路由与菜单都接了：下载一个 .md，入口在会话菜单里', () => {
  const server = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')
  assert.match(server, /path === '\/mini\/api\/export'/)
  assert.match(server, /attachment; filename\*=UTF-8''/)
  assert.match(server, /nav\.exportSession/)
  const nav = readFileSync(new URL('../lib/page-nav.js', import.meta.url), 'utf8')
  assert.match(nav, /data-act="export"/)
  assert.match(nav, /\/mini\/api\/export\?sessionId=/)
})
