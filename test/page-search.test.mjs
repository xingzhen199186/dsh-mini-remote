import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 会话搜索（2026-11-14）。
 *
 * 页面脚本是普通脚本，这里按老办法加载：拼一段代码求值，取回函数。
 * 要守住的三件事：**命中标题**、**工作区名命中也能带出会话**、
 * **没加载的工作区不能假装"没有"**。
 */

const SRC = readFileSync(new URL('../lib/page-search.js', import.meta.url), 'utf8')
const { searchSessions } = new Function(`${SRC}\nreturn { searchSessions };`)()

const WS = [
  { id: 'w1', title: '极简遥控器' },
  { id: 'w2', title: '写作算法' },
  { id: 'w3', title: '没打开过的工作区' },
]
const LOADED = {
  w1: { sessions: [
    { id: 's1', title: '修 PDF 预览' },
    { id: 's2', title: '凭据遮挡' },
  ] },
  w2: { sessions: [
    { id: 's3', title: '采访稿润色' },
  ] },
}

test('按会话标题匹配，大小写不敏感', () => {
  const one = searchSessions(WS, LOADED, 'pdf')
  assert.equal(one.rows.length, 1)
  assert.equal(one.rows[0].id, 's1')
  assert.equal(one.rows[0].ws, '极简遥控器')
})

test('工作区名命中时，把它下面的会话都列出来', () => {
  const two = searchSessions(WS, LOADED, '写作算法')
  assert.equal(two.rows.length, 1)
  assert.equal(two.rows[0].id, 's3')
})

test('没加载过的工作区如实计数，不许假装搜过', () => {
  const none = searchSessions(WS, LOADED, '完全搜不到的词')
  assert.equal(none.empty, true)
  // hidden 只算**没加载过**的工作区（w3）；加载过但没命中的不算隐藏，
  // 否则界面会误报"还有 3 个工作区没加载"。
  assert.equal(none.hidden, 1)

  const hitWs = searchSessions(WS, LOADED, '没打开过')
  assert.equal(hitWs.rows.length, 1)
  assert.equal(hitWs.rows[0].id, '', '没加载的工作区只能给一句提示，不能给可点的会话')
})

test('空搜索词不会把全部会话倒出来（界面那边靠它不画结果）', () => {
  // 纯函数不做界面判断，但 empty 要是 false、rows 要完整，交给调用方决定。
  const all = searchSessions(WS, LOADED, '')
  assert.equal(all.empty, false)
  // 3 条会话 + 1 条"没加载"的提示行；界面靠 navQuery.trim() 拦在前面，不会走到这里。
  assert.equal(all.rows.length, 4)
})

test('导航里真的接了搜索：输入框、结果视图、输入事件', () => {
  const nav = readFileSync(new URL('../lib/page-nav.js', import.meta.url), 'utf8')
  assert.match(nav, /data-search="1"/)
  assert.match(nav, /navSearchHtml\(navQuery\)/)
  assert.match(nav, /searchSessions\(navList/)
  assert.match(nav, /matches\('\[data-search\]'\)/)
})
