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
    'state', 'replyEl', 'mainEl', 'escapeHtml', 'mdToHtml', 'ICON_COPY',
    `${html.slice(rs, re)}\nreturn renderMinimal;`,
  )
  // build(...) 返回的是 renderMinimal 本身，还得**调用一次**才真的渲染。
  // ICON_COPY 要从真实源码里取（见上面 md 那段）——切片是从 renderMinimal 开始的，
  // 拿不到它上面定义的东西；编一个假的值就等于在测桩，不是在测页面。
  const renderMinimal = build(state, replyEl, mainEl, md.escapeHtml, md.mdToHtml, md.ICON_COPY)
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
    'state', 'replyEl', 'mainEl', 'escapeHtml', 'mdToHtml', 'ICON_COPY',
    `${html.slice(rs, re)}\nreturn renderMinimal;`,
  )
  const renderMinimal = build(state, replyEl, mainEl, md.escapeHtml, md.mdToHtml, md.ICON_COPY)
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
  const m = /<script>([\s\S]*)<\/script>/.exec(html)
  assert.ok(m, '页面里应该有且只有一个 <script> 块')
  const body = m[1]
  assert.ok(body.length > 1000, '抽出来的脚本太短了，正则可能没匹配对')
  // 只解析不执行：脚本顶层就要摸 DOM，这里要的只是「语法没过」这件事。
  assert.doesNotThrow(() => new Function(body), '页面脚本有语法错误')
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
  assert.match(row, /width:\s*max-content/, '行宽跟着内容走，将来有更长的词条也不会溢出')
  assert.match(row, /min-width:\s*min\(299px, 100%\)/, '最少要有最长那句的整组宽度')
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
  const css = html.slice(html.indexOf('.work-progress'), html.indexOf('.work-elapsed'))
  assert.match(css, /workSweep/, '要有流动动画')
  assert.match(css, /transform: translateX/, '靠位移流动，而不是靠改宽度')
  assert.ok(!/transition:\s*width/.test(css), '不该用宽度过渡假装进度在涨')
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
assert.ok(ws > 0, `在 page.html 里找不到锚点「${WS}」`)
assert.ok(we > ws, `在 page.html 里找不到锚点「${WE}」`)

/** 够用的元素桩：能存 class、文本、style，也能挂监听（停止按钮要用）。 */
function makeEl(id) {
  const el = {
    id, textContent: '', src: '', children: [], hidden: false, disabled: false,
    _cls: new Set(), style: {}, _on: {},
  }
  el.classList = {
    toggle(c, on) { if (on) el._cls.add(c); else el._cls.delete(c) },
    contains: (c) => el._cls.has(c),
  }
  el.appendChild = (c) => { el.children.push(c); return c }
  el.addEventListener = (type, fn) => { (el._on[type] || (el._on[type] = [])).push(fn) }
  el.click = () => { for (const fn of el._on.click || []) fn() }
  // preloadPoses 靠 `stage.innerHTML = ''` 清空重来，桩也得认这一句。
  // 同时把写进去的 HTML 记下来——队列那块是整段 innerHTML 拼出来的，
  // 不记的话「拼出来的到底是什么」就无从断言了。
  let written = ''
  Object.defineProperty(el, 'innerHTML', {
    get: () => written,
    set: (v) => { written = v == null ? '' : String(v); if (!written) el.children = [] },
  })
  return el
}

function buildWhale({ token = 'tok', reduced = false, apiRejects = false } = {}) {
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
      return apiRejects ? Promise.reject(new Error('停不下来')) : Promise.resolve({ ok: true })
    },
    $: (id) => els[id],
  }
  const names = ['POSES', 'state', 'work', 'posePool', 'poseSequence', 'paintPose', 'elapsedLabel',
    'artUrl', 'preloadPoses', 'startWork', 'stopWork', 'nextPose', 'paintWork', 'paintStop', 'requestStop',
    'paintQueue', 'requestUnqueue']
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
  assert.equal(w.els.workStage.children.length, n, `${n} 个姿势各一层`)
  assert.equal(w.els.workStage.children[0].style.backgroundImage,
    'url("/mini/art/work-1-ready.webp?token=abc%20def&v=abc123")',
    'token 要转义，指纹要带上')
  // #work 是 hidden，浏览器不会为它下载背景图，所以必须另有游离的 <img> 主动拉
  const warmed = w.created.filter((e) => e.id === 'img')
  assert.equal(warmed.length, n, '每一张都要主动预加载，不然第一次会闪空白')
  assert.equal(warmed[0].src, '/mini/art/work-1-ready.webp?token=abc%20def&v=abc123')
})

test('每个姿势的翻帧速度不一样，快的快、慢的慢', () => {
  // 敲键盘和小跑要快，端着茶等和托腮想事情要慢。一刀切的节奏看着像机器在闪。
  const w = buildWhale()
  w.preloadPoses()
  const dur = w.els.workStage.children.map((c) => parseFloat(c.style.animationDuration))
  assert.deepEqual(dur, w.POSES.map((p) => p.flip), '动画时长要跟着 POSES 里的 flip 走')
  assert.ok(dur.every((d) => d > 0.2 && d < 3), `时长要落在合理区间，实际 ${dur}`)
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
  w.state.queued = []
  w.paintQueue()
  assert.equal(w.els.queue.hidden, true)
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
     return { renderNav, sessionsHtml, createSession, setSessions: (v) => { navSessions = v } };`,
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

