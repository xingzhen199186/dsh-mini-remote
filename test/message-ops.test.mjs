import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 消息操作（2026-11-14）。
 *
 * 这一块只有两个动作是**现在就能真做的**：整条复制（已有）和引用追问（新）。
 * 「重新回答」和「从这条分叉」要宿主接口，当前没有——测试里只盯住能做的，
 * 不做假按钮（画了按下去没反应，比没有更坏）。
 */

const render = readFileSync(new URL('../lib/page-render.js', import.meta.url), 'utf8')
const app = readFileSync(new URL('../lib/page-app.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../lib/page.html', import.meta.url), 'utf8')

test('每条消息都有复制和引用两个按钮', () => {
  assert.match(render, /data-copy="/)
  assert.match(render, /data-quote="/)
  // 两条渲染路径（自己发的、AI 回答）都要带上引用按钮。
  assert.ok((render.match(/quoteBtn\(m\.text\)/g) || []).length >= 1)
})

test('引用只取前两行，长回答不许把输入框撑满', () => {
  const { quoteText } = new Function(
    'escapeHtml', 'isLongUserText',
    `${render.slice(render.indexOf('function quoteText'), render.indexOf('function quoteBtn'))}\nreturn { quoteText };`,
  )((t) => t, () => false)
  const short = quoteText('就一句话')
  assert.equal(short, '> 就一句话\n\n')

  const many = Array.from({ length: 30 }, (_, i) => `第 ${i} 行`).join('\n')
  const quoted = quoteText(many)
  assert.match(quoted, /^> 第 0 行 第 1 行（前两行，共 30 行）/)
  assert.ok(quoted.length < 120, '引用太长会把要问的问题挤没')
})

test('点引用把内容塞进输入框并聚焦，不打乱已输入的字', () => {
  assert.match(app, /closest\('\[data-quote\]'\)/)
  assert.match(app, /input\.value = quoteText\(/)
  assert.match(app, /input\.focus\(\)/)
})

test('图片预览里有「存到手机」，落到下载目录', () => {
  assert.match(html, /id="imgViewSave"/)
  assert.match(app, /t\.id === 'imgViewSave'/)
  assert.match(app, /a\.download = '图片-/)
  // 不许画"存相册"却做不到。
  assert.doesNotMatch(app, /存相册/)
})

test('做不到的两个动作不要画假按钮', () => {
  assert.doesNotMatch(render, /重新回答/)
  assert.doesNotMatch(render, /从这条分叉/)
})

test('"离底一屏内"也不许把人按到页尾（2026-11-14 跳动的直接原因）', () => {
  const render = readFileSync(new URL('../lib/page-render.js', import.meta.url), 'utf8')
  // 原来这里只有 !stick && !canPin 两个条件；现在必须带 atBottom()。
  assert.match(render, /if \(!stick && !canPin && atBottom\(\)\) mainEl\.scrollTop = mainEl\.scrollHeight/)
})

test('记录器不许自己调自己（会抛栈溢出、整页白屏）', () => {
  const probe = readFileSync(new URL('../lib/page-scrollprobe.js', import.meta.url), 'utf8')
  assert.doesNotMatch(probe, /function send\(body\)\s*\{\s*send\(body\)\s*\}/)
  assert.match(probe, /fetch\(LOG, \{/)
})
