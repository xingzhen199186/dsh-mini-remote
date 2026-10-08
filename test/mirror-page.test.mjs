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

  // 「要什么给什么」：这一段的代码会去拿好几个元素（开关、入口、那一整屏、里面的框、
  // 关闭按钮），**逐个列出来会漏**——加了新元素就得回来补，忘一次就是一片红。
  const made = new Map()
  const fakeEl = () => ({
    hidden: false,
    textContent: '',
    href: '',
    src: '',
    children: [],
    dataset: {},
    classList: { toggle() {} },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) },
  })
  const table = {}
  const el = (k) => {
    if (!table[k]) table[k] = fakeEl()
    return table[k]
  }
  const on = fakeEl(); on.dataset = { mirror: 'on' }
  const off = fakeEl(); off.dataset = { mirror: 'off' }
  table.segMirror = fakeEl(); table.segMirror.children = [on, off]

  const calls = []
  const toasts = []
  const api = (path, options) => {
    calls.push({ path, options })
    return apiImpl
      ? Promise.resolve(apiImpl(path, options))
      : Promise.resolve({ ok: true })
  }

  const src = `${html.slice(a, b)}; return { mirror, paintMirror, loadMirror, tapMirror };`
  // `window` / `location` 照真实环境给上：这一段里挂着一条 message 监听
  // （框里那一页发「返回手机页」时收屏，见 page.html 里那段说明）。
  const out = new Function('$', 'state', 'api', 'toast', 'window', 'location', src)(
    el, { token: 'TK-123' }, api, (m) => toasts.push(m),
    { addEventListener() {} }, { origin: 'http://phone' },
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

test('进阶设置：结构上该有的都在，两行默认都不显示', () => {
  assert.ok(html.includes('<div class="row" id="rowMirror" hidden>'),
    '开关那一行要在，而且**默认 hidden**——这是个权限开关，默认必须是关的')
  assert.ok(html.includes('<div class="row" id="rowMirrorOpen" hidden>'),
    '入口那一行也要默认 hidden')
  assert.ok(html.includes('id="segMirror"'), '缺了开关本体')
  assert.ok(html.includes('id="btnMirrorOpen"'), '缺了入口那个链接')
})

test('进阶设置：开关那排按钮要绑上处理（逻辑对、没人喊它是另一种坏法）', () => {
  assert.match(html, /\$\('segMirror'\)\.addEventListener\('click'/,
    '开关上必须绑监听——真机上「逻辑对但没接线」这个坑踩过一次')
})

/**
 * 「那一行看不见」不能只看 `hidden` 这个属性——**还得看样式表认不认它**。
 *
 * 2026-10-08 真机验出来的（无头 Edge + CDP 打开手机页）：
 *   `paintMirror()` 一直是对的，四种状态下 `hidden` 全都设对了；
 *   可 `.row { display: flex }` 是**作者样式表**，它压得住 UA 那句 `[hidden]{display:none}`
 *   ——于是「进阶设置」关着的时候，「电脑端界面」那一行照样画出来（实测 358×70，
 *   `getComputedStyle` 回来还是 `flex`）。脚本量着是 hidden、用户眼睛看着是在，两边都对不上。
 *
 * 这条测试守的就是那一句兜底样式：**凡是页面用 `hidden` 藏的 `.row`，
 * 样式表里必须有一条管得到它的 `[hidden]{display:none}`**。
 * 光靠上面那些「hidden === true」的用例守不住这个 bug——它们当时全绿。
 */
test('页面用 hidden 藏的 .row，样式表必须有 [hidden] 兜底（否则 hidden 等于没写）', () => {
  const cssStart = html.indexOf('<style>')
  const cssEnd = html.indexOf('</style>')
  assert.ok(cssStart > 0 && cssEnd > cssStart, '找不到页面的 <style> 段')
  const css = html.slice(cssStart, cssEnd).replace(/\/\*[\s\S]*?\*\//g, '')

  /** 页面里那些「带 class="row" 又是元素本身」的行：id → 它的 class 列表。 */
  const rows = new Map()
  for (const m of html.matchAll(/<div class="([^"]*)" id="([^"]+)"/g)) {
    if (m[1].split(/\s+/).includes('row')) rows.set(m[2], m[1].split(/\s+/))
  }
  assert.ok(rows.has('rowMirror') && rows.has('rowMirrorOpen'), '两行都该是 .row（改了结构要同步改这里）')

  /** 脚本里用 `$('x').hidden = …` 藏的行。 */
  const hiddenByScript = new Set()
  for (const m of html.matchAll(/\$\('([\w-]+)'\)\.hidden\s*=/g)) hiddenByScript.add(m[1])

  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2], at: m.index }))
  /** 一条选择器「管得到」某个元素吗——只看最后那一段（够用：`.sheet .version` 那种管的是后代）。 */
  const covers = (compound, id, classes) => {
    const idHit = /#([\w-]+)/.exec(compound)
    if (idHit && idHit[1] !== id) return false
    const cls = [...compound.matchAll(/\.([\w-]+)/g)].map((m) => m[1])
    return cls.every((c) => classes.includes(c))
  }
  const spec = (compound) => [/#[\w-]+/g, /[.\[]/g].map((re) => (compound.match(re) || []).length)
  const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1])

  const missing = []
  for (const [id, classes] of rows) {
    if (!hiddenByScript.has(id)) continue
    // 作者样式表里，有没有一条规则给这个元素写了 display（那它就可能压住 UA 的 hidden）
    let own = null
    for (const r of rules) {
      if (!/display\s*:/.test(r.body)) continue
      if (r.sel.split(',').some((s) => covers(s.trim().split(/\s+/).pop(), id, classes))) own = r
    }
    // 兜底那条：给 display:none、选择器带 [hidden]、而且**压得住**上面那条（优先级更高，或排得更后）
    const guard = rules.find((r) => /display\s*:\s*none/.test(r.body) && r.sel.split(',').some((s) => {
      const last = s.trim().split(/\s+/).pop()
      return /\[hidden\]$/.test(last) && covers(last, id, classes)
        && (cmp(spec(last), own ? spec(own.sel.split(',').pop().trim().split(/\s+/).pop()) : [0, 0, 0]) > 0 || r.at > (own?.at ?? 0))
    }))
    if (!guard) missing.push(id + (own ? `（它自己的 display 来自「${own.sel.trim()}」）` : ''))
  }
  assert.deepEqual(missing, [],
    '这些行被 hidden 藏着，可样式表里没有一条 [hidden]{display:none} 压得住它们自己的 display —— '
    + '真机上就是「脚本说藏了、屏幕上还在」。修法照 `.row[hidden]` 那一句加。')
})

/**
 * 「打开」**内嵌**那一整屏，不许再走「跳转」。
 *
 * 2026-10-06 用户**三次**实机报「点击打开没反应」，三版都在赌「跳转」这个动作：
 *   · `<a target="_blank">`——内嵌浏览器（微信这类）常把新标签直接拦掉；
 *   · 加 JS 兜底（`window.open` 失败就同标签跳）——还是没反应，因为那些浏览器里
 *     `window.open` 会**「成功」返回一个对象**，代码以为开好了就不再跳，新标签开在后台；
 *   · 干脆用普通 `<a href>` 同标签跳（理论上拦不掉）——**用户那边仍然没反应**。
 *
 * 所以改成内嵌：点一下只是把一层显示出来、给里面的框设个地址。**没有跳转、没有新标签、
 * 没有弹窗——浏览器没有任何东西可以拦。**（已用真浏览器验过那个界面愿意被嵌。）
 */
function mirrorOpenHarness() {
  // 从 `var mirror = …` 起切：`openMirror` 会引用 `mirror`，不带上它整段跑不起来
  // （切点选在 `mirrorUrl` 那会儿就踩过这个坑）。
  const A = 'var mirror = { available:'
  const B = 'function loadMirror()'
  const a = html.indexOf(A)
  const b = html.indexOf(B)
  assert.ok(a > 0, `在 page.html 里找不到锚点「${A}」`)
  assert.ok(b > a, `在 page.html 里找不到锚点「${B}」`)

  const made = new Map()
  const el = (key) => {
    if (!made.has(key)) {
      made.set(key, {
        hidden: false, src: '', textContent: '', dataset: {},
        classList: { toggle() {} },
        children: [],
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) },
      })
    }
    return made.get(key)
  }
  const table = {}
  for (const k of ['rowMirror', 'rowMirrorOpen', 'mirrorHint', 'segMirror', 'btnMirrorOpen', 'mirrorView', 'mirrorFrame', 'mirrorClose']) {
    table[k] = el(k)
  }
  const src = `${html.slice(a, b)}; return { mirror, mirrorUrl, openMirror, closeMirror, win: window };`
  const toasts = []
  // `window` / `location` 也照真实环境给上：这一段里挂着一条 message 监听
  // （框里那一页发「返回手机页」时收屏，见 page.html 里那段说明）。
  const win = {
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) },
  }
  const out = new Function('$', 'state', 'api', 'toast', 'window', 'location', src)(
    (k) => table[k], { token: 'TK-123' }, () => Promise.resolve({ ok: true }), (m) => toasts.push(m),
    win, { origin: 'http://phone' },
  )
  return { ...out, els: table, toasts, win }
}

test('进阶设置：地址要带令牌和尾斜杠（框里那些请求不一定都带得上 cookie）', () => {
  const h = mirrorOpenHarness()
  assert.equal(h.mirrorUrl(), '/mini/mirror/?token=TK-123',
    '尾斜杠不能省：外壳写着 <base href="./">，少了它里面的脚本会解析到 /mini/assets/...'
    + '（那是我们自己的地盘）上，全 404、界面白屏')
})

test('进阶设置：点「打开」只显示那一层并设地址——没有跳转', () => {
  const h = mirrorOpenHarness()
  h.mirror.enabled = true
  h.openMirror()
  assert.equal(h.els.mirrorView.hidden, false, '要把那一整屏显示出来')
  assert.equal(h.els.mirrorFrame.src, '/mini/mirror/?token=TK-123', '地址设在里面的框上')
})

/**
 * **顺序：先显示那一层，再给框设地址。**
 *
 * 2026-10-06 真机报「图标旁边的文字点一下才出来」。查出：**直接打开镜像没有这个毛病**，
 * 差别就在这两行的先后——反过来写的话，那个界面是**在 `display:none` 里开始加载的**，
 * 在不可见的上下文里渲染出来的东西要等用户点一下触发重绘才画全。
 */
test('进阶设置：要先显示那一层、再给框设地址（反了就是「点一下才出字」）', () => {
  const A = "$('mirrorView').hidden = false;"
  const B = "$('mirrorFrame').src = mirrorUrl();"
  const a = html.indexOf(A)
  const b = html.indexOf(B)
  assert.ok(a > 0 && b > 0, '这两句都要在')
  assert.ok(a < b,
    '先显示、再设地址。反过来的话界面在 display:none 里开始加载，'
    + '渲染出来的东西要等用户点一下才画全（真机上就是「点一下才出字」）')
})

test('进阶设置：点「打开」要先给一句提示（它是诊断，不是装饰）', () => {
  const h = mirrorOpenHarness()
  h.mirror.enabled = true
  h.openMirror()
  assert.ok(h.toasts.length > 0,
    '三次「点了没反应」都是因为分不开这三种情况：点击没到按钮 / 到了但没显示 / 显示了但里面没加载。'
    + '先弹一句提示，就能一眼分开——这一句不能省')
})

test('进阶设置：没开的时候点不动（不给一个能绕过开关的入口）', () => {
  const h = mirrorOpenHarness()
  h.mirror.enabled = false
  // 真页面上那一层初始就是 hidden（HTML 里带着这个属性）；替身默认不是，先摆成真实状态。
  h.els.mirrorView.hidden = true
  h.openMirror()
  assert.equal(h.els.mirrorView.hidden, true, '开关关着时那一层不该出现')
  assert.equal(h.els.mirrorFrame.src, '', '地址也不该设——否则等于绕过了开关')
})

test('进阶设置：关掉那一层要把框的地址清掉（里面是个还在跑的应用）', () => {
  const h = mirrorOpenHarness()
  h.mirror.enabled = true
  h.openMirror()
  h.closeMirror()
  assert.equal(h.els.mirrorView.hidden, true)
  assert.equal(h.els.mirrorFrame.src, 'about:blank',
    '要真停掉：那一屏里是完整应用，还在跑、还连着，留着会继续占内存和连接')
})

/**
 * 框里那一页**打不开的时候**是我们自己发的一页提示（lib/server.js 的
 * `sendMirrorUnavailable`），那一页里除了浏览器自己的返回没有别的出口——
 * 所以它的「返回手机页」按钮往这里发一条消息，这一屏要收起来。
 * 2026-10-08 真机：用户卡在一个 `{"error":"not found"}` 的框里，出不来。
 */
test('进阶设置：框里那一页发「返回」时，这一屏要收起来（且只认同源那一条）', () => {
  const h = mirrorOpenHarness()
  h.mirror.enabled = true
  h.openMirror()
  const fire = (origin, data) => {
    for (const fn of h.win.listeners.message ?? []) fn({ origin, data })
  }
  fire('http://evil', 'mini-mirror-close')
  assert.equal(h.els.mirrorView.hidden, false, '不是同源的一律不理')
  fire('http://phone', '别的消息')
  assert.equal(h.els.mirrorView.hidden, false, '只认那一条字符串')
  fire('http://phone', 'mini-mirror-close')
  assert.equal(h.els.mirrorView.hidden, true, '同源 + 那一条字符串 → 收屏')
  assert.equal(h.els.mirrorFrame.src, 'about:blank', '顺带把框停掉，别留在后台跑')
})

test('进阶设置：整页不许再出现 window.open / target（三次都栽在跳转上）', () => {
  assert.ok(!/window\.open\(/.test(html), '整页不许再用 window.open')
  const tag = html.match(/<[a-z]+[^>]*id="btnMirrorOpen"[^>]*>/)
  assert.ok(tag, '找不到「打开」那个元素')
  assert.ok(!/target=/.test(tag[0]), '不许带 target——不再走新标签那条路')
  assert.ok(!/<a[^>]*id="btnMirrorOpen"/.test(html),
    '它不再是链接了（不再靠 href 跳转），应当是个按钮')
})

test('进阶设置：按钮和**整行**都要绑上（那个按钮只有 54×40，手指容易点偏）', () => {
  assert.match(html, /\$\('btnMirrorOpen'\)\.addEventListener\('click', openMirror\)/,
    '按钮上要绑')
  assert.match(html, /\$\('rowMirrorOpen'\)\.addEventListener\('click'/,
    '整行也要绑——三次失败之后不该再赌「手指正好点在按钮上」')
  assert.match(html, /\$\('mirrorClose'\)\.addEventListener\('click', closeMirror\)/,
    '关的那个按钮也要绑，否则进去出不来')
})

test('进阶设置：那一层要盖住设置抽屉，但在授权卡和门禁页**下面**', () => {
  const rule = html.match(/#mirrorView\s*\{[^}]*\}/)
  assert.ok(rule, '找不到 #mirrorView 的样式')
  const z = Number((rule[0].match(/z-index:\s*(\d+)/) || [])[1])
  assert.ok(z > 50, '要盖住设置抽屉（50）和动态小面板（70）')
  assert.ok(z < 100, '但要在门禁页（100）和授权卡（300+）下面——那两样是打断性的，永远最上面')
})

test('进阶设置：display:flex 的那一层必须补 [hidden]（作者样式表会被压住）', () => {
  assert.match(html, /#mirrorView\[hidden\]\s*\{\s*display:\s*none/,
    '写了 display: flex 就必须补 [hidden] { display: none }，'
    + '否则 hidden 压不住它（和 .sheet .version[hidden] 同一个坑）')
})

/**
 * 框底那条让位**必须写在元素所在的这份文档里**（2026-10-07 修的）。
 *
 * 它原先写在 lib/mirror.js 的 `ADAPT_CSS` 里，而那段样式是注进**被镜像的那份 HTML**
 * （框里那份文档）的；`#mirrorFrame` 是本文件（外层）的元素——两个文档，
 * 那条规则一个像素都没生效。活服务上量过：框自己的 `padding-bottom` 是 `0px`，
 * 被镜像的那份 HTML 里倒躺着一份官方界面根本没有的 `#mirrorFrame` 规则。
 *
 * 这条测试钉的是「规则在哪份文档里」，不是「规则写没写」——写错地方的那种坏法，
 * 光看代码是看不出来的。
 */
test('进阶设置：框的底部让位写在外层页上（它以前写错了文档）', () => {
  const rule = html.match(/#mirrorFrame\s*\{[^}]*\}/)
  assert.ok(rule, '找不到 #mirrorFrame 的样式')
  assert.match(rule[0], /padding-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/,
    '框底要按机型让开手势条：这条规则只能落在**元素所在的这份文档**里')
  assert.match(rule[0], /box-sizing:\s*border-box/,
    '要让开的那一条从框自己的高度里扣，不是把框整体顶出去')
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
