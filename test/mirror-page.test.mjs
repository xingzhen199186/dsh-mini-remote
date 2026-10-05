/**
 * 「进阶设置（电脑端界面）」的页面侧（2026-10-06 用户要求）。
 *
 * 这是个**权限开关**，不是普通偏好：打开它，这个令牌的权限就从「我们那张手机页
 * 暴露的那点事」扩到整个电脑端设置面。所以这一组测的重点不是画得好不好看，
 * 而是那三条口径有没有被守住：
 *   ① 默认关，而且**关着的时候那一行根本不显示**（不是露一个点了没用的按钮）；
 *   ② 开启要**点两次**——第一次只把后果摆出来；
 *   ③ 关掉不拦（往更安全的方向走，不用确认）。
 *
 * 还测一条会悄悄坏掉的：入口链接必须**带上令牌**。新标签里没有 X-Mini-Token 头，
 * 不带令牌的那一下会被服务端 401——而且这个错在电脑上看不出来，只有手机上才发现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../lib/page.html', import.meta.url), 'utf8')

/** 把「进阶设置」那一段从页面里切出来单独跑，$ / api / toast 全给桩。 */
function mirrorHarness({ apiImpl } = {}) {
  const A = 'var mirror = { available:'
  const B = 'if (NOTIFY_OK) {'
  const a = html.indexOf(A)
  const b = html.indexOf(B)
  assert.ok(a > 0, `在 page.html 里找不到锚点「${A}」`)
  assert.ok(b > a, `在 page.html 里找不到锚点「${B}」`)

  const fakeEl = () => ({
    hidden: false,
    textContent: '',
    href: '',
    children: [],
    dataset: {},
    classList: { toggle() {} },
    addEventListener() {},
  })
  const rowMirror = fakeEl()
  const rowMirrorOpen = fakeEl()
  const mirrorHint = fakeEl()
  const btnMirrorOpen = fakeEl()
  const on = fakeEl(); on.dataset = { mirror: 'on' }
  const off = fakeEl(); off.dataset = { mirror: 'off' }
  const segMirror = fakeEl(); segMirror.children = [on, off]
  const table = { rowMirror, segMirror, mirrorHint, rowMirrorOpen, btnMirrorOpen }

  const calls = []
  const toasts = []
  const api = (path, options) => {
    calls.push({ path, options })
    return apiImpl
      ? Promise.resolve(apiImpl(path, options))
      : Promise.resolve({ ok: true })
  }

  const src = `${html.slice(a, b)}; return { mirror, paintMirror, loadMirror, tapMirror };`
  const out = new Function('$', 'state', 'api', 'toast', src)(
    (k) => table[k], { token: 'TK-123' }, api, (m) => toasts.push(m),
  )
  return { ...out, els: table, calls, toasts, on, off }
}

/** 等一等，让 api() 那个 Promise 的 then 跑完。 */
const tick = () => new Promise((r) => setTimeout(r, 0))

test('进阶设置：默认关，而且关着的时候那一行根本不显示', () => {
  const h = mirrorHarness()
  // 起手就是「还没读到」的状态：两行都不该露出来。
  assert.equal(h.mirror.available, false, '没读到之前不许当成可用')
  assert.equal(h.mirror.enabled, false, '没读到之前一律当关——这是个权限开关，要往关那边倒')
  h.paintMirror()
  assert.equal(h.els.rowMirror.hidden, true, '没这个能力时整行不显示，不摆一个假开关')
  assert.equal(h.els.rowMirrorOpen.hidden, true)
})

test('进阶设置：服务端说没这个能力（available=false）时整块都不画', async () => {
  const h = mirrorHarness({ apiImpl: () => ({ ok: true, available: false, enabled: false }) })
  await h.loadMirror()
  await tick()
  assert.equal(h.mirror.available, false)
  assert.equal(h.els.rowMirror.hidden, true, '没有这个能力就不画——和「繁忙时的发送行为」同一条口径')
  assert.equal(h.els.rowMirrorOpen.hidden, true)
})

test('进阶设置：读到了、但没开 → 只显示开关那一行，入口不露', async () => {
  const h = mirrorHarness({ apiImpl: () => ({ ok: true, available: true, enabled: false }) })
  await h.loadMirror()
  await tick()
  assert.equal(h.els.rowMirror.hidden, false, '有这个能力就要把开关露出来')
  assert.equal(h.els.rowMirrorOpen.hidden, true, '没开的时候入口不许露——那是个点了没用的按钮')
})

test('进阶设置：要**点两次**才开——第一次只把后果摆出来', async () => {
  const h = mirrorHarness({ apiImpl: () => ({ ok: true, available: true, enabled: false }) })
  await h.loadMirror()
  await tick()

  // 第一次点「开」：只是把话摆出来，**不许发请求**。
  h.tapMirror('on')
  assert.equal(h.mirror.armed, true, '第一次点要进入「已举起」状态')
  assert.equal(h.mirror.enabled, false, '第一次点不许真开')
  assert.match(h.els.mirrorHint.textContent, /再点一次/,
    '第一次点之后要说明「再点一次」——用户得知道这一下还没生效')
  assert.match(h.els.mirrorHint.textContent, /完整的电脑设置权限/,
    '后果必须写清楚：打开后手机拿到的是完整的电脑设置权限')
  // 只数 POST：`loadMirror()` 自己发过一次 GET（读状态），那是页面进来时该做的事。
  assert.equal(h.calls.filter((c) => c.options).length, 0, '第一次点不许发任何写请求')

  // 第二次点：这才真开。
  h.tapMirror('on')
  await tick()
  assert.equal(h.mirror.enabled, true, '第二次点才真开')
  assert.equal(h.mirror.armed, false, '开成就该把「已举起」收掉')
  const post = h.calls.find((c) => c.path === '/mini/api/mirror' && c.options)
  assert.ok(post, '第二次点要发一次 POST')
  assert.deepEqual(JSON.parse(post.options.body), { enabled: true })
  assert.equal(h.els.rowMirrorOpen.hidden, false, '开了才把入口露出来')
})

test('进阶设置：关掉不用确认（往更安全的方向走不拦）', async () => {
  const h = mirrorHarness({ apiImpl: () => ({ ok: true, available: true, enabled: true }) })
  await h.loadMirror()
  await tick()
  assert.equal(h.els.rowMirrorOpen.hidden, false)

  h.tapMirror('off')
  await tick()
  assert.equal(h.mirror.enabled, false, '关一下就该关掉')
  assert.equal(h.mirror.armed, false)
  const post = h.calls.find((c) => c.path === '/mini/api/mirror' && c.options)
  assert.ok(post, '关也要发一次 POST')
  assert.deepEqual(JSON.parse(post.options.body), { enabled: false })
  assert.equal(h.els.rowMirrorOpen.hidden, true, '关掉之后入口也要收回去')
})

test('进阶设置：入口链接要带上令牌（新标签里没有请求头可用）', async () => {
  const h = mirrorHarness({ apiImpl: () => ({ ok: true, available: true, enabled: true }) })
  await h.loadMirror()
  await tick()
  assert.equal(h.els.btnMirrorOpen.href, '/mini/mirror?token=TK-123',
    '新标签里没有 X-Mini-Token 头，只能靠地址带 token；不带的话入口那一下会 401')
})

test('进阶设置：失败要画回去，不能留一个没生效的状态', async () => {
  const h = mirrorHarness({
    apiImpl: (path, options) => {
      // 读的时候说没开；开的那一次说失败。
      if (options) return { ok: false }
      return { ok: true, available: true, enabled: false }
    },
  })
  await h.loadMirror()
  await tick()
  h.tapMirror('on')
  h.tapMirror('on')
  await tick()
  assert.equal(h.mirror.enabled, false, '开启失败要画回去——留着选中态用户会以为开了')
  assert.equal(h.els.rowMirrorOpen.hidden, true)
  assert.ok(h.toasts.length > 0, '失败了要说一句话，不能默不作声')
})

// ---------------------------------------------------------------------------
// 结构 / 接线：这几条是「逻辑对、但没人喊它」那一类错
// ---------------------------------------------------------------------------

test('进阶设置：结构上该有的都在，入口开新标签且不带 opener', () => {
  assert.ok(html.includes('<div class="row" id="rowMirror" hidden>'),
    '开关那一行要在，而且**默认 hidden**——这是个权限开关，默认必须是关的')
  assert.ok(html.includes('<div class="row" id="rowMirrorOpen" hidden>'),
    '入口那一行也要默认 hidden')
  assert.ok(html.includes('id="segMirror"'), '缺了开关本体')
  assert.match(html, /id="btnMirrorOpen"[^>]*target="_blank"/, '入口要开新标签')
  assert.match(html, /id="btnMirrorOpen"[^>]*rel="noopener"/, '开新标签要带 rel="noopener"')
})

test('进阶设置：开关那排按钮要绑上处理（逻辑对、没人喊它是另一种坏法）', () => {
  assert.match(html, /\$\('segMirror'\)\.addEventListener\('click'/,
    '开关上必须绑监听——真机上「逻辑对但没接线」这个坑踩过一次')
})

test('进阶设置：设置抽屉每次打开都要重读一次（电脑端能把它关掉）', () => {
  const A = "$('btnSettings').addEventListener('click'"
  const B = "$('btnClose').addEventListener('click'"
  const a = html.indexOf(A)
  const b = html.indexOf(B)
  const block = html.slice(a, b)
  assert.match(block, /loadMirror\(\)/,
    '开抽屉时要重读一次：这个开关电脑端也能改，手机上不能一直停在「开着」')
})
