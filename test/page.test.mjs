/**
 * 手机页面里那套手写 markdown 渲染器的离线测试。
 *
 * page.html 是个整页模板，直接跑需要浏览器。这里把渲染相关的几个函数从模板里
 * **抠出来**求值——它们除了彼此之外没有别的依赖（`escapeHtml` 在最前面，
 * `CODE_SLOT` 夹在中间，都包含在切片范围内）。
 *
 * 锚点一旦对不上就立刻失败，不会静悄悄地变成「零个测试通过」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../lib/page.html', import.meta.url), 'utf8')

const START = 'function escapeHtml'
const END = '// 复制。navigator.clipboard'
const start = html.indexOf(START)
const end = html.indexOf(END)
assert.ok(start > 0, `在 page.html 里找不到锚点「${START}」，渲染器可能被改名了`)
assert.ok(end > start, `在 page.html 里找不到锚点「${END}」，渲染器可能被改名了`)

// eslint-disable-next-line no-new-func
const md = new Function(html.slice(start, end)
  // 渲染器拼图片地址要用 artUrl，它定义在切片范围之外（页面里在立绘那一段），
  // 所以这里补一个桩。测试关心的是「名字 → /mini/art/<名字>.webp」这个形状，
  // 不关心 token 的实际取值。若哪天 artUrl 被挪进切片，重复声明也是合法的。
  + '\nfunction artUrl(f) { return "/mini/art/" + f + ".webp?token=TEST"; }'
  // 写路径那种图片地址会带上 token（imageSrc 里读 state.token），给个桩就够。
  + '\nvar state = { token: "TEST" };'
  + '\nreturn { escapeHtml, mdInline, mdToHtml, ICON_COPY, ICON_DONE };')()

/**
 * 把 renderMinimal 单独抠出来真跑一遍。
 *
 * 用户报的现象是「发完新指令，上一步的回答整块消失，只剩正在执行」——
 * 那是渲染顺序的问题（running 分支排在最前面并 return），光看源码不容易发现，
 * 所以这里用桩把两条路径都跑出来比一比。
 *
 * 起点从 `function renderMinimal` 往前挪到了 `var scrolledReplyAt`：那个变量是
 * renderMinimal 读的「这条回答跳过顶没有」，它必须在切片里，不然函数一跑就
 * ReferenceError。锚点对不上会立刻断言失败，不会安静地退化成空测试。
 */
const RS = 'var scrolledReplyAt'
const RE = 'function renderChat'
const rs = html.indexOf(RS)
const re = html.indexOf(RE)
assert.ok(rs > 0, `在 page.html 里找不到锚点「${RS}」`)
assert.ok(re > rs, `在 page.html 里找不到锚点「${RE}」`)

function renderMinimalWith(state) {
  const replyEl = { innerHTML: '' }
  const mainEl = { classList: { remove() {} }, scrollTop: 0, scrollHeight: 0 }
  // eslint-disable-next-line no-new-func
  const build = new Function(
    'state', 'replyEl', 'mainEl', 'escapeHtml', 'mdToHtml', 'ICON_COPY', 'timeLabel',
    `${html.slice(rs, re)}\nreturn renderMinimal;`,
  )
  // build(...) 返回的是 renderMinimal 本身，还得**调用一次**才真的渲染。
  // ICON_COPY 要从真实源码里取（见上面 md 那段）——切片是从 renderMinimal 开始的，
  // 拿不到它上面定义的东西；编一个假的值就等于在测桩，不是在测页面。
  // timeLabel 同理由：它定义在切片范围之外（在「复制」那一段后面），页面里是原函数，
  // 这里给个固定桩——测试关心的是「时刻画出来了没有」，不关心它精确到几分。
  const renderMinimal = build(state, replyEl, mainEl, md.escapeHtml, md.mdToHtml, md.ICON_COPY, () => '12:00')
  renderMinimal()
  return replyEl.innerHTML
}

/**
 * 跟 renderMinimalWith 一样，但**只搭一次、可以反复调用**。
 *
 * 单帧模式的「新回答跳到顶部」是靠一个闭包变量记「这条回答跳过顶没有」的，
 * 每次重新 build 都会把它重置成 0——那样就永远测不出「同一条回答重新渲染时
 * 不该再跳」这条最关键的规则。所以这里把 renderMinimal 和它的作用域一起留住。
 */
function minimalRunner(state) {
  const replyEl = { innerHTML: '' }
  const mainEl = { classList: { remove() {} }, scrollTop: 0, scrollHeight: 0 }
  // eslint-disable-next-line no-new-func
  const build = new Function(
    'state', 'replyEl', 'mainEl', 'escapeHtml', 'mdToHtml', 'ICON_COPY', 'timeLabel',
    `${html.slice(rs, re)}\nreturn renderMinimal;`,
  )
  const renderMinimal = build(state, replyEl, mainEl, md.escapeHtml, md.mdToHtml, md.ICON_COPY, () => '12:00')
  return {
    state,
    mainEl,
    // 模拟「用户往上翻到了别处」，好验证跳顶真的把位置改回了 0。
    scrollTo(top) { mainEl.scrollTop = top },
    render() { renderMinimal() },
  }
}

/**
 * 把 renderChat 也抠出来真跑一遍：塞一段历史进去，看渲染出来的 HTML。
 * 用户报的现象是「聊天模式下自己发的指令没有复制按钮」——那是渲染时按角色分了叉，
 * 光看源码容易漏，所以这里把两种气泡都渲染出来数一数。
 */
function renderChatWith(state) {
  const replyEl = { innerHTML: '' }
  const mainEl = { classList: { remove() {} }, scrollTop: 0, scrollHeight: 0 }
  // 从 liveBlock 开始切：它排在 renderMinimal 和 renderChat 中间，两边都要用它。
  const lb = html.indexOf('function liveBlock')
  assert.ok(lb > 0, '在 page.html 里找不到 liveBlock')
  // eslint-disable-next-line no-new-func
  const build = new Function(
    'state', 'replyEl', 'mainEl', 'timeLabel',
    `${html.slice(start, end)}\n${html.slice(lb, html.indexOf('function render()'))}\nreturn renderChat;`,
  )
  build(state, replyEl, mainEl, () => '12:00')()
  return replyEl.innerHTML
}

test('聊天模式里，自己发的指令也有复制按钮', () => {
  const out = renderChatWith({
    running: false,
    history: [
      { role: 'user', text: '帮我把这段改成两列', timestamp: 1 },
      { role: 'assistant', text: '改好了。', timestamp: 2 },
    ],
  })
  assert.match(out, /data-copy="帮我把这段改成两列"/, '自己的指令也要能复制')
  assert.match(out, /data-copy="改好了。"/, 'AI 那条本来就有，别弄丢')
  const n = (out.match(/class="copy/g) || []).length
  assert.equal(n, 2, `两条气泡各一个复制按钮，实际 ${n} 个`)
})

test('指令里的引号不会把 data-copy 属性提前闭合', () => {
  const out = renderChatWith({
    running: false,
    history: [{ role: 'user', text: '他说"你好"就行', timestamp: 1 }],
  })
  assert.match(out, /data-copy="他说&quot;你好&quot;就行"/, '引号要转义成实体')
})

test('聊天模式：历史被截断时，要在内容最上面说清「这不是全部」', () => {
  // 服务端读历史有上限（会话太大只读日志尾部）。这件事**说到内容里**才算数：
  // 只把条数砍短、不吭声，用户就会以为这个会话只有这么点。
  const out = renderChatWith({
    running: false,
    history: [
      { role: 'user', text: '第一个问题', timestamp: 1 },
      { role: 'assistant', text: '第一个回答', timestamp: 2 },
    ],
    historyTruncated: true,
    historyNote: '这个会话很大，只显示最近一段（读取上限：200 条 / 16MB 窗口）',
  })
  assert.match(out, /class="history-note"/, '要有那条提示')
  assert.match(out, /只显示最近一段/, '要说清为什么不是全部')
  assert.ok(out.indexOf('history-note') < out.indexOf('第一个问题'), '提示要排在内容前面')
})

test('聊天模式：没截断就不许冒出那句提示（不许无病呻吟）', () => {
  const out = renderChatWith({
    running: false,
    history: [
      { role: 'user', text: '第一个问题', timestamp: 1 },
      { role: 'assistant', text: '第一个回答', timestamp: 2 },
    ],
    historyTruncated: false,
    historyNote: '',
  })
  assert.ok(!out.includes('history-note'), '完整的历史不该带截断提示')
})

test('聊天模式的气泡按文字收，不是固定撑满', () => {
  /**
   * 这条只能验 CSS 声明本身——气泡宽度是纯样式，渲染桩算不出真实布局。
   * 但它值得钉死，因为**这是块级元素的经典陷阱**：
   * 块级元素宽度默认「撑满容器」，只写 max-width 只是封了个顶，
   * 于是短消息（「好的」「继续」）照样撑成一个 86% 宽的大方块。
   * 2026-09-21 用户实机提的正是这个。
   */
  const css = html.slice(html.indexOf('.bubble {'), html.indexOf('.bubble.user'))
  assert.match(css, /width:\s*fit-content/, '要按内容收，不然短消息就是个大白块')
  assert.match(css, /max-width:\s*86%/, '长的还是要封顶，不然长段落会顶出屏幕')
  // 只改一边（比如只给 .bubble.user 加）的话，短的 AI 回复那边还会露出大方块。
  // 写在基类 .bubble 上，两种气泡一起生效。
  assert.ok(!/\.bubble\.(user|assistant)\s*\{[^}]*width/.test(html),
    '宽度写在基类就够了，别在子类上再各写一份——那样两边迟早不一致')
})

test('聊天模式里，指令套气泡、回答不套', () => {
  // 上一条钉的是「宽度规则写了」，这一条钉的是「规则够得着」——
  // 渲染时类名换了（比如改成 .msg.user），上一条照样绿，但界面会退回大方块。
  const out = renderChatWith({
    running: false,
    history: [
      { role: 'user', text: '好的', timestamp: 1 },
      { role: 'assistant', text: '嗯。', timestamp: 2 },
    ],
  })
  assert.match(out, /class="bubble user"/, '自己的指令要用 .bubble.user，宽度规则才够得着')
  assert.ok(!/class="bubble assistant"/.test(out),
    'AI 的回答不该再有气泡——用户要求「参考单帧模式那样」')
  assert.match(out, /class="said"/, '回答换成 .said 那一块，别再套回气泡')
})

test('先把 HTML 转义掉，模型吐出来的标签不会变成真标签', () => {
  const out = md.mdToHtml('<img src=x onerror=alert(1)>')
  assert.ok(!out.includes('<img'), `不能出现真的 img 标签：${out}`)
  assert.match(out, /&lt;img/)
})

test('script 标签同样被转义（不依赖任何白名单）', () => {
  const out = md.mdToHtml('看这个 <script>alert(1)</script> 结束')
  assert.ok(!out.includes('<script'))
  assert.match(out, /&lt;script&gt;/)
})

test('粗体、斜体、行内代码', () => {
  assert.match(md.mdToHtml('这是 **粗** 字'), /<strong>粗<\/strong>/)
  assert.match(md.mdToHtml('这是 *斜* 字'), /<em>斜<\/em>/)
  assert.match(md.mdToHtml('用 `npm test` 跑'), /<code>npm test<\/code>/)
})

test('行内代码里的星号不被当成粗体（占位符那套要真的生效）', () => {
  const out = md.mdToHtml('写 `**x**` 就是粗体')
  assert.match(out, /<code>\*\*x\*\*<\/code>/, `代码里的星号必须原样保留：${out}`)
  assert.ok(!out.includes('<strong>'), '代码里的星号不该生成 strong')
})

test('围栏代码块：内容和语言都认，并且带复制按钮', () => {
  const out = md.mdToHtml('看代码：\n```js\nconst a = **1**;\n```\n完')
  assert.match(out, /<span class="lang">js<\/span>/)
  assert.match(out, /<pre><code>const a = \*\*1\*<\/code><\/pre>|const a = \*\*1\*\*/)
  assert.ok(!out.includes('<strong>'), '代码块里的 ** 不能变成粗体')
  assert.match(out, /data-copy="/, '代码块要能一键复制')
})

test('复制按钮的 data-copy 里存的是原文，引号已转义', () => {
  const out = md.mdToHtml('```\nconst s = "hi";\n```')
  assert.ok(!/data-copy="[^"]*"[^>]*"/.test(out.replace(/data-copy="[^"]*"/, '')), '属性不能提前闭合')
  assert.match(out, /data-copy="const s = &quot;hi&quot;;"/)
})

test('标题按级别出标签', () => {
  assert.match(md.mdToHtml('# 一级'), /<h1>一级<\/h1>/)
  assert.match(md.mdToHtml('### 三级'), /<h3>三级<\/h3>/)
})

test('无序列表与有序列表', () => {
  const ul = md.mdToHtml('- 甲\n- 乙')
  assert.match(ul, /<ul><li>甲<\/li><li>乙<\/li><\/ul>/)
  const ol = md.mdToHtml('1. 一\n2. 二')
  assert.match(ol, /<ol><li>一<\/li><li>二<\/li><\/ol>/)
})

test('引用与分隔线', () => {
  assert.match(md.mdToHtml('> 引用一句'), /<blockquote>.*引用一句.*<\/blockquote>/s)
  assert.match(md.mdToHtml('---'), /<hr>/)
})

test('表格', () => {
  const out = md.mdToHtml('| 名 | 值 |\n|---|---|\n| a | 1 |')
  assert.match(out, /<table>/)
  assert.match(out, /<th>名<\/th>/)
  assert.match(out, /<td>a<\/td>/)
})

test('链接：markdown 写法与裸网址都变可点的 a 标签', () => {
  assert.match(md.mdToHtml('[点我](https://a.example/x)'),
    /<a href="https:\/\/a\.example\/x"[^>]*>点我<\/a>/)
  assert.match(md.mdToHtml('见 https://b.example/y 这里'),
    /<a href="https:\/\/b\.example\/y"[^>]*>/)
})

test('图片：本机名字和外链都认，且不给注入留口子', () => {
  // ① 一个名字（带不带 .webp 都行）→ 走本机图片通道，和立绘同一条路、同样带 token。
  assert.match(md.mdToHtml('![深色](out-demo)'),
    /<img class="md-img" src="\/mini\/art\/out-demo\.webp\?token=/)
  assert.match(md.mdToHtml('![深色](out-demo.webp)'),
    /src="\/mini\/art\/out-demo\.webp\?token=/)
  // ①b 写成 lib/art/out-demo.webp 这种带前缀的也认——2026-09-28 助手在正文里就是这么写的，
  //    手机上成了破图标，用户第三次为此来问。写法不该这么脆。
  assert.match(md.mdToHtml('![深色](lib/art/out-demo.webp)'),
    /src="\/mini\/art\/out-demo\.webp\?token=/)
  assert.match(md.mdToHtml('![深色](./lib/art/out-demo.webp)'),
    /src="\/mini\/art\/out-demo\.webp\?token=/)
  // ①c 直接写一张图在电脑上的位置（相对项目根，或者 Windows 绝对路径）→ 走 ?p=，
  //    PNG/JPG 也行，不要求先把图拷进 lib/art。
  assert.match(md.mdToHtml('![截图](dsh-image-gen/a.png)'),
    /src="\/mini\/art\/\?p=dsh-image-gen%2Fa\.png&token=TEST"/)
  assert.match(md.mdToHtml('![截图](C:\\Users\\me\\shot.png)'),
    /src="\/mini\/art\/\?p=C%3A%5CUsers%5Cme%5Cshot\.png&token=TEST"/)
  // ② 完整 http(s) 链接原样用，手机直接去那个网站取。
  assert.match(md.mdToHtml('![图](https://a.example/x.png)'),
    /src="https:\/\/a\.example\/x\.png"/)
  // ③ 不是 http(s) 的一律当本机名字，所以 `javascript:` 这类进不了 src——
  //    它只会被拼成 /mini/art/javascript:...webp 这么一个同源路径。
  const out = md.mdToHtml('![x](javascript:alert(1))')
  assert.match(out, /src="\/mini\/art\//)
  assert.doesNotMatch(out, /src="javascript:/)
  // ④ 图片规则必须排在链接规则前面。晚一步的话，`![x](y)` 里的 `[x](y)`
  //    会先被链接规则吃掉，页面上只剩一个光秃秃的感叹号。
  const body = html.slice(html.indexOf('function mdInline'), html.indexOf('function codeBlock'))
  assert.ok(body.indexOf('md-img') < body.indexOf('<a href='), '图片规则要排在链接规则前面')
})

test('认不出来的语法原样留着，绝不吞内容', () => {
  const src = '普通一行\n\n~~删除线~~ 和 @@乱写@@'
  const out = md.mdToHtml(src)
  assert.match(out, /普通一行/)
  assert.match(out, /~~删除线~~/, '不支持的语法要原样显示，而不是消失')
  assert.match(out, /@@乱写@@/)
})

test('段落里的单个换行变成 <br>，空行才分段', () => {
  const out = md.mdToHtml('第一行\n第二行\n\n另起一段')
  assert.match(out, /第一行<br>第二行/)
  assert.equal((out.match(/<p>/g) || []).length, 2, '空行才切段')
})

test('空输入不炸', () => {
  assert.equal(md.mdToHtml(''), '')
  assert.equal(md.mdToHtml('\n\n'), '')
})

test('未闭合的围栏代码块不会吃掉后面的内容或死循环', () => {
  const out = md.mdToHtml('```js\nconst a = 1;')
  assert.match(out, /const a = 1;/)
})

// ---------------------------------------------------------------------------
// 整页脚本的语法
// ---------------------------------------------------------------------------

test('page.html 里的脚本能通过解析（改坏了要立刻发现）', () => {
  // 页面里**故意有不止一块**脚本：<head> 里那一小块要在首屏之前定好主题，
  // 不能等到页面底部的主体脚本。所以这里逐块解析，而不是"只取一块"。
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.ok(blocks.length >= 2, '该有两块脚本：首屏主题那块 + 主体那块')
  assert.ok(blocks.join('').length > 1000, '抽出来的脚本太短了，正则可能没匹配对')
  // 只解析不执行：脚本顶层就要摸 DOM，这里要的只是「语法没过」这件事。
  for (const body of blocks) {
    assert.doesNotThrow(() => new Function(body), '页面脚本有语法错误')
  }
})

test('页面里该有的元素都在（改了 id 要同步改这里）', () => {
  const ids = ['reply', 'input', 'btnSend', 'btnSettings', 'toast',
    'btnNav', 'nav', 'navBody', 'btnNavClose', 'btnNavRefresh']
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `页面里少了 id="${id}"`)
  }
})

test('会话切换只在导航栏里，设置里不再有那一项', () => {
  assert.ok(!html.includes('selSession'), '设置里的下拉框应该已经拿掉了')
  assert.ok(!html.includes('renderSessionPicker'))
  assert.ok(html.includes('遥控的会话') === false, '设置里不该再出现「遥控的会话」这一行')
})

test('导航栏先列工作区、展开才取会话（本机有 452 个会话的工作区）', () => {
  assert.match(html, /\/mini\/api\/workspaces'/, '要有列工作区的接口调用')
  assert.match(html, /\/sessions'\)/, '展开时才去取该工作区的会话')
})

test('没有标题的会话用日期兜底，不是 id 前 8 位', () => {
  // 本机真有一个会话 id 是 session-80fd8f3c-…，slice(0,8) 正好等于 "session-"
  assert.ok(!/id\.slice\(0,\s*8\)/.test(html), '不能再拿 id 前 8 位当名字')
  assert.match(html, /dayLabel\(s\.createdAt\)/, '没有标题就显示日期')
})

test('复制按钮的处理器用事件委托，不是逐个绑定', () => {
  // 回复区每次整块重绘，逐个绑会漏；这条钉住实现方式，防止以后被改回去
  assert.match(html, /replyEl\.addEventListener\('click'/, '复制要靠回复区上的委托')
  assert.match(html, /closest\('\.copy'\)/)
})

test('复制有 execCommand 退路（明文 HTTP 下 navigator.clipboard 是 undefined）', () => {
  assert.match(html, /execCommand\('copy'\)/, '没有退路的话，局域网 HTTP 下复制会静默失败')
})

/**
 * 把 copyText 单独抠出来真跑一遍。
 *
 * 「点一下变对勾，过会儿自己变回来」是用户明确要的反馈。光看源码看不出它会不会
 * 卡在对勾上——尤其连点的时候：后一个定时器会被前一个提前触发，图标在对勾和
 * 复制之间闪，或者干脆不回来。所以这里把 navigator 和定时器都换成桩，手动推时间。
 */
const CS = 'function copyText'
const CE = 'function timeLabel'
const cs = html.indexOf(CS)
const ce = html.indexOf(CE)
assert.ok(cs > 0, `在 page.html 里找不到锚点「${CS}」`)
assert.ok(ce > cs, `在 page.html 里找不到锚点「${CE}」`)

function makeCopyBtn() {
  const cls = new Set()
  return {
    innerHTML: '',
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      has: (c) => cls.has(c),
    },
  }
}

function buildCopyText({ clipboard = true } = {}) {
  const timers = []
  const toasts = []
  const sandbox = {
    ICON_COPY: md.ICON_COPY,
    ICON_DONE: md.ICON_DONE,
    toast: (m) => toasts.push(m),
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cancelled: false }); return timers.length },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true },
    navigator: clipboard ? { clipboard: { writeText: () => Promise.resolve() } } : {},
    document: {
      createElement: () => ({ style: {}, setAttribute() {}, select() {}, setSelectionRange() {} }),
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => false,
    },
  }
  const names = Object.keys(sandbox)
  // eslint-disable-next-line no-new-func
  const build = new Function(...names, `${html.slice(cs, ce)}\nreturn copyText;`)
  return { copyText: build(...names.map((n) => sandbox[n])), timers, toasts }
}

/** 跑掉还没被取消的定时器。 */
function runLiveTimers(timers) {
  for (const t of timers) {
    if (!t.cancelled) {
      t.cancelled = true
      t.fn()
    }
  }
}

test('点了复制，图标变成对勾', async () => {
  const { copyText } = buildCopyText()
  const btn = makeCopyBtn()
  copyText('内容', btn)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(btn.innerHTML, md.ICON_DONE, '点完要变成对勾')
  assert.ok(btn.classList.has('done'), '还要带上 done 这个类，颜色才跟着变')
})

test('过一会儿自己变回复制图标，不会一直挂着对勾', async () => {
  const { copyText, timers } = buildCopyText()
  const btn = makeCopyBtn()
  copyText('内容', btn)
  await Promise.resolve()
  await Promise.resolve()
  runLiveTimers(timers)
  assert.equal(btn.innerHTML, md.ICON_COPY, '过 1.4 秒要自己变回来')
  assert.ok(!btn.classList.has('done'))
})

test('连点两下：只留一个活着的定时器，图标不会卡在对勾上', async () => {
  const { copyText, timers } = buildCopyText()
  const btn = makeCopyBtn()
  copyText('内容', btn)
  await Promise.resolve()
  await Promise.resolve()
  copyText('内容', btn)
  await Promise.resolve()
  await Promise.resolve()
  const live = timers.filter((t) => !t.cancelled)
  assert.equal(live.length, 1, `连点之后只该剩一个活着的定时器，实际 ${live.length} 个`)
  runLiveTimers(timers)
  assert.equal(btn.innerHTML, md.ICON_COPY, '最后还是要变回来')
})

test('明文 HTTP 下没有 navigator.clipboard，失败也要说一声', async () => {
  const { copyText, toasts } = buildCopyText({ clipboard: false })
  const btn = makeCopyBtn()
  copyText('内容', btn)
  await Promise.resolve()
  assert.equal(toasts.length, 1, '复制失败要说一声，不能点下去毫无反应')
  assert.equal(btn.innerHTML, '', '没复制成功就不该给对勾')
})

test('系统通知那一行不露出来，别再被加回来', () => {
  // 2026-09-25 用户裁决：浏览器里不做这个功能了，原话「类似功能我们以后考虑做成 APP
  // 时再加，浏览器里不放了」。
  //
  // 试到底的结论：**手机锁屏会冻结后台页面**，那条实时连接跟着断掉，回复根本到不了
  // 页面，也就没人去发通知。这是手机系统的调度，网页绕不过去；service worker 也救不了
  // ——它是被事件唤醒的，没有事件它就不存在。
  //
  // **代码留着，只是不露出来**，所以这里钉的是「没有把它露出来的那行代码」，
  // 不是「这段代码不存在」。将来做 App 里的锁屏提醒，这些直接能用。
  assert.ok(/id="rowNotify"[^>]*style="display:none"/.test(html), '那一行必须是藏着的')
  // **不能直接 includes()**：那行代码是**注释掉**留着的，字符串还在文件里，一查就命中。
  // 所以按行看：凡是提到它的行，必须都是注释。
  const revealLines = html.split('\n').filter((l) => l.includes("rowNotify').style.display"))
  assert.ok(revealLines.length > 0, '那行代码应该留着（注释形式），将来做 App 用得上')
  assert.ok(revealLines.every((l) => l.trim().startsWith('//')), '别再把它露出来了')
  assert.ok(html.includes("// $('rowNotify').style.display = ''"), '留着的形式是注释')
  assert.ok(/showNotification/.test(html), '通知那段逻辑要留着，将来做 App 用得上')
  assert.ok(/window\.isSecureContext/.test(html), '它认安全上下文，这段判断也留着')
})

test('「语音输入」那一行仍然不在界面上', () => {
  // 这一条没有变。加密路通了，但语音输入要做的话，得先决定「录下的声音送到哪儿去
  // 转成文字」——那意味着给插件引进一条「你的声音要出这台电脑」的路径，而它现在
  // 完全没有这类东西。那是另一件事，还没做，所以这一行照旧撤着。
  assert.ok(!html.includes('micHint'), '语音输入那一行的元素要撤掉')
  assert.ok(!/<div class="label">语音输入<\/div>/.test(html), '界面上不该有这一行')
})

test('输入框旁边的麦克风图标已移除，而且别再被加回来', () => {
  // 2026-09-21 用户裁决。原来那个 🎤 走 SpeechRecognition，明文 HTTP 下用不了
  // （W3C bug 30176），而浏览器把它报成 not-allowed，用户看到的是「权限被拒绝」，
  // 去浏览器设置里翻也找不到能改的东西。**留着按了没用，比没有更糟。**
  //
  // 断言的是**代码形态**，不是「某个词不出现」——上面这段注释里就有那串名字，
  // 用 includes() 会被自己的注释绊倒（已经栽过两次）。
  assert.ok(!html.includes('btnMic'), '图标要拿掉，连同它的点击处理')
  assert.ok(!/window\.(webkit)?SpeechRecognition/.test(html), '别再读那个接口了')
  assert.ok(!html.includes('recognition.start'), '别再启动它')
  assert.ok(!html.includes("classList.add('rec')"), '录音时的红点样式也别留')
})

test('快照里的 running 会被用上（切会话后不能继承上一个会话的「正在执行」）', () => {
  // 用户报的现象：在导航栏切到别的会话，那个会话明明闲着也显示「正在执行」。
  // 服务端已经把 running 放进快照了，这里钉住手机端真的接住它。
  assert.match(html, /'running' in snap/, 'applySnapshot 要接住 running')
  assert.match(html, /setRunning\(snap\.running\)/)
})

test('切会话走的是绑定接口，切完由服务端广播把状态纠正过来', () => {
  assert.match(html, /\/mini\/api\/bind/)
})

test('切会话时直接用接口返回的快照渲染，不等 SSE', () => {
  // 不这样的话，切过去的一瞬间屏幕上还留着上一个会话的内容
  const i = html.indexOf('function bindSession')
  assert.ok(i > 0, '找不到 bindSession')
  const body = html.slice(i, i + 700)
  assert.match(body, /applySnapshot\(res\.state\)/, '要用响应里的快照')
})

test('快照里的 latest 和 history 会被接住（切会话后不能显示上一个会话的答案）', () => {
  // 用户报的现象：切到一个正在执行中的会话，单帧模式里显示的却是之前会话的回答。
  assert.match(html, /state\.latest = snap\.latest/)
  assert.match(html, /state\.history = snap\.history/)
})

// ---------------------------------------------------------------------------
// 单帧模式：发完新指令，上一条回答要留着
// ---------------------------------------------------------------------------

test('正在执行时，上一条回答还在', () => {
  const out = renderMinimalWith({
    running: true,
    latest: { text: '上一步的答案' },
  })
  assert.match(out, /上一步的答案/, '正在执行的时候，上一条回答不能消失')
})

test('没有上一条回答时，回复区留空，不显示空态提示', () => {
  const out = renderMinimalWith({ running: true, latest: null })
  assert.ok(!out.includes('在下面输入一条指令'), '正在执行时不该显示空态提示')
  assert.equal(out.trim(), '', '正在执行时回复区留空，执行提示交给常驻的 #work')
})

test('跑完了就只剩回答，执行提示要撤掉', () => {
  const out = renderMinimalWith({ running: false, latest: { text: '这次的答案' } })
  assert.match(out, /这次的答案/)
  assert.ok(!out.includes('running-bar'), '已经跑完就不该再显示正在执行')
})

test('上一条回答的复制按钮在正在执行时也还在', () => {
  const out = renderMinimalWith({ running: true, latest: { text: '上一步的答案' } })
  assert.match(out, /data-copy="上一步的答案"/, '复制按钮不能跟着消失')
})

test('单帧模式：复制按钮在正文下方，不在上面', () => {
  const out = renderMinimalWith({ running: false, latest: { text: '这次的答案' } })
  const body = out.indexOf('这次的答案')
  const foot = out.indexOf('reply-foot')
  assert.ok(body > 0, '正文得在')
  assert.ok(foot > body, '复制按钮要在正文**后面**——用户要求挪到左下角，原来在上面靠右')
  assert.ok(!/reply-bar[\s\S]*copy/.test(out), '上面那条不该再放复制按钮了')
})

test('单帧模式：复制按钮是个图标按钮，不是「复制全文」四个字', () => {
  const out = renderMinimalWith({ running: false, latest: { text: '这次的答案' } })
  assert.match(out, /<svg/, '按钮里要画图标')
  // 断言的是「没有文字节点」，不是「这四个字不出现」——aria-label 里就有这四个字，
  // 用 includes() 会被自己绊倒（这个坑栽过）。
  assert.ok(!/>复制全文</.test(out), '按钮里不该再有文字了')
  assert.match(out, /aria-label="复制全文"/,
    '没了文字就得有 aria-label——读屏的人靠它知道这按钮是干什么的')
})

test('单帧模式：「已停止」还在正文上方', () => {
  // 它是给正文打的预防针（你收到的只是半句），得在读到正文之前看到；
  // 复制按钮才挪到下面去。两件事别一起搬。
  const out = renderMinimalWith({ running: false, latest: { text: '半句话', interrupted: true } })
  const tag = out.indexOf('已停止')
  const body = out.indexOf('半句话')
  assert.ok(tag > 0, '被按停的那一轮要标出来')
  assert.ok(tag < body, '「已停止」要在正文前面')
})

test('单帧模式：没被按停时不留一个空的顶栏', () => {
  const out = renderMinimalWith({ running: false, latest: { text: '完整的回答。' } })
  assert.ok(!out.includes('reply-bar'), '没内容就别留个空框在那儿')
})

test('两条都没有时显示空态提示', () => {
  const out = renderMinimalWith({ running: false, latest: null })
  assert.match(out, /在下面输入一条指令/)
})

// ---------------------------------------------------------------------------
// 「正在执行」：鲸鱼娘 + 进度条 + 气泡
// ---------------------------------------------------------------------------

test('执行提示不再拼进回复区，改由常驻的 #work 显示', () => {
  // 拼进 replyEl.innerHTML 的话，每次状态广播重绘都会把它重建一次，
  // 轮播和浮动动画会一直从头开始——所以它必须是回复区的**兄弟节点**。
  const out = renderMinimalWith({ running: true, latest: { text: '上一步的答案' } })
  assert.ok(!out.includes('running-bar'), '不该再有内联的执行提示块')
  assert.ok(!out.includes('work-stage'), '鲸鱼娘也不该被拼进回复区')
})

test('#work 排在 #reply 后面，所以执行提示天然在回答下面', () => {
  const main = html.slice(html.indexOf('<main id="main">'), html.indexOf('</main>'))
  const replyAt = main.indexOf('id="reply"')
  const workAt = main.indexOf('id="work"')
  assert.ok(replyAt > 0, '找不到 #reply')
  assert.ok(workAt > replyAt, '#work 要排在 #reply 后面，执行提示才在回答下面')
})

test('#work 里有立绘位、气泡、进度条和秒数', () => {
  const main = html.slice(html.indexOf('<main id="main">'), html.indexOf('</main>'))
  for (const id of ['workStage', 'workBubble', 'workElapsed']) {
    assert.ok(main.includes(`id="${id}"`), `#work 里缺少 id="${id}"`)
  }
  assert.match(main, /class="work-progress"/, '进度条要在')
  assert.match(main, /id="work"[^>]*hidden/, '默认是藏着的，跑起来才显示')
})

test('每个姿态要么有词条、要么明确不带（不配气泡那种）', () => {
  const block = html.slice(html.indexOf('var POSES = ['), html.indexOf('var POSE_MS'))
  const files = block.match(/file: '[a-z0-9-]+'/g) || []
  // line 允许是空串——用户 2026-09-22 要的那张冲刺就指定不带词条，
  // 空串会让整个气泡收起来。**但不许漏写 line 这个字段**：漏了就是 undefined，
  // paintPose 里 `|| ''` 会把它当空串，于是静默地不显示气泡——
  // 那不是「故意不带」，是忘了写，两者在页面上长得一样，在代码里必须能分开。
  const lines = block.match(/line: '[^']*'/g) || []
  assert.equal(files.length, 8, '姿态数应该是 8')
  assert.equal(lines.length, files.length, '每个姿态都要有 line 字段，空也要写出来')
  // 姿态文件必须各不相同，否则轮播会出现两张一样的
  assert.equal(new Set(files).size, files.length, '姿态文件名不能重复')
})

test('「还在忙」那句只在跑够久之后才进轮播', () => {
  // 前 6 个是常规轮播，第 7 个（waiting）要等 SLOW_MS。它说的是实话——
  // 任务没跑够久就说「还在忙」是在卖惨，不是在报实情。
  const block = html.slice(html.indexOf('var POSES = ['), html.indexOf('function paintPose'))
  assert.match(block, /SLOW_MS = 60000/, '阈值应该是 60 秒')
  assert.match(html, /Date\.now\(\) - work\.startedAt >= SLOW_MS \? POSES\.length : POSES\.length - 1/,
    'posePool 要按跑了多久决定放几条进来')
})

test('每个姿势是两帧雪碧图，靠 background-position 硬切翻帧', () => {
  const css = html.slice(html.indexOf('.work-stage'), html.indexOf('.work-bubble'))
  assert.match(css, /background-size:\s*244px 106px/, '两帧并排后的显示宽度要是 122×2')
  assert.match(css, /@keyframes poseFlip/)
  assert.match(css, /background-position:\s*-122px 0/, '第二帧靠左移一帧宽')
  assert.match(css, /animation-timing-function:\s*step-end/,
    '要硬切——用插值的话会看到两张图横向滑过去')
  assert.ok(!/\.work-stage img/.test(css), '立绘已经不是 <img> 了，别留旧样式')
})

test('没轮到的那层停着不动，设了「减少动态效果」的人全停', () => {
  assert.match(html, /animation-play-state:\s*paused/, '不显示的层不该继续烧 CPU')
  assert.match(html, /\.pose\.on \{[^}]*animation-play-state:\s*running/,
    '轮到的那层才跑')
  const rm = html.slice(html.indexOf('@media (prefers-reduced-motion: reduce)'))
  assert.match(rm, /\.pose \{ animation: none/, '减少动态效果时连翻帧都要停')
})

/**
 * 读 WebP 的画布尺寸。
 *
 * 只为一件事：核对「页面上写的帧数」和「图里真并排了几帧」对不对得上。
 * 立绘是雪碧图，页面的显示宽度是按帧数算出来的——图多一帧少一帧，人就会缺半张或
 * 多出隔壁那帧的一条。这种错光看源码看不出来，必须落到文件本身。
 */
function webpSize(buf) {
  assert.equal(buf.subarray(0, 4).toString('latin1'), 'RIFF', '不是 WebP：缺 RIFF')
  assert.equal(buf.subarray(8, 12).toString('latin1'), 'WEBP', '不是 WebP：缺 WEBP')
  let off = 12
  while (off + 8 <= buf.length) {
    const tag = buf.toString('latin1', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    // 带透明通道的图走 VP8X，画布尺寸在它自己的头里：1 字节标志 + 3 字节保留，
    // 接着 24 位小端的「宽-1」「高-1」。
    if (tag === 'VP8X') {
      const p = off + 8
      return {
        w: 1 + (buf[p + 4] | (buf[p + 5] << 8) | (buf[p + 6] << 16)),
        h: 1 + (buf[p + 7] | (buf[p + 8] << 8) | (buf[p + 9] << 16)),
      }
    }
    // 不带透明通道的走 VP8（有损），尺寸在帧头里（14 位）。
    if (tag === 'VP8 ') {
      return { w: buf.readUInt16LE(off + 14) & 0x3fff, h: buf.readUInt16LE(off + 16) & 0x3fff }
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('WebP 里找不到尺寸块')
}

test('帧数写在数据里，缺省 2 帧；冲刺和跑是 6 帧', () => {
  // 冲刺（work-8-sprinting）从 2026-09-29 起是 6 帧：那一趟头发是拿冻结基准帧当底、
  // 用位移场程序化算出来的（tools/whale-sway.py），身体逐像素不动。
  // 跑（work-6-running）从 2026-09-28 起也是 6 帧，同一套两步：先把两帧画出来的头发摆动收小
  // （重画，甩幅 155.3 → 70.6），再用同一个工具把这一趟切成六帧补上流动（甩幅 74.9）。
  // 别的六个姿势仍是两帧，**缺省值就是 2**，所以它们一个字段都不用写。
  const block = html.slice(html.indexOf('var POSES = ['), html.indexOf('var POSE_MS'))
  const written = block.match(/frames:\s*\d+/g) || []
  assert.equal(written.length, 2, '只有冲刺和跑该写 frames，别的姿势吃缺省')
  assert.match(block, /file: 'work-8-sprinting'[^}]*frames:\s*6/, '冲刺写 6 帧')
  assert.match(block, /file: 'work-6-running'[^}]*frames:\s*6/, '跑写 6 帧')
  // 说话那张不进 POSES，也是两帧，不许悄悄写成别的
  assert.match(html, /var SPEAK_POSE = \{ file: 'work-9-talking', flip: 1\.1 \}/,
    '说话那张保持两帧')
})

test('帧数只驱动两处：显示宽度和用哪套翻帧关键帧', () => {
  const css = html.slice(html.indexOf('.work-stage'), html.indexOf('.work-bubble'))
  assert.match(css, /\.pose\[data-frames="6"\]\s*\{[^}]*background-size:\s*732px 106px/,
    '6 帧并排的显示宽度是 122×6')
  assert.match(css, /\.pose\[data-frames="6"\]\s*\{[^}]*animation-name:\s*poseFlip6/,
    '6 帧要用自己那套关键帧')
  const after = css.slice(css.indexOf('@keyframes poseFlip6'))
  // 第一格是 `0 0`（没写单位），后面几格是 `-122px 0`——两种都认。
  const steps = [...after.matchAll(/background-position:\s*(-?\d+)(?:px)?\s+-?\d+(?:px)?/g)]
    .map((m) => Number(m[1]))
  assert.deepEqual(steps, [0, -122, -244, -366, -488, -610],
    'poseFlip6 要正好 6 格，每格右移一帧宽（122 像素），不能多出一格')
  // 时长**不跟着帧数放大**：一圈还是 flip 秒。多出来的帧只是把头发那一趟切得更细，
  // 腿脚换帧的快慢必须和两帧时一模一样。
  assert.match(html, /layer\.setAttribute\('data-frames', POSES\[i\]\.frames \|\| 2\)/,
    '帧数从数据里读，缺省 2')
  assert.match(html, /layer\.style\.animationDuration = POSES\[i\]\.flip \+ 's'/,
    '时长还是 flip 秒，不许乘帧数')
  assert.match(html, /speak\.setAttribute\('data-frames', SPEAK_POSE\.frames \|\| 2\)/,
    '说话那层也要按帧数挂对关键帧')
})

test('切帧的三个数必须自洽，而且和真图的画布宽度对得上', () => {
  // 三个数各写一处，谁也管不住谁：
  //   ① .work-stage 的宽 = 每格**显示**宽度（122）
  //   ② .pose[data-frames="N"] 的 background-size 宽 = 122 × N
  //   ③ @keyframes 里每一步的位移 = 122
  // 只改其中一个，窗口就会切到隔壁那一格：切少了看不出，切多了会同时露出两格。
  // 2026-09-29 真机上出过「两条腿变成四条腿」——旧页面（两格写法、244 像素宽）去切新的
  // 六格图，122 像素的窗口里挤进三个压扁的小人。所以这条测试**不拿页面里的常数互相印证**，
  // 而是把真图的画布宽度读出来一起验算（图多一格少一格、页面漏改一处，都会当场红）。
  const cell = Number(html.match(/\.work-stage \{[^}]*width:\s*(\d+)px/)[1])
  assert.ok(cell > 0, '没读到 .work-stage 的宽度')
  for (const frames of [2, 6]) {
    const name = frames === 2 ? 'poseFlip' : 'poseFlip6'
    const rule = frames === 2
      ? html.match(/\.pose \{([^}]*)\}/)[1]          // 两帧那套是默认规则，不带属性选择器
      : html.match(new RegExp(`\\.pose\\[data-frames="6"\\]\\s*\\{([^}]*)\\}`))[1]
    assert.match(rule, new RegExp(`background-size:\\s*${cell * frames}px`),
      `${frames} 帧的显示宽度必须是 ${cell}×${frames}`)
    assert.match(rule, new RegExp(`animation-name:\\s*${name}\\b`))
    const after = html.slice(html.indexOf(`@keyframes ${name} `))
    const steps = [...after.slice(0, 600)
      .matchAll(/background-position:\s*(-?\d+)(?:px)?\s+-?\d+(?:px)?/g)]
      .map((m) => Math.abs(Number(m[1])))
    const want = frames === 2 ? [0, cell] : Array.from({ length: frames }, (_, k) => cell * k)
    assert.deepEqual(steps.slice(0, want.length), want,
      `${name} 每一步的位移必须是 ${cell} 的整数倍：${want}`)
  }
  // 图里真并排几格：逐张拿「页面写的帧数」去核。冲刺与跑都是六格（2280 = 6×380），
  // 其余六张两格（760 = 2×380）。这里不再给冲刺开例外——六帧的姿势一视同仁。
  const sprint = webpSize(readFileSync(new URL('../lib/art/work-8-sprinting.webp', import.meta.url)))
  assert.equal(sprint.h, 330, '每帧高 330')
  assert.equal(sprint.w / 6, 380, `冲刺该是 6 格 × 380，实宽 ${sprint.w}`)
  const block = html.slice(html.indexOf('var POSES = ['), html.indexOf('var POSE_MS'))
  const entries = block.match(/\{ file: '[a-z0-9-]+'[^}]*\}/g) || []
  assert.equal(entries.length, 8, '姿态数应该是 8')
  for (const entry of entries) {
    const name = entry.match(/file: '([a-z0-9-]+)'/)[1]
    const frames = Number((entry.match(/frames:\s*(\d+)/) || [0, 2])[1])
    const { w, h } = webpSize(readFileSync(new URL(`../lib/art/${name}.webp`, import.meta.url)))
    assert.equal(h, 330, `${name} 每帧高 330`)
    assert.equal(w, 380 * frames,
      `${name} 声明 ${frames} 帧，图里就该并排 ${frames} 帧（宽 ${380 * frames}），实宽 ${w}`)
  }
})

test('声明的帧数、CSS 里的规则、图里的格子数，三者必须两两对上', () => {
  // 这条管的是另一类漏：`.pose[data-frames="6"]` 那套规则是**按帧数写死**的，
  // 数据里写一个没有对应规则的帧数（比如 8），属性挂上去也没有关键帧可匹配，
  // 浏览器就退回默认那套（244 像素、两格）——切出来正好是"两格图里塞六格图"的反面。
  const block = html.slice(html.indexOf('var POSES = ['), html.indexOf('var POSE_MS'))
  const entries = block.match(/\{ file: '[a-z0-9-]+'[^}]*\}/g) || []
  assert.equal(entries.length, 8, '姿态数应该是 8')
  const declared = new Set()
  for (const entry of entries) {
    const name = entry.match(/file: '([a-z0-9-]+)'/)[1]
    const frames = Number((entry.match(/frames:\s*(\d+)/) || [0, 2])[1])
    declared.add(frames)
    const { w, h } = webpSize(readFileSync(new URL(`../lib/art/${name}.webp`, import.meta.url)))
    assert.equal(h, 330, `${name} 每帧高 330`)
    assert.equal(w, 380 * frames,
      `${name} 声明 ${frames} 帧，图里就该并排 ${frames} 帧（宽 ${380 * frames}），实宽 ${w}`)
  }
  for (const frames of declared) {
    if (frames === 2) continue                    // 两帧走 .pose 默认那套
    assert.ok(html.includes(`.pose[data-frames="${frames}"]`),
      `数据里声明了 ${frames} 帧，就必须有 .pose[data-frames="${frames}"] 那套规则`)
    assert.ok(html.includes(`@keyframes poseFlip${frames}`),
      `${frames} 帧要有自己的关键帧 poseFlip${frames}`)
  }
  // 反过来：CSS 里备着的那套规则，数据里也得真有人用（否则是没人管的死规则）
  for (const m of html.matchAll(/\.pose\[data-frames="(\d+)"\]/g)) {
    assert.ok(declared.has(Number(m[1])), `CSS 里有 ${m[1]} 帧的规则，却没有姿势声明 ${m[1]} 帧`)
  }
})

test('服务器构建号变了，页面要自己刷一次（不然会拿旧规则切新图）', async () => {
  // 见 lib/page.html 里 watchBuild 的注释：页面是启动时读进内存发的，立绘是每次现读盘的，
  // 这两件事不同步时，旧页面会把新图切成好几个小人（真机上表现为「四条腿」）。
  const from = html.indexOf('  function watchBuild() {')
  const to = html.indexOf('  // 复制按钮：')
  assert.ok(from > 0 && to > from, '没切到 watchBuild 那段源码')
  const make = (api, build, inputValue, token) => {
    const reloads = []
    const fn = new Function('api', 'BUILD', 'state', 'inputEl', 'location',
      `${html.slice(from, to)}\nreturn watchBuild;`)(
      api, build, { token }, { value: inputValue }, { reload: () => reloads.push(1) })
    return { fn, reloads }
  }
  const same = make(() => Promise.resolve({ build: 'abc' }), 'abc', '', 't')
  await same.fn()
  assert.equal(same.reloads.length, 0, '构建号一样就不该刷')

  const stale = make(() => Promise.resolve({ build: 'def' }), 'abc', '', 't')
  await stale.fn()
  assert.equal(stale.reloads.length, 1, '构建号变了要刷一次')

  const typing = make(() => Promise.resolve({ build: 'def' }), 'abc', '还没发出去的话', 't')
  await typing.fn()
  assert.equal(typing.reloads.length, 0, '正在打字时不能刷——不能把用户没发出去的话吞掉')

  const offline = make(() => Promise.reject(new Error('连不上')), 'abc', '', 't')
  await offline.fn()
  assert.equal(offline.reloads.length, 0, '读不到就什么都不做，别把页面弄崩')

  const noToken = make(() => { throw new Error('不该发请求') }, 'abc', '', '')
  await noToken.fn()
  assert.equal(noToken.reloads.length, 0, '没 token 时不发请求')
})

test('建出来的层上真的挂着 data-frames：冲刺 6，其余 2', () => {
  // 上面那条查的是源码里写没写对，这条查的是**跑起来之后挂在层上的值**——
  // 帧数要是没传到层上，CSS 会一直按两帧算宽度，图里六帧就只显示前两帧。
  const w = buildWhale()
  w.preloadPoses()
  const layers = w.els.workStage.children
  const got = layers.map((c) => c.getAttribute('data-frames'))
  assert.deepEqual(got, w.POSES.map((p) => String(p.frames || 2)).concat('2'),
    '每个姿势按自己的 frames 挂，说话那张（最后一层）吃缺省 2')
  const sprint = w.POSES.findIndex((p) => p.file === 'work-8-sprinting')
  assert.equal(got[sprint], '6', '冲刺那层是 6 帧')
})

test('气泡贴着自己的词条，多长就多宽', () => {
  const css = html.slice(html.indexOf('.work-bubble {'), html.indexOf('.work-bubble::before'))
  // 上一版是定宽的（min-width: min(180px, …)），短词条右边会空一大块。
  assert.ok(!/min-width/.test(css), '不该再给气泡定宽——它要自己贴住文字')
  assert.match(css, /flex:\s*0 1 auto/, '不撑满整行，也不许被撑大')
  assert.match(css, /max-width:\s*calc\(100% - 128px\)/, '窄屏退路：立绘 122 + 间隙 6')
  assert.match(css, /align-self:\s*flex-start/, '气泡要抬到头部高度，别对着身子中间')
})

test('立绘站哪儿由行宽决定，跟气泡宽窄无关', () => {
  const row = html.slice(html.indexOf('.work-top {'), html.indexOf('.work-stage {'))
  // 行宽固定成「最长那句」的整组宽度，再把这一行居中 → 立绘永远在同一个位置。
  assert.match(row, /width:\s*max-content/, '行宽跟着内容走')
  assert.match(row, /min-width:\s*min\(299px, 100%\)/, '最少要有最长那句的整组宽度')
  // 但 max-content 只有下限没有上限：再来一句更长的（自言自语就是我那几句英文思考），
  // 这行会一直撑到屏幕外，手机上得横着划才看得见（2026-09-27 用户截图报的）。
  // 气泡那条 `max-width: calc(100% - 128px)` 里的 100% 又是拿这一行自己算的，管不住它。
  assert.match(row, /max-width:\s*100%/, '行宽必须有上限：再长的词条也不能把这行顶出屏幕')
  assert.match(row, /margin:\s*0 auto/, '这一行要居中')
  // 这条是坑：行宽固定之后**又**在行内 justify-content:center，等于把这一组
  // 重新居中一次，立绘照样被气泡推着走——白忙一场。
  assert.ok(!/justify-content/.test(row), '行内不能再居中，否则立绘又被气泡推着走')
})

test('立绘地址由 artUrl 统一拼，带 token 和构建指纹', () => {
  assert.match(html, /function artUrl\(file\)/, '地址拼法要收在一个函数里')
  assert.match(html, /'\/mini\/art\/' \+ file \+ '\.webp\?token='/,
    '立绘要带 token——立绘接口和别的接口一样要鉴权')
  assert.match(html, /&v=' \+ encodeURIComponent\(BUILD\)/,
    '要带构建指纹，否则换了图浏览器会一直用缓存那张')
  const uses = html.match(/artUrl\(POSES\[i\]\.file\)/g) || []
  assert.equal(uses.length, 2, `建层和预加载都要用它，实际用了 ${uses.length} 次`)
})

test('立绘在页面打开时就全部预加载', () => {
  // 不预加载的话，第一次「正在执行」会先闪一下空白再出图。
  assert.match(html, /function preloadPoses/, '要有预加载')
  assert.match(html, /preloadPoses\(\);\s*\n\s*connect\(\);/, '启动时要先预加载再连')
  assert.match(html, /preloadPoses\(\);\s*\n\s*connect\(\);\s*\n\s*\}\)\s*\n\s*\.catch/,
    '从门禁页手输 token 进来的人也要预加载——立绘地址是拿 state.token 拼的')
})

test('系统里设了「减少动态效果」就不轮播、不浮动', () => {
  assert.match(html, /prefers-reduced-motion: reduce/, 'CSS 要有这条媒体查询')
  assert.match(html, /reducedMotion = window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)/,
    'JS 也要认这条设置')
  assert.match(html, /if \(reducedMotion\) return;/, '认了就要真的停下轮播')
})

test('进度条是不确定进度，不谎报百分比', () => {
  // 插件按设计拿不到 Agent 跑到哪一步，所以只能表达「在跑」，不能表达「跑到哪了」。
  //
  // 这一条前后改过三次，钉的都是**规矩**而不是某个实现：
  //   ① 最初是一条来回扫的流光（workSweep）→ 按 UI 规格删掉（"看起来在动"的廉价套话）；
  //   ② 删完剩一根定在 38% 的静态标记 → 用户实机问「底部的进度条好像不会动」，
  //      而一根停在三成八的线，比一个会动的它更像在谎报百分比。于是：
  //   ③ 现在动的是**位置**（translateX 逐格推进），宽度写死 38% 永不改变。
  // 真正兜底的始终是最后一条：脚本从不按"跑到第几步"去改它，它就不可能谎报。
  const css = html.slice(html.indexOf('.work-progress'), html.indexOf('.work-elapsed'))
  assert.match(css, /animation:\s*barStep/, '它得动——一根停住不动的进度条，看着像卡住了')
  assert.match(css, /width:\s*38%/, '宽度是写死的常量，不许跟着时间涨')
  assert.ok(!/transition:\s*width/.test(css), '不该用宽度过渡假装进度在涨')
  // 脚本那一侧才是关键：只要没有人按"跑到第几步"去改宽度，它就不可能谎报。
  const js = html.slice(html.indexOf('function paintWork'), html.indexOf('function setStatus'))
  assert.ok(js.length > 0, '找不到 paintWork')
  assert.ok(!/work-progress|workProgress/.test(js),
    '脚本不该去改进度条的长度——那等于在说"跑到哪了"，而插件根本不知道')
})

test('气泡词条里不出现假进度话术', () => {
  const block = html.slice(html.indexOf('var POSES = ['), html.indexOf('var POSE_MS'))
  assert.ok(!/\d+\s*%/.test(block), '词条里不该出现百分比')
  assert.ok(!/马上就好|立刻完成|就差一点/.test(block), '不该许下兑现不了的承诺')
})

test('发指令时不再把上一条回答清掉', () => {
  // 原来 send() 里有 `state.latest = null`，配合渲染顺序就是用户看到的那个现象。
  const sendStart = html.indexOf('function send()')
  assert.ok(sendStart > 0, '找不到 send()')
  const sendBody = html.slice(sendStart, sendStart + 900)
  assert.ok(!/state\.latest\s*=\s*null/.test(sendBody),
    'send() 不该再把 latest 清成 null')
})

// ---------------------------------------------------------------------------
// 鲸鱼娘那套逻辑：抠出来真跑，不是拿正则去匹配源码
// ---------------------------------------------------------------------------

const WS = 'var POSES = ['
const WE = '// ---------------- 渲染 ----------------'
const ws = html.indexOf(WS)
const we = html.indexOf(WE)

// 气泡和回答区共用页面里那套行内 Markdown 渲染，而它写在切片之外（切片只从 POSES 起）。
// 这里把**真货**原样编译一份丢进鲸鱼娘测试的沙箱，不写替身——替身会跟真货慢慢分家，
// 测试就成了自我安慰（这一条是 `tasks/lessons.md` 里「假 DOM 没有排版」的同一个道理）。
const MD = (() => {
  const s = html.indexOf('function escapeHtml')
  const e = html.indexOf('function codeBlock')
  // eslint-disable-next-line no-new-func
  return new Function(`${html.slice(s, e)}\nreturn { mdInline };`)()
})()
assert.ok(ws > 0, `在 page.html 里找不到锚点「${WS}」`)
assert.ok(we > ws, `在 page.html 里找不到锚点「${WE}」`)

/** 够用的元素桩：能存 class、文本、style，也能挂监听（停止按钮要用）。 */
function makeEl(id) {
  const el = {
    id, textContent: '', src: '', children: [], hidden: false, disabled: false,
    _cls: new Set(), style: {}, _on: {}, _attrs: {},
  }
  el.classList = {
    toggle(c, on) { if (on) el._cls.add(c); else el._cls.delete(c) },
    contains: (c) => el._cls.has(c),
  }
  // 立绘那层用它告诉 CSS 该用哪套翻帧关键帧（data-frames，2026-09-29 加的）。
  // 桩里存下来，测试才能断言「挂在层上的到底是 2 还是 6」。
  el.setAttribute = (k, v) => { el._attrs[k] = String(v) }
  el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null)
  el.appendChild = (c) => { el.children.push(c); return c }
  el.addEventListener = (type, fn) => { (el._on[type] || (el._on[type] = [])).push(fn) }
  el.click = () => { for (const fn of el._on.click || []) fn() }
  // preloadPoses 靠 `stage.innerHTML = ''` 清空重来，桩也得认这一句。
  // 同时把写进去的 HTML 记下来——队列那块是整段 innerHTML 拼出来的，
  // 不记的话「拼出来的到底是什么」就无从断言了。
  let written = ''
  Object.defineProperty(el, 'innerHTML', {
    get: () => written,
    set: (v) => {
      written = v == null ? '' : String(v)
      if (!written) el.children = []
      // 真 DOM 里写 innerHTML，textContent 会跟着变（标签去掉、实体还原）。
      // 这里是那个行为的最小复刻——气泡改走 innerHTML 之后，原先断言
      // `textContent` 的那些用例才不会变成「测桩子」。
      el.textContent = htmlToText(written)
    },
  })
  return el
}

/** 把一段 HTML 还原成它显示出来的纯文字：标签去掉，实体还原。 */
function htmlToText(htmlStr) {
  return String(htmlStr)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function buildWhale({ token = 'tok', reduced = false, apiRejects = false, apiError = '' } = {}) {
  const els = {
    work: makeEl('work'),
    workStage: makeEl('workStage'),
    workBubble: makeEl('workBubble'),
    workElapsed: makeEl('workElapsed'),
    btnStop: makeEl('btnStop'),
    queue: makeEl('queue'),
    btnSend: makeEl('btnSend'),
    input: makeEl('input'),
    // 答题卡片的元素（2026-09-25 新增）。真页面上它们永远在，这里补上同样的替身，
    // 否则卡片的接线代码在测试里会拿到空、`addEventListener` 当场报错。
    askCard: makeEl('askCard'),
    askHead: makeEl('askHead'),
    askText: makeEl('askText'),
    askDetail: makeEl('askDetail'),
    askOpts: makeEl('askOpts'),
    askCustomWrap: makeEl('askCustomWrap'),
    askCustom: makeEl('askCustom'),
    askBack: makeEl('askBack'),
    askOwn: makeEl('askOwn'),
    askNext: makeEl('askNext'),
  }
  const created = []
  const timers = []
  const toasts = []
  const calls = []
  let clock = 0
  const sandbox = {
    state: { token },
    inputEl: els.input,
    document: {
      getElementById: (id) => els[id] ?? null,
      createElement: (tag) => { const e = makeEl(tag); created.push(e); return e },
    },
    window: { matchMedia: () => ({ matches: reduced }) },
    BUILD: 'abc123',
    encodeURIComponent,
    // 气泡写进 innerHTML，得先过一遍真的行内 Markdown 渲染（含"先转义、再上标签"）。
    mdInline: MD.mdInline,
    // paintQueue 拼队列那几行时要转义指令文本——那也是用户自己敲的字，一样不能当 HTML。
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    )),
    Date: { now: () => clock },
    setInterval: (fn, ms) => ({ fn, ms }),
    clearInterval: () => {},
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) },
    toast: (m) => toasts.push(m),
    api: (path, opts) => {
      calls.push({ path, opts })
      if (apiRejects) return Promise.reject(new Error('停不下来'))
      // apiError 模拟服务端**说得出理由**的拒绝（{ status, message }）：
      // 答题那一头靠 status 409 区分「这题已经交回电脑了」和「压根没发出去」。
      if (apiError) {
        const e = new Error(apiError.message || '出错')
        e.status = apiError.status || 500
        return Promise.reject(e)
      }
      return Promise.resolve({ ok: true })
    },
    $: (id) => els[id],
  }
  const names = ['POSES', 'state', 'work', 'posePool', 'poseSequence', 'paintPose', 'elapsedLabel',
    'artUrl', 'preloadPoses', 'startWork', 'stopWork', 'nextPose', 'paintWork', 'paintStop', 'requestStop',
    'paintQueue', 'requestUnqueue', 'SPEAK_POSE', 'SPEAK_MAX_MS', 'speakDuration', 'paintSpeak', 'maybeSpeak', 'sendAnswer']
  // eslint-disable-next-line no-new-func
  const build = new Function(
    ...Object.keys(sandbox),
    `${html.slice(ws, we)}\nreturn { ${names.join(', ')} };`,
  )
  const api = build(...Object.values(sandbox))
  return {
    ...api, els, created, timers, toasts, calls,
    setClock: (v) => { clock = v },
  }
}

test('每个立绘都建了层，地址带着 token 和构建指纹', () => {
  const w = buildWhale({ token: 'abc def' })
  w.preloadPoses()
  const n = w.POSES.length
  // **比姿势多一层**：2026-09-26 加的「自言自语」那张（SPEAK_POSE）不在 POSES 里
  // ——它不占轮播的格子，只在有台词时插播一下，所以是单独一层。
  assert.equal(w.els.workStage.children.length, n + 1, `${n} 个姿势各一层，外加说话那张`)
  assert.equal(w.els.workStage.children[0].style.backgroundImage,
    'url("/mini/art/work-1-ready.webp?token=abc%20def&v=abc123")',
    'token 要转义，指纹要带上')
  // #work 是 hidden，浏览器不会为它下载背景图，所以必须另有游离的 <img> 主动拉
  const warmed = w.created.filter((e) => e.id === 'img')
  assert.equal(warmed.length, n + 1, '每一张都要主动预加载，不然第一次会闪空白')
  assert.equal(warmed[0].src, '/mini/art/work-1-ready.webp?token=abc%20def&v=abc123')
})

test('每个姿势的翻帧速度不一样，快的快、慢的慢', () => {
  // 敲键盘和小跑要快，端着茶等和托腮想事情要慢。一刀切的节奏看着像机器在闪。
  const w = buildWhale()
  w.preloadPoses()
  // 最后一层是说话那张，它不参与轮播，单独看它自己的翻帧速度。
  const dur = w.els.workStage.children.slice(0, w.POSES.length)
    .map((c) => parseFloat(c.style.animationDuration))
  assert.deepEqual(dur, w.POSES.map((p) => p.flip), '动画时长要跟着 POSES 里的 flip 走')
  assert.ok(dur.every((d) => d > 0.2 && d < 3), `时长要落在合理区间，实际 ${dur}`)
  const speakFlip = parseFloat(
    w.els.workStage.children[w.POSES.length].style.animationDuration)
  assert.ok(speakFlip > 0.2 && speakFlip < 3, `说话那张的翻帧也要落在同一区间，实际 ${speakFlip}`)
  const typing = w.POSES.findIndex((p) => p.file === 'work-3-typing')
  const waiting = w.POSES.findIndex((p) => p.file === 'work-7-waiting')
  assert.ok(dur[typing] < dur[waiting], '敲键盘该比端着茶快')
})

test('paintPose 只点亮一层，并把气泡换成对应词条', () => {
  const w = buildWhale()
  w.preloadPoses()
  w.paintPose(2)
  const on = w.els.workStage.children.filter((c) => c.classList.contains('on'))
  assert.equal(on.length, 1, '同一时刻只能亮一层，否则会重影')
  assert.equal(w.els.workBubble.textContent, '正在写…')
  const waiting = w.POSES.findIndex((p) => p.file === 'work-7-waiting')
  w.paintPose(waiting)
  assert.equal(w.els.workBubble.textContent, '还在忙，再等我一会儿')
})

test('「还在忙」要等跑满一分钟才进轮播', () => {
  const w = buildWhale()
  const n = w.POSES.length
  w.work.startedAt = 1000
  w.setClock(1000 + 59000)
  assert.equal(w.posePool(), n - 1, '不到 60 秒不该轮到「还在忙」')
  w.setClock(1000 + 60000)
  assert.equal(w.posePool(), n, '满 60 秒之后才把它放进来')
})

test('startWork 是幂等的：状态广播来十次也不会把姿态拨回第一张', () => {
  // 这个真的踩过：running 的状态推送很密，每次重置的话轮播会永远停在第 1 张。
  const w = buildWhale()
  w.setClock(5000)
  w.startWork()
  const startedAt = w.work.startedAt
  w.work.pose = 3
  w.setClock(9000)
  w.startWork()
  assert.equal(w.work.startedAt, startedAt, '已经在跑就不该重置起点')
  assert.equal(w.work.pose, 3, '也不该把姿态拨回去')
})

test('stopWork 把起点和两个定时器都清掉', () => {
  const w = buildWhale()
  w.setClock(5000)
  w.startWork()
  assert.ok(w.work.startedAt > 0, 'startWork 之后应该在跑')
  assert.ok(w.work.poseTimer && w.work.tickTimer, '两个定时器都要起')
  w.stopWork()
  assert.equal(w.work.startedAt, 0)
  assert.equal(w.work.poseTimer, null)
  assert.equal(w.work.tickTimer, null)
})

test('系统里设了「减少动态效果」就不起轮播，但秒数照常走', () => {
  const w = buildWhale({ reduced: true })
  w.setClock(5000)
  w.startWork()
  assert.equal(w.work.poseTimer, null, '不该起轮播定时器')
  assert.ok(w.work.tickTimer, '秒数是信息不是装饰，要照常走')
})

test('秒数到 60 进位成分', () => {
  const w = buildWhale()
  assert.equal(w.elapsedLabel(0), '已 0 秒')
  assert.equal(w.elapsedLabel(12500), '已 12 秒')
  assert.equal(w.elapsedLabel(59000), '已 59 秒')
  assert.equal(w.elapsedLabel(60000), '已 1 分 0 秒')
  assert.equal(w.elapsedLabel(125000), '已 2 分 5 秒')
  // 时钟回拨或者快照带了个未来时间，不该显示成「已 -3 秒」
  assert.equal(w.elapsedLabel(-3000), '已 0 秒')
})

test('paintWork 跟着 running 显隐', () => {
  const w = buildWhale()
  w.state.running = true
  w.paintWork()
  assert.equal(w.els.work.hidden, false, '跑起来就该露出来')
  w.state.running = false
  w.paintWork()
  assert.equal(w.els.work.hidden, true, '跑完就该收起来')
})

test('队列非空时那块东西不收起（停掉这轮、队列还没接上的那一小段）', () => {
  const w = buildWhale()
  w.state.running = false
  w.state.queued = [{ id: 'm1', text: '还在排队的一条', placement: 'next-turn' }]
  w.paintWork()
  assert.equal(w.els.work.hidden, false, '队列里还有活儿，那块不该先消失一下')
  w.state.queued = []
  w.paintWork()
  assert.equal(w.els.work.hidden, true, '队列空了才收')
})

test('流式一开始吐字，鲸鱼娘就让位——别在回答底下再挂一只', () => {
  // 用户 2026-09-22 实机提的：「当内容开始流式生成的时候，鲸鱼娘的动画就可以消失了，
  // 现在流式生成的时候，鲸鱼娘依然会在内容的下方出现。」
  const w = buildWhale()
  w.state.running = true

  w.state.live = ''
  w.paintWork()
  assert.equal(w.els.work.hidden, false, '还在跑、还没吐字——这时候鲸鱼娘该在')

  w.state.live = '正在写的这一句'
  w.paintWork()
  assert.equal(w.els.work.hidden, true, '字都开始往上冒了，那块就该让位')

  w.state.live = ''
  w.paintWork()
  assert.equal(w.els.work.hidden, false, '流式那段收工了（比如转去调工具），它还得回来')
})

test('指令气泡和回答之间的间距，比同一条消息内部更大', () => {
  // 用户 2026-09-22：「用户指令气泡和回答正文第一行之间的间距可以再留出一些，
  // 现在贴得太紧了。」原来是 10px——那是「同一条消息内部」的距离，而这里跨的是
  // 「我说的话」和「它答的话」，是更大的一个断点。
  const css = html.slice(html.indexOf('.bubble {'), html.indexOf('.bubble.user'))
  const m = css.match(/margin-bottom:\s*(\d+)px/)
  assert.ok(m, '.bubble 得有个下边距')
  assert.ok(Number(m[1]) >= 16,
    `指令和回答之间该留够，现在是 ${m[1]}px（原来 10px 太挤）`)
})

test('鲸鱼娘说的话里不许出现让人以为出事的字眼', () => {
  // 用户 2026-09-22 实机指着气泡里的「这里有点不对劲」问「这一句有问题还是什么」。
  // 那七个姿势是**纯装饰**的轮播——轮到哪张图跟 Agent 实际在干什么毫无关系。
  // 用户正在等结果，这时候冒出一句像报错的话，他会当真。
  const poses = html.slice(html.indexOf('var POSES = ['), html.indexOf('var POSE_MS'))
  const lines = [...poses.matchAll(/line:\s*'([^']*)'/g)].map((m) => m[1])
  assert.equal(lines.length, 8, '八条都要在')
  const alarming = /不对劲|出错|错误|失败|坏了|异常|有问题/
  for (const line of lines) {
    assert.ok(!alarming.test(line),
      `「${line}」会让用户以为出事了——轮播是装饰，不许报忧`)
  }
})

test('不带词条的姿势，气泡整个收起来', () => {
  // 用户 2026-09-22 要的那张冲刺动作，指定「不配说话气泡和词条」。
  // 留一个空泡泡在那儿比不放气泡更怪——那个尖角还指着她的头，像话没说出来。
  const w = buildWhale()
  w.preloadPoses()

  const sprint = w.POSES.findIndex((p) => p.line === '')
  assert.ok(sprint >= 0, '得有一个不带词条的姿势')

  w.paintPose(sprint)
  assert.equal(w.els.workBubble.hidden, true, '没词条就把气泡收起来')
  assert.equal(w.els.workBubble.textContent, '', '也别留上一次的字')

  w.paintPose(0)
  assert.equal(w.els.workBubble.hidden, false, '有词条的姿势要正常显示')
  assert.equal(w.els.workBubble.textContent, w.POSES[0].line)

  // 上面那两条只证明「把 hidden 置上了」——**它到底藏没藏住，这个假 DOM 看不出来**。
  // 所以在这里补一句 CSS 的账：hidden 会被自己那条 display 盖掉，必须显式写一条
  // （2026-09-27 用户截图报的正是这个空药丸）。静态查页面源码，不依赖浏览器。
  assert.match(html, /\.work-bubble\[hidden\]\s*\{[^}]*display:\s*none/,
    'hidden 得真能把气泡藏住：元素自己有 display，光靠 hidden 属性会被盖掉')
})

test('轮播序列是「姿势→冲刺→姿势→冲刺」，冲刺插在每一对之间', () => {
  // 用户 2026-09-22 的原话：「在所有已有动画的间隙插入，也就是第一个有词条的动画
  // 开始后，跑动的鲸鱼娘出现，然后再出现原来的第二个，表现的是她在干活的意思。」
  // 所以冲刺**不是第 8 个姿势**，是姿势之间的过渡。
  const w = buildWhale()
  w.work.startedAt = 1000
  w.setClock(1000)          // 不到 60 秒，「还在忙」还没进来
  const seq = w.poseSequence()
  const gap = w.POSES.findIndex((p) => p.gap)
  assert.ok(gap >= 0, '得有一张标记成过渡的')

  assert.equal(seq.length % 2, 0, '姿势和冲刺必须成对出现')
  for (let i = 0; i < seq.length; i += 2) {
    assert.notEqual(seq[i], gap, `第 ${i} 位该是一个带词条的姿势，不是冲刺`)
    assert.ok(w.POSES[seq[i]].line, '姿势位必须是有词条的那几张')
    assert.equal(seq[i + 1], gap, `第 ${i + 1} 位该是冲刺`)
  }
  // 姿势之间不重复、也不漏
  const posesShown = seq.filter((_, i) => i % 2 === 0)
  assert.deepEqual(posesShown, posesShown.map((_, i) => i).map((i) => posesShown[i]),
    '姿势位按原顺序排')
  assert.equal(new Set(posesShown).size, posesShown.length, '同一个姿势不该连出两次')
})

test('冲刺要停够时间，让用户看得清', () => {
  // 用户 2026-09-22 提了两次：先是「持续时间太短」（1.4 → 2.4 秒），
  // 后来又「出现时间可以再久一些」。现在和一个正常姿势一样长。
  // 这里钉住的是「别再被谁改回一闪而过」——上一版那条断言写的是「必须比姿势短」，
  // 那是被用户否掉的设计，留在这里会把错误的设计固化下来。
  const w = buildWhale()
  w.setClock(1000)
  w.startWork()
  const first = w.timers[w.timers.length - 1]
  assert.equal(first.ms, 3600, '第一个姿势停 3.6 秒')

  // 手动推着走到冲刺那一步，看它排的下一次是多久
  const gap = w.POSES.findIndex((p) => p.gap)
  w.work.pose = w.poseSequence().indexOf(gap) - 1
  w.nextPose()
  const after = w.timers[w.timers.length - 1]
  assert.equal(w.els.workBubble.hidden, true, '轮到冲刺时气泡是收起的')
  assert.equal(after.ms, 3600, '冲刺也停 3.6 秒——用户要看清这个动作')
  assert.ok(after.ms >= 2400, '不得少于上一版被嫌短的那个值')
})

// ---------------------------------------------------------------------------
// 自言自语（2026-09-26）：模型执行步骤时说的那句话，用鲸鱼娘的气泡念出来
// ---------------------------------------------------------------------------

test('一句话说多久：短句 15 秒起步，长句按字数加，30 秒封顶', () => {
  // 2026-09-27 用户问「能不能再久一些」——原来是一律 10 秒。长句从那天起会完整显示，
  // 200 字的话念 10 秒根本念不完，所以时长改成跟句子长短走。
  const w = buildWhale()
  assert.equal(w.speakDuration(''), 15000, '空的一句也给起步时长')
  assert.equal(w.speakDuration('这就去看。'), 15000, '短句：起步时长')
  assert.equal(w.speakDuration('说'.repeat(66)), 15000, '66 字刚好还是起步时长')
  assert.equal(w.speakDuration('说'.repeat(134)), 20100, '134 字按每字 0.15 秒算')
  assert.equal(w.speakDuration('说'.repeat(200)), 30000, '200 字正好到天花板')
  assert.equal(w.speakDuration('说'.repeat(400)), w.SPEAK_MAX_MS, '再长也不超过天花板')
})

test('新台词从那一刻重新计时，时长按这句自己的长短算', () => {
  const w = buildWhale()
  w.preloadPoses()
  w.setClock(1000)
  w.startWork()
  w.state.thought = { text: '我先看看这个文件。', at: 111 }
  w.maybeSpeak()
  assert.equal(w.work.speakUntil, 1000 + w.speakDuration('我先看看这个文件。'),
    '短句：起步时长（原来写死 10 秒）')
  w.setClock(5000)
  w.state.thought = { text: '说'.repeat(134), at: 222 }
  w.maybeSpeak()
  assert.equal(w.work.speakUntil, 5000 + w.speakDuration('说'.repeat(134)),
    '长句：从这一刻按这句的字数重新算')
})

test('说话那张不进 POSES，也不进轮播序列', () => {
  // 它是**按需插播**的，不是第 9 个节目。混进 POSES 就要连带改 posePool 那套
  // 「靠位置认还在忙」的写法，还要占一个轮播格子——那是另一件事。
  const w = buildWhale()
  assert.ok(!w.POSES.some((p) => p.file === w.SPEAK_POSE.file), '不该混进轮播节目单')
  assert.equal(w.POSES.length, 8, '节目单还是 8 个')
  w.work.startedAt = 1000
  w.setClock(1000)
  const seq = w.poseSequence()
  assert.ok(!seq.some((i) => w.POSES[i].file === w.SPEAK_POSE.file), '轮播序列里也不该有它')
  // 单独声明：名字必须和磁盘上的立绘对得上（这一张由 make-pose.mjs 出）
  assert.match(html, /var SPEAK_POSE = \{ file: 'work-9-talking'/, '要单独声明这一张')
})

test('台词一到就换成说话那张，气泡写下那句原话', () => {
  const w = buildWhale()
  w.preloadPoses()
  w.setClock(1000)
  w.startWork()
  w.state.thought = { text: '我先看看这个文件。', at: 111 }
  w.maybeSpeak()
  assert.ok(w.work.speakLayer.classList.contains('on'), '说话那张要亮起来')
  assert.ok(w.work.layers.every((l) => !l.classList.contains('on')), '轮播的姿势要全部让位')
  assert.equal(w.els.workBubble.hidden, false)
  assert.equal(w.els.workBubble.textContent, '我先看看这个文件。', '原话照写，不加文字也不减')
  assert.ok(w.work.speakUntil > 1000, '要说一会儿——用户选的是「一直说到它结束」，最多 10 秒')
})

test('模型吐的尖括号不会变成标签，只当字面文字', () => {
  // 台词是模型的原话，里面完全可能出现 < > 和引号。渲染那一步的顺序是"先转义、再上标签"，
  // 所以原话里的标签不能生效——换了渲染入口之后，这条保证必须原样还在。
  const w = buildWhale()
  w.preloadPoses()
  w.startWork()
  w.state.thought = { text: '<b>这行不该变粗</b>', at: 5 }
  w.maybeSpeak()
  assert.ok(!w.els.workBubble.innerHTML.includes('<b>'), '原话里的标签不许生效')
  assert.match(w.els.workBubble.innerHTML, /&lt;b&gt;/, '要原样显示成字面文字')
  assert.equal(w.els.workBubble.textContent, '<b>这行不该变粗</b>', '读出来还是那句话')
})

test('气泡里的 markdown 要渲染出来，星号不许端给用户', () => {
  // 用户 2026-09-27 报的：气泡里显示成 `**重启把连接掐断**`，星号原样摆着。
  const w = buildWhale()
  w.preloadPoses()
  w.startWork()
  w.state.thought = {
    text: '最可能是**重启把连接掐断**，跑一下 `npm test` 就知道。',
    at: 21,
  }
  w.maybeSpeak()
  assert.match(w.els.workBubble.innerHTML, /<strong>重启把连接掐断<\/strong>/, '粗体要真的变粗')
  assert.match(w.els.workBubble.innerHTML, /<code>npm test<\/code>/, '行内代码要真的变代码')
  assert.ok(!w.els.workBubble.textContent.includes('**'), '星号不许留在字面上')
  assert.ok(!w.els.workBubble.textContent.includes('`'), '反引号也不许留')
  assert.ok(w.els.workBubble.textContent.includes('重启把连接掐断'), '内容一个字不能少')
})

test('词条也走同一个渲染入口（两条路各写各的早晚会分叉）', () => {
  const w = buildWhale()
  w.preloadPoses()
  // 词条是我们自己写的、不含 markdown，之前是 textContent、台词是另一条路。
  // 现在两边都过 paintBubble：断言词条写出来的是"渲染过的那一份"。
  w.paintPose(2)
  assert.equal(w.els.workBubble.innerHTML, MD.mdInline(w.POSES[2].line))
  assert.equal(w.els.workBubble.textContent, w.POSES[2].line, '词条照旧显示成那句话')
})

test('说话那张加载不出来时：台词照说、人照轮播，不许把舞台清空', () => {
  // 立绘还没画出来的那段时间里，说话那张是 404。要是照旧把正常那几张全关掉、
  // 换上一张空的，她会当场从屏幕上消失——用户只会以为坏了。
  const w = buildWhale()
  w.preloadPoses()
  w.setClock(1000)
  w.startWork()
  // 预热用的那张 <img> 报错：真机上 404 走的就是这条路。
  const warmed = w.created.filter((e) => e.id === 'img')
  const warmSpeak = warmed[warmed.length - 1]
  assert.ok(warmSpeak.src.includes(w.SPEAK_POSE.file), '最后预热的那张就是说话立绘')
  warmSpeak.onerror()
  w.state.thought = { text: '我先看看这个文件。', at: 111 }
  w.maybeSpeak()
  assert.equal(w.els.workBubble.textContent, '我先看看这个文件。', '台词还是要说')
  assert.ok(!w.work.speakLayer.classList.contains('on'), '那张空图不能点亮')
  assert.ok(w.work.layers.some((l) => l.classList.contains('on')),
    '轮播的立绘得留在台上——她在，只是没换姿势')
})

// ---------------------------------------------------------------------------
// 答题卡片：答案要亲手交回电脑，交成了才算数
//
// 这几条钉的是同一件事：**没成事要说出来**。原来那段是按下就收卡片、失败咽着不说
// （`catch(function () {})`），于是用户看到「手机上点了、电脑上什么也没发生」
// ——2026-09-27 用户报的正是这一幕。
// ---------------------------------------------------------------------------

test('答案交回电脑：收下了 / 答晚了 / 没发出去，三种要分得开', async () => {
  // 顺利：答案原样交出去，回 'ok'。
  const ok = buildWhale()
  assert.equal(await ok.sendAnswer('q1', [{ id: 'q1', selected: ['A'] }]), 'ok')
  assert.equal(ok.calls.at(-1).path, '/mini/api/answer')
  assert.deepEqual(JSON.parse(ok.calls.at(-1).opts.body),
    { id: 'q1', answers: [{ id: 'q1', selected: ['A'] }] })

  // 答晚了：插件那边回 409「这个提问已经结束了」——得让用户去电脑上答。
  const late = buildWhale({ apiError: { status: 409, message: '这个提问已经结束了。' } })
  assert.equal(await late.sendAnswer('q1', []), 'late')

  // 压根没发出去（连不上）：卡片要留着，能再按一次。
  const failed = buildWhale({ apiError: { status: 0, message: 'Failed to fetch' } })
  assert.equal(await failed.sendAnswer('q1', []), 'failed')
})

test('答题卡片：没成事就不收卡片，而且要说一句——不能静悄悄', () => {
  // 静态钉一遍那句「别咽下去」：发不出去时不收卡片、还要有话说。
  assert.ok(!/api\('\/mini\/api\/answer'[\s\S]{0,240}\.catch\(function \(\) \{\}\)/.test(html),
    '答案发出去失败，不能一声不吭')
  assert.match(html, /if \(verdict === 'failed'\)/, '没发出去要单独一条路：卡片留着')
  assert.match(html, /没送出去，看一眼和电脑的连接/, '发不出去要明说，让人知道这一下没生效')
  assert.match(html, /这道题已经交回电脑了，去电脑上答/, '答晚了要指明去哪儿答')
})

test('同一句只说一次——快照广播来得很密', () => {
  const w = buildWhale()
  w.preloadPoses()
  w.setClock(5000)
  w.startWork()
  w.state.thought = { text: '第一句', at: 1 }
  w.maybeSpeak()
  const first = w.work.speakUntil
  w.setClock(5500)
  w.maybeSpeak()
  assert.equal(w.work.speakUntil, first, '同一条再广播十次也不该重新开始说')
  // 来了新的一句就接着往下说（「一直说到它结束」就是这个意思）
  w.state.thought = { text: '第二句', at: 2 }
  w.maybeSpeak()
  assert.equal(w.work.speakText, '第二句')
  assert.ok(w.work.speakUntil > first, '新的那句从这一刻重新算时长')
})

test('说话期间轮播停住，到点回到被打断的那一格', () => {
  const w = buildWhale()
  w.preloadPoses()
  w.setClock(1000)
  w.startWork()
  w.work.pose = 3
  w.setClock(2000)
  w.state.thought = { text: '等我一下', at: 7 }
  w.maybeSpeak()

  w.nextPose()
  assert.equal(w.work.pose, 3, '说话期间轮播不许往前走')
  assert.ok(w.work.speakLayer.classList.contains('on'), '还在这张上')

  w.setClock(2000 + w.SPEAK_MAX_MS + 1)
  w.nextPose()
  assert.equal(w.work.pose, 4, '回到被打断的那一格接着走，不是从头来')
  assert.ok(!w.work.speakLayer.classList.contains('on'), '说话那张要收掉')
  const seq = w.poseSequence()
  assert.ok(w.work.layers[seq[4]].classList.contains('on'), '画的是那一格该有的姿势')
  assert.equal(w.els.workBubble.textContent, w.POSES[seq[4]].line || '', '气泡回到那个姿势的词条')
})

test('没在跑的时候不冒台词，闲下来也要收掉', () => {
  const w = buildWhale()
  w.preloadPoses()
  w.state.running = false
  w.state.thought = { text: '这句不该在她停下之后还挂着', at: 9 }
  w.paintWork()
  assert.ok(w.els.work.hidden, '没在跑，#work 本来就是藏着的')
  assert.ok(!w.work.speakLayer.classList.contains('on'), '也不该点亮说话那张')
})

test('台词随快照进来时，paintWork 让她说——而且不能被「收到，这就去办」盖掉', () => {
  const w = buildWhale()
  w.preloadPoses()
  w.state.running = true
  w.state.thought = { text: '这就去看。', at: 12 }
  w.paintWork()
  assert.equal(w.els.work.hidden, false)
  assert.ok(w.work.speakLayer.classList.contains('on'))
  assert.equal(w.els.workBubble.textContent, '这就去看。')
  // startWork 会先画第 0 张，台词必须随后盖上去。顺序反了，用户看到的就是开场白。
  assert.ok(!w.work.layers[0].classList.contains('on'), '第 0 张要让位')
})

test('台词是长文本：一句都不能少，宁可让整页长高', () => {
  // 用户 2026-09-27 报的：一句长话在手机上被切掉半行，第四行连省略号都没有。
  // 所以这里验的正好跟原来相反——**不许限行数、不许 overflow:hidden**，
  // 唯一的边界是 max-height + 内部滚动，只兜病态长文（几屏那种）。
  const css = html.slice(html.indexOf('.work-bubble {'), html.indexOf('.work-bubble::before'))
  assert.ok(!/-webkit-line-clamp/.test(css), '限行数就会截断，用户要的是完全展现')
  assert.ok(!/overflow:\s*hidden/.test(css), 'overflow:hidden 也是截断的另一种写法')
  assert.match(css, /max-height:\s*\d+vh/, '总得有一道兜底，别让一句跑飞的长文吃掉整屏')
  assert.match(css, /overflow-y:\s*auto/, '真超过那道上限时要能滚到，而不是被切掉')
  assert.match(css, /overflow-wrap:\s*anywhere/, '长英文串、URL 不认换行，会把气泡顶宽')
  // 尖角原来钉在气泡的 50% 上，气泡一长高它就滑到立绘身子下边；现在钉在固定高度对着头。
  const tail = html.slice(html.indexOf('.work-bubble::before, .work-bubble::after'),
    html.indexOf('.work-bubble::before {'))
  assert.match(tail, /top:\s*\d+px/, '尖角要固定对着她的头，不能跟着气泡高度跑')
  assert.ok(!/top:\s*50%/.test(tail), '跟着高度跑就是长句时跑偏的根源')
  assert.match(html, /'thought' in snap/, 'applySnapshot 要接住这门新字段')
})

test('「还在忙」那张必须留在数组最后——posePool 靠位置认它', () => {
  // posePool 用的是 POSES.length - 1：跑够一分钟才把最后一张放进来。
  // 谁要是往数组末尾追加新姿势，这条规则就废了——那张会提前混进轮播。
  const w = buildWhale()
  const last = w.POSES[w.POSES.length - 1]
  assert.equal(last.file, 'work-7-waiting', '最后一张得是「还在忙」')
  assert.equal(last.line, '还在忙，再等我一会儿')
})

test('跑着的时候输入框和发送键不禁用——禁了就等于把排队这条路封死', () => {
  // setRunning 不在上面那个切片里（它在渲染段，鲸鱼娘段之外），单独切一小段出来。
  // 桩里特意给了 $ 和 inputEl：如果哪天有人把「跑着就禁用」那两行加回来，
  // 它得能真的执行、然后被下面这两条断言抓住——而不是以「变量未定义」变红。
  const els = { btnSend: { disabled: false } }
  const inputEl = { disabled: false }
  const state = { running: false }
  const rs2 = html.indexOf('function setRunning(running) {')
  const re2 = html.indexOf('function renderMinimal() {')
  assert.ok(rs2 > 0 && re2 > rs2, '找不到 setRunning 那一段的锚点')
  // eslint-disable-next-line no-new-func
  const build = new Function('state', 'updateStatusUI', 'paintWork', '$', 'inputEl',
    `${html.slice(rs2, re2)}\nreturn setRunning;`)
  const setRunning = build(state, () => {}, () => {}, (id) => els[id], inputEl)

  setRunning(true)
  assert.equal(state.running, true)
  assert.equal(els.btnSend.disabled, false, '跑着也能接着发，那条会排队')
  assert.equal(inputEl.disabled, false, '输入框也一样，不然连字都敲不进去')
})

// ---------------- 排队中的指令 ----------------

test('队列画出来：每条一句、带 id 的撤销按钮、条数写在标题里', () => {
  const w = buildWhale()
  w.state.queued = [
    { id: 'm1', text: '顺便把测试也跑一遍', placement: 'next-turn' },
    { id: 'm2', text: '先别动那个文件', placement: 'next-step' },
  ]
  w.paintQueue()
  assert.equal(w.els.queue.hidden, false)
  const out = w.els.queue.innerHTML
  assert.match(out, /排队中 2 条/, '得说清楚有几条')
  assert.match(out, /顺便把测试也跑一遍/)
  assert.match(out, /先别动那个文件/)
  assert.match(out, /data-drop="m1"/, '撤销按钮要认得出是哪一条')
  assert.match(out, /data-drop="m2"/)
})

test('队列空了就把那块收起来，不留个空框', () => {
  const w = buildWhale()
  w.state.queued = [{ id: 'm1', text: '一条', placement: 'next-turn' }]
  w.paintQueue()
  assert.equal(w.els.queue.hidden, false)

  // 2026-09-27 用户裁决：**跑着、但队列是空的，整块也不显示。**
  // 上一版这里是「只要在跑就留着」（一个金点表示"你这一轮是第 1 步"），
  // 用户实机看到的是「排队中 0 条」配一个孤零零的点，判定为噪音，撤销。
  w.state.queued = []
  w.state.running = true
  w.paintQueue()
  assert.equal(w.els.queue.hidden, true, '跑着但队列空着，不该出现')
  assert.equal(w.els.queue.innerHTML, '', '别留个空壳')
})

test('指令里的尖括号会被转义，不会当成 HTML', () => {
  const w = buildWhale()
  w.state.queued = [{ id: 'm1', text: '<img src=x onerror=alert(1)>', placement: 'next-turn' }]
  w.paintQueue()
  assert.ok(!w.els.queue.innerHTML.includes('<img'), '用户敲的字一律转义')
  assert.match(w.els.queue.innerHTML, /&lt;img/)
})

test('按撤销：拿 id 打 /mini/api/unqueue', async () => {
  const w = buildWhale()
  w.requestUnqueue('m1')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(w.calls.length, 1)
  assert.equal(w.calls[0].path, '/mini/api/unqueue')
  assert.equal(JSON.parse(w.calls[0].opts.body).id, 'm1', 'id 要真的带上，不然撤哪条都不知道')
})

test('撤销失败（多半是那条已经开跑了）：说人话，不假装撤掉了', async () => {
  const w = buildWhale({ apiRejects: true })
  w.requestUnqueue('m1')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(w.toasts.length, 1, '得给用户一句话')
  assert.match(w.toasts[0], /停不下来|撤不回来/)
})

/**
 * 发送那一段单独抠出来跑。
 *
 * 要钉的是「跑着的时候也能发」——原来 `send()` 开头有个 `|| state.running` 直接
 * return，界面上输入框还被禁用，等于把「排队」这条路整个封死。
 * 这条断言的是行为，不是源码里有没有那句话。
 */
const SS2 = '// ---------------- 发送 ----------------'
const SE2 = "$('btnSend').addEventListener('click', send)"
const s2 = html.indexOf(SS2)
const e2 = html.indexOf(SE2)
assert.ok(s2 > 0 && e2 > s2, `找不到「发送」那一段的锚点（${SS2}）`)

function buildSend({ running = false, serverSays = { ok: true }, rejects = false } = {}) {
  const input = { value: '', style: {}, scrollHeight: 40 }
  const calls = []
  const toasts = []
  const renders = []
  const runnings = []
  const scrollAtSetRunning = []
  const mainEl = { classList: { remove() {} }, scrollTop: 0, scrollHeight: 1000, clientHeight: 100 }
  const state = { running, mode: 'minimal', history: [], latest: null, uploads: [] }
  // send() 现在还要照顾附件小条。这里给每个 id 一个桩元素——够它设置 hidden/innerHTML
  // 就行，不必真去模拟 DOM。
  const els = {}
  const el = (id) => (els[id] || (els[id] = {
    hidden: false, innerHTML: '', disabled: false, value: '',
    files: null,
    classList: { toggle() {} },
    // 附件那几个按钮的接线也在这段切片里，构建时就会执行，所以要能收下监听器。
    addEventListener() {},
    click() {},
  }))
  const sandbox = {
    state, inputEl: input,
    Date: { now: () => 1700000000000 },
    unlockAudio: () => {},
    // send() 会无条件把页面拉回底部（见 lib/page.html 里那段注释），所以要给它一个 mainEl。
    mainEl,
    render: () => renders.push(state.mode),
    // 记下 setRunning 被调用的**那一刻**滚动条在哪。用来钉住顺序：必须先滚到底再
    // setRunning——setRunning 会触发渲染，而渲染里的 atBottom() 在改内容之前问，
    // 顺序反了那次渲染会判成「用户翻上去了」，刚回到底部又停在原地。
    setRunning: (v) => { state.running = v; runnings.push(v); scrollAtSetRunning.push(mainEl.scrollTop) },
    toast: (m) => toasts.push(m),
    // 附件那几条函数在切片里，它们要用到这三个。
    $: el,
    escapeHtml: md.escapeHtml,
    MAX_UPLOAD: 50 * 1024 * 1024,
    api: (path, opts) => {
      calls.push({ path, opts })
      return rejects ? Promise.reject(new Error('发不出去')) : Promise.resolve(serverSays)
    },
  }
  // eslint-disable-next-line no-new-func
  const build = new Function(...Object.keys(sandbox), `${html.slice(s2, e2)}\nreturn send;`)
  const send = build(...Object.values(sandbox))
  return { send, input, calls, toasts, renders, runnings, state, els, mainEl, scrollAtSetRunning }
}

// ---------------------------------------------------------------------------
// 上传附件
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 回答流式生成（手机这一侧）
// ---------------------------------------------------------------------------

test('正在流出来的那段：画出来，而且和最终答案画得不一样', () => {
  const out = renderMinimalWith({ latest: null, running: true, live: '写到一半' })
  assert.match(out, /class="live"/, '要有那块容器')
  assert.match(out, /写到一半/, '文字要显示出来')
  assert.ok(!out.includes('data-copy'),
    '流式当中不给复制按钮——它还会变，复制一个半句没有意义')
  assert.ok(!out.includes('reply-foot'), '没有复制按钮，也就不该有那一行')
})

test('流式那段排在上一轮回答下面，两个都在', () => {
  // 上一条回答要留着：用户得能一边看新的、一边回头看上一步得到了什么。
  const out = renderMinimalWith({ latest: { text: '上一轮的回答' }, running: true, live: '这一轮' })
  const a = out.indexOf('上一轮的回答')
  const b = out.indexOf('这一轮')
  assert.ok(a > -1, '上一条回答不能因为开始流式就消失')
  assert.ok(b > a, '新写的要排在它下面')
  assert.match(out, /data-copy/, '上一条已经落定，它的复制按钮该在')
})

test('没有东西在流的时候，那一块不出现', () => {
  const out = renderMinimalWith({ latest: { text: '上一轮的回答' }, running: false, live: '' })
  assert.ok(!out.includes('class="live"'), '空的就别画一块虚线出来')
  assert.match(out, /上一轮的回答/)
})

test('聊天模式下，正在写的那段跟在最后一条消息后面', () => {
  const out = renderChatWith({
    running: true,
    live: '正在写',
    history: [{ role: 'user', text: '你好', timestamp: 1 }],
  })
  const said = out.indexOf('你好')
  const live = out.indexOf('正在写')
  assert.ok(live > said, '要排在整串消息后面')
  assert.match(out, /class="live"/)
})

/**
 * 渲染一次，返回渲染后的滚动位置。用来盯「会不会把用户拽回底部」。
 *
 * 假 mainEl 的 scrollHeight 不会自己变，所以渲染后 scrollTop 只有三种结果：
 *   1. 被设成 scrollHeight —— 跟到底了；
 *   2. **被对齐到回答开头**（2026-09-24 之后新增的第三条路，见 renderChat 的 scrollChat）；
 *   3. 原样不动 —— 没打扰用户。
 *
 * 假 replyEl 必须能 `querySelector('.live')`，否则第 2 条会静默退化成空操作，
 * 测试就测了个寂寞。`.live` 的开头固定在 800，容器顶固定在 0。
 */
function scrollAfterRender(state, { scrollTop, scrollHeight, clientHeight }) {
  const replyEl = {
    innerHTML: '',
    querySelector(sel) {
      if (sel !== '.live') return null
      return this.innerHTML.includes('class="live"')
        ? { getBoundingClientRect: () => ({ top: 800 }) } : null
    },
  }
  const mainEl = {
    classList: { remove() {} }, scrollTop, scrollHeight, clientHeight,
    getBoundingClientRect: () => ({ top: 0 }),
  }
  const lb = html.indexOf('function liveBlock')
  // eslint-disable-next-line no-new-func
  const build = new Function(
    'state', 'replyEl', 'mainEl', 'timeLabel',
    `${html.slice(start, end)}\n${html.slice(lb, html.indexOf('function render()'))}\nreturn renderChat;`,
  )
  build(state, replyEl, mainEl, () => '12:00')()
  return mainEl.scrollTop
}

test('用户翻上去看历史时，不把他拽回底部', () => {
  // 用户 2026-09-22 实机提的：「有动画的时候手机端页面运动到上面都会自动调回底部，
  // 这种机制没必要吧。」原来每次重画都无条件滚到底，而鲸鱼娘一帧一动、流式一秒七次，
  // 于是想往上翻根本翻不动——手一松就被拽回去。
  const state = {
    running: true,
    live: '正在写',
    history: [
      { role: 'user', text: '一条指令', timestamp: 1 },
      { role: 'assistant', text: '一条回答', timestamp: 2 },
    ],
  }

  // 用户翻在上面（离底部 800px）：别动他的位置
  const up = scrollAfterRender(state, { scrollTop: 100, scrollHeight: 2000, clientHeight: 0 })
  assert.equal(up, 100, '用户翻上去看历史，不该被拽回底部')

  // 本来就在底部：**不再跟着滚到末尾，改成把回答的开头对齐到顶部**
  // （2026-09-24 用户提的「回答出现时页面应该停留在回答的开头而非末尾」）。
  // 开头在 800，容器顶在 0：1990 + 800 - 12 = 2778。
  const bottom = scrollAfterRender(state, { scrollTop: 1990, scrollHeight: 2000, clientHeight: 0 })
  assert.equal(bottom, 2778, '本来就在底部，就把回答开头拉上来（不是滚到末尾）')

  // 差几个像素（手指惯性、地址栏收起）也算在底部——48px 容差现在管的是
  // 「要不要动他」这件事：1960 + 800 - 12 = 2748。
  const near = scrollAfterRender(state, { scrollTop: 1960, scrollHeight: 2000, clientHeight: 0 })
  assert.equal(near, 2748, '差一点点也算在底部，同样把开头拉上来')
})

test('按发送时，不管翻到哪儿都立刻回到底部', () => {
  // 用户 2026-09-22 实机提的：「用户发送指令时，如果在手机端页面比较上面的位置，
  // 应该马上下滚回底部。」
  //
  // 这条和上面「翻上去看历史时不拽他」不冲突，管的是两件事：上面那条管**页面自己在动**
  // （鲸鱼娘在跳、流式在写），这条管**用户自己按了发送**——那是主动动作。
  const t = buildSend()
  t.mainEl.scrollTop = 100
  t.mainEl.scrollHeight = 1000
  t.input.value = '一条指令'
  t.send()
  assert.equal(t.mainEl.scrollTop, 1000, '按了发送就该立刻回到底部，不管当时翻在哪儿')

  // 顺序也要对：必须**先滚到底，再 setRunning**。setRunning 会触发一次渲染，而渲染里的
  // atBottom() 是在改内容之前问的——如果那时滚动条还在上面，那次渲染会判成
  // 「用户翻上去了」而停在原地，于是刚回到底部又不动了。
  assert.equal(t.scrollAtSetRunning[0], 1000,
    'setRunning 触发渲染时滚动条得已经在底部了，否则那次渲染不会跟着走')
})

test('还在排队的那条，聊天里不显示成「已发出」', () => {
  // 用户 2026-09-22 实机提的：「在轮到之前不该出现在指令气泡里，就像发出去了一样，
  // 应该轮到再发出去。」光在发送时不记账不够——DSH 的一条排队消息可能被领走一步、
  // 那一步又被驳回、于是退回队列，而「它开始跑了」的事件已经发过，聊天记录里
  // 就此留下一笔。实测抓到过同一个 id 队列和聊天两处都在。
  const queued = { id: 'q1', text: '排队的这条', placement: 'next-turn' }
  const out = renderChatWith({
    running: true,
    history: [
      { role: 'user', text: '已经跑起来的这条', id: 'done', timestamp: 1 },
      { role: 'user', text: '排队的这条', id: 'q1', timestamp: 2 },
    ],
    queued: [queued],
  })
  assert.ok(out.includes('已经跑起来的这条'), '不在队列里的指令要正常显示')
  assert.ok(!out.includes('排队的这条'),
    '队列里还有它，就说明还没轮到——不该长成一条「已发出」的气泡')

  // 它从队列里消失了，那一笔就该露出来——「轮到再发出去」
  const after = renderChatWith({
    running: true,
    history: [
      { role: 'user', text: '已经跑起来的这条', id: 'done', timestamp: 1 },
      { role: 'user', text: '排队的这条', id: 'q1', timestamp: 2 },
    ],
    queued: [],
  })
  assert.ok(after.includes('排队的这条'), '轮到了就要出现')
})

test('排队列表不许挂在鲸鱼娘那块里面——否则她隐身时它也跟着消失', () => {
  // 用户 2026-09-22 报：「排队列表现在手机端直接没出现了」。
  //
  // 原因是结构性的，不是逻辑坏了：#queue 原本是 #work 的子元素，而 #work 在回答
  // 开始流式生成时会整块 hidden（用户先前提的「内容开始流式生成的时候，鲸鱼娘的
  // 动画就可以消失了」）。父元素一藏，子元素跟着没了。
  //
  // 这个 bug 是**被流式修好之后才变明显的**：门槛从 120 降到 40 之后，回答很早就
  // 开始流式、state.live 长期有值，用户接着发指令时正好落在那个窗口里。
  //
  // 为什么用结构断言而不是跑一遍：上面的 DOM 桩里 #work 和 #queue 是两个独立的
  // 对象，**没有父子关系**，所以桩永远测不出这个 bug。真实页面里它们有——这一条
  // 必须对着 page.html 的嵌套结构来验。
  const openWork = html.indexOf('<div id="work"')
  assert.ok(openWork > 0, '在 page.html 里找不到 #work')

  // 从 #work 的开标签开始做标签配对，量出它的整段子树
  const tagRe = /<div\b|<\/div>/g
  tagRe.lastIndex = openWork
  let depth = 0
  let endWork = -1
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    depth += m[0] === '</div>' ? -1 : 1
    if (depth === 0) { endWork = m.index; break }
  }
  assert.ok(endWork > openWork, '#work 的标签没配平，先修 HTML')

  const workTree = html.slice(openWork, endWork)
  assert.ok(!workTree.includes('id="queue"'),
    '#queue 不能放在 #work 里面：回答一开始流式，#work 就被藏了，排队列表会跟着消失')

  // 反过来也要钉住：它得真的还在页面上，别在挪出来的时候弄丢了
  assert.ok(html.includes('id="queue"'), '#queue 整个不见了')
  assert.ok(html.indexOf('id="queue"') > endWork, '#queue 要放在 #work 之后，不要塞回去')
})

test('队列里只有排队的那几条时，别把空屏当成「还没有对话记录」', () => {
  // 历史被滤空了、但队列里还有东西——这时候屏幕上是有内容的（排队列表），
  // 不该盖一句「还没有对话记录」上去。
  const out = renderChatWith({
    running: true,
    history: [{ role: 'user', text: '排队的这条', id: 'q1', timestamp: 1 }],
    queued: [{ id: 'q1', text: '排队的这条', placement: 'next-turn' }],
  })
  assert.ok(!out.includes('还没有对话记录'), '有排队的东西就不算空屏')
})

test('传文件时不写 Content-Type: application/json', async () => {
  // authHeaders 原来把 JSON 的类型写死了。传文件时硬写上去，服务端收到的就是一个
  // 错的文件类型声明，而浏览器也没机会自己定——它才是知道该写什么的那一方。
  const AS = 'function authHeaders'
  const AE = '// ---------------- 声音与震动'
  const as = html.indexOf(AS)
  const ae = html.indexOf(AE)
  assert.ok(as > 0 && ae > as, `找不到锚点（${AS} / ${AE}）`)

  const seen = []
  // eslint-disable-next-line no-new-func
  const build = new Function('state', 'fetch', `${html.slice(as, ae)}\nreturn api;`)
  const api = build({ token: 'tok' }, (path, opts) => {
    seen.push(opts)
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })

  await api('/mini/api/upload', { method: 'POST', body: new Blob(['hi']) })
  assert.equal(seen[0].headers['Content-Type'], undefined,
    '文件不能声明成 JSON——那会让服务端收到一个错的类型')
  assert.equal(seen[0].headers['X-Mini-Token'], 'tok', '但 token 照样要带')

  await api('/mini/api/send', { method: 'POST', body: JSON.stringify({ text: 'x' }) })
  assert.equal(seen[1].headers['Content-Type'], 'application/json', '普通请求还是 JSON')
})

test('输入框旁边有上传按钮，文件选择器是藏起来的', () => {
  assert.match(html, /id="btnAttach"/, '要有回形针按钮')
  assert.match(html, /id="filePick"[^>]*hidden/,
    'file input 本身要藏起来——它那个系统样式没法统一，点按钮去触发它就好')
  assert.match(html, /id="attachBar"/, '附件小条也要在，发之前得看得见自己带了什么')
})

test('上传的体积上限由服务端注入，页面里不写第二份', () => {  // 两处各写一个数，迟早会不一致，而那时候的表现是「页面让你传，服务端拒绝」——
  // 最难查的那种不一致。
  assert.match(html, /var MAX_UPLOAD = __MAX_UPLOAD__;/)
  assert.ok(!/var MAX_UPLOAD = \d/.test(html), '别在页面里写死一个数')
})

test('发送时把附件的小票一起带上', async () => {
  const b = buildSend()
  b.input.value = '看看这个'
  b.state.uploads = [{ uploadId: 'u1', name: 'a.txt', bytes: 10 }]
  b.send()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(b.calls.length, 1)
  const sent = JSON.parse(b.calls[0].opts.body)
  assert.deepEqual(sent.uploadIds, ['u1'], '小票要跟着指令一起发出去')
  assert.equal(sent.text, '看看这个')
  assert.equal(b.state.uploads.length, 0, '发出去之后本地就该收起来')
})

test('只带附件、一个字不写也能发', async () => {
  const b = buildSend()
  b.input.value = ''
  b.state.uploads = [{ uploadId: 'u1', name: 'a.txt', bytes: 10 }]
  b.send()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(b.calls.length, 1, '「这份文件你看一下」本来就是常见用法')
})

test('发失败时附件还回来，不用重新传一遍', async () => {
  // 不然网络抖一下，用户刚传上去的文件就白传了——而重新选一次意味着重新传一遍。
  const b = buildSend({ rejects: true })
  b.input.value = '看看'
  b.state.uploads = [{ uploadId: 'u1', name: 'a.txt', bytes: 10 }]
  b.send()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(b.state.uploads.length, 1, '附件要还回来')
  assert.equal(b.state.uploads[0].uploadId, 'u1')
})

test('跑着的时候照样能发出去（那条会排队，不是被挡回来）', async () => {
  const b = buildSend({ running: true, serverSays: { ok: true, queued: true } })
  b.input.value = '再顺手跑一下测试'
  b.send()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(b.calls.length, 1, '原来这里因为 running 直接 return，一个请求都不会发')
  assert.equal(b.calls[0].path, '/mini/api/send')
  assert.equal(JSON.parse(b.calls[0].opts.body).text, '再顺手跑一下测试')
  assert.equal(b.input.value, '', '发出去了就把输入框清掉')
})

test('服务端说这条排队了，就给一句话；没说就不打扰', async () => {
  const queued = buildSend({ running: true, serverSays: { ok: true, queued: true } })
  queued.input.value = '排队的这条'
  queued.send()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(queued.toasts.length, 1, '得让用户知道它排上了，不然像石沉大海')
  assert.match(queued.toasts[0], /排队/)

  const direct = buildSend({ running: false, serverSays: { ok: true, queued: false } })
  direct.input.value = '马上跑'
  direct.send()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(direct.toasts.length, 0, '马上就跑的不用多一句话')
})

test('排队的那条不长成指令气泡——轮到它才该出现', async () => {
  // 用户 2026-09-22 实机提的：「排队的指令会出现在排队列表里了，但在轮到之前不该出现
  // 在指令气泡里，就像发出去了一样，应该轮到再发出去。」
  // 排队列表才是它此刻该待的地方；长成气泡就等于骗人说已经发了。
  const b = buildSend({ running: true, serverSays: { ok: true, queued: true } })
  b.state.mode = 'chat'
  b.state.history = []
  b.input.value = '排队的这条'
  b.send()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(b.calls.length, 1, '请求照发——排队是服务端说了算')
  assert.equal(b.state.history.length, 0,
    '还没轮到，聊天记录里不该有它——有了就成了一条「已发出」的气泡')

  // 对照：不排队的那条要正常回显，否则聊天模式就哑了
  const direct = buildSend({ running: false, serverSays: { ok: true, queued: false } })
  direct.state.mode = 'chat'
  direct.state.history = []
  direct.input.value = '马上跑'
  direct.send()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(direct.state.history.length, 1, '真发出去了要回显一条')
  assert.equal(direct.state.history[0].text, '马上跑')
  assert.equal(direct.state.history[0].role, 'user')
})

test('空消息不发（跑着也不发）', async () => {
  const b = buildSend({ running: true })
  b.input.value = '   '
  b.send()
  await Promise.resolve()
  assert.equal(b.calls.length, 0, '只有空白字符，不该发出去')
})

// ---------------- 停止 ----------------

test('按停止：先禁用改文案，再打 /mini/api/stop', async () => {
  const w = buildWhale()
  w.state.running = true
  w.els.btnStop.click()
  // cancel() 在服务端只是递个请求，真正停下要等状态翻。这中间必须让人看见「按到了」，
  // 否则会连按好几下——所以按钮当场就该禁用、改文案。
  assert.equal(w.els.btnStop.disabled, true, '按下去就该禁用')
  assert.equal(w.els.btnStop.textContent, '正在停…')
  assert.equal(w.calls.length, 1, '要发一次请求')
  assert.equal(w.calls[0].path, '/mini/api/stop')
  assert.equal(w.calls[0].opts.method, 'POST')
  await new Promise((r) => setImmediate(r))
  assert.equal(w.timers.length, 1, '递了请求要留一个兜底计时器')
  assert.equal(w.timers[0].ms, 10000, '十秒还没翻就把按钮放回去')
})

test('没在跑的时候，停止按钮按不动', () => {
  const w = buildWhale()
  w.state.running = false
  w.els.btnStop.click()
  assert.equal(w.calls.length, 0, '没在跑就不该发请求')
  assert.equal(w.els.btnStop.disabled, false)
})

test('停止请求失败：按钮复位，并且说人话', async () => {
  const w = buildWhale({ apiRejects: true })
  w.state.running = true
  w.els.btnStop.click()
  assert.equal(w.els.btnStop.disabled, true)
  await new Promise((r) => setImmediate(r))
  assert.equal(w.els.btnStop.disabled, false, '失败了要能再按')
  assert.equal(w.els.btnStop.textContent, '停止')
  assert.equal(w.toasts[0], '停不下来', '要把服务端的话原样带出来')
})

test('跑完之后按钮自己复位，下一轮才是干净的「停止」', async () => {
  const w = buildWhale()
  w.state.running = true
  w.els.btnStop.click()
  await new Promise((r) => setImmediate(r))
  assert.equal(w.timers.length, 1)
  // running 翻成 false → paintWork() → stopWork()
  w.state.running = false
  w.paintWork()
  assert.equal(w.els.btnStop.disabled, false)
  assert.equal(w.els.btnStop.textContent, '停止')
  // 计时器不撤的话，十秒后会凭空冒出一句「还没停下来」，而它其实早停了。
  assert.equal(w.timers.length, 0, '兜底计时器要撤掉')
})

// ---------------- 被按停的那一轮 ----------------
//
// 中止的那一轮会把「已经吐出来的半句话」当成一条 assistant/message 落下来，
// 而且**不带 tool-call 块**（dsh-session 的类型注释明说 "undispatched tool calls
// are absent"），于是它会一路通过过滤、被当成最终回答推到手机上。
// 不标出来的话，按了停止之后冒出来的半句话看着就像模型答崩了。

test('单帧模式：被按停的那一轮标出「已停止」', () => {
  const out = renderMinimalWith({
    latest: { text: '先说结论：', interrupted: true }, running: false,
  })
  assert.match(out, /已停止/, '半句话必须标出来')
  assert.match(out, /先说结论：/, '内容还是要留着的，不替用户丢东西')
  const clean = renderMinimalWith({ latest: { text: '完整的回答。' }, running: false })
  assert.ok(!/已停止/.test(clean), '正常回答不该带这个标签')
})

test('聊天模式：只标被按停的那一条', () => {
  const out = renderChatWith({
    running: false,
    history: [
      { role: 'user', text: '写个长一点的', timestamp: 1 },
      { role: 'assistant', text: '首先，', timestamp: 2, interrupted: true },
      { role: 'assistant', text: '完整的回答。', timestamp: 3 },
    ],
  })
  assert.equal((out.match(/已停止/g) || []).length, 1, '三条气泡里只有一条该被标')
  assert.match(out, /首先，/, '内容留着')
})

/**
 * 把 SSE 那一段抠出来真跑一遍，喂一条 reply 事件进去。
 *
 * 这一条是补上来的：前面两条渲染测试是**手工把 interrupted 塞进 state** 的，
 * 而实时推送（SSE）和刷新时拉完整快照（/mini/api/state）走的是**两条不同的代码路径**。
 * 只在快照那条路上带 interrupted，表现就是「刷新一下标签才出现」——
 * 测试全绿，真机是坏的。所以这里必须把事件处理器本身跑起来。
 */
const SS = '// ---------------- SSE ----------------'
const SE = '// ---------------- 发送 ----------------'
const ss = html.indexOf(SS)
const se = html.indexOf(SE)
assert.ok(ss > 0 && se > ss, `找不到 SSE 那一段的锚点（${SS}）`)

function feedReply(payload, { mode = 'minimal', history = [] } = {}) {
  const state = { token: 'tok', mode, history, connected: false, running: true }
  const els = {}
  let source = null
  class FakeEventSource {
    constructor(url) { this.url = url; this._on = {}; source = this }
    addEventListener(type, fn) { (this._on[type] || (this._on[type] = [])).push(fn) }
    close() {}
    fire(type, data) { for (const fn of this._on[type] || []) fn({ data: JSON.stringify(data) }) }
  }
  const calls = []
  // eslint-disable-next-line no-new-func
  const build = new Function(
    'state', 'EventSource', 'document', 'encodeURIComponent', '$',
    'setStatus', 'showGate', 'updateStatusUI', 'applySnapshot', 'render',
    'setRunning', 'playDing', 'buzz',
    `${html.slice(ss, se)}\nreturn connect;`,
  )
  build(
    state, FakeEventSource, { hidden: false }, encodeURIComponent,
    // 这个替身原来只造出 `{ textContent }`，够老代码用；答题卡片要在元素上
    // 挂 `addEventListener`、改 `classList`/`style`/`value`，所以把这几样补齐。
    // 真页面上这些元素本来就都有，这里只是让测试里的替身也具备同样的能力。
    (id) => (els[id] || (els[id] = {
      textContent: '', value: '', innerHTML: '', style: {},
      classList: { add() {}, remove() {}, contains: () => false },
      addEventListener() {}, appendChild() {}, focus() {},
    })),
    () => {}, () => {}, () => {}, () => {}, () => {},
    (v) => { calls.push(v); state.running = v }, () => {}, () => {},
  )()
  source.fire('reply', payload)
  return { state, calls }
}

test('SSE 实时推来的回复也要带上 interrupted（不能只有刷新才有）', () => {
  const cut = feedReply({
    text: '先说结论：这个方案', sessionId: 's1', timestamp: 7, interrupted: true,
  })
  assert.equal(cut.state.latest.interrupted, true, '实时那条也要带标记')
  assert.equal(cut.state.latest.text, '先说结论：这个方案', '内容不能丢')

  const chat = feedReply(
    { text: '首先，', sessionId: 's1', timestamp: 8, interrupted: true },
    { mode: 'chat' },
  )
  assert.equal(chat.state.history.at(-1).interrupted, true, '聊天模式追加的那条也要带')

  const ok = feedReply({ text: '完整的回答。', sessionId: 's1', timestamp: 9 })
  assert.equal(ok.state.latest.interrupted, false, '正常推送不该带标记')
  assert.equal(ok.state.history.length, 0, '单帧模式不往 history 里塞')
  assert.deepEqual(ok.calls, [false], '收到回复要把「正在执行」收掉')
})

// ---------------------------------------------------------------------------
// 左侧导航栏：在工作区里新建会话
// ---------------------------------------------------------------------------
//
// 导航栏这块原来一条行为测试都没有（只有「这些 id 存在」那种存在性检查），
// 所以「＋ 新建会话」渲染在哪儿、点了打哪个接口、连点会不会建出两个，
// 全靠肉眼看。这里把导航栏那几段从模板里切出来真跑一遍。
//
// 切片从 `var navList` 开始：navList / navSessions / navExpanded 三个模块级变量
// 就声明在那儿，renderNav 和 sessionsHtml 都要读它们，切在函数里面就找不到了。
// 锚点对不上会立刻断言失败，不会安静地退化成空测试。

function navHarness({ apiImpl } = {}) {
  const START_AT = 'var navList = null;'
  const END_AT = 'function bindSession'
  const a = html.indexOf(START_AT)
  const b = html.indexOf(END_AT)
  assert.ok(a > 0, `在 page.html 里找不到锚点「${START_AT}」`)
  assert.ok(b > a, `在 page.html 里找不到锚点「${END_AT}」`)

  const calls = []
  const toasts = []
  const applied = []
  const navCls = []
  const navBody = { innerHTML: '', querySelectorAll: () => [] }
  const state = { boundSessionId: 's-old' }

  // eslint-disable-next-line no-new-func
  const build = new Function(
    'state', 'escapeHtml', '$', 'api', 'toast', 'closeNav', 'loadWorkspaces',
    'applySnapshot', 'render',
    `${html.slice(a, b)}
     return { renderNav, sessionsHtml, createSession, toggleWorkspace,
              getSessions: () => navSessions,
              setSessions: (v) => { navSessions = v } };`,
  )
  const scope = build(
    state,
    md.escapeHtml,
    (id) => {
      if (id === 'navBody') return navBody
      // 'nav' 这个假元素要记下 classList 的增删：closeNav / openNav 都是切片里
      // **真实存在**的函数（我一开始想用桩替换它们，结果被遮住了、桩是死的），
      // 所以「导航栏收起来了没有」只能从它对 classList 的动作上看。
      return { classList: { add: (c) => navCls.push('+' + c), remove: (c) => navCls.push('-' + c), contains: () => true } }
    },
    (path, opts) => {
      calls.push({ path, opts })
      return apiImpl ? apiImpl(path, opts) : Promise.resolve({
        ok: true, sessionId: 'session-new', workspaceTitle: '极简遥控器',
        state: { boundSessionId: 'session-new' },
      })
    },
    (m) => toasts.push(m),
    // closeNav / loadWorkspaces 在切片里有真身，这两个参数用不上；留着是为了
    // 万一以后切片范围变了不至于 ReferenceError。
    () => {},
    () => {},
    (snap) => applied.push(snap),
    () => {},
  )
  return {
    scope, navBody, calls, toasts, applied, navCls, state,
    // 只数「建会话」那个请求，不数建成之后刷新列表那一次。
    creates: () => calls.filter((c) => c.path.includes('/sessions')),
  }
}

test('导航栏：「＋ 新建会话」排在会话列表最上面', () => {
  // 排末尾的话，一个 452 条会话的工作区要划到底才看得到（本机真有一个）。
  const h = navHarness()
  h.scope.setSessions({
    w1: {
      total: 2,
      truncated: false,
      sessions: [
        { id: 's1', title: '甲', createdAt: 200, running: false },
        { id: 's2', title: '乙', createdAt: 100, running: false },
      ],
    },
  })
  const out = h.scope.sessionsHtml('w1')
  const at = out.indexOf('ws-new')
  const firstSess = out.indexOf('class="sess')
  assert.ok(at >= 0, '没渲染出「新建会话」')
  assert.ok(at < firstSess, `「新建会话」要排在第一条会话前面（${at} vs ${firstSess}）`)
  assert.match(out, /data-newws="w1"/, '要带上工作区 id，不然点了不知道建在哪儿')
})

test('导航栏：一个会话都没有时，「＋ 新建会话」照样在', () => {
  const h = navHarness()
  h.scope.setSessions({ w1: { total: 0, truncated: false, sessions: [] } })
  const out = h.scope.sessionsHtml('w1')
  assert.match(out, /ws-new/)
  assert.match(out, /还没有会话/)
})

test('导航栏：点了「新建会话」打的是 POST 到那个工作区的会话路径', () => {
  const h = navHarness()
  return h.scope.createSession('w-abc').then(() => {
    const made = h.creates()
    assert.equal(made.length, 1, '应该只发一次建会话的请求')
    assert.equal(made[0].path, '/mini/api/workspaces/w-abc/sessions')
    assert.equal(made[0].opts.method, 'POST')
  })
})

test('导航栏：连点两下只建一个（建会话不是幂等的）', () => {
  // 服务端那道闸门拦不住这个：两个请求都是合法的，会真建出两个会话，
  // 而手机上什么都看不出来。必须前端自己拦。
  let release
  const gate = new Promise((r) => { release = r })
  const h = navHarness({ apiImpl: () => gate })
  const first = h.scope.createSession('w1')
  h.scope.createSession('w1')            // 第二下：闸门应该把它丢掉
  release({ ok: true, sessionId: 's1', workspaceTitle: '甲', state: {} })
  return first.then(() => {
    assert.equal(h.creates().length, 1, '第二次点击必须被丢掉')
  })
})

test('导航栏：建成后用返回的快照直接渲染，收起导航栏，并刷新列表', () => {
  // 不这么做的话，切过去的一瞬间屏幕上还留着上一个会话的正文。
  const h = navHarness()
  return h.scope.createSession('w1').then(() => {
    assert.deepEqual(h.applied, [{ boundSessionId: 'session-new' }], '要拿接口返回的快照渲染')
    assert.ok(h.navCls.includes('-open'), '建完要把导航栏收起来')
    assert.ok(
      h.calls.some((c) => c.path === '/mini/api/workspaces?refresh=1'),
      '还要刷一次列表，让新会话立刻出现（带 refresh 绕过服务端缓存）',
    )
    assert.match(h.toasts[0], /极简遥控器/, '提示里要说清建在哪个工作区')
  })
})

test('导航栏：建失败时说人话，并且按钮要能再按', () => {
  const h = navHarness({
    apiImpl: () => Promise.reject(new Error('这台电脑上的 DSH 没提供新建会话的能力。')),
  })
  return h.scope.createSession('w1').then(() => {
    assert.equal(h.toasts.length, 1)
    assert.match(h.toasts[0], /没提供新建会话的能力/)
    assert.equal(h.applied.length, 0, '失败了不该拿快照去渲染')
    // 解锁的证据：再点一次还能发出请求（不解锁的话第二次会被闸门吃掉）。
    return h.scope.createSession('w1')
  }).then(() => {
    assert.equal(h.creates().length, 2, '失败之后必须解锁，不然以后都点不动了')
  })
})

// ---------------------------------------------------------------------------
// 左侧导航栏：标题补齐按服务端说的「还剩几条」来，不再盲猜次数
// ---------------------------------------------------------------------------

/** 让挂起的 promise 落地。假时钟只接管 setTimeout / Date，setImmediate 还是真的。 */
const flushMicro = () => new Promise((resolve) => setImmediate(resolve));

/** 数「问某个工作区的会话列表」这个请求发了几次（建会话那类带 opts 的不算）。 */
function sessionAsks(haz) {
  return haz.calls.filter((c) => c.path.includes('/sessions') && !c.opts).length;
}

test('导航栏：标题补齐按服务端报的「还剩几条」接着问，归零就停', async (t) => {
  // 一个工作区里四五个冷会话实测要 19 秒才读完，而原来固定补三次（1.5/3/3 秒）——
  // 盖不住，标题就是长不出来。现在服务端说还剩几条，就问几次。
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const answers = [
    { pending: 2, sessions: [{ id: 's1', title: '', createdAt: 1 }] },
    { pending: 0, sessions: [{ id: 's1', title: '长出来的标题', createdAt: 1 }] },
  ]
  const haz = navHarness({ apiImpl: () => Promise.resolve(answers.shift()) })

  haz.scope.toggleWorkspace('w1')
  await flushMicro()
  assert.equal(sessionAsks(haz), 1, '展开就先问一次')

  t.mock.timers.tick(2500)
  await flushMicro()
  assert.equal(sessionAsks(haz), 2, '服务端说还剩 2 条没读，就该接着问')
  // 看状态而不是看渲染出来的 HTML：这个用例开着假时钟（Date 也在假的那边），
  // 而列表里那条日期会走到 timeLabel——它在切片之外，渲染会因此炸。
  assert.equal(
    haz.scope.getSessions().w1.sessions[0].title, '长出来的标题',
    '这一趟问回来的标题要落进列表状态（渲染画的就是它）',
  )

  t.mock.timers.tick(2500)
  await flushMicro()
  assert.equal(sessionAsks(haz), 2, 'pending 归零，一次都不许再问')
})

test('导航栏：一直没归零也不会问个没完（30 秒总时限兜底）', async (t) => {
  // 万一有条日志坏了、永远读不出来，不能让它一直问下去。
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const haz = navHarness({
    apiImpl: () => Promise.resolve({
      pending: 3,
      sessions: [{ id: 's1', title: '', createdAt: 1 }],
    }),
  })

  haz.scope.toggleWorkspace('w1')
  await flushMicro()
  for (let i = 0; i < 16; i += 1) {      // 走过 40 秒，早该越过总时限
    t.mock.timers.tick(2500)
    await flushMicro()
  }
  const settled = sessionAsks(haz)
  assert.ok(settled >= 6, `该追的还是要追（只追了 ${settled} 次）`)

  for (let i = 0; i < 8; i += 1) {       // 再给它 20 秒
    t.mock.timers.tick(2500)
    await flushMicro()
  }
  assert.equal(sessionAsks(haz), settled, '过了 30 秒总时限，一次都不该再问')
})

test('导航栏：服务端没给 pending 时退回数空标题（新页面配旧进程也要能追）', async (t) => {
  // 「改了要重启」会出现半新状态：页面是新读的、进程还是旧的。旧服务端不给 pending，
  // 那时就退回原来的判据（还有空标题就接着问），至少有旧行为，不会反而不追了。
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const haz = navHarness({
    apiImpl: () => Promise.resolve({ sessions: [{ id: 's1', title: '', createdAt: 1 }] }),
  })

  haz.scope.toggleWorkspace('w1')
  await flushMicro()
  assert.equal(sessionAsks(haz), 1)

  t.mock.timers.tick(2500)
  await flushMicro()
  assert.equal(sessionAsks(haz), 2, '没有 pending 字段时，退回「还有空标题就接着问」')
})

test('导航栏：会话数据被清空后，展开着的工作区要自己重新拉（不干等点击）', async () => {
  // 真机报的（2026-10-03）：从会话打开导航栏，展开的工作区停在「正在读取…」
  // 不动，收起再展开却又很快。根因是 navigation-refresh（会话开跑/收工都会广播）
  // 清空了 navSessions 却留着 navExpanded——重画时只画出占位符，而取列表的请求
  // 只在点击里发，没人发就永远停着。所以重画要自己把缺的那份补拉回来。
  const haz = navHarness({
    apiImpl: () => Promise.resolve({ pending: 0, sessions: [{ id: 's1', title: '甲', createdAt: 1 }] }),
  })

  haz.scope.toggleWorkspace('w1')            // 第一次展开：照常拉一次
  await flushMicro()
  assert.equal(sessionAsks(haz), 1, '展开要发一次请求')

  haz.scope.setSessions({})                  // 模拟 navigation-refresh 清空（展开态不动）
  haz.scope.renderNav()
  haz.scope.renderNav()                      // 连画两次也不许发两趟（在途要拦）
  await flushMicro()
  assert.equal(sessionAsks(haz), 2, '清空后重画必须自己补发请求，且只补一次')
  assert.equal(
    haz.scope.getSessions().w1.sessions[0].title, '甲',
    '补拉回来的数据要落进状态（渲染画的就是它）',
  )
})

// ---------------------------------------------------------------------------
// 单帧模式：回答出现时跳到顶部
// ---------------------------------------------------------------------------

test('单帧模式：新回答到了就跳到顶部，从第一行开始读', () => {
  const r = minimalRunner({ latest: { text: '一段很长的结论。', timestamp: 100 }, live: '' })
  r.mainEl.scrollHeight = 3000
  r.scrollTo(2500)                       // 用户还停在上一轮的末尾
  r.render()
  assert.equal(r.mainEl.scrollTop, 0, '回答落定就该回到顶部')
})

test('同一条回答重新渲染时不再跳顶（重连、切模式、从后台回来）', () => {
  // 这是整件事最容易做坏的地方：那几种情况都会重新渲染**同一条**回答，
  // 而用户可能正读到一半，弹回顶部比不跳还烦人。
  const r = minimalRunner({ latest: { text: '一段很长的结论。', timestamp: 100 }, live: '' })
  r.mainEl.scrollHeight = 3000
  r.scrollTo(2500)
  r.render()
  assert.equal(r.mainEl.scrollTop, 0, '第一次要跳')

  r.scrollTo(1200)                       // 用户往下读了一段
  r.render()                             // 重连 / SSE 重推 / 切模式回来
  assert.equal(r.mainEl.scrollTop, 1200, '同一条回答不能再把人弹回顶部')
  r.render()
  assert.equal(r.mainEl.scrollTop, 1200, '再来几次也一样')
})

test('换了一条新回答就再跳一次（timestamp 变了）', () => {
  const r = minimalRunner({ latest: { text: '第一条。', timestamp: 100 }, live: '' })
  r.mainEl.scrollHeight = 3000
  r.render()

  r.scrollTo(1200)
  r.render()
  assert.equal(r.mainEl.scrollTop, 1200, '同一条不跳')

  r.state.latest = { text: '第二条。', timestamp: 200 }
  r.render()
  assert.equal(r.mainEl.scrollTop, 0, '新的一条要跳')
})

test('流式那一段还是黏底，没被跳顶逻辑抢走', () => {
  // 两条规则管的是不同时刻：live 还在说明答案没落定，该跟着往下走。
  const r = minimalRunner({ latest: { text: '上一条。', timestamp: 100 }, live: '' })
  r.render()                             // 先让「跳过顶的是哪一条」记成 100
  r.mainEl.scrollHeight = 1000
  r.scrollTo(990)                        // 本来就在底部
  r.state.live = '正在写…'
  r.render()
  assert.equal(r.mainEl.scrollTop, 1000, 'live 还在的时候要跟着往下滚')
})

test('用户翻上去看历史时，流式也不把他拽回去', () => {
  // 既有行为，别被这次改动带坏：atBottom 为假就不黏底。
  const r = minimalRunner({ latest: { text: '上一条。', timestamp: 100 }, live: '' })
  r.render()
  r.mainEl.scrollHeight = 3000
  r.scrollTo(500)                        // 离底部很远
  r.state.live = '正在写…'
  r.render()
  assert.equal(r.mainEl.scrollTop, 500, '别拽他回来')
})

test('还没有回答时不跳顶（占位符那条）', () => {
  const r = minimalRunner({ latest: null, live: '' })
  r.mainEl.scrollHeight = 800
  r.scrollTo(400)
  r.render()
  assert.equal(r.mainEl.scrollTop, 400, '没回答可读，别乱动位置')
})

test('回答对象没有 timestamp 时也不跳——没有判据就不动', () => {
  // 跳顶的唯一判据就是 timestamp。拿不到它就没法知道这是不是「新的一条」，
  // 这时候宁可不动，也不能猜。不写这条的话，`latest.timestamp` 那道判断
  // 摘掉测试也照样全绿（反向验证时就是这么发现的）。
  const r = minimalRunner({ latest: { text: '一段结论，但没带时间戳。' }, live: '' })
  r.mainEl.scrollHeight = 3000
  r.scrollTo(1200)
  r.render()
  assert.equal(r.mainEl.scrollTop, 1200, '没有判据就不该跳')
})

/**
 * 聊天模式的滚动：**回答的开头才是要读的地方，不是末尾。**
 *
 * 用户 2026-09-24 提的：「聊天模式下，回答出现时，页面也应该停留在回答的开头
 * 而非末尾，这样用户不用往上滚到开头」。
 *
 * 这推翻了原先那条「聊天模式照旧黏底（用户只说了单帧）」——当时他只说了单帧，
 * 所以聊天模式特意保持原样。现在口径变了，测试跟着变，不是测试写错了。
 */
function chatRunner({
  latest, live, history = [], scrollTop = 0, scrollHeight = 2000,
  liveTop = 800, saidTop = 600, mainTop = 0,
} = {}) {
  // 假的 replyEl：querySelector / querySelectorAll 靠扫 innerHTML 里的 class 字符串，
  // 不真去解析 HTML——够用，而且渲染细节变了也不会误红。
  const replyEl = {
    innerHTML: '',
    querySelector(sel) {
      if (sel !== '.live') return null
      return this.innerHTML.includes('class="live"')
        ? { getBoundingClientRect: () => ({ top: liveTop }) } : null
    },
    querySelectorAll(sel) {
      if (sel !== '.said') return []
      const n = (this.innerHTML.match(/class="said"/g) || []).length
      return Array.from({ length: n }, (_, i) => ({
        getBoundingClientRect: () => ({ top: saidTop + i * 10 }),
      }))
    },
  }
  const mainEl = {
    classList: { remove() {} },
    scrollTop, scrollHeight, clientHeight: 0,
    getBoundingClientRect: () => ({ top: mainTop }),
  }
  const state = { mode: 'chat', history, live: live || '', latest, boundSessionId: 's1' }
  const lb = html.indexOf('function liveBlock')
  assert.ok(lb > 0, '在 page.html 里找不到 liveBlock')
  // eslint-disable-next-line no-new-func
  const build = new Function(
    'state', 'replyEl', 'mainEl', 'timeLabel',
    `${html.slice(start, end)}\n${html.slice(lb, html.indexOf('function render()'))}\nreturn renderChat;`,
  )
  return { render: build(state, replyEl, mainEl, () => '12:00'), state, mainEl, replyEl }
}

test('聊天模式：没有新回答时照旧黏底（重排、切会话不该乱动）', () => {
  // 没有 latest、没有 live —— 也就是「什么都没新来」，这时候维持原样：
  // 本来在底部就跟着底部。这条是原来那条测试的本意，保留下来。
  const r = chatRunner({
    history: [{ role: 'assistant', text: '一段很长的结论。', timestamp: 100 }],
    scrollTop: 1990, scrollHeight: 2000,
  })
  r.render()
  assert.equal(r.mainEl.scrollTop, 2000, '没有新回答就照旧黏底')
})

test('聊天模式：新回答落定时对齐它的开头，不是末尾', () => {
  // 本来在底部（1990/2000，差 10px 在 48px 容差内），所以该动他。
  // 回答开头在 600，容器顶在 0 —— 滚过去 600 再留 12px 空隙：1990 + 600 - 12。
  const r = chatRunner({
    latest: { text: '答案', timestamp: 7 },
    history: [{ role: 'assistant', text: '答案', timestamp: 7 }],
    scrollTop: 1990, scrollHeight: 2000, saidTop: 600,
  })
  r.render()
  assert.equal(r.mainEl.scrollTop, 2578, '回答开头(600)该对齐到视野顶部，留 12px 空隙')
})

test('聊天模式：回答正在流的时候停在开头，不被反复拽回末尾', () => {
  const r = chatRunner({ live: '第一句', scrollTop: 1990, scrollHeight: 2000, liveTop: 800 })
  r.render()
  assert.equal(r.mainEl.scrollTop, 2778, '流式一开始就把开头(800)对齐到顶部：1990 + 800 - 12')

  // 关键的一条。流式每秒重画好几次，用户这时候多半正读到一半——
  // 这里故意把 scrollHeight 设成让 atBottom() 为**真**（340-300=40 < 48 的容差），
  // 也就是「看起来就在底部」。要是流式期间还走黏底那条路，他刚滚到开头就被拽走。
  r.mainEl.scrollTop = 300
  r.state.live = '第一句，又长了一点'
  r.mainEl.scrollHeight = 340
  r.render()
  assert.equal(r.mainEl.scrollTop, 300, '流式期间就算贴着底部，也不该被拽走')

  // 也不能「每次重画都再对齐一次」——那同样会把人从读到一半的地方弹回开头。
  r.mainEl.scrollTop = 120
  r.state.live = '第一句，又长了一点，再长一点'
  r.render()
  assert.equal(r.mainEl.scrollTop, 120, '同一条回答只对齐一次，别反复弹回开头')
})

test('聊天模式：他自己翻上去看历史时，回答来了也不动他', () => {
  // 用户 2026-09-22 实机提的：「有动画的时候手机端页面运动到上面都会自动调回底部，
  // 这种机制没必要吧。」把他拽到回答开头，和当初拽回底部是同一类冒犯。
  // 所以「对齐开头」只在**他本来就在底部跟着看**的时候才做。
  const r = chatRunner({ live: '正在写', scrollTop: 100, scrollHeight: 2000, liveTop: 800 })
  r.render()
  assert.equal(r.mainEl.scrollTop, 100, '翻上去看历史时，流式来了也不该动他的位置')

  // 落定的回答同理。
  const s = chatRunner({
    latest: { text: '答案', timestamp: 7 },
    history: [{ role: 'assistant', text: '答案', timestamp: 7 }],
    scrollTop: 100, scrollHeight: 2000, saidTop: 600,
  })
  s.render()
  assert.equal(s.mainEl.scrollTop, 100, '翻上去看历史时，回答落定也不该动他')
})

/**
 * 聊天记录是**一屏一屏铺**的（2026-09-30 改的，原委见 page.html 里 CHAT_PAGE 那段）。
 *
 * 这里要验的三件事，都得让假 DOM 有一点「高度」才验得出来：
 *   ① 首屏只铺最近 40 条；
 *   ② 往上滑再放一屏时，**位置要校回来**；
 *   ③ 那句「往上滑看更早的」什么时候露、什么时候收。
 * 所以 mainEl.scrollHeight 不能是个死数，得跟着铺出来的条数长——这里按
 * 「顶上 40px + 每条 10px」估。真排版算不出精确像素，但「离底部的距离有没有变」
 * 这个不变量是准的，而真机上跳没跳，靠的就是它。
 *
 * 假 replyEl 还得能 `querySelector('.more-note')`：那颗提示的露 / 收是靠给它
 * 加 classList 上的 hide 类做的，没有这一步就测不到「在底部时它收没收」。
 */
function chatPager({
  history, queued = [], boundSessionId = 's1', clientHeight = 0, saidTop = 600,
} = {}) {
  const replyEl = { innerHTML: '' }
  // 假的 .more-note：只复刻真 DOM 里用得到的那点能力（classList）。
  // 它贴不贴顶、长什么样是 CSS 的事，这里管不着，也不用管。
  const note = (() => {
    const cls = new Set()
    return {
      offsetHeight: 30,
      classList: {
        add: (c) => cls.add(c),
        remove: (c) => cls.delete(c),
        contains: (c) => cls.has(c),
        toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c) },
      },
    }
  })()
  replyEl.querySelector = (sel) => (
    sel === '.more-note' && replyEl.innerHTML.includes('more-note') ? note : null
  )
  // 「回答落定对齐开头」那条路要数 `.said`。全给同一个位置：测试要的是「对齐到哪里」，
  // 不是哪一条回答——真排版里最后那条的位置，这里用一个定值代替。
  replyEl.querySelectorAll = (sel) => (
    sel !== '.said' ? []
      : Array.from({ length: (replyEl.innerHTML.match(/class="said"/g) || []).length },
        () => ({ getBoundingClientRect: () => ({ top: saidTop }) }))
  )
  const mainEl = {
    classList: { remove() {} },
    scrollTop: 0,
    clientHeight,
    get scrollHeight() {
      const n = (replyEl.innerHTML.match(/class="(?:said|bubble)/g) || []).length
      return 40 + 10 * n
    },
    getBoundingClientRect: () => ({ top: 0 }),
  }
  const state = { mode: 'chat', history, queued, live: '', boundSessionId }
  const lb = html.indexOf('function liveBlock')
  assert.ok(lb > 0, '在 page.html 里找不到 liveBlock')
  // eslint-disable-next-line no-new-func
  const build = new Function(
    'state', 'replyEl', 'mainEl', 'timeLabel',
    `${html.slice(start, end)}\n${html.slice(lb, html.indexOf('function render()'))}
     return { renderChat, maybeGrowChat, onMainScroll };`,
  )
  const api = build(state, replyEl, mainEl, () => '12:00')
  // 真 DOM 里 class 是重画 innerHTML 时建出来的，替身不会自己长——渲染完补这一步。
  function syncNote() {
    note.classList.toggle('hide', /class="more-note hide"/.test(replyEl.innerHTML))
  }
  return {
    ...api, state, mainEl, replyEl,
    // 铺出来几条：数气泡和回答块，不数复制按钮和那两条提示。
    count: () => (replyEl.innerHTML.match(/class="(?:said|bubble)/g) || []).length,
    // 「打开这个会话」：第一次重画时页面还空着，按 atBottom 的判据那算「在底部」，
    // 于是铺完会黏到底——这正是真机上的样子（点开会话先看到最新的那条）。
    // 所以「用户往上滑」要在这之后单独模拟：见下面各条里的 scrollTo。
    open() { api.renderChat(); syncNote(); return this },
    render() { api.renderChat(); syncNote(); return this },
    // 把滚动条放到离顶 top 像素（只动位置，不惊动滚动处理器）。
    scrollTo(top) { mainEl.scrollTop = top; return this },
    // 用户滚了一下：位置已经由 scrollTo 放好，这里跑那根 scroll 线上的真逻辑。
    scrolled() { api.onMainScroll(); return this },
    noteHidden: () => note.classList.contains('hide'),
  }
}

/** 一串够长的历史，text 是「第 N 条」，方便断言哪一条在、哪一条还没铺出来。 */
function longHistory(n) {
  return Array.from({ length: n }, (_, i) => ({
    role: 'assistant', text: `第 ${i + 1} 条`, timestamp: i + 1,
  }))
}

test('聊天记录首屏只铺最近 40 条', () => {
  // 用户报的「点一个没选中的会话切换很慢」：不是网络也不是服务端（本机实测那三个
  // 接口 168 / 36 / 107 毫秒），是这一页一次把推上来的 200 条全铺出来。
  const p = chatPager({ history: longHistory(200) }).open()
  assert.equal(p.count(), 40, '首屏只摊 40 条，剩下的等他往上滑')
  assert.ok(p.replyEl.innerHTML.includes('第 200 条'), '最新那条必须在')
  assert.ok(p.replyEl.innerHTML.includes('第 161 条'), '从最新往回数满 40 条')
  assert.ok(!p.replyEl.innerHTML.includes('第 160 条'), '第 41 条要留给下一屏')
  assert.match(p.replyEl.innerHTML, /往上滑看更早的/, '本地还有更早的，就得说一句')
})

test('往上滑到接近顶部：再放一屏，并且位置原样不动', () => {
  const p = chatPager({ history: longHistory(200) }).open()
  p.scrollTo(30)
  const fromBottom = p.mainEl.scrollHeight - p.mainEl.scrollTop
  p.maybeGrowChat()
  assert.equal(p.count(), 80, '再放一屏：40 + 40')
  assert.ok(p.replyEl.innerHTML.includes('第 121 条'), '往回多铺了一屏出来')
  assert.ok(!p.replyEl.innerHTML.includes('第 120 条'), '再多就没有了，一屏就是一屏')
  assert.equal(p.mainEl.scrollHeight - p.mainEl.scrollTop, fromBottom,
    '离底部的距离要原样不动——他正看着的那几行一格都不该走（这是「不跳走」的唯一判据）')

  // 滑下来了就不再放：一屏一屏地来，不是一滑就哗啦啦铺完。
  p.scrollTo(400)
  p.maybeGrowChat()
  assert.equal(p.count(), 80, '没靠近顶部就不该再放')
})

test('本地的记录放完了：不再放，那句提示也收起来', () => {
  const p = chatPager({ history: longHistory(50) }).open()
  assert.equal(p.count(), 40, '先铺 40 条')
  assert.match(p.replyEl.innerHTML, /往上滑看更早的/)
  p.scrollTo(10)
  p.maybeGrowChat()
  assert.equal(p.count(), 50, '只剩 10 条就全铺出来，不多不少')
  assert.ok(!p.replyEl.innerHTML.includes('往上滑看更早的'),
    '本地都放完了就别再催他往上滑（服务端截断那句另说，见 .history-note）')
  p.maybeGrowChat()
  assert.equal(p.count(), 50, '再滑也不动了')
})

test('换会话时窗口收回首屏：上一个会话铺到多少条都不带过来', () => {
  // 这条要修的就是「切会话慢」——铺开的量必须跟着会话走，不能攒着。
  const p = chatPager({ history: longHistory(100) }).open()
  p.scrollTo(10)
  p.maybeGrowChat()
  assert.equal(p.count(), 80)
  p.state.boundSessionId = 's2'
  p.state.history = longHistory(200)
  p.render()
  assert.equal(p.count(), 40, '换到新会话就是新的一屏，不继承上一个会话铺开的量')
})

test('跑着的时候来的新消息，照旧铺在最后，不会被窗口挡在外面', () => {
  const p = chatPager({ history: longHistory(100) }).open()
  p.state.history = p.state.history.concat([{ role: 'assistant', text: '刚写完的那条', timestamp: 101 }])
  p.render()
  assert.ok(p.replyEl.innerHTML.includes('刚写完的那条'), '新消息必须露出来（流式追加不能被窗口挡住）')
  assert.ok(p.replyEl.innerHTML.includes('第 62 条'), '窗口还是 40 条，整体往后挪一条')
  assert.ok(!p.replyEl.innerHTML.includes('第 61 条'), '最老的那条让出去')
})

test('滑到最下面读内容时，那句「往上滑看更早的」不许露脸', () => {
  // 用户 2026-09-30 真机提的：都滑到最下面了，它还挂在顶上（它是 sticky 的，
  // 跟用户滑到哪儿无关）。那句话是催人往上滑的，人已经在底部读内容，它就成了挡视线的。
  const p = chatPager({ history: longHistory(200) }).open()
  assert.ok(p.noteHidden(), '点开会话就在底部：一开始就得是收着的')
  assert.match(p.replyEl.innerHTML, /class="more-note hide"/,
    '光不显示还不够：它得是「收着」的这一档（那块地方留着，收 / 露之间不顶内容）')

  // 往上滑到触发线以内：这时候它才该露（正是用得着它的时候）。
  p.scrollTo(30).scrolled()
  assert.ok(!p.noteHidden(), '靠近顶部了，该它出来说话了')

  // 再滑回最下面：必须收起来。这一半只能靠滚动里那根线——中间不会来快照，
  // 也就不会重画，不在滚动里收，它就一直挂在顶上（真机上就是这么发现的）。
  p.scrollTo(p.mainEl.scrollHeight).scrolled()
  assert.ok(p.noteHidden(), '滑回底部还不收，就是真机上那条反馈')

  // 中间地带（离顶远、又没到底）也不露：那句提示只在够得着顶部时有意义。
  p.scrollTo(600).scrolled()
  assert.ok(p.noteHidden(), '离顶远了就不该再挂着')
})

test('内容只比一屏高一点点时，在底部同样不许露——「在底部」是独立的一条判据', () => {
  // 单看「离顶近不近」是不够的：记录短的时候（比如最近这 40 条大多是短的指令行），
  // 滚到底也还落在触发线以内，那句提示照样会挂在顶上——和真机报的是同一个毛病。
  // 所以判据里「不在底部」这一条是独立的，不能由前者推出来。
  const p = chatPager({ history: longHistory(200), clientHeight: 400 }).open()
  // 假 mainEl 不会自己把 scrollTop 夹到合法范围（真浏览器会），这里手动摆成
  // 真机上「滚到底」的位置：内容 440、一屏 400 → 40。
  p.scrollTo(40).scrolled()
  assert.ok(p.noteHidden(), '这个位置离顶确实很近，但它同时就是底部——在底部就不许露')
})

test('回答落定对齐开头时：那句提示收着，而且不为它多留一段空白', () => {
  // 两颗牙齿合在一起才成立：pinToTop 只留 12px 空隙，**不给**那颗 sticky 条让高度
  //（让了会凭空多出一段空白，所以 page.html 里特意没让）。那就必须保证——
  // 「对齐开头」发生的那一刻（人本来就在底部），提示是收着的（见 chatNoteVisible）。
  const p = chatPager({ history: longHistory(200), saidTop: 600 })
  p.state.latest = { text: '答案', timestamp: 9 }
  p.open()
  assert.ok(p.noteHidden(), '在底部对齐回答开头时，提示必须是收着的')
  assert.equal(p.mainEl.scrollTop, 600 - 12,
    '回答开头(600)对齐到视野顶部、只留 12px 空隙；多留一段就是那颗收着的提示占的')
})

test('往上滑的接线在：main 上挂了 scroll，而不是只有一段没人喊的逻辑', () => {
  // 真机踩过的同类坏法：逻辑全对、就是没人喊它（见下面权限那一段）。这里是同样的坑，
  // 所以不测「函数返回什么」，测「这根线在不在」。
  // 这条线上挂的是两件事：那句提示的露 / 收，和再放一屏（见 onMainScroll）。
  assert.match(html, /mainEl\.addEventListener\('scroll', onMainScroll\)/,
    'main 的 scroll 要接到 onMainScroll，否则往上滑永远不加载、提示也永远不会收')
})

/**
 * 权限档位的点击接线。
 *
 * 真机踩到过：三档**画得出来、点下去毫无反应**——因为 `#segPerm` 上根本没绑点击，
 * `tapPerm` 一次都没被调用过。逻辑是对的，缺的是那根线。
 *
 * 所以这类 bug 逻辑测试永远测不出来（测试直接调 `tapPerm` 验逻辑，而真机上坏掉的
 * 正是「谁来喊它」）。这里把**那段接线本身**切出来真跑一遍：绑不上监听、绑错了事件、
 * 点下去不喊 `tapPerm`，三种情况都要红。
 */
test('权限档位的点击真的接上了 tapPerm（不是画出来就算）', () => {
  const P0 = "$('segPerm').addEventListener('click'"
  const P1 = "Array.prototype.forEach.call($('segMode')"
  const p0 = html.indexOf(P0)
  const p1 = html.indexOf(P1)
  assert.ok(p0 > 0, `在 page.html 里找不到权限档位的点击绑定（${P0}）`)
  assert.ok(p1 > p0, `找不到权限档位绑定的结束锚点（${P1}）`)

  const bound = []
  const segEl = { addEventListener(type, fn) { bound.push([type, fn]) } }
  const tapped = []
  // eslint-disable-next-line no-new-func
  new Function('$', 'tapPerm', `${html.slice(p0, p1)}\n`)(
    (id) => (id === 'segPerm' ? segEl : { addEventListener() {} }),
    (name) => tapped.push(name),
  )

  assert.equal(bound.length, 1, '#segPerm 上必须正好绑一个监听（绑两个会点一下切两次）')
  assert.equal(bound[0][0], 'click', '绑的必须是 click')
  const onClick = bound[0][1]

  // 真机上那一下：点的是按钮本身（按钮里只有文字）。
  const btn = { dataset: { perm: 'read-only' }, parentNode: null }
  onClick.call(segEl, { target: btn })
  assert.deepEqual(tapped, ['read-only'], '点按钮要带着 data-perm 去喊 tapPerm')

  // 点到容器空白处不能误触发——那不是任何一档。
  tapped.length = 0
  onClick.call(segEl, { target: segEl })
  assert.deepEqual(tapped, [], '点到容器本身不该切档位')

  // 监听挂在容器上、不挂在按钮上：renderPerms 每次都整块换 innerHTML，
  // 挂按钮上的监听会被下一次重画冲掉——那样修完能好一次，再点就坏。
  assert.match(html, /renderPerms[\s\S]*?seg\.innerHTML/, 'renderPerms 应当是整块重画')
})

/**
 * 权限档位那块**不能只在启动时读一次**。
 *
 * 真机现象：抽屉里根本没有「权限档位」这一块，别的行都正常。查下来，这块整块不显示
 * 只有一条路——`loadPermissions()` 读不回来（`renderPerms()` 是先去掉 hidden 再画，
 * 逻辑本身没问题）。而它原来只被调用一次，就在启动那一刻：宿主刚重启、绑定的会话
 * 还没装进 `ctx.agents` 的那几秒里，服务端如实回 `no-session`，那一次正好撞上，
 * 这一块就再也不出现，只有整页刷新能救回来。
 *
 * 两条牙：①一次读失败不许把已经画出来的那一盘擦掉；②打开设置抽屉要重读一次
 *（顺带让「现在是哪一档」不至于停在开机那一刻的旧值）。
 */
const PERM_S = 'var permOptions = null;'
const PERM_E = 'function renderPerms() {'
const PERM_END = html.indexOf('function tapPerm')
const permS = html.indexOf(PERM_S)
const permE = html.indexOf(PERM_E)
assert.ok(permS > 0, `在 page.html 里找不到锚点「${PERM_S}」`)
assert.ok(permE > permS, `在 page.html 里找不到锚点「${PERM_E}」`)
assert.ok(PERM_END > permE, '在 page.html 里找不到锚点「function tapPerm」')

/**
 * 把「读一次档位盘 + 画出来」那一段抠出来真跑。
 *
 * 切片要连 `renderPerms` 一起带上：**露出这一块的动作在它里面**（先去掉 hidden 再画）。
 * 只抠 `loadPermissions` 就会把「露出来」那一步换成桩，测的就不是页面上真跑的那条链了。
 */
function permReader() {
  const els = {
    permBlock: { hidden: true },
    segPerm: { innerHTML: '' },
    permHint: { textContent: '' },
  }
  const queue = []
  const box = new Function('$', 'api', 'escapeHtml',
    `${html.slice(permS, PERM_END)}\n`
    + 'return { load: loadPermissions, current: function () { return permOptions; },'
    + ' feed: function (b) { permOptions = b; renderPerms(); } };')(
    (id) => els[id], () => queue.shift()(), md.escapeHtml,
  )
  return { els, queue, box }
}

const PERM_LIVE = {
  ok: true,
  options: [
    { value: 'read-only', name: '仅可查看', description: '', dangerous: false },
    { value: 'workspace-write', name: '工作区内修改', description: '', dangerous: false },
    { value: 'danger-full-access', name: '完全权限', description: '', dangerous: true },
    { value: 'auto', name: '自动审查', description: '', dangerous: true },
  ],
  currentValue: 'auto',
}

test('权限档位：一次读失败不许把已经画出来的那一盘擦掉', async () => {
  const r = permReader()
  r.queue.push(() => Promise.resolve(PERM_LIVE))
  r.box.load()
  await flushMicro()
  assert.equal(r.els.permBlock.hidden, false, '读到了就要露出来')
  assert.match(r.els.segPerm.innerHTML, /data-perm="auto"/, '读到了就要把那几档画出来')

  // 真机上就是这一下：读回来一个 ok:false（宿主刚重启、会话还没加载完）或者干脆断线。
  r.queue.push(() => Promise.reject(new Error('断线')))
  r.box.load()
  await flushMicro()
  assert.equal(r.els.permBlock.hidden, false, '已经显示出来的档位，不许因为一次读失败当场消失')
  assert.ok(r.box.current(), '读失败也不该把上一次读到的档位丢掉（丢了连点击都点不动）')
  assert.match(r.els.segPerm.innerHTML, /data-perm="auto"/, '读失败后原来画的那一盘要原样留着')
})

test('权限档位：一个档位都没读到过时，读不回来仍然整块不显示（不摆一个空壳）', async () => {
  const r = permReader()
  r.queue.push(() => Promise.resolve({ ok: false, reason: 'no-session' }))
  r.box.load()
  await flushMicro()
  assert.equal(r.els.permBlock.hidden, true, '一个档位都没读到，空壳不该露出来')

  // 那一段过去之后要能自己长回来——不能「一次没读成，这块就永远算了」。
  r.queue.push(() => Promise.resolve(PERM_LIVE))
  r.box.load()
  await flushMicro()
  assert.equal(r.els.permBlock.hidden, false, '后来读到了就要露出来')
})

test('打开设置抽屉会重读一次权限档位（不是只在启动时读一次）', () => {
  const A = "$('btnSettings').addEventListener('click'"
  const B = "$('btnClose').addEventListener('click'"
  const a = html.indexOf(A)
  const b = html.indexOf(B)
  assert.ok(a > 0, `在 page.html 里找不到锚点「${A}」`)
  assert.ok(b > a, `在 page.html 里找不到锚点「${B}」`)

  const bound = []
  const el = {
    classList: { add() {}, remove() {} },
    addEventListener(type, fn) { bound.push([type, fn]) },
    textContent: '',
  }
  let loads = 0
  new Function('$', 'sheet', 'state', 'loadPermissions', html.slice(a, b))(
    () => el, el, { connected: true }, () => { loads += 1 },
  )

  assert.equal(bound.length, 1, '这个按钮上正好绑一个监听')
  bound[0][1]()
  assert.equal(loads, 1, '打开设置时必须重读一次档位盘，否则开机那一次没读成就永远缺这一块')
})

test('四档（含宿主保留档 auto）都要画出来，当前那一档要标出来', () => {
  // 这份数据是 3090 上 /mini/api/permissions 真实回的形状：桌面端加载了
  // experimental-auto-review 之后多出第四档，它的 name 由 lib/permissions.js 的
  // PRESET_LABELS 补成中文。这一侧**一个标识符都不许写死**——多几档就画几档。
  const r = permReader()
  r.box.feed(PERM_LIVE)

  const buttons = r.els.segPerm.innerHTML.match(/data-perm="/g) || []
  assert.equal(buttons.length, 4, `四档要画四个按钮，实际 ${buttons.length} 个`)
  assert.match(r.els.segPerm.innerHTML, />自动审查</, '第四档要显示中文名，不能显示标识符 auto')
  assert.match(r.els.segPerm.innerHTML, /data-perm="auto" class="active">自动审查</,
    '当前这一档（auto）要带 active，界面要能标出「现在是哪一档」')
  assert.equal(r.els.permHint.textContent, '当前：自动审查', '说明那一行要说出现在是哪一档')
  assert.equal(r.els.permBlock.hidden, false, '画出来了就要露出来')
})

/**
 * 权限档位是**每个会话各一份**的。
 *
 * 宿主的 `permission/preset` 记在会话自己的日志里，`service.current(session)` 读的是
 * 这个会话那份投影（见 lib/permissions.js 的 listPresets 与 lib/index.js 的 sessionFor）。
 * 这一侧原来只在开机和打开抽屉时读，于是切了会话之后抽屉里还是上一个会话那一档——
 * 用户复制过来的原话就是「切到会话二是工作区内修改，它显示的是自动审查」。
 *
 * 两条牙：①换会话当场撤掉那一份高亮（列表留着，不许整盘消失）；②上一个会话那一份
 * 晚到的应答不许顶掉这个会话的。
 */
test('权限档位：换了会话，上一个会话那一档的高亮当场撤掉（列表留着）', async () => {
  const r = permReader()
  r.queue.push(() => Promise.resolve({ ...PERM_LIVE }))   // 会话一：当前是「自动审查」
  r.box.load('s1')
  await flushMicro()
  assert.match(r.els.segPerm.innerHTML, /data-perm="auto" class="active"/, '会话一那一档先标出来')

  // 会话二那一份还在路上（网络慢或宿主还没登记这个会话）。
  r.queue.push(() => new Promise(() => {}))
  r.box.load('s2')
  assert.ok(!/class="active"/.test(r.els.segPerm.innerHTML),
    '还没读到会话二的档位，就不许拿会话一那一档冒充——宁可一个都不标')
  assert.match(r.els.segPerm.innerHTML, /data-perm="auto"/, '但列表要留着，不能整盘消失')
  assert.equal(r.els.permHint.textContent, '作用在当前会话上', '说不清是哪一档时，不编一个名字')
})

test('权限档位：上一个会话那一份晚到的应答不许覆盖这个会话', async () => {
  const r = permReader()
  let release1
  r.queue.push(() => new Promise((resolve) => { release1 = resolve }))
  r.box.load('s1')                                        // 会话一那一发还飞在路上
  r.queue.push(() => Promise.resolve({ ...PERM_LIVE, currentValue: 'workspace-write' }))
  r.box.load('s2')                                        // 用户已经切到会话二
  await flushMicro()
  assert.match(r.els.segPerm.innerHTML, /data-perm="workspace-write" class="active"/,
    '会话二自己那一档要标出来')

  release1({ ...PERM_LIVE, currentValue: 'auto' })        // 会话一那一发这才回来
  await flushMicro()
  assert.match(r.els.segPerm.innerHTML, /data-perm="workspace-write" class="active"/,
    '会话一的答案属于会话一，不许把会话二的高亮顶掉')
  assert.ok(!/data-perm="auto" class="active"/.test(r.els.segPerm.innerHTML), '会话一那一档不许冒头')
})

/**
 * 换会话那一瞬间要发生什么——把**真的** applySnapshot 抠出来跑。
 *
 * 这一段以前只有 `'running' in snap` 那种静态正则，所以「换了会话之后哪些东西要
 * 重取」全靠肉眼。权限档位就是这么漏掉的。
 */
function snapshotHarness() {
  const A = 'function applySnapshot(snap) {'
  const B = '// ---------------- 左侧导航栏'
  const a = html.indexOf(A)
  const b = html.indexOf(B)
  assert.ok(a > 0, `在 page.html 里找不到锚点「${A}」`)
  assert.ok(b > a, `在 page.html 里找不到锚点「${B}」`)

  const state = { boundSessionId: null }
  const permCalls = []
  // eslint-disable-next-line no-new-func
  const apply = new Function(
    'state', '$', 'setRunning', 'paintCmdMenu', 'paintNavCurrent', 'render',
    'loadPermissions', 'saCache', 'saCacheSession', 'saCacheAt',
    `${html.slice(a, b)}\nreturn applySnapshot;`,
  )(
    state,
    () => ({ classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {} }),
    () => {}, () => {}, () => {}, () => {},
    (id) => permCalls.push(id),
    null, null, 0,
  )
  return { apply, state, permCalls }
}

test('换会话要重读权限档位（它是每个会话各一份的）', () => {
  const h = snapshotHarness()
  h.apply({ boundSessionId: 's1' })
  assert.deepEqual(h.permCalls, ['s1'], '第一次拿到绑定会话就该读一次')

  h.permCalls.length = 0
  h.apply({ boundSessionId: 's1' })   // 同一个会话的快照（每秒都来一份）
  assert.deepEqual(h.permCalls, [], '没换会话，不该无谓地重读')

  h.apply({ boundSessionId: 's2' })   // 用户在导航栏切到了会话二
  assert.deepEqual(h.permCalls, ['s2'],
    '换了会话必须重读——不读显示的就是会话一那一档（用户的真机反馈）')
})

// ---------------------------------------------------------------------------
// 斜杠指令：手机上打 / 弹菜单、点一条执行、以及它在历史里怎么画
// ---------------------------------------------------------------------------
//
// 这一块要的两条接口（GET /mini/api/commands、POST /mini/api/command）是宿主侧同时
// 在做的，所以这里**按契约把它们的形状造出来**，而不是等那边写完——这一份的绿红
// 不该取决于同事的进度。造的是接口的样子（回什么字段、收什么 body），不是另一套行为：
// 契约一旦变了，这里要跟着变，所以下面每一条桩都写明了它对应契约的哪一句。

const CM_S = '// ---------------- 斜杠指令'
const CM_E = '// ---------------- 上传附件 ----------------'
assert.ok(html.indexOf(CM_S) > 0, `在 page.html 里找不到锚点「${CM_S}」`)
assert.ok(html.indexOf(CM_E) > html.indexOf(CM_S), `在 page.html 里找不到锚点「${CM_E}」`)

// 契约里那条 GET 的形状：已按 name 排好序，hint 可能为 null。
const COMMANDS = [
  { name: 'compact', description: '压缩这个会话的上下文', hint: null, attachments: false },
  { name: 'config', description: '改设置', hint: '要改哪一项？', attachments: false },
  { name: 'cost', description: '看这个会话花掉多少', hint: null, attachments: false },
]

/**
 * 把「斜杠指令」那一段从模板里抠出来跑。
 *
 * 切片是两个注释锚点之间的整块：菜单的数据、画菜单、点一条、执行。锚点对不上会立刻
 * 断言失败，不会安静地退化成空测试。
 */
function buildMenu({
  value = '/', sessionId = 's1', rejects = false,
  replies = { commands: { ok: true, commands: COMMANDS } },
} = {}) {
  const input = {
    value, placeholder: '说点什么…', style: {}, scrollHeight: 40,
    focus() {}, setSelectionRange() {},
  }
  const els = {}
  const calls = []
  const toasts = []
  const state = {
    commands: null, commandsError: '', commandsFor: null, commandsLoading: false,
    boundSessionId: sessionId,
  }
  const sandbox = {
    state, inputEl: input,
    api: (path, opts) => {
      calls.push({ path, opts })
      if (rejects) return Promise.reject(new Error('连不上电脑'))
      // 按契约：路径去掉前缀就是那份桩的名字（commands / command）。
      return Promise.resolve(replies[path.replace('/mini/api/', '')] || { ok: true })
    },
    toast: (m) => toasts.push(m),
    escapeHtml: md.escapeHtml,
    autoGrow: () => {},
    $: (id) => (els[id] || (els[id] = {
      hidden: true, innerHTML: '', addEventListener() {},
    })),
  }
  // eslint-disable-next-line no-new-func
  const build = new Function(...Object.keys(sandbox),
    `${html.slice(html.indexOf(CM_S), html.indexOf(CM_E))}\n`
    + 'return { slashQuery, paintCmdMenu, pickCommand, runCommand, hideCmdMenu, needCommands };')
  const fns = build(...Object.values(sandbox))
  return {
    ...fns, input, els, calls, toasts, state,
    menu: () => els.cmdMenu,
    // 菜单的数据是异步取回来的，等它落地。两个微任务够 api() 那条链走完。
    settle: async () => { await Promise.resolve(); await Promise.resolve() },
  }
}

test('斜杠菜单：打一个 / 就弹出来，列出指令的名字和说明', async () => {
  const m = buildMenu()
  m.paintCmdMenu()
  await m.settle()

  // 第一次用到它才去取——页面打开时不取，省一趟请求。
  assert.equal(m.calls.length, 1, `只该取一次，实际 ${m.calls.length} 次`)
  assert.equal(m.calls[0].path, '/mini/api/commands')
  assert.equal(m.menu().hidden, false, '菜单要露出来')
  assert.match(m.menu().innerHTML, /compact/, '名字要在')
  assert.match(m.menu().innerHTML, /压缩这个会话的上下文/, '说明也要在，不能只有名字')
  assert.match(m.menu().innerHTML, /cost/, '别的指令不许漏')
  assert.match(m.menu().innerHTML, /data-cmd="compact"/, '点了要知道点的是哪一条')
})

test('斜杠菜单：打下去的字母按前缀过滤', async () => {
  // 两个字母：三条里 co 打头的都还在。
  const two = buildMenu({ value: '/co' })
  two.paintCmdMenu()
  await two.settle()
  assert.match(two.menu().innerHTML, /compact/)
  assert.match(two.menu().innerHTML, /config/, 'co 打头的都要留着')
  assert.match(two.menu().innerHTML, /cost/)

  // 再打一个字母：只剩对得上的那条。这一半才是「过滤」本身——
  // 只验「名字还在」的话，把过滤整个去掉测试也照样绿。
  const three = buildMenu({ value: '/com' })
  three.paintCmdMenu()
  await three.settle()
  const out = three.menu().innerHTML
  assert.match(out, /compact/)
  assert.ok(!out.includes('config'), 'com 打头的只剩 compact')
  assert.ok(!out.includes('cost'))
})

test('斜杠菜单：出现空格或者不再是 / 打头，就收起来，也不白取一次', async () => {
  // 打了空格 = 这条指令的名字打完了、开始写参数了，菜单让位给输入框。
  const space = buildMenu({ value: '/compact ' })
  space.paintCmdMenu()
  await space.settle()
  assert.equal(space.menu().hidden, true, '有空格就收起来')
  assert.equal(space.menu().innerHTML, '', '不许留个空壳在那儿')
  assert.equal(space.calls.length, 0, '收起来了就不该为它取指令表')

  // 内容不再以 / 开头，同理。
  const talk = buildMenu({ value: '你好 /compact' })
  talk.paintCmdMenu()
  await talk.settle()
  assert.equal(talk.menu().hidden, true)

  // 大写不算命中：DSH 的指令名就是小写，把 /CO 当命中会让用户「打了没反应」。
  const upper = buildMenu({ value: '/CO' })
  upper.paintCmdMenu()
  await upper.settle()
  assert.equal(upper.menu().hidden, true)
})

test('斜杠菜单：取不到时说清原因，不显示空列表，也不反复重取', async () => {
  // 契约里那条失败形状：这个会话没在跑。
  const m = buildMenu({
    replies: {
      commands: { ok: false, error: '这个会话现在没在跑，指令要先让它跑起来。' },
    },
  })
  m.paintCmdMenu()
  await m.settle()
  const out = m.menu().innerHTML
  assert.equal(m.menu().hidden, false, '出错了也要占着菜单位置把话说清楚')
  assert.match(out, /这个会话现在没在跑/, '服务端那句话要原样显示出来')
  assert.ok(!out.includes('cmd-row'),
    '不能显示成空列表——空列表看着就像「这个会话没有指令」，是另一回事')

  // 用户接着打字，每敲一个字都会重画一次。失败之后不能每次都再打一遍接口。
  m.paintCmdMenu()
  m.paintCmdMenu()
  await m.settle()
  assert.equal(m.calls.length, 1, `失败之后不该反复重取，实际取了 ${m.calls.length} 次`)
})

test('斜杠菜单：上次没取到，重新打开时会再试一次', async () => {
  // 失败的原因多半是「这个会话现在没在跑」，而用户随后完全可能发一条消息让它跑起来。
  // 那时再打 /，要是还挂着上次那句话，他会以为这个功能坏了。
  // 但也不能每敲一个字都重取——所以判据是「关着→打开」这一下。
  const m = buildMenu({
    replies: {
      commands: { ok: false, error: '这个会话现在没在跑，指令要先让它跑起来。' },
    },
  })
  m.paintCmdMenu()
  await m.settle()
  assert.equal(m.calls.length, 1)

  // 菜单还开着的时候接着打字：不再取。
  m.paintCmdMenu()
  await m.settle()
  assert.equal(m.calls.length, 1, '开着的时候接着打字不该再取')

  // 收起来（比如清空输入框）再重新打一个 /：这一次可以再试。
  m.input.value = ''
  m.paintCmdMenu()
  assert.equal(m.menu().hidden, true, '输入框空了就收起来')
  m.input.value = '/'
  m.paintCmdMenu()
  await m.settle()
  assert.equal(m.calls.length, 2, '重新打开时要再问一次，不能一直挂着上次那句话')
})

test('斜杠菜单：连不上电脑时也要说一句，不是一片空白', async () => {
  const m = buildMenu({ rejects: true })
  m.paintCmdMenu()
  await m.settle()
  assert.equal(m.menu().hidden, false)
  assert.match(m.menu().innerHTML, /连不上电脑/, '网络不通也得说人话')
})

test('斜杠菜单：换了会话要重取（指令表是每个会话一份的）', async () => {
  const m = buildMenu()
  m.paintCmdMenu()
  await m.settle()
  assert.equal(m.calls.length, 1)

  m.state.boundSessionId = 's2'      // 用户在导航栏切到了另一个会话
  m.paintCmdMenu()
  await m.settle()
  assert.equal(m.calls.length, 2,
    '换了会话必须重取：拿上一个会话的指令表出来点，点下去必然被拒，用户还看不出为什么')
})

test('斜杠菜单：点没参数的指令，立刻执行，并清空输入框、收起菜单', async () => {
  const m = buildMenu({ value: '/co' })
  m.paintCmdMenu()
  await m.settle()

  m.pickCommand('compact')
  await m.settle()
  assert.equal(m.input.value, '', '执行了就把输入框清空')
  assert.equal(m.menu().hidden, true, '菜单同时收起来')
  assert.equal(m.calls.length, 2, `取列表一次、执行一次，实际 ${m.calls.length} 次`)
  assert.equal(m.calls[1].path, '/mini/api/command')
  assert.equal(JSON.parse(m.calls[1].opts.body).line, '/compact',
    '发的是完整的一行（含 /），不是光一个名字')
})

test('斜杠菜单：点要参数的指令，只填进输入框，并把 hint 挂到 placeholder 上', async () => {
  const m = buildMenu({ value: '/con' })
  m.paintCmdMenu()
  await m.settle()

  m.pickCommand('config')
  await m.settle()
  assert.equal(m.input.value, '/config ', '末尾要留一个空格，等用户接着打参数')
  assert.equal(m.input.placeholder, '要改哪一项？',
    '提示就用服务端给的 hint，不自己编一句「请输入参数」')
  assert.equal(m.menu().hidden, true, '填完就收起来，别再挡着')
  assert.equal(m.calls.length, 1, '还只是在填参数，这时候不该执行')
})

test('发送：trim 之后以 / 开头，就走指令接口，不再走 send', async () => {
  const b = buildSend()
  b.input.value = '  /compact --force  '
  b.send()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(b.calls.length, 1, `只该发一次，实际 ${b.calls.length} 次`)
  assert.equal(b.calls[0].path, '/mini/api/command', '走的是指令那条路')
  assert.equal(JSON.parse(b.calls[0].opts.body).line, '/compact --force',
    '发的是 trim 之后的完整一行（参数也在里面）')
  assert.equal(b.input.value, '', '发出去了就把输入框清掉')
})

test('发送：不是 / 开头的照旧走 send', async () => {
  const b = buildSend()
  b.input.value = '把这一段改成两列'
  b.send()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(b.calls.length, 1)
  assert.equal(b.calls[0].path, '/mini/api/send', '普通消息一个字都不该变')
})

test('发送：点过指令之后又把名字删掉，只留参数——这行不许当普通提问发出去', async () => {
  // 从面板/菜单点一条「要参数」的指令，输入框里是 `/config `。用户把名字删掉、只留参数，
  // 按发送——原来只认「首字符是不是 /」，这一行会被当成普通提问发给模型，真花一次额度。
  const b = buildSend()
  b.state.pendingCommand = 'config'
  b.input.value = '要改暗色'
  b.send()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(b.calls.length, 0,
    '既不许走 /mini/api/command，也不许走 /mini/api/send——这一行是那条指令的参数')
  assert.equal(b.input.value, '要改暗色', '输入框里那行要留着，用户补回名字就能接着发')
  assert.equal(b.toasts.length, 1, '得告诉他出了什么事、怎么办')
  assert.match(b.toasts[0], /config/)
})

test('发送：名字补回去了，照旧走指令那条路，并且把那枚标记清掉', async () => {
  const b = buildSend()
  b.state.pendingCommand = 'config'
  b.input.value = '/config 暗色'
  b.send()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(b.calls.length, 1)
  assert.equal(b.calls[0].path, '/mini/api/command')
  assert.equal(b.state.pendingCommand, null,
    '跑过之后必须清掉：不清的话，用户下一条普通提问会被这条残留的标记拦住')
})

test('发送：没点过指令时，普通提问一个字都不许被拦', async () => {
  const b = buildSend()
  b.state.pendingCommand = null
  b.input.value = '把这一段改成两列'
  b.send()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(b.calls.length, 1)
  assert.equal(b.calls[0].path, '/mini/api/send')
  assert.equal(b.toasts.length, 0, '没点过指令就不该冒出任何提示')
})

test('发送：指令被拒时说清原因，而且**不会**再当普通消息发一次', async () => {
  // 契约里那条拒绝形状。用户拍板过：打了一条不存在的指令要跟电脑端一样拒绝并说明，
  // 不能悄悄当普通消息发给模型。
  const b = buildSend({ serverSays: { ok: false, error: '没有 /xyz 这条指令' } })
  b.state.mode = 'chat'
  b.input.value = '/xyz'
  b.send()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(b.calls.length, 1, `被拒之后不能再补发一次普通消息，实际发了 ${b.calls.length} 次`)
  assert.equal(b.calls[0].path, '/mini/api/command')
  assert.equal(b.toasts.length, 1, '要把原因说出来，不能悄悄咽掉')
  assert.equal(b.toasts[0], '没有 /xyz 这条指令')
  assert.equal(b.state.history.length, 0,
    '也不许在聊天记录里留一条「已发出」的气泡——那等于骗人说发出去了')
})

test('斜杠菜单：点过的指令要记下来，名字删掉之后不许回退成普通消息', async () => {
  const m = buildMenu({ value: '/con' })
  m.paintCmdMenu()
  await m.settle()
  m.pickCommand('config')
  await m.settle()
  assert.equal(m.state.pendingCommand, 'config',
    '点过之后这一行就「曾经是一条指令」，send 里要认这个标记')

  // 清空输入框 = 明确取消。之后写普通提问不该再被拦（不然用户没法恢复成随便聊天）。
  m.input.value = ''
  m.paintCmdMenu()
  assert.equal(m.state.pendingCommand, null, '清空输入框就是取消这条指令')
})

test('斜杠菜单：点没参数的指令不落这枚标记（它当场就跑完了，没留参数在框里）', async () => {
  const m = buildMenu({ value: '/co' })
  m.paintCmdMenu()
  await m.settle()
  m.pickCommand('compact')
  await m.settle()
  assert.equal(m.input.value, '', '当场执行的那条，输入框已经清空')
  assert.equal(m.calls.length, 2, '取列表 + 执行，两趟')
  assert.equal(m.state.pendingCommand, null)
})

test('历史里的指令行：running / success / error 三种长得不一样', () => {
  const base = { role: 'command', commandId: 'c1', name: 'compact', args: ' --force', timestamp: 5 };

  const running = renderChatWith({ running: true, history: [{ ...base, kind: 'running' }] })
  assert.match(running, /class="cmd running"/, '正在跑的是单独一种')
  assert.match(running, /\/compact --force/, '名字要连着参数一起画，而且是原样的')
  assert.match(running, /执行中…/, '不知道结果就只说在跑，不编进度')

  const done = renderChatWith({ running: false, history: [{ ...base, kind: 'success', text: '已压缩' }] })
  assert.match(done, /class="cmd success"/)
  assert.match(done, /已压缩/, '成功时显示服务端给的那句话')

  // 成功但没给话时也得有个交代，不能留半行空白。
  const quiet = renderChatWith({ running: false, history: [{ ...base, kind: 'success' }] })
  assert.match(quiet, /完成/)

  const bad = renderChatWith({
    running: false,
    history: [{ ...base, kind: 'error', text: '压缩失败：没有可压缩的内容' }],
  })
  assert.match(bad, /class="cmd error"/)
  assert.match(bad, /压缩失败：没有可压缩的内容/, '失败的原因要显示出来')
})

test('历史里的指令行：不是气泡、没有复制按钮，出错是红的', () => {
  const out = renderChatWith({
    running: false,
    history: [
      { role: 'user', text: '压一下上下文', timestamp: 1 },
      { role: 'command', commandId: 'c1', name: 'compact', args: '', kind: 'error', text: '没跑起来', timestamp: 2 },
    ],
  })
  // 它是「会话做的一个动作」，不是谁说的话：套气泡就会被当成回答去读。
  assert.ok(!/class="bubble[^"]*">\s*<span class="cmd-line"/.test(out), '指令行不许套气泡')
  assert.ok(!out.includes('class="said"'), '也不该用 AI 回答那一套')
  // 复制一条「/compact 没跑起来」没有意义。
  assert.equal((out.match(/class="copy/g) || []).length, 1,
    '整串历史里只有用户那条气泡该有复制按钮')

  // 类名挂上了不等于颜色对——这条钉的是样式本身。
  // 切片取「.cmd 那一段规则」到菜单那一段，中间正好是它的全部样式。
  const cssAt = html.indexOf('.cmd {')
  const cssEnd = html.indexOf('.cmd-row')
  assert.ok(cssAt > 0 && cssEnd > cssAt,
    '找不到指令行的样式（锚点对不上，别让这两条断言静悄悄地空跑）')
  const css = html.slice(cssAt, cssEnd)
  assert.match(css, /\.cmd\.error \{[^}]*--err/, '出错那条左边的线要是红的')
  assert.match(css, /\.cmd\.error \.cmd-res \{[^}]*--err/, '连结果那行字一起红')
})

test('命令结果太长要在框里折行，不许顶出屏幕', () => {
  // 用户 2026-09-30 实机报的：手机上一条 /doctor 结果被切在屏幕右边，读不全。
  // 根因是 `.cmd-res` 的 `flex: 0 0 auto`——那等于「这一格不许缩，一行放完」，
  // 长结果就顶出 .cmd 的框；.cmd 不裁剪，溢出再顶到 main，main 的
  // overflow-y:auto 会把横向也变成滚动区，结果是整页能左右拉、右边那截看不见。
  // 这条钉的是「结果是正文」：可以缩、可以从任意处断开，但**不许**换成横向滚动或省略号。
  const cssAt = html.indexOf('.cmd {')
  const cssEnd = html.indexOf('.cmd-row')
  assert.ok(cssAt > 0 && cssEnd > cssAt,
    '找不到指令行的样式（锚点对不上，别让这条断言静悄悄地空跑）')
  const css = html.slice(cssAt, cssEnd)
  const resAt = css.indexOf('.cmd .cmd-res')
  assert.ok(resAt > 0, '找不到命令结果的样式')
  // 只取这一条规则本身（到它的 `}` 为止）：切太宽会把下面别的区块的
  // `text-overflow: ellipsis`（比如 .chip .nm）也算进来，断言就不是这条规则的事了。
  const rest = css.slice(resAt)
  const res = rest.slice(0, rest.indexOf('}') + 1)
  assert.ok(!/\.cmd \.cmd-res \{[^}]*flex:\s*0\s+0/.test(css),
    'flex: 0 0 auto 就是「一行放完」，长结果必顶出框')
  assert.match(res, /min-width:\s*0/, '不许窄于内容，就折不了行')
  assert.match(res, /overflow-wrap:\s*anywhere/, '长英文串、路径不认换行，得允许从任意处断开')
  assert.ok(!/overflow-x/.test(res), '结果是正文，不许横向滚动')
  assert.ok(!/text-overflow/.test(res), '也不许省略号截断——用户要的是读全')
})

test('标签让位给结果：长结果那条不许把标签推出来', () => {
  // 长结果那条命令里，DSH 给的结果文本本身已经带着「/doctor: …」，
  // 所以标签这时候必须照旧让到 0（今天的观感），否则会重复显示一遍指令名。
  const css = html.slice(html.indexOf('.cmd {'), html.indexOf('.cmd-row'))
  const line = css.slice(css.indexOf('.cmd .cmd-line'), css.indexOf('.cmd .cmd-res'))
  // 只取规则本身（到第一个 `}` 为止）：注释里会引用旧的 `flex: 0 0 auto` 当例子，
  // 整段丢给正则会被那行例子先命中。
  const rule = line.slice(0, line.indexOf('}') + 1)
  const shrink = /flex:\s*0\s+(\d+)\s+auto/.exec(rule)
  assert.ok(shrink, '标签要写清收缩权重，别用默认值')
  assert.ok(Number(shrink[1]) >= 2,
    '标签的收缩权重要明显大于结果，长结果才先挤标签、后折结果')
  assert.match(rule, /text-overflow:\s*ellipsis/, '短行时标签照旧要能省略着显示')
})

test('单帧模式：历史里最后一条是指令时，也要显示出来', () => {
  // 用户点一下 /compact，单帧模式整屏只有「最新一条回复」——而指令不产生回复，
  // 不特意画它的话，屏幕上就是一动不动，看着像点了个没反应的按钮。
  const out = renderMinimalWith({
    running: false,
    latest: { text: '上一步的答案', timestamp: 100 },
    history: [
      { role: 'assistant', text: '上一步的答案', timestamp: 100 },
      { role: 'command', commandId: 'c1', name: 'compact', args: '', kind: 'success', text: '已压缩', timestamp: 200 },
    ],
  })
  assert.match(out, /上一步的答案/, '上一条回答照旧留着')
  assert.match(out, /cmd-line/, '指令行要露出来')
  assert.match(out, /\/compact/)
  assert.match(out, /已压缩/, '跑完了就说它跑完了')
})

test('单帧模式：最后一条不是指令时，不该冒出指令行', () => {
  const out = renderMinimalWith({
    running: false,
    latest: { text: '这次的答案', timestamp: 300 },
    history: [
      { role: 'command', commandId: 'c1', name: 'compact', args: '', kind: 'success', timestamp: 200 },
      { role: 'assistant', text: '这次的答案', timestamp: 300 },
    ],
  })
  assert.match(out, /这次的答案/)
  assert.ok(!out.includes('cmd-line'), '最后一条是回答，就不该有指令行')
})

test('单帧模式：新回答到了，底下不该再挂着上一条指令', () => {
  // 这道判断看着多余，其实是必须的：单帧模式的回答走 SSE 的 reply 那条路，
  // 它**不往 history 里塞**东西，所以 history 的尾巴会一直停在那条指令上。
  // 只按「最后一条是 command」判断的话，新回答下面会永远挂着一条过期指令。
  const out = renderMinimalWith({
    running: false,
    latest: { text: '这次的答案', timestamp: 300 },
    history: [
      { role: 'command', commandId: 'c1', name: 'compact', args: '', kind: 'running', timestamp: 200 },
    ],
  })
  assert.match(out, /这次的答案/)
  assert.ok(!out.includes('cmd-line'), '那条指令比手上的回答还旧，已经不是最新的事了')
})


/**
 * 上下文用量那句人话（2026-09-27 新增：手机上要看上下文窗口用量）。
 *
 * 只测那个**纯函数**：缺字段怎么办、超过窗口怎么显示。取数本身（sessionQuery 的
 * 会话投影）需要真环境，这里不测，留给真机验证——没有证据的部分不假装测过。
 */
const CTS = 'function contextLabel'
const CTE = 'function sel('
// 名字特意加前缀：这个文件上面已经用过 CS/CE/cs/ce 做另一处切片，
// 重名会让整个文件在加载时就报 "Identifier has already been declared"——**一失败就是全文件失败**，
// 而 node --test 的汇总里只看得到"文件级失败"，不容易看出是重名（2026-09-27 踩过）。
const cts = html.indexOf(CTS)
const cte = html.indexOf(CTE)
assert.ok(cts > 0, `在 page.html 里找不到锚点「${CTS}」`)
assert.ok(cte > cts, `在 page.html 里找不到锚点「${CTE}」，contextLabel 可能被挪走了`)

// eslint-disable-next-line no-new-func
const contextLabelOf = new Function(html.slice(cts, cte) + '\nreturn contextLabel;')()

test('上下文用量：缺一半就不说，超过窗口按 100% 显示', () => {
  assert.equal(contextLabelOf(42000, 200000), '21%')
  assert.equal(contextLabelOf(1000, 200000), '1%')
  assert.equal(contextLabelOf(0, 200000), '', '没用量就不显示，不写 0%')
  assert.equal(contextLabelOf(42000, undefined), '', '窗口不知道就不显示')
  assert.equal(contextLabelOf(undefined, 200000), '', '用量不知道就不显示')
  assert.equal(contextLabelOf(42000, 0), '', '窗口为 0 不显示（也别除零）')
  assert.equal(contextLabelOf(260000, 200000), '100%', '超过窗口按 100% 显示')
  assert.equal(contextLabelOf(-5, 200000), '', '负数当没有')
})

test('上下文用量：页面上是从接口的 context 字段取，再交给 contextLabel 说人话', () => {
  // 这条钉的是**接线**（服务端给 `context: {used, window}`，页面得真去读它、真拼进顶栏）。
  // 用户 2026-09-28 报「看不到这个数字」时，页面这段其实是好的，断在服务端取数上；
  // 但接线本身也该有断言看守，不然哪天被改断了没人知道。
  assert.match(html, /contextUsage = d\.context \|\| null/, '页面要说得出这份数从接口的哪个字段来')
  assert.match(html, /contextLabel\(contextUsage && contextUsage\.used, contextUsage && contextUsage\.window\)/,
    '取到的两半要原样交给那个纯函数，别在中间自己算一个')
})

test('排队框的叉号：要从被点的元素往上找按钮，不能直接读 e.target', () => {
  // 用户 2026-09-28 实机报「排队框的 ✗ 点了没反应」。成因不在接口，在接线：
  // ✗ 是按钮里的 SVG 图形，手指落上去 e.target 就是图形本身，直接读它身上的
  // data-drop 只能拿到 null，于是静默什么都不做。这条把它钉住。
  const from = html.indexOf("$('queue').addEventListener('click'");
  const to = html.indexOf('function paintWork');
  assert.ok(from > 0 && to > from, '排队框那段的锚点变了，先修测试')
  const block = html.slice(from, to)
  assert.ok(block.includes("closest('.q-drop')"), '点叉号时要往上找按钮，不能只看被点的那个元素')
  // 扫描前先剔掉注释：这段代码的注释里就引用着旧写法，不剔掉会把自己绊倒（本轮绊过一次）。
  const code = block.replace(/\/\/[^\n]*/g, '')
  assert.ok(!/e\.target\.getAttribute\(\s*'data-drop'/.test(code), '不能直接读被点元素身上的编号')
})
test('图没加载出来要说一声：error 挂捕获阶段，只认正文图片', () => {
  const at = html.indexOf("addEventListener('error'")
  assert.ok(at > 0, '没有监听图片加载失败：手机页里写错图片地址时，用户只会看到一个破图标')
  const block = html.slice(at, at + 900)
  assert.match(block, /classList\.contains\('md-img'\)/, '只该管正文里的图片，别把别的加载失败也报出来')
  assert.match(block, /,\s*true\)/, '图片的 error 不冒泡，挂在冒泡阶段一个也收不到')
  assert.match(block, /toast\(/, '要让用户知道为什么看不到，而不是只画个破图标')
})

// ---------------------------------------------------------------------------
// 子智能体完工的卡片（2026-10-03）
//
// 这条通知原来在手机上**整条不见了**：它挂在 `user/message` 上，而提取器只认
// `source.kind === 'user'`，于是被一起挡掉。现在它进得来了，这一组钉住的是
// **它长得对**：一张能展开的卡片、不是用户气泡、正文是转述不是回答。
// ---------------------------------------------------------------------------

const noticeMsg = (extra = {}) => ({
  role: 'notice',
  text: 'Background subagent session-child finished.\n\nIts closing message:\n\n两条依赖重复，已经删掉一条。',
  summary: 'Background subagent session-child finished.',
  senderSessionId: 'session-1234abcd-5678',
  timestamp: 300,
  ...extra,
})

test('聊天模式：完工通知画成一张可展开的卡片，不是用户气泡', () => {
  const out = renderChatWith({
    running: false,
    history: [
      { role: 'user', text: '派个活', timestamp: 1 },
      { role: 'assistant', text: '派出去了', timestamp: 2 },
      noticeMsg(),
    ],
  })

  // 展开/收起交给原生 <details>：不写一行脚本、不加一个关键帧，键盘和读屏也都认。
  assert.match(out, /<details class="sa-card">/, '通知要是一张能展开/收起的卡片')
  assert.match(out, /子智能体完工/, '要说清这是谁的消息')
  // 正文是 DSH 生成的**转述**：先说清「谁、为什么结束」，再把它自己的收尾原话接上。
  assert.match(out, /Background subagent session-child finished\./)
  assert.match(out, /Its closing message:/)
  assert.match(out, /两条依赖重复，已经删掉一条。/)
  // **不能**套成用户气泡：那会变成「我说过这句话」，是假的。
  assert.match(out, /<div class="sa-body">[\s\S]*?Background subagent/,
    '通知的正文要落在卡片正文里')
  const bubbles = [...out.matchAll(/class="bubble user"/g)].length
  assert.equal(bubbles, 1, '只有那句真的用户消息该是气泡，通知不掺进去')
})

test('完工卡片里的会话 id 要抹掉人人相同的那截前缀', () => {
  // 会话 id 都是 `session-xxxxxxxx-…` 开头。整段贴出来，一排卡片看着一模一样。
  const out = renderChatWith({ running: false, history: [noticeMsg()] })
  assert.ok(!out.includes('session-1234abcd'), '整段 id 贴出来，一排卡片看着一模一样')
  assert.match(out, />1234abcd</, '要显示真能区分它们的那几个字符')
})

test('完工卡片的正文是文本，不是能执行的 HTML', () => {
  const out = renderChatWith({
    running: false,
    history: [noticeMsg({ text: '<img src=x onerror=alert(1)> 收尾' })],
  })
  assert.ok(!/<img src=x/.test(out), '通知正文必须先转义再贴出来')
  assert.match(out, /&lt;img src=x/, '转义过的原文要照着显示')
})

test('单帧模式：通知是最后一条时露出来，被新回答顶掉后就不露了', () => {
  // 通知一到，父级通常会被唤醒作答。那条回答到了之后，通知就不该再占着最下面。
  const withNoticeLast = renderMinimalWith({
    running: false,
    history: [noticeMsg()],
    latest: null,
  })
  assert.match(withNoticeLast, /<details class="sa-card">/, '通知到了要看得见——那一段空窗里不能一动不动')

  const withNewerReply = renderMinimalWith({
    running: false,
    history: [noticeMsg({ timestamp: 100 })],
    latest: { text: '我看过了，没问题。', timestamp: 200 },
  })
  assert.ok(!withNewerReply.includes('sa-card'), '新回答到了，底下不该还挂着那条通知')
})

test('单帧模式：通知不占「最新一条回复」那个位置', () => {
  // 单帧模式显示的是模型的回答。通知占了那儿，用户会以为模型说了这串英文。
  const out = renderMinimalWith({
    running: false,
    history: [noticeMsg()],
    latest: { text: '模型说的是这句。', timestamp: 50 },
  })
  assert.match(out, /模型说的是这句。/)
  assert.ok(!/md[^>]*>[\s\S]{0,80}Background subagent/.test(out),
    '通知不该被当成正文画出来')
})

test('子智能体入口：紧挨在设置齿轮左边，还是那套 24 格线性图标', () => {
  // 用户点名要求：入口放在设置齿轮的**左边**。放在右边会把最右边那个惯用位置抢走。
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'))
  const sub = header.indexOf('id="btnSubagents"')
  const gear = header.indexOf('id="btnSettings"')
  assert.ok(sub > 0, '顶栏里没有子智能体入口')
  assert.ok(sub < gear, '入口要在设置齿轮左边')
  assert.ok(!header.slice(sub + 20, gear).includes('id="btn'), '这两个按钮之间不该再夹别的入口')
  assert.match(header, /id="btnSubagents" aria-label="子智能体"/, '要有说得出口的名字（读屏靠它）')
  // 和旁边那两个按钮同一套画法：24 格、只有描边、不填色。
  const svg = header.slice(sub, header.indexOf('</button>', sub))
  assert.match(svg, /viewBox="0 0 24 24"/, '要和旁边那两个同一套格子')
  assert.match(svg, /<circle /, '三个端点要画出来')
})

test('子智能体面板：外壳复用设置抽屉那一套，没有另起一套样式', () => {
  // 用户要求「复用既有抽屉与视觉样式」。这里钉住它确实复用了 .sheet，
  // 而不是又写了一个长得像的。
  const from = html.indexOf('<div id="subagents">')
  assert.ok(from > 0, '页面里没有子智能体面板')
  const block = html.slice(from, html.indexOf('<div id="gate">'))
  assert.match(block, /<div class="sheet">/, '面板外壳要用设置那一套 .sheet')
  for (const id of ['subagentsList', 'subagentsDoc', 'subagentsBack', 'subagentsClose', 'subagentsTitle']) {
    assert.ok(block.includes(`id="${id}"`), `面板里少了 id="${id}"`)
  }
})

test('完工卡片和列表行只用了既有令牌，一个新颜色都没造', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
  // 新造令牌要在深浅两套主题各写一份，漏一边就有元素在某个主题下隐身。
  // 这一块的做法是**一个都不造**，全用主屏已有的那几个。
  const sa = css.slice(css.indexOf('/* ---------- 子智能体'), css.indexOf('/* ---------- 显示区'))
  assert.ok(sa.length > 0, '找不到子智能体那段样式，锚点变了先修测试')
  const declared = [...sa.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])
  assert.deepEqual(declared, [], `子智能体那段不该声明新令牌：${JSON.stringify(declared)}`)
  // 强调色是**一屏最多两处**的稀缺资源，这一屏没有它。
  assert.ok(!sa.includes('var(--act)'), '子智能体这屏没有主按钮色的位置')
  assert.ok(!sa.includes('var(--gold)'), '子智能体这屏没有暖金字的位置')
})

// ---------------------------------------------------------------------------
// 统一操作面板（输入框旁边那一个入口点开的东西）
//
// 它把「添加文件」和「调用指令」合进一个入口：外壳复用设置抽屉那一套，指令数据复用
// state.commands 那份按会话缓存，附件复用 state.uploads + renderAttach()。这一组钉的
// 是「复用」和「一次点击不许直接执行」这两件事——它们最容易在后续改动里悄悄退化。
// ---------------------------------------------------------------------------

const OP_S = '// ---------------- 统一操作面板'
const OP_E = "$('btnAttach').addEventListener('click'"
const opS = html.indexOf(OP_S)
const opE = html.indexOf(OP_E)
assert.ok(opS > 0, `在 page.html 里找不到锚点「${OP_S}」`)
assert.ok(opE > opS, `在 page.html 里找不到锚点「${OP_E}」`)

/**
 * 把面板那一段抠出来跑。
 *
 * 面板自己不认识指令数据、也不认得上传通道——它全靠外面那几样（那条按会话缓存的
 * 指令表、pickCommand、renderAttach、dropUpload）。这里按名字把它们换成熟手替身，
 * 好断言「面板真的走了现成那条路」，而不是自己另写一份。
 */
function buildOps({
  commands = COMMANDS, commandsError = '', commandsFor = 's1', sessionId = 's1',
  filter = '', need = true,
} = {}) {
  const els = {}
  const listeners = {}
  const calls = []
  const drops = []
  const state = {
    commands, commandsError, commandsFor, commandsLoading: false,
    boundSessionId: sessionId, uploads: [], pendingCommand: null,
  }
  const input = {
    value: '', placeholder: '说点什么…', style: {}, scrollHeight: 40, blurred: 0,
    blur() { this.blurred += 1 }, focus() {}, setSelectionRange() {},
  }
  const el = (id) => (els[id] || (els[id] = {
    id, hidden: false, innerHTML: '', value: id === 'opsFilter' ? filter : '',
    attrs: {}, clicked: false,
    classList: {
      set: new Set(),
      add(c) { this.set.add(c) },
      remove(c) { this.set.delete(c) },
      contains(c) { return this.set.has(c) },
    },
    setAttribute(k, v) { this.attrs[k] = v },
    removeAttribute(k) { delete this.attrs[k] },
    click() { this.clicked = true },
    addEventListener(type, fn) { (listeners[id] = listeners[id] || {})[type] = fn },
  }))
  const sandbox = {
    state, inputEl: input, $: el,
    escapeHtml: md.escapeHtml,
    toast: () => {},
    needCommands: () => need,
    loadCommands: () => { calls.push({ path: '/mini/api/commands' }) },
    pickCommand: (name, defer) => { calls.push({ path: 'pick', name, defer }) },
    dropUpload: (btn) => { drops.push(btn.getAttribute('data-drop')) },
    renderAttach: () => {},
  }
  // eslint-disable-next-line no-new-func
  const build = new Function(...Object.keys(sandbox),
    `${html.slice(opS, opE)}\nreturn { openOps, closeOps, paintOps, openFilePicker };`)
  const fns = build(...Object.values(sandbox))
  return {
    ...fns, els, state, input, listeners, calls, drops,
    el, cmds: () => els.opsCmds, files: () => els.opsFiles,
  }
}

test('统一入口：回形针那个位置改成开面板，三个 id 一个都没动', () => {
  // 位置和尺寸是硬规矩（见 test/ui.test.mjs 那两条），所以入口**还是那一个按钮**，
  // 改的只是点了之后干什么。
  assert.match(html, /id="btnAttach"/, '要有那个入口按钮')
  assert.match(html, /id="filePick"[^>]*hidden/, '文件选择器仍旧藏着')
  assert.match(html, /id="attachBar"/, '附件小条也在')
  const at = html.indexOf("$('btnAttach').addEventListener('click'")
  assert.ok(at > 0, '找不到入口按钮的点击接线')
  const body = html.slice(at, html.indexOf('});', at))
  assert.match(body, /openOps\(\)/, '点了要开统一面板')
  assert.ok(!/filePick'\)\.click\(\)/.test(body),
    '不许再直接开文件选择器——那正是「两个入口」的老样子')
})

test('统一面板：外壳复用设置抽屉那一套，上「添加文件」下「调用指令」', () => {
  const from = html.indexOf('<div id="ops">')
  assert.ok(from > 0, '页面里没有统一操作面板')
  const block = html.slice(from, html.indexOf('<div id="subagents">'))
  assert.match(block, /<div class="sheet">/, '面板外壳要用设置那一套 .sheet，不另起一套样式')
  for (const id of ['opsClose', 'opsPick', 'opsShot', 'opsFiles', 'opsFilter', 'opsCmds']) {
    assert.ok(block.includes(`id="${id}"`), `面板里少了 id="${id}"`)
  }
  assert.ok(block.indexOf('添加文件') > 0 && block.indexOf('调用指令') > 0)
  assert.ok(block.indexOf('添加文件') < block.indexOf('调用指令'), '上是添加文件、下是调用指令')
})

test('统一面板：打开就先收键盘、贴上抽屉，并按当前会话对齐指令表', () => {
  // 手上还没有这个会话的指令表（第一次打开就是这样）：要取，并且先占个位。
  const o = buildOps({ commands: null, commandsFor: null })
  o.openOps()
  // 抽屉贴着底边，键盘不收，它就被顶到看不见的地方。
  assert.equal(o.input.blurred, 1, '打开时要把键盘收起来')
  assert.ok(o.el('ops').classList.contains('open'), '抽屉要露出来')
  // 判据和打 / 时同一份（needCommands），不是面板专用的一套。
  assert.equal(o.calls.length, 1, `该取就取一次，实际 ${o.calls.length} 次`)
  assert.equal(o.calls[0].path, '/mini/api/commands')
  assert.match(o.cmds().innerHTML, /正在读取可用的指令…/, '取回来之前先占位，不留一片空白')
})

test('统一面板：这个会话的指令表已经取到了，就不再白取一次', () => {
  const o = buildOps({ need: false })
  o.openOps()
  assert.equal(o.calls.length, 0)
  assert.match(o.cmds().innerHTML, /data-cmd="compact"/, '直接画手上那份')
})

test('统一面板：列出这个会话的指令，名字和说明都在', () => {
  const o = buildOps()
  o.openOps()
  const out = o.cmds().innerHTML
  assert.match(out, /data-cmd="compact"/)
  assert.match(out, /压缩这个会话的上下文/, '说明要在，不能只有名字')
  assert.match(out, /data-cmd="cost"/, '别的指令不许漏')
})

test('统一面板：筛选框同时匹配名字和说明，顺手带个斜杠也算', () => {
  // 用户平时打指令就是 `/名字`，在搜索框里多半也会这么打。
  const byName = buildOps({ filter: '/c' })
  byName.paintOps()
  for (const name of ['compact', 'config', 'cost']) {
    assert.match(byName.cmds().innerHTML, new RegExp(`data-cmd="${name}"`), `/c 该筛出 ${name}`)
  }

  const byDesc = buildOps({ filter: '花掉' })
  byDesc.paintOps()
  assert.match(byDesc.cmds().innerHTML, /data-cmd="cost"/, '说明里的话也要搜得到')
  assert.ok(!byDesc.cmds().innerHTML.includes('data-cmd="compact"'), '对不上的不该留在列表里')
})

test('统一面板：搜不到也要说一句，不留白（空白看着像坏了）', () => {
  const o = buildOps({ filter: 'zzz没有这条' })
  o.paintOps()
  assert.match(o.cmds().innerHTML, /没有对得上的指令/)
})

test('统一面板：取不到指令时原样说原因，不显示成空列表', () => {
  const o = buildOps({
    commands: null,
    commandsError: '这个会话现在没在跑，指令要先让它跑起来（发一句话）。',
  })
  o.paintOps()
  const out = o.cmds().innerHTML
  assert.match(out, /这个会话现在没在跑/, '服务端那句话要原样显示')
  assert.ok(!out.includes('cmd-row'), '空列表看着就像「这个会话没有指令」，是另一回事')
})

test('统一面板：声明要附件的指令如实标一句，不假装支持', () => {
  const o = buildOps({
    commands: [
      { name: 'goal', description: '设一个目标', hint: '要做什么？', attachments: true },
      { name: 'compact', description: '压缩上下文', hint: null, attachments: false },
    ],
  })
  o.paintOps()
  const rows = o.cmds().innerHTML.split('<button')
  const goal = rows.find((r) => r.includes('data-cmd="goal"'))
  const compact = rows.find((r) => r.includes('data-cmd="compact"'))
  assert.match(goal, /手机暂时带不了附件/, '这一轮带不了，就得写出来')
  assert.ok(!/手机暂时带不了附件/.test(compact), '没声明要附件的指令不该被盖上这面旗')
})

test('统一面板：点一行**不执行**，交给 pickCommand(名字, true) 填进输入框', () => {
  const o = buildOps()
  o.openOps()
  o.listeners.opsCmds.click({
    target: { closest: (sel) => (sel === '[data-cmd]' ? { getAttribute: () => 'config' } : null) },
  })
  assert.deepEqual(o.calls.filter((c) => c.path === 'pick'),
    [{ path: 'pick', name: 'config', defer: true }], '要走现成那条路，并且明确「先别跑」')
  assert.equal(o.calls.filter((c) => c.path === '/mini/api/command').length, 0,
    '一次点击不许直接执行——「要参数的指令不会误执行」是验收里的一条')
  assert.ok(!o.el('ops').classList.contains('open'), '挑完就收起来，别再挡着')
  // 面板里点那一行也不许自己执行：源码里连 runCommand 都不该出现。
  const body = html.slice(html.indexOf("$('opsCmds').addEventListener"), opE)
  assert.ok(!/runCommand\(/.test(body), '面板这一段不许直接执行指令')
  assert.match(body, /closest\('\[data-cmd\]'\)/, '要从被点的元素往上找那一行')
})

test('统一面板：已选文件那条 ✕ 走同一个 dropUpload，不直接读 e.target', () => {
  const o = buildOps()
  o.listeners.opsFiles.click({
    target: { closest: (sel) => (sel === '[data-drop]' ? { getAttribute: () => '1' } : null) },
  })
  assert.deepEqual(o.drops, ['1'], '面板和小条共用同一个去掉逻辑')
  const body = html.slice(html.indexOf("$('opsFiles').addEventListener"), opE)
  assert.match(body, /closest\('\[data-drop\]'\)/, '手指落在 ✕ 的图形上时，e.target 是那根线，不是按钮')
  assert.ok(!/e\.target\.getAttribute/.test(body))
})

test('统一面板：已选文件和附件小条是同一份数据、同一个渲染函数', () => {
  // 面板里再存一个附件数组的话，两处迟早对不上：面板里删了一条，小条还挂着，
  // 用户不知道该信哪个。
  const from = html.indexOf('function renderAttach')
  const to = html.indexOf('function dropUpload')
  assert.ok(from > 0 && to > from, '找不到 renderAttach / dropUpload')
  const body = html.slice(from, to)
  assert.match(body, /\$\('attachBar'\)/, '小条还是它画')
  assert.match(body, /\$\('opsFiles'\)/, '面板里那几行也得由它画，不许另写一个')
  assert.ok(!/state\.uploads\s*=\s*\[/.test(body), '不许在这里换掉那个数组')
})

test('统一面板：选文件和拍照都走原来那个藏起来的 file input', () => {
  const o = buildOps()
  o.openFilePicker(false)
  assert.equal(o.el('filePick').clicked, true, '选文件就是点那个 input')
  assert.equal(o.el('filePick').attrs.accept, undefined, '不挑类型的文件照旧不设 accept')
  o.openFilePicker(true)
  assert.equal(o.el('filePick').attrs.accept, 'image/*', '拍照只收图片')
  assert.equal(o.el('filePick').attrs.capture, 'environment', '后置摄像头')
  assert.ok(!/\/mini\/api\/upload/.test(html.slice(opS, opE)), '面板不许另造一条上传通道')
})

// ---------------------------------------------------------------------------
// 「完整」模式的轨迹区：三层折叠（组 → 步 → 正文）
// ---------------------------------------------------------------------------
//
// 前两棒把服务端推来的执行轨迹收进了 state.trajectory（只存不画），这一棒画它。
// 切片取 renderFull → applySnapshot：renderFull 与它后面的折叠逻辑、以及 render
// 按 state.mode 的分派整段都在里面——「思考只进完整模式」这条边界靠的正是那个
// 分派，切掉 render 就测不到了。锚点对不上会立刻断言失败，不会安静地退化成空测试。

function trajHarness(chat) {
  const START_AT = 'function renderFull'
  const END_AT = 'function applySnapshot'
  const a = html.indexOf(START_AT)
  const b = html.indexOf(END_AT)
  assert.ok(a > 0, `在 page.html 里找不到锚点「${START_AT}」`)
  assert.ok(b > a, `在 page.html 里找不到锚点「${END_AT}」`)

  const state = { mode: 'full', boundSessionId: 's1', trajectory: [], trajectoryLoading: false }
  const replyEl = {
    innerHTML: '',
    listeners: {},
    // 委托绑在容器上：这整块每次重绘都是全新 HTML，逐个绑必漏（和复制按钮同一根线）。
    addEventListener(type, fn) { this.listeners[type] = fn },
  }
  // 聊天那串的桩。不传 chat 时给一段可辨认的「聊天内容」；传了 chat.history
  // （[{role, turn, text}…]）就按消息逐条给行——穿插落点的判据靠它（行里带
  // data-turn，和真页面上消息带轮号是同一件事）。chat.all 是「滤掉排队那条之后
  // 的全量」，出窗判据（组跟消息走）靠它，默认与 history 同一份。
  const msgs = (chat && chat.history) || [{ role: 'user', turn: null, text: '聊天内容' }]
  const all = (chat && chat.all) || msgs
  const rows = msgs.map((m) => '<div class="chat-rows"'
    + (m.turn == null ? '' : ' data-turn="' + m.turn + '"') + '>' + m.text + '</div>')
  // renderChat 的桩（render() 分派到「聊天」模式时用）；完整模式的穿插走 buildChat——
  // 同一批行，但带结构（行数组 + 对应消息 + 全量），renderFull 要往行之间插过程组。
  const chatStub = () => { replyEl.innerHTML = rows.join('') }
  const buildChat = () => ({
    empty: null, moreNote: '', rows: rows.slice(), list: msgs.slice(), all: all.slice(),
  })
  // $ 的替身：按 id 记住同一个元素。搜索条是常驻元素，「输入框清没清空」这类判据
  // 要看到值的改动——每次返回新对象就什么都看不见了。
  const els = {}
  const $ = (id) => {
    if (!els[id]) els[id] = { textContent: '', innerHTML: '', hidden: false, value: '' }
    return els[id]
  }

  // eslint-disable-next-line no-new-func
  const build = new Function(
    'state', 'replyEl', 'escapeHtml', 'renderChat', 'renderMinimal', 'modeHint', '$',
    'buildChat', 'mainEl', 'atBottom', 'scrollChat',
    `${html.slice(a, b)}
     return { render, renderFull, toggleTrajGroup, toggleTrajEntry, state, replyEl, getEl: $ };`,
  )
  return build(
    state, replyEl, md.escapeHtml,
    chatStub,
    () => { replyEl.innerHTML = '' },
    () => '',
    $,
    buildChat,
    { classList: { remove() {} } },
    () => false,
    () => {},
  )
}

/** 一条工具步的通用样子；第二个参数按需覆盖（轮号、状态、正文……）。 */
function trajTool(id, over = {}) {
  return Object.assign({
    id, turn: 1, step: 1, kind: 'tool', name: '读文件',
    args: '{"path":"a.txt"}', summary: 'a.txt', output: '读到了甲',
    state: 'ok', error: null, truncated: null, timestamp: 1,
  }, over)
}

test('完整模式：已结束的两步组默认收成一行，切开才见条目与正文', () => {
  const h = trajHarness()
  h.state.trajectory = [{
    turn: 1, state: 'done', reason: 'completed',
    entries: [
      trajTool('k1', { name: 'read' }),
      trajTool('k2', { step: 2, name: 'write', summary: 'b.txt', output: '写完了乙' }),
    ],
  }]
  h.render()
  const out = h.replyEl.innerHTML
  assert.match(out, /data-traj-group="1"/, '组头在（过程组直接穿插在对话流里，没有整块轨迹区）')
  assert.match(out, /已读取文件并写入文件/, '收成的那一行是 PC 同款组合标题（前两类「并」起来）')
  assert.ok(!out.includes('data-traj-entry='), '默认收着：条目行不该出现')
  assert.ok(!out.includes('读到了甲') && !out.includes('写完了乙'), '条目名与正文都收起来')
  assert.ok(out.indexOf('chat-rows') < out.indexOf('data-traj-group="1"'),
    '默认桩的消息没有轮号：过程组按兜底规则落页尾（消息带轮号时落原位，见穿插那组测试）')

  h.toggleTrajGroup(1)
  const open = h.replyEl.innerHTML
  assert.ok(open.includes('data-traj-entry="k1"'), '切一下组，条目行出现')
  assert.ok(open.includes('写入') && open.includes('b.txt'),
    '条目行 = PC 的工具显示名 · 参数摘要（tool.title.* 的叫法）')
  assert.ok(!open.includes('写完了乙'), '正文还收着，那是条目级的事')

  h.toggleTrajEntry('k1')
  assert.ok(h.replyEl.innerHTML.includes('读到了甲'), '点开条目才见正文（工具给参数+结果）')
  h.toggleTrajEntry('k1')
  assert.ok(!h.replyEl.innerHTML.includes('读到了甲'), '再点一下收起')

  assert.equal(typeof h.replyEl.listeners.click, 'function', '点击走容器委托，不逐条绑')
})

test('完整模式：turn/end 收官的组按服务端真实字典（done）叫「已完成」，不许误标进行中', () => {
  // 服务端收官走 turnStateOf：completed → 'done'（lib/trajectory.js:140），组状态字典里
  // 从来没有 'ok'——真机上组头全是 done，认不出就落到兜底「进行中」，跑完的轮全在转圈。
  const h = trajHarness()
  h.state.trajectory = [{
    turn: 7, state: 'done', reason: 'completed',
    entries: [
      trajTool('d1', { turn: 7, name: 'read' }),
      trajTool('d2', { turn: 7, step: 2, name: 'write', summary: 'b.txt', output: '写完了乙' }),
    ],
  }]
  h.render()
  const out = h.replyEl.innerHTML
  assert.match(out, /data-traj-group="7"/, '组头在')
  assert.match(out, /已读取文件并写入文件/, 'done 的组头是 PC 的组合标题，本身就是「已完成」的意思')
  assert.ok(!/进行中/.test(out), '跑完的组头不许再说进行中')
  assert.ok(!out.includes('data-traj-entry='), '已结束的两步组默认收着（9.3-3 不变）')
})

test('完整模式：running 的组不收，条目一直看得见', () => {
  const h = trajHarness()
  h.state.trajectory = [{
    turn: 2, state: 'running', reason: null,
    entries: [
      trajTool('r1', { turn: 2, state: 'running', output: null, name: 'read' }),
      trajTool('r2', { turn: 2, step: 2, state: 'running', output: null, name: 'read' }),
    ],
  }]
  h.render()
  const out = h.replyEl.innerHTML
  assert.match(out, /data-traj-group="2"/, '组头照画')
  assert.ok(out.includes('正在读取文件'), '跑着的组头挂 PC 的活动词（正在…）')
  assert.ok(out.includes('data-traj-entry="r1"'), '还在跑的组随时要看新条目，不许收')
})

test('完整模式：跑着但还没条目的组也要露头——「正在分析请求」就是进展本身', () => {
  // turn/start 到了、模型还在想：条目要等这一步说完才落（事件就是这么给的）。
  // 这期间「没有条目」不等于「没有动静」——整组不画的话，用户看到的就是
  // 「跑完之后所有步骤一次性全冒出来」（2026-10-04 真机报告的正是这个）。
  const h = trajHarness()
  h.state.trajectory = [{ turn: 6, state: 'running', reason: null, entries: [] }]
  h.render()
  const out = h.replyEl.innerHTML
  assert.ok(out.includes('data-traj-group="6"'), '组头在，哪怕它还一条条目都没有')
  assert.ok(out.includes('正在分析请求'), '活动词照 PC 的兜底词：正在分析请求')
})

test('完整模式：跑完仍然一条条目都没有的组不画（没过程就是没过程）', () => {
  const h = trajHarness()
  h.state.trajectory = [{ turn: 6, state: 'done', reason: 'completed', entries: [] }]
  h.render()
  assert.ok(!h.replyEl.innerHTML.includes('data-traj-group'),
    '收官还是空的组不冒头——露头的只有「正在跑」的那种')
})

test('完整模式：单条组不收组级，那一步直接看得见', () => {
  const h = trajHarness()
  h.state.trajectory = [{
    turn: 3, state: 'done', reason: null,
    entries: [trajTool('s1', { turn: 3, name: 'read' })],
  }]
  h.render()
  const out = h.replyEl.innerHTML
  assert.ok(out.includes('data-traj-group="3"'), '组头在')
  assert.ok(out.includes('已读取文件'), '单条组的标题就是那一类的完成词')
  assert.ok(out.includes('data-traj-entry="s1"'), '单条收起来只剩一行没有信息量，不收')
  assert.ok(!out.includes('读到了甲'), '但正文仍是条目级的事，默认收着')
})

test('完整模式：出错的组自动摊到条目级，不用人点', () => {
  const h = trajHarness()
  h.state.trajectory = [{
    turn: 4, state: 'error', reason: 'failed', entries: [trajTool('e1'), trajTool('e2', { step: 2 })],
  }]
  h.render()
  assert.ok(h.replyEl.innerHTML.includes('data-traj-entry="e1"'),
    '出了错的组要把每一步摊出来给人看')
})

test('聊天模式：手里有轨迹也一块都不画（思考只进完整模式）', () => {
  const h = trajHarness()
  h.state.mode = 'chat'
  h.state.trajectory = [{
    turn: 5, state: 'ok', reason: null, entries: [trajTool('c1', { turn: 5 })],
  }]
  h.render()
  const out = h.replyEl.innerHTML
  assert.match(out, /chat-rows/, '聊天照常画')
  assert.ok(!out.includes('data-traj-') && !out.includes('class="traj"'),
    '轨迹区块一个字都不许出现——分派只认 state.mode')
})

test('完整模式：没轨迹就不画轨迹区；「正在读取」那句照旧垫在最前面', () => {
  const h = trajHarness()
  h.render()
  assert.equal(h.replyEl.innerHTML, '<div class="chat-rows">聊天内容</div>',
    '无轨迹且不在 loading：完整模式的观感同聊天，是预期')
  h.state.trajectoryLoading = true
  h.render()
  const out = h.replyEl.innerHTML
  assert.ok(out.startsWith('<div class="history-note">正在读取这个会话的过程…</div>'),
    'loading 注记保留在最前，这句和它的位置都不能动')
  assert.ok(!out.includes('class="traj"'), 'loading 不等于有轨迹：轨迹区还是不画')
})

// ---------------------------------------------------------------------------
// 「完整」模式的四类状态呈现：失败 / 进行中 / 截断 / 服务端「不是全部」的说明
// ---------------------------------------------------------------------------
//
// 上一棒把三层折叠画出来了，这一棒补状态的呈现细节。口径都钉在「折叠处一眼可见」
// 上：失败首行收着的时候就得在；进行中要有字样且零动效；截断按 truncated 字段
// 如实标（N 是原始总字符数，措辞照 lib/trajectory.js 的 clipForTrajectory）；
// 服务端的说明「存在才显示」，一个字都没有时不许凭空冒出来。

test('完整模式：失败原因首行顶在折叠处（错误色），点开正文仍见参数与结果', () => {
  const h = trajHarness()
  h.state.trajectory = [{
    turn: 4, state: 'error', reason: null,
    entries: [
      trajTool('e1', {
        turn: 4, state: 'error',
        error: { name: 'Error', code: null, reason: '读不到 a.txt\n第二行是细节' },
        output: '部分结果',
      }),
      trajTool('e2', { turn: 4, step: 2 }),
    ],
  }]
  h.render()
  const closed = h.replyEl.innerHTML
  assert.match(closed, /class="traj-err"[^>]*>读不到 a\.txt</,
    '失败首行要在折叠处可见，且挂 .traj-err 交给 CSS 上错误色')
  assert.ok(!closed.includes('第二行是细节'), '只露首行：细节留在正文里点开看')
  assert.ok(!closed.includes('部分结果'), '折叠处不提前甩正文')

  h.toggleTrajEntry('e1')
  const open = h.replyEl.innerHTML
  assert.ok(open.includes('参数：'), '点开正文仍见 args')
  assert.ok(open.includes('部分结果'), '点开正文仍见 output')

  // 组头同一口径：手动把出错的组收起来，失败首行还得挂在组头上。
  h.toggleTrajGroup(4)
  const shut = h.replyEl.innerHTML
  assert.ok(!shut.includes('data-traj-entry='), '组确实收着')
  assert.match(shut, /class="traj-err"[^>]*>读不到 a\.txt</, '收着的组头也带失败首行')
})

test('完整模式：进行中有明确标识，轨迹区零动效（有标识但不闪）', () => {
  const h = trajHarness()
  h.state.trajectory = [{
    turn: 2, state: 'running', reason: null,
    entries: [trajTool('r1', { turn: 2, state: 'running', output: null })],
  }]
  h.render()
  const out = h.replyEl.innerHTML
  assert.equal((out.match(/class="traj-run"/g) || []).length, 2,
    '组头和条目行各挂一个「进行中」标识')
  assert.ok(out.includes('进行中'), '标识要写人话：进行中')

  h.state.trajectory[0].state = 'ok'
  h.state.trajectory[0].entries[0].state = 'ok'
  h.render()
  assert.equal((h.replyEl.innerHTML.match(/class="traj-run"/g) || []).length, 0,
    '跑完就摘掉标识，不许留着谎报')

  // 颜色与「不闪」都在样式里钉：颜色只从现成令牌取，轨迹区一个动效都不加。
  const trajCss = html.slice(html.indexOf('.traj-group {'), html.indexOf('/* ---------- 设置抽屉'))
  assert.ok(trajCss.length > 0, '锚点：轨迹样式块要找得到')
  assert.match(trajCss, /\.traj-err\s*\{[^}]*color:\s*var\(--err\)/, '失败首行走 --err')
  assert.match(trajCss, /\.traj-run\s*\{[^}]*color:\s*var\(--run\)/, '进行中行走 --run')
  assert.ok(!/@keyframes|animation\s*:/.test(trajCss), '轨迹区零动效：有标识但不闪')
})

test('完整模式：截断如实标注——truncated 在场就写明原始总字符数，没截的不瞎标', () => {
  const h = trajHarness()
  h.state.trajectory = [{
    turn: 1, state: 'ok', reason: null,
    entries: [
      trajTool('t1', {
        args: '{"path":"big.txt"}', output: '前四千字符的正文',
        truncated: { args: { chars: 4000, total: 49930 }, output: { chars: 4000, total: 12345 } },
      }),
      trajTool('t2', { step: 2, output: '完整正文' }),
    ],
  }]
  h.render()
  h.toggleTrajGroup(1) // 两条的已完成组默认收着
  h.toggleTrajEntry('t1')
  const out = h.replyEl.innerHTML
  assert.ok(out.includes('已截断，共 49930 字符'),
    '参数截断：N 是原始总字符数（chars 是留下的那段，不拿它充数），措辞照 lib/trajectory.js')
  assert.ok(out.includes('已截断，共 12345 字符'), '结果截断同样标出来，绝不静默砍尾')
  h.toggleTrajEntry('t1')
  h.toggleTrajEntry('t2')
  assert.ok(!h.replyEl.innerHTML.includes('已截断'), '没截的条目正文一个字都不标')
})

test('完整模式：服务端「这份轨迹不是全部」的说明按实况展示，没有就不吭声', () => {
  // 11.1-C：搜索框删了，说明挪进轨迹内容里（跟着过程组走；轨迹空了兜底页尾）。
  const h = trajHarness()
  h.state.trajectory = [{
    turn: 1, state: 'done', reason: null, entries: [trajTool('n1', { name: 'read' })],
  }]
  h.render()
  assert.ok(!h.replyEl.innerHTML.includes('traj-note'),
    '没给说明就不显示——空态观感和聊天保持一致')

  h.state.trajectoryNote = '轨迹只显示最近一段（读取上限：120 条）'
  h.render()
  assert.match(h.replyEl.innerHTML,
    /class="traj-note"[^>]*>轨迹只显示最近一段（读取上限：120 条）</,
    '服务端给的原句原样显示')
  assert.ok(h.replyEl.innerHTML.indexOf('traj-note') < h.replyEl.innerHTML.indexOf('data-traj-group'),
    '说明跟在轨迹内容里、排在第一个过程组前面')

  // 只有截断标志、没有句子（服务端实况里两者同生同灭，这里钉兜底）：也得有话说。
  h.state.trajectoryNote = ''
  h.state.trajectoryTruncated = true
  h.render()
  assert.match(h.replyEl.innerHTML, /class="traj-note"/, '截断标志在场就要出说明')

  // 手里空了但服务端留了话（读取失败那条路）：话还得说——「读不到」不等于「没有过程」。
  h.state.trajectory = []
  h.state.trajectoryTruncated = false
  h.state.trajectoryNote = '读不到这个会话的过程。'
  h.render()
  assert.match(h.replyEl.innerHTML,
    /class="traj-note"[^>]*>读不到这个会话的过程。</,
    '轨迹空了，说明照说（兜底页尾）')

  h.state.trajectoryNote = ''
  h.render()
  assert.ok(!h.replyEl.innerHTML.includes('traj-note'), '说明撤了就彻底不占地方')
})

// ---------------------------------------------------------------------------
// 轨迹的接线四件套：订阅建立 / 收帧 / GET 整份替换 / loading
// ---------------------------------------------------------------------------
//
// 90440b3 落地时零测试，这里补上。切片取 function trajectoryKeyOf → var $ = function：
// 四件套在这一段里连续排布，$ 起就进 DOM 小工具了。render/api/connect 都给桩——
// 这里测的是「什么时候发什么、state 怎么变」，画面上的事归上面的折叠测试管。
// subscribedClientId 是页面的外层变量，切片里只写不声明：桩里补一个同名 var，
// 才能断言「退订后记号清没清」这种跨调用的状态。

function wiringHarness(apiImpl) {
  const START_AT = 'function trajectoryKeyOf'
  const END_AT = 'var $ = function (id)'
  const a = html.indexOf(START_AT)
  const b = html.indexOf(END_AT)
  assert.ok(a > 0, `在 page.html 里找不到锚点「${START_AT}」`)
  assert.ok(b > a, `在 page.html 里找不到锚点「${END_AT}」`)

  const state = {
    mode: 'full', token: 'tk', boundSessionId: 's1',
    trajectory: [], trajectorySeq: 0, trajectoryEpoch: '',
    trajectoryLoading: false, trajectoryNote: '', trajectoryTruncated: false,
  }
  const log = [] // 每次 api() 的 url + opts，先记账再交给桩
  const api = (url, opts) => {
    log.push({ url, opts })
    return apiImpl
      ? apiImpl(url, opts)
      : Promise.resolve({ ok: true, turns: [], seq: 0, truncated: false, note: null, loading: false })
  }
  let connects = 0
  // eslint-disable-next-line no-new-func
  const build = new Function(
    'state', 'api', 'render', 'connect', 'clientId',
    `var subscribedClientId = '';
     ${html.slice(a, b)}
     return {
       syncTrajectorySubscription, receiveTrajectoryFrame, setTrajectoryFromGet,
       requestTrajectory,
       subscribed() { return subscribedClientId },
     };`,
  )
  const h = build(state, api, () => {}, () => { connects += 1 }, 'c1')
  return { state, log, h, connects: () => connects }
}

/** 把挂起的微任务排干净（POST 的 .then、GET 的回包都靠它落地）。 */
const tick = () => new Promise((r) => setTimeout(r, 0))

test('轨迹接线：订阅跟着「完整」开关走——切进先 POST 订上再 GET 对齐，切走 POST 退订并清记号', async () => {
  const w = wiringHarness()
  w.state.mode = 'chat'
  w.h.syncTrajectorySubscription()
  assert.equal(w.log.length, 0, '不是完整模式：一个请求都不发')

  w.state.mode = 'full'
  w.h.syncTrajectorySubscription()
  assert.equal(w.log.length, 1, '没订过：先 POST 订上这一条')
  assert.match(w.log[0].url, /\/mini\/api\/trajectory\/subscribe/)
  const on = JSON.parse(w.log[0].opts.body)
  assert.equal(on.clientId, 'c1', 'POST 要带自己的 clientId')
  assert.equal(on.on, true, '这是「订上」')
  await tick()
  assert.equal(w.h.subscribed(), 'c1', '订成功才记下「已订」')
  assert.ok(w.log.some((c) => /\/mini\/api\/trajectory\?sessionId=s1/.test(c.url)),
    '订上之后 GET 一次，把手里的换成服务端那份')

  w.h.syncTrajectorySubscription()
  assert.equal(w.log.filter((c) => /subscribe/.test(c.url)).length, 1,
    '已经订过：再同步只 GET 对齐，不重复 POST')
  assert.equal(w.log.filter((c) => /\/mini\/api\/trajectory\?/.test(c.url)).length, 2,
    '已订状态下的同步补一次 GET')

  w.state.mode = 'chat'
  w.h.syncTrajectorySubscription()
  assert.equal(w.h.subscribed(), '', '退订要立刻清「已订」记号——不许留着骗下次')
  const last = w.log[w.log.length - 1]
  assert.match(last.url, /subscribe/, '切走发的是退订')
  const off = JSON.parse(last.opts.body)
  assert.equal(off.on, false, 'on:false 才是退订')
  assert.equal(off.clientId, 'c1', '退的是当初订的那条连接')

  // POST 回 404：这条流不在了（服务重启/断流没重连），当场 connect() 重连一次。
  const w2 = wiringHarness((url, opts) => (opts && opts.method === 'POST'
    ? Promise.reject(Object.assign(new Error('gone'), { status: 404 }))
    : Promise.resolve({ ok: true, turns: [], seq: 0 })))
  w2.h.syncTrajectorySubscription()
  await tick()
  assert.equal(w2.connects(), 1, '404 = 流没了：立刻重连')
})

test('轨迹接线：收帧按 id 增补改、seq 只进不退，跳一截不硬拼而是 GET 重拉', () => {
  const w = wiringHarness(() => new Promise(() => {})) // GET 挂起：别让它把 state 换掉
  const f1 = {
    epoch: 'E1', seq: 1, sessionId: 's1', turn: 1,
    add: [{
      id: 'k1', turn: 1, step: 1, kind: 'tool', name: '读文件',
      args: null, summary: null, output: '甲', state: 'ok',
      error: null, truncated: null, timestamp: 1,
    }],
    update: [],
  }
  w.h.receiveTrajectoryFrame(f1)
  assert.equal(w.state.trajectory.length, 1, '没见过的轮次立一组')
  assert.equal(w.state.trajectory[0].entries.length, 1)
  assert.equal(w.state.trajectory[0].entries[0].output, '甲')
  assert.equal(w.state.trajectorySeq, 1, 'seq 收下')

  w.h.receiveTrajectoryFrame(f1)
  assert.equal(w.state.trajectory[0].entries.length, 1, '同帧重放按 id 认出是同一条，不长第二份')

  w.h.receiveTrajectoryFrame({
    seq: 2, turn: 1,
    update: [{ id: 'k1', state: 'error', output: '读失败', error: { name: 'Error', code: null, reason: '撞墙了' } }],
  })
  const e = w.state.trajectory[0].entries[0]
  assert.equal(e.state, 'error', 'update 改状态')
  assert.equal(e.output, '读失败', 'update 改正文')
  assert.equal(e.error.reason, '撞墙了', 'update 带上失败身份')
  assert.equal(w.state.trajectorySeq, 2, 'seq 跟着涨')

  w.h.receiveTrajectoryFrame({ seq: 3, turn: 1, update: [{ id: 'k1', state: 'stopped' }] })
  assert.equal(w.state.trajectory[0].entries[0].output, '读失败',
    '补丁里没带 output：不许把已有正文清空')

  w.h.receiveTrajectoryFrame({ seq: 2, turn: 1, update: [{ id: 'k1', state: 'ok' }] })
  assert.equal(w.state.trajectorySeq, 3, '旧帧（seq 更小）不许把 seq 退回去')

  w.h.receiveTrajectoryFrame({ seq: 9, turn: 1, update: [] })
  assert.equal(w.state.trajectorySeq, 9, '跳帧时 seq 先记到帧给的位置')
  assert.ok(w.log.some((c) => /\/mini\/api\/trajectory\?/.test(c.url)),
    '中间丢过帧：不硬拼增量，GET 重拉整份')
  assert.equal(w.state.trajectory[0].entries[0].output, '读失败',
    '重拉回来之前手里那份不许先被清掉')

  w.h.receiveTrajectoryFrame({ epoch: 'E2', seq: 1, turn: 1, add: [] })
  assert.deepEqual(w.state.trajectory, [], '换代（服务重启过）：旧代那份整份作废')
  assert.equal(w.state.trajectorySeq, 0, 'seq 跟着换代归零')
})

test('轨迹接线：GET 是整份替换——旧组清空、seq 对齐，说明与 loading 一起收下', () => {
  const w = wiringHarness()
  w.state.trajectory = [{ turn: 9, state: 'ok', reason: null, entries: [trajTool('old')] }]
  w.state.trajectorySeq = 3
  w.state.trajectoryLoading = true
  w.h.setTrajectoryFromGet({
    ok: true, seq: 12,
    turns: [{ turn: 2, state: 'running', reason: null, entries: [] }],
    truncated: true, note: '轨迹只显示最近一段（读取上限：120 条）', loading: false,
  })
  assert.equal(w.state.trajectory.length, 1)
  assert.equal(w.state.trajectory[0].turn, 2, '服务端那份整个换进来——不是往旧的里合')
  assert.equal(w.state.trajectorySeq, 12, 'seq 跟服务端对齐')
  assert.equal(w.state.trajectoryTruncated, true, '「不是全部」的标志收下')
  assert.equal(w.state.trajectoryNote, '轨迹只显示最近一段（读取上限：120 条）', '原句收下')
  assert.equal(w.state.trajectoryLoading, false, 'loading 如实收下')

  const kept = w.state.trajectory
  w.h.setTrajectoryFromGet({ ok: false, seq: 99, turns: [{ turn: 7, entries: [] }] })
  assert.equal(w.state.trajectorySeq, 12, '没读成的 GET 不许动手里那份')
  assert.strictEqual(w.state.trajectory, kept, 'ok 不为 true：整个当没看见')
})

test('轨迹接线：loading 随拉取起落——发出即真，回包/出错归假，出错写明原因', async () => {
  const w = wiringHarness()
  w.state.mode = 'chat'
  w.h.requestTrajectory()
  assert.equal(w.log.length, 0, '不是完整模式不拉')
  assert.equal(w.state.trajectoryLoading, false)

  w.state.mode = 'full'
  w.state.boundSessionId = ''
  w.h.requestTrajectory()
  assert.equal(w.log.length, 0, '没绑会话不拉——拉一个空 sessionId 只是白跑')
  assert.deepEqual(w.state.trajectory, [], '没绑会话时手里那份清空')
  assert.equal(w.state.trajectoryLoading, false, '没在拉就别说在拉')

  w.state.boundSessionId = 's1'
  w.h.requestTrajectory()
  assert.equal(w.log.length, 1)
  assert.match(w.log[0].url, /\/mini\/api\/trajectory\?sessionId=s1/)
  assert.equal(w.state.trajectoryLoading, true, '请求在途：loading 该是真的')
  await tick()
  assert.equal(w.state.trajectoryLoading, false, '回包收下：loading 归假')

  const w2 = wiringHarness(() => Promise.reject(new Error('网络断了')))
  w2.h.requestTrajectory()
  assert.equal(w2.state.trajectoryLoading, true, '发出那一刻先置真')
  await tick()
  assert.equal(w2.state.trajectoryLoading, false, '读失败也归假——不能一直转')
  assert.equal(w2.state.trajectoryNote, '读不到这个会话的过程。',
    '读不到就说读不到，不冒充「没有过程」')
})

// ---------------------------------------------------------------------------
// S5：「完整」模式的日常路径——翻更早记录、窗口口径、切模式
// ---------------------------------------------------------------------------
//
// 完整模式缺「往上滑再放一屏」：maybeGrowChat 第一道闸只认聊天，growChat 放完
// 又直画 renderChat——在完整模式下会把轨迹区抹掉。切片取 `var scrolledReplyAt`
// → `function applySnapshot`：renderChat、maybeGrowChat、growChat、renderFull 和
// 按模式分发的 render 整段都在里面，切掉 render 就测不到「走没走总分发」。
// 锚点对不上会立刻断言失败，不会安静地退化成空测试。

function fullPager({ history, trajectory = [] } = {}) {
  // renderFull 要在 replyEl 上绑轨迹委托，替身得具备 addEventListener（同 trajHarness）。
  const replyEl = {
    innerHTML: '',
    addEventListener() {},
  }
  const hintEl = { textContent: '' }
  const $ = (id) => (id === 'hintMode' ? hintEl : { textContent: '' })
  const mainEl = {
    classList: { remove() {} },
    scrollTop: 0,
    clientHeight: 0,
    get scrollHeight() {
      const n = (replyEl.innerHTML.match(/class="(?:said|bubble)/g) || []).length
      return 40 + 10 * n
    },
    getBoundingClientRect: () => ({ top: 0 }),
  }
  const state = {
    mode: 'full', boundSessionId: 's1', history, queued: [], live: '', latest: null,
    trajectory, trajectoryLoading: false, historyTruncated: false,
  }
  const RS = 'var scrolledReplyAt'
  const RE = 'function applySnapshot'
  const a = html.indexOf(RS)
  const b = html.indexOf(RE)
  assert.ok(a > 0, `在 page.html 里找不到锚点「${RS}」`)
  assert.ok(b > a, `在 page.html 里找不到锚点「${RE}」`)
  // eslint-disable-next-line no-new-func
  const build = new Function(
    'state', 'replyEl', 'mainEl', 'timeLabel', '$', 'hintEl',
    `${html.slice(start, end)}\n${html.slice(a, b)}
     return { render, maybeGrowChat, state, mainEl, replyEl, hintEl };`,
  )
  const api = build(state, replyEl, mainEl, () => '12:00', $, hintEl)
  return Object.assign(api, {
    count: () => (replyEl.innerHTML.match(/class="(?:said|bubble)/g) || []).length,
  })
}

test('完整模式：往上滑也一屏一屏往前放，放完走 render() 总分发（轨迹区不许被画没）', () => {
  const p = fullPager({
    history: longHistory(200),
    trajectory: [{ turn: 1, state: 'ok', entries: [trajTool('k1'), trajTool('k2', { step: 2 })] }],
  })
  p.render()
  assert.equal(p.count(), 40, '首屏口径与聊天一致：只铺最近 40 条')
  assert.ok(p.replyEl.innerHTML.includes('第 161 条') && !p.replyEl.innerHTML.includes('第 160 条'),
    '从最新往回数满 40 条，第 41 条留给下一屏（同聊天的裁剪口径）')
  assert.match(p.replyEl.innerHTML, /data-traj-group/, '过程组在：完整模式画的就是聊天+穿插的轨迹')

  p.mainEl.scrollTop = 30
  const fromBottom = p.mainEl.scrollHeight - p.mainEl.scrollTop
  p.hintEl.textContent = ''
  p.maybeGrowChat()
  assert.equal(p.count(), 80, '完整模式也要放一屏：40 + 40')
  assert.equal(p.mainEl.scrollHeight - p.mainEl.scrollTop, fromBottom,
    '位置补偿照旧：离底部的距离一格不动')
  assert.match(p.replyEl.innerHTML, /data-traj-group/,
    '放完过程组还要在——必须走 render() 总分发，直画 renderChat 会把它抹掉')
  assert.equal(p.hintEl.textContent, '完整：附加每一步过程',
    'hintMode 也由 render() 刷新过（renderChat 单画不会碰它）')

  p.mainEl.scrollTop = 400
  p.maybeGrowChat()
  assert.equal(p.count(), 80, '没靠近顶部就不该再放')

  p.state.mode = 'chat'
  p.render()
  assert.equal(p.count(), 80, '切到聊天：窗口跟着会话走，铺开的量不缩水')
})

test('SSE 推来的回复在「完整」模式也进聊天记录（单帧仍不进）', () => {
  // 3877 那个分支原来只认聊天：完整模式画的也是同一串聊天记录，回复落定却不追加，
  // 等于「跑完了页面上没这句」，要等下一份快照才补上。单帧渲染 latest、不画记录，
  // 不进才对——这条边界不能跟着一起放宽。
  const full = feedReply(
    { text: '跑完了。', sessionId: 's1', timestamp: 11 },
    { mode: 'full' },
  )
  assert.equal(full.state.history.length, 1, '完整模式渲染的就是聊天记录：回复落定必须追加')
  assert.equal(full.state.history[0].text, '跑完了。', '内容不能丢')

  const min = feedReply(
    { text: '单帧那条', sessionId: 's1', timestamp: 12 },
    { mode: 'minimal' },
  )
  assert.equal(min.state.history.length, 0, '单帧模式仍不往 history 里塞')
})

test('三档切换接线：minimal↔chat↔full 来回切，提示语跟着换、重画与轨迹订阅都喊到', () => {
  // 权限档位真机踩过「画得出、点不动」，档位切换同一条线：逻辑都在，缺的是有人喊。
  // 这里把切换那段接线连同真的 modeHint 一起切出来跑——三句话收在一处就是为了
  // 不走样（见 modeHint 注释），测试得钉死它们和 data-mode 一一对应。
  const A0 = "Array.prototype.forEach.call($('segMode')"
  const A1 = "Array.prototype.forEach.call($('segSound')"
  const M0 = 'function modeHint'
  const M1 = 'function renderFull'
  const idx = [A0, A1, M0, M1].map((s) => html.indexOf(s))
  assert.ok(idx.every((i) => i > 0), '四个锚点都要在 page.html 里找得到')
  assert.ok(idx[1] > idx[0] && idx[3] > idx[2], '锚点顺序不对，先修测试')

  const hintEl = { textContent: '' }
  const btns = ['minimal', 'chat', 'full'].map((m) => {
    const b = { dataset: { mode: m } }
    b.addEventListener = (type, fn) => { b[type] = fn }
    return b
  })
  const $ = (id) => (id === 'segMode' ? { children: btns } : hintEl)
  const store = {}
  const localStorage = { setItem(k, v) { store[k] = v }, getItem(k) { return store[k] } }
  const state = { mode: 'minimal' }
  const calls = { render: 0, syncTraj: 0, syncSeg: 0 }
  // eslint-disable-next-line no-new-func
  new Function('state', '$', 'localStorage', 'syncSeg', 'render', 'syncTrajectorySubscription',
    `${html.slice(idx[2], idx[3])}\n${html.slice(idx[0], idx[1])}\n`)(
    state, $, localStorage,
    () => { calls.syncSeg += 1 },
    () => { calls.render += 1 },
    () => { calls.syncTraj += 1 },
  )

  const click = (m) => btns.find((b) => b.dataset.mode === m).click()
  click('chat')
  assert.equal(state.mode, 'chat', '点档位要改 state.mode')
  assert.equal(hintEl.textContent, '聊天：常规问答对话', '切完提示语立即跟着换')
  click('full')
  assert.equal(hintEl.textContent, '完整：附加每一步过程', '切到完整：提示语也换')
  click('minimal')
  assert.equal(hintEl.textContent, '单帧：只留最新一条回复', '切回单帧：还是那句')
  click('full'); click('chat'); click('full')
  assert.equal(state.mode, 'full', '来回切不卡壳')
  assert.equal(store.dshMiniMode, 'full', '每次都落盘')
  assert.deepEqual(calls, { render: 6, syncTraj: 6, syncSeg: 6 },
    '每切一次都要重画、重同步按钮和轨迹订阅（缺一样就是真机上的死档位）')
})

// ---------------------------------------------------------------------------
// 轨迹样式对齐 PC（2026-10-03 用户需求，tasks/todo.md 第 11 节）
// ---------------------------------------------------------------------------
//
// 叫法照抄 DSH 桌面端（dsh-client-ui-chat / dsh-client-ui-tool 0.2.0-rc.1 的
// message.stepProcess.* 与 tool.title.*），一个字都不自创：组头是「动作分类的
// 完成词」（两类「并」、三类「，」、多于三类加「等」），条目行是「工具显示名 ·
// 参数摘要」，思考行是「思考 · 首行」。移动端适配只有点按展开这一件事。

test('完整模式：组头标题照抄 DSH 的拼法（并 / ， / 等）', () => {
  const h = trajHarness()
  // 两类：共享前缀「已」按 DSH 的规则去掉第二个，中间用「并」。
  h.state.trajectory = [{ turn: 1, state: 'done', reason: null, entries: [
    trajTool('a', { name: 'read' }), trajTool('b', { step: 2, name: 'subagent', summary: 'x' }),
  ] }]
  h.render()
  assert.match(h.replyEl.innerHTML, /已读取文件并协调子智能体/, '两类：「并」起来')
  // 三类：按 DSH 用「，」连。
  h.state.trajectory = [{ turn: 1, state: 'done', reason: null, entries: [
    trajTool('a', { name: 'read' }), trajTool('b', { step: 2, name: 'write' }),
    trajTool('c', { step: 3, name: 'edit' }),
  ] }]
  h.render()
  assert.match(h.replyEl.innerHTML, /已读取文件，已写入文件，修改了文件/, '三类：「，」连')
  // 多于三类：只取前三类，后面加「等」（DSH 的 more）。
  h.state.trajectory = [{ turn: 1, state: 'done', reason: null, entries: [
    trajTool('a', { name: 'read' }), trajTool('b', { step: 2, name: 'write' }),
    trajTool('c', { step: 3, name: 'edit' }), trajTool('d', { step: 4, name: 'pwsh' }),
  ] }]
  h.render()
  assert.match(h.replyEl.innerHTML, /修改了文件等/, '多于三类：前三类 + 「等」')
  // 只有思考：DSH 的 counts 里没有思考这一类，空了才落「已完成分析」。
  h.state.trajectory = [{ turn: 1, state: 'done', reason: null, entries: [
    trajTool('t', { kind: 'think', name: null, args: null, summary: null, output: '先想想' }),
  ] }]
  h.render()
  assert.match(h.replyEl.innerHTML, /已完成分析/, '纯思考组落「已完成分析」（DSH 的兜底词）')
})

test('完整模式：条目行用 PC 的工具显示名与摘要，思考行是「思考 · 首行」', () => {
  const h = trajHarness()
  h.state.trajectory = [{ turn: 1, state: 'running', reason: null, entries: [
    trajTool('p1', { name: 'pwsh', summary: 'dir', output: '结果甲' }),
    trajTool('t1', { step: 2, kind: 'think', name: null, args: null, summary: null,
      output: '先看目录结构\n第二行不进折叠处' }),
    trajTool('x1', { step: 3, name: 'mystery_tool', summary: 's1' }),
  ] }]
  h.render()
  const out = h.replyEl.innerHTML
  assert.match(out, /class="traj-name">运行命令<\/span><span class="traj-detail"> · dir/,
    'pwsh → PC 显示名「运行命令」，后面接参数摘要')
  assert.match(out, /class="traj-name">思考<\/span><span class="traj-detail"> · 先看目录结构/,
    '思考行 = 思考 · 首行')
  assert.ok(!out.includes('第二行不进折叠处'), '只露首行，剩下的在正文里')
  assert.match(out, /class="traj-name">工具调用<\/span><span class="traj-detail"> · s1/,
    '认不出的工具落 PC 的「工具调用」，摘要照给')
  assert.ok(!out.includes('结果甲'), '折叠处不提前甩正文（结果在点开的正文里）')
})

test('完整模式：鲸鱼娘、气泡、光流条收起来；页面上没有轨迹搜索框', () => {
  const h = trajHarness()
  h.render()
  assert.match(String(h.getEl('work').className), /\bbare\b/,
    '完整模式给「正在执行」块挂 bare：立绘 / 气泡 / 光流进度条由 CSS 藏掉')
  h.state.mode = 'chat'
  h.render()
  assert.ok(!/\bbare\b/.test(String(h.getEl('work').className)), '别的模式照旧，一个字不动')
  assert.match(html, /\.work\.bare \.work-top[^}]*display:\s*none/,
    'CSS 里要真有这条：bare 下 work-top（立绘+气泡）不画')
  assert.match(html, /\.work\.bare \.work-progress[^}]*display:\s*none/,
    'CSS 里要真有这条：bare 下光流进度条不画')
  // 搜索框是整条删掉（连元素带脚本），不是「藏起来」。
  assert.ok(!html.includes('id="trajSearch"'), '页面上不再有轨迹搜索框')
  assert.ok(!html.includes('onTrajectoryInput') && !html.includes('traj-hit'),
    '搜索链整条删干净（输入、高亮、命中强开都没了）')
})

// ---------------------------------------------------------------------------
// S8：轨迹穿插进对话（2026-10-03 用户裁决「一定要让执行轨迹的逻辑符合DSH本身」）
// ---------------------------------------------------------------------------
//
// DSH 聊天视图的「过程」节点长在每轮对话原位——指令之后、最终回答之前
// （turn-process）。落点四条（tasks/todo.md 10.3-1）：
//   a 该轮第一个回答之前（指令 → 过程 → 回答）；
//   b 该轮没有回答（跑着/失败）落该轮簇尾，活轮即页尾；
//   c 该轮有消息但都不在窗口里 → 不画（组跟消息走，翻页上来自然带进来）；
//   d 该轮一条消息都没有（排队被滤掉等）→ 兜底页尾。

test('完整模式·穿插：过程块插在本轮指令之后、回答之前（对齐 DSH）', () => {
  const h = trajHarness({ history: [
    { role: 'user', turn: 1, text: '第一问' },
    { role: 'assistant', turn: 1, text: '第一答' },
    { role: 'user', turn: 2, text: '第二问' },
    { role: 'assistant', turn: 2, text: '第二答' },
  ] })
  h.state.trajectory = [
    { turn: 1, state: 'done', reason: 'completed', entries: [trajTool('a1', { turn: 1 })] },
    { turn: 2, state: 'done', reason: 'completed', entries: [trajTool('b1', { turn: 2 })] },
  ]
  h.render()
  const out = h.replyEl.innerHTML
  const o = (s) => out.indexOf(s)
  assert.ok(o('第一问') < o('data-traj-group="1"') && o('data-traj-group="1"') < o('第一答'),
    '第 1 轮：指令 → 过程 → 回答')
  assert.ok(o('第二问') < o('data-traj-group="2"') && o('data-traj-group="2"') < o('第二答'),
    '第 2 轮同理，各在各的原位')
  assert.ok(o('第一答') < o('第二问'), '对话顺序不许被穿插打乱')
})

test('完整模式·穿插：跑着的轮（还没有回答）落在本轮簇尾，照旧摊开逐条冒', () => {
  const h = trajHarness({ history: [{ role: 'user', turn: 2, text: '正在问' }] })
  h.state.trajectory = [{
    turn: 2, state: 'running', reason: null,
    entries: [trajTool('r1', { turn: 2, state: 'running', output: null })],
  }]
  h.render()
  const out = h.replyEl.innerHTML
  assert.ok(out.indexOf('正在问') < out.indexOf('data-traj-group="2"'),
    '过程跟在指令后面（簇尾）——新步骤就从这里冒出来')
  assert.ok(out.includes('data-traj-entry="r1"'), '跑着的组不收，条目一直看得见')
})

test('完整模式·穿插：出窗的轮不画过程（组跟消息走，翻页带上来）', () => {
  const h = trajHarness({
    history: [{ role: 'user', turn: 8, text: '新问' }, { role: 'assistant', turn: 8, text: '新答' }],
    all: [
      { role: 'user', turn: 7, text: '老问' }, { role: 'assistant', turn: 7, text: '老答' },
      { role: 'user', turn: 8, text: '新问' }, { role: 'assistant', turn: 8, text: '新答' },
    ],
  })
  h.state.trajectory = [
    { turn: 7, state: 'done', reason: null, entries: [trajTool('old', { turn: 7 })] },
    { turn: 8, state: 'done', reason: null, entries: [trajTool('new', { turn: 8 })] },
  ]
  h.render()
  const out = h.replyEl.innerHTML
  assert.ok(!out.includes('data-traj-group="7"'), '第 7 轮的消息没铺出来，它的过程也不画')
  assert.ok(out.includes('data-traj-group="8"'), '窗口里的轮照画')
})

test('完整模式·穿插：该轮一条消息都没有（排队被滤掉等），兜底落页尾', () => {
  const h = trajHarness({ history: [{ role: 'user', turn: 1, text: '先问的' }] })
  h.state.trajectory = [{
    turn: 9, state: 'error', reason: null, entries: [trajTool('e1', { turn: 9 })],
  }]
  h.render()
  const out = h.replyEl.innerHTML
  assert.ok(out.indexOf('先问') < out.indexOf('data-traj-group="9"'),
    '兜底落页尾，不挤在别人中间')
})
