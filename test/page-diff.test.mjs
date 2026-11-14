import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 改动对照（2026-11-14）。
 *
 * 页面上原来是把 old_string / new_string 两段原样并排放，**看不出改了什么**。
 * 这组测试守两件事：**增删认得对**；**没改动就别画红绿**。
 */

const SRC = readFileSync(new URL('../lib/page-diff.js', import.meta.url), 'utf8')
const { diffLines, diffHtml, editPair } = new Function(
  `${SRC}\nreturn { diffLines, diffHtml, editPair };`,
)()

test('新增的行标 add，删掉的行标 del，没动的标 same', () => {
  const out = diffLines('苹果\n香蕉\n橘子', '苹果\n香蕉\n西瓜')
  const kinds = out.rows.map((r) => r.type + ':' + r.text)
  assert.deepEqual(kinds, ['same:苹果', 'same:香蕉', 'del:橘子', 'add:西瓜'])
  assert.equal(out.cut, false)
})

test('只加不改：整段加进去', () => {
  const out = diffLines('第一行', '第一行\n第二行\n第三行')
  assert.deepEqual(out.rows.filter((r) => r.type === 'add').map((r) => r.text), ['第二行', '第三行'])
})

test('两边一样时不给 HTML：别为没改动画一块红绿', () => {
  assert.equal(diffHtml('一样的内容', '一样的内容'), '')
  assert.match(diffHtml('旧', '新'), /class="diff-row diff-del"/)
})

test('参数里的"改前/改后"认得出来，多种写法都试', () => {
  assert.deepEqual(
    editPair(JSON.stringify({ path: 'a.txt', old_string: '旧', new_string: '新' })),
    { before: '旧', after: '新' },
  )
  assert.deepEqual(editPair({ search: 'a', replace: 'b' }), { before: 'a', after: 'b' })
  assert.equal(editPair({ path: 'a.txt' }), null, '没有改前改后就不是编辑')
  assert.equal(editPair('不是 JSON'), null)
})

test('太长要有上限，并且如实说被截了', () => {
  const many = Array.from({ length: 600 }, (_, i) => `行 ${i}`).join('\n')
  const out = diffLines(many, '完全不同')
  assert.equal(out.cut, true)
})

test('工具行真的接了对照，而且渲染器里带着它', () => {
  const traj = readFileSync(new URL('../lib/page-trajectory.js', import.meta.url), 'utf8')
  assert.match(traj, /editPair\(e\.args\)/)
  assert.match(traj, /diffHtml\(pair\.before, pair\.after\)/)
  const bundle = readFileSync(new URL('../lib/page.js', import.meta.url), 'utf8')
  assert.match(bundle, /'page-diff\.js'/)
})
