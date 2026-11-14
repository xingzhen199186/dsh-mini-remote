import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 公式渲染（2026-11-14）。
 *
 * 页面脚本是普通脚本，这里求值取函数。要守住的：
 * **成对的才当公式**、**反斜杠不许被 Markdown 吃掉**、**落单的 $ 原样留着**。
 */

const SRC = readFileSync(new URL('../lib/page-math.js', import.meta.url), 'utf8')
const { extractMath, mathPlaceholders } = new Function(
  'document', 'MutationObserver',
  `${SRC}\nreturn { extractMath, mathPlaceholders };`,
)({ createElement: () => ({}) }, function () {})

test('行内公式抠出来，位置留占位符', () => {
  const one = extractMath('质能方程是 $E=mc^2$ 这样')
  assert.equal(one.items.length, 1)
  assert.equal(one.items[0].tex, 'E=mc^2')
  assert.equal(one.items[0].display, false)
  assert.match(one.text, /@@MATH0@@/)
  assert.doesNotMatch(one.text, /E=mc\^2/)
})

test('块级公式认 $$…$$，排版用 display 模式', () => {
  const two = extractMath('推导：\n\n$$\\frac{a}{b} = c$$\n\n完')
  assert.equal(two.items.length, 1)
  assert.equal(two.items[0].display, true)
  assert.equal(two.items[0].tex, '\\frac{a}{b} = c')
})

test('落单的美元符号不当公式：价格不能被排版', () => {
  const price = extractMath('这个 5$ 那个 8$')
  assert.equal(price.items.length, 0)
  assert.equal(price.text, '这个 5$ 那个 8$')
})

test('反斜杠原样留住（Markdown 之前就得抠）', () => {
  const one = extractMath('$\\alpha + \\beta$')
  assert.equal(one.items[0].tex, '\\alpha + \\beta')
})

test('占位符换成容器，LaTeX 放在属性里且转义过', () => {
  const { text, items } = extractMath('$a<b$')
  const html = mathPlaceholders(`<p>${text}</p>`, items)
  assert.match(html, /class="math"/)
  assert.match(html, /data-tex="a&lt;b"/)
})

test('渲染器与启动处都接上了公式', () => {
  const md = readFileSync(new URL('../lib/page-markdown.js', import.meta.url), 'utf8')
  assert.match(md, /extractMath\(src\)/)
  assert.match(md, /mathPlaceholders\(html\.join/)
  const app = readFileSync(new URL('../lib/page-app.js', import.meta.url), 'utf8')
  assert.match(app, /watchMath\(\)/)
  const server = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')
  assert.match(server, /\/mini\/vendor\/katex\//)
})
