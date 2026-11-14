import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// 页面脚本是普通脚本（没有模块），这里按老办法加载它：拼一段代码求值，取回函数。
const SRC = readFileSync(new URL('../lib/page-mask.js', import.meta.url), 'utf8')
const { maskSecrets, maskLabel, paintSecrets, renderMasked } = new Function(
  `${SRC}\nreturn { maskSecrets, maskLabel, paintSecrets, renderMasked };`,
)()

/**
 * 凭据遮挡（2026-11-14）。
 *
 * 两条要求：**该遮的一定遮住**；**不该遮的别乱遮**——如果把提交号、普通长单词
 * 也糊成圆点，聊天记录就没法读了。
 */

test('常见的 Key 形状都认得出', () => {
  const cases = [
    'sk-abcdefghijklmnopqrstuvwx',
    'ghp_abcdefghijklmnopqrstuvwxyz',
    'AKIAABCDEFGHIJKLMNOP',
    'xoxb-1234567890-abcdefghij',
    'Bearer abcdefghijklmnopqrstuvwxyz123',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghij',
  ]
  for (const one of cases) {
    const { text, secrets } = maskSecrets(`配置是 ${one} 别外传`)
    assert.equal(secrets.length, 1, `${one} 没被认出来`)
    assert.doesNotMatch(text, /abcdefghij|ABCDEFGHIJ|1234567890/, `${one} 还留在明文里`)
  }
})

test('"apiKey": "xxxx" 这种赋值形式也遮', () => {
  const { text, secrets } = maskSecrets('{"apiKey": "abcdef0123456789abcdef"}')
  assert.equal(secrets.length, 1)
  assert.match(text, /@@SEC0@@/)
})

test('普通文字不许误伤：提交号、单词、路径', () => {
  const ordinary = '提交 86d24b0 改了 lib/page-mask.js，单词 internationalization 没问题'
  const { secrets } = maskSecrets(ordinary)
  assert.equal(secrets.length, 0, '普通文字被当成凭据遮掉了')
})

test('遮住之后只露前八位', () => {
  assert.equal(maskLabel('sk-1234567890abcdef'), 'sk-12345••••', '前八位照原样留着')
  assert.equal(maskLabel('short'), '••••••', '太短的干脆全遮')
})

test('展开用的全文放在 data-full 里，并且转义过', () => {
  const { secrets } = maskSecrets('key: sk-abcdefghijklmnop')
  const html = paintSecrets('<p>@@SEC0@@</p>', secrets)
  assert.match(html, /class="secret"/)
  assert.match(html, /data-full="sk-abcdefghijklmnop"/)
  assert.match(html, /sk-abcde••••/)
})

test('渲染路径统一走 renderMasked：先遮，再转 HTML', () => {
  const html = renderMasked('我的 key 是 sk-abcdefghijklmnop', (t) => `<p>${t}</p>`)
  assert.match(html, /class="secret"/)
  // 可见文字里只有前八位；全文只许待在被转义过的 data-full 里（点开才用）。
  assert.match(html, />sk-abcde••••</)
  assert.match(html, /data-full="sk-abcdefghijklmnop"/)
})

test('页面里三条渲染路径都接了遮挡', () => {
  const src = readFileSync(new URL('../lib/page-render.js', import.meta.url), 'utf8')
  // 用户气泡、AI 回答、正在流式的那段、以及"最新回答"那块。
  assert.ok((src.match(/renderMasked\(/g) || []).length >= 4, '渲染路径没有全部接上遮挡')
  const app = readFileSync(new URL('../lib/page-app.js', import.meta.url), 'utf8')
  assert.match(app, /initSecrets\(\)/, '启动时要绑定展开点击')
})
