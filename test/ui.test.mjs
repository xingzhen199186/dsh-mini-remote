/**
 * 界面规格的守卫。
 *
 * 用户 2026-09-27 定了这套视觉规格（"六关键词翻译表"）。它不该是一次性装修：
 * 以后谁再往 page.html 里加样式，都得先过这里。规格只写在注释里是会烂掉的，
 * 写成断言才拦得住——**尤其是"暖金一屏最多两处"这一条**，它最容易在后续开发里
 * 被当成"再强调一下也没关系"，一点点失控。
 *
 * 这里只读源码做静态检查，不开浏览器：page.html 是单文件模板，样式就是文本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../lib/page.html', import.meta.url), 'utf8')
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))

test('设计令牌：圆角只有 2px 一档，强调色是暖金 #c9a55c', () => {
  assert.match(css, /--r:\s*2px/, '卡片圆角必须是 2px')
  assert.match(css, /--gold:\s*#c9a55c/, '暖金必须是 #c9a55c')
  assert.match(css, /--ice:\s*#a9c8e8/, '冰蓝必须是 #a9c8e8')
  assert.ok(!/--accent:/.test(css), '旧的蓝色强调色 --accent 应该清干净了')
  assert.ok(!/--radius:/.test(css), '旧的 --radius 应该清干净了')
})

test('圆角只有 2px / 999px / 50% 三档，没有中间值', () => {
  const bad = []
  for (const m of css.matchAll(/border-radius:\s*([^;]+);/g)) {
    const value = m[1].trim()
    for (const part of value.split(/\s+/)) {
      if (part === '0' || part === '2px' || part === '50%' || part === '999px') continue
      if (part.startsWith('var(--r')) continue // var(--r, 2px) 这种带回落的写法
      bad.push(value)
      break
    }
  }
  assert.deepEqual(bad, [], `圆角出现了规格外的档位：${JSON.stringify(bad)}`)
})

test('动效只剩这六种关键帧：光标、立绘翻帧（两套）、上传转圈、进度条逐格推进、跑着的行扫光', () => {
  // 第四个是 2026-09-27 补回来的：进度条原来是静止的，用户实机看着像卡住了。
  // 它动的只有位置、宽度写死，所以不违背"别表演"那条——原委写在 page.html 的注释里。
  // 第五个（poseFlip6，2026-09-29）**不是新动效**：冲刺那张立绘从 2 帧变 6 帧，
  // 翻帧这同一件事要多一套关键帧（2 帧那套仍然是其余七个姿势在用的）。运动种类还是四种。
  // 第六个（shimSweep，2026-10-04）用户点名加的：「DSH 里某一行正在运行时会有一个
  // 渐变的效果闪过去，这种逻辑也可以做移动端上复现，但要适配具体的主题」——
  // 它是运行状态的指示（只挂跑着的行），不是"界面在表演"；亮色走 --shimmer 令牌，
  // 深浅两套主题各看各的，减少动效时整条关掉。
  const names = [...css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]).sort()
  assert.deepEqual(names, ['barStep', 'caret', 'poseFlip', 'poseFlip6', 'shimSweep', 'spin', 'subagent-spin'],
    '只允许这些：子智能体运行状态需要一个明确的入口动效，跑着的行需要一道扫光，其余都是"界面在表演"')
})

test('状态点不再闪动，只留 160ms 的颜色过渡', () => {
  const dot = css.slice(css.indexOf('.dot {'), css.indexOf('.icon-btn'))
  assert.ok(!/animation:/.test(dot), '状态点不该有动画（那圈呼吸闪动是视觉套话）')
  assert.match(dot, /transition:\s*background\s*\.16s/, '状态变化是瞬时的：160ms 颜色过渡')
})

test('强调色只许出现在清单里的这几处（一屏最多两处）', () => {
  // 强调色分两个角色，各自冻结一份清单：
  //   --act   当**底**用（一屏一个主按钮）；--gold 当**字/点**用（刻度上"当前这一步"）。
  // 深色下两者都是暖金 #c9a55c；浅色下 --act 换成宣传图的宝蓝、--gold 压深到 #8a6529
  // ——用户 2026-09-27 看过对照图后定的。
  // 要加一处，先回答"这一屏是不是已经有两处强调色了"，再改这里。
  const ALLOWED_ACT = [
    '.send',                                          // 主屏：发送键
    '.pick-here',                                     // 抽屉：选定这个工作区
    '.btn.primary',                                   // 设置：这一屏的主按钮
    '#gate button',                                   // 口令页：唯一的按钮
    '#askCard .qfoot button#askNext',                 // 答题卡：唯一的主按钮
    // 审批卡：唯一的主按钮。它是**整屏一层**（fixed/inset:0），和主屏、设置页、
    // 答题卡都不同时出现，所以这一屏上没有第二处当底的强调色（2026-09-27 加）。
    '#approveCard .afoot button#approveAllow',
  ]
  const ALLOWED_INK = [
    '.queue .q-node.cur i',                           // 主屏：当前这一步的点
    '.queue .q-node.cur b',                           // 主屏：当前这一步的序号
  ]
  function selectorsUsing(name) {
    const found = []
    for (const chunk of css.split('}')) {
      if (!chunk.includes('var(' + name + ')')) continue
      const brace = chunk.lastIndexOf('{')
      if (brace < 0) continue
      found.push(chunk.slice(0, brace).trim().split('\n').pop().trim())
    }
    return found
  }
  const act = selectorsUsing('--act')
  const ink = selectorsUsing('--gold')
  assert.ok(act.length > 0, '一个主按钮色都没找到，令牌接错了')
  for (const sel of act) {
    assert.ok(ALLOWED_ACT.includes(sel),
      `当底用的强调色跑到清单外了：「${sel}」——先确认这一屏是不是已经有两处了`)
  }
  for (const sel of ink) {
    assert.ok(ALLOWED_INK.includes(sel),
      `当字/点用的强调色跑到清单外了：「${sel}」——先确认这一屏是不是已经有两处了`)
  }
})

test('浅色主题覆盖了每一个颜色令牌（缺一个就有元素在那个主题下隐身）', () => {
  const darkFrom = css.indexOf(':root {')
  const dark = css.slice(darkFrom, css.indexOf('}', darkFrom))
  // 认**规则**，不是那串字——注释里也会提到 [data-theme="light"]，按字找会切到注释上。
  const lightFrom = css.indexOf('[data-theme="light"] {')
  assert.ok(lightFrom > 0, '找不到浅色主题那一块')
  const light = css.slice(lightFrom, css.indexOf('}', lightFrom))

  const namesIn = (block) => [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])
  // 只比"颜色"这一类：圆角 --r 是尺寸，两套主题共用一份，不该跟着主题变。
  const COLOUR = /^--(bg|bg-top|bg-deep|panel|panel-2|line|fg|muted|dim|ice|gold|act|ok|run|shimmer|err|sh-\d|glass|tint|pop|scrim|on-act)$/
  const want = namesIn(dark).filter((n) => COLOUR.test(n))
  const have = new Set(namesIn(light))
  assert.ok(want.length >= 21, `颜色令牌只认出 ${want.length} 个，大概正则写歪了`)
  assert.deepEqual(want.filter((n) => !have.has(n)), [],
    '浅色主题缺令牌：新加的颜色必须两套主题都写一份')
  // 用户 2026-09-27 的裁决：浅色下主按钮底用宣传图那个宝蓝，不当字用的金压深。
  assert.match(light, /--act:\s*#3b6fc4/, '浅色下主按钮底该是宝蓝')
  assert.match(light, /--gold:\s*#8a6529/, '浅色下当字用的金要压深，白底才读得清')
  assert.match(dark, /--act:\s*#c9a55c/, '深色下主按钮底还是暖金，别跟着变')
})

test('顶栏底栏是毛玻璃，且有不支持时的实色回落', () => {
  assert.match(css, /footer\s*\{[^}]*backdrop-filter/, '底栏该是悬浮毛玻璃')
  assert.match(css, /header\s*\{[^}]*backdrop-filter/, '顶栏也一样')
  assert.match(css, /-webkit-backdrop-filter/, 'iOS 上要带 -webkit- 前缀')
  assert.match(css, /@supports not/, '不支持毛玻璃时要退回实色，不能糊成一片')
})

test('工序刻度尺只表达队列，不假装知道 Agent 跑到哪一步', () => {
  const block = css.slice(css.indexOf('.queue .q-scale'), css.indexOf('.queue .q-row'))
  assert.ok(block.length > 0, '找不到刻度尺')
  assert.match(block, /q-node\.cur/, '当前这一步要有自己的样式')
  assert.match(block, /\.16s/, '节点由"待"变"过"是 160ms')
  // 最要紧的一条：界面上不许出现编出来的工序进度。
  assert.ok(!/width:\s*\d+(\.\d+)?%/.test(block), '刻度不该按百分比假装进度')
})

// ---------------------------------------------------------------------------
// 别处答掉了：手机页只许**换状态**，位置一个像素都不许动
//
// 用户 2026-10-02 的硬规矩：飞书那边答了，手机页这张卡片要自己收起来，但
// 「位置不许变」。所以那两条监听只准把状态清掉、把 `on` 拿掉——**不许碰任何
// 位置/尺寸**。卡片本身还是老样子：整屏一层，由 `on` 决定显不显示。
// 这里把这两件事都钉住，以后谁想「顺手调整一下」就得先过这一关。
// ---------------------------------------------------------------------------

test('答题卡/审批卡还是整屏一层，显不显示只由 on 决定（位置没动）', () => {
  assert.match(css, /#askCard\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0/, '答题卡还是整屏一层')
  assert.match(css, /#askCard\.on\s*\{\s*display:\s*flex;?\s*\}/, '显不显示只由 on 决定')
  assert.match(css, /#approveCard\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0/, '审批卡还是整屏一层')
  assert.match(css, /#approveCard\.on\s*\{\s*display:\s*flex;?\s*\}/, '显不显示只由 on 决定')
})

test('别处答掉了：手机页那两条监听只换状态，不碰位置', () => {
  // 只读源码做静态检查：页面那一大段脚本里，这两条监听各自只干三件事——
  // 比对编号、清掉状态、拿掉 `on`。出现位置/尺寸相关的写法就是越界了。
  for (const [event, label] of [['question-done', '答题卡'], ['approval-done', '审批卡']]) {
    const from = html.indexOf(`es.addEventListener('${event}'`)
    assert.ok(from > 0, `页面里找不到 ${event} 这条监听——别处答掉了，${label}就只能干挂着`)
    const body = html.slice(from, html.indexOf('});', from))
    assert.match(body, /classList\.remove\('on'\)/, `${label}要收起来就得拿掉 on`)
    assert.ok(!/\.style\b/.test(body), `${label}不许就地改样式（位置一个像素都不能动）`)
    assert.ok(!/(top|left|right|bottom|width|height|margin|padding|transform|zoom)\s*:/.test(body),
      `${label}不许碰任何位置/尺寸`)
  }
})

test('别处答掉了：只有飞书答的才说「已在飞书答过」，超时/断线不冒充', () => {
  // 来源由插件如实说（notifySettled 只带 'phone' / 'feishu'，超时是空串）。
  // 页面据此挑话——猜不得，更不能把「没人答、收摊了」说成「已在飞书答过」。
  const from = html.indexOf("es.addEventListener('question-done'")
  const body = html.slice(from, html.indexOf('});', from))
  assert.match(body, /payload\.source === 'feishu'/, '要按来源分话')
  assert.match(body, /已经在飞书里答过了/)
  const aFrom = html.indexOf("es.addEventListener('approval-done'")
  const aBody = html.slice(aFrom, html.indexOf('});', aFrom))
  assert.match(aBody, /payload\.source === 'feishu'/)
  assert.match(aBody, /已经在飞书里处理过了/)
})

// ---------------------------------------------------------------------------
// 统一操作面板：窄屏与深浅色
//
// 用户 2026-10-02 验收里的两条是「深浅色主题和窄屏都不溢出」。这一屏的做法是
// **一个令牌都不造**（深浅色自动成对）、**一个圆角档位都不加**、长文字一律省略；
// 抽屉本身那三样（限高、自己滚、让开底部安全区）由既有的 .sheet 提供。
// ---------------------------------------------------------------------------

test('统一操作面板：不新造令牌、不放强调色、长文字省略（窄屏与深浅色一起管住）', () => {
  const from = css.indexOf('/* ---------- 统一操作面板')
  const to = css.indexOf('/* ---------- token 输入')
  assert.ok(from > 0 && to > from, '找不到统一面板那段样式，锚点变了先修测试')
  const block = css.slice(from, to)

  // 深浅色：新造的颜色令牌要在 [data-theme="light"] 里再写一份，漏一边就有元素在
  // 那个主题下隐身。这一块的做法是**一个都不造**，全用主屏已有的那几个。
  const declared = [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])
  assert.deepEqual(declared, [], `统一面板不该声明新令牌：${JSON.stringify(declared)}`)
  // 强调色是一屏最多两处的稀缺资源（见上面那张白名单），这一屏没有它。
  assert.ok(!block.includes('var(--act)'), '统一面板不放主按钮')
  assert.ok(!block.includes('var(--gold)'), '统一面板没有暖金字的位置')
  // 圆角只能用现成那一档（全页那条断言也管着，这里再钉最容易被写歪的一处）。
  for (const m of block.matchAll(/border-radius:\s*([^;]+);/g)) {
    assert.equal(m[1].trim(), 'var(--r)', `统一面板只许用 var(--r)：${m[1].trim()}`)
  }

  // 窄屏：列表自己滚，别把抽屉撑出屏幕。
  assert.match(block, /max-height:\s*40vh/)
  assert.match(block, /overflow-y:\s*auto/)
  // 抽屉那三样照旧归 .sheet 管：限高、自己滚、让开底部安全区。
  const sheet = css.slice(css.indexOf('.sheet {'), css.indexOf('.sheet h2'))
  assert.match(sheet, /max-height:\s*86vh/, '抽屉要限高，否则窄屏上顶出去')
  assert.match(sheet, /overflow-y:\s*auto/, '装不下要能滚')
  assert.match(sheet, /env\(safe-area-inset-bottom\)/, '要按机型让开底部那一条')
})

/**
 * 设置页整屏（2026-10-05 用户要求：内容越来越多，改全屏）。
 *
 * 钉两件事：
 *   ① 只改设置这一处——.sheet 是设置 / 统一操作面板 / 子智能体 / 插件页**四处共用**的，
 *      顺手改它会把另外三处也顶成整屏；
 *   ② **整屏之后必须还有一个一直看得见的关闭口**。原来「点抽屉外面」那条路没了
 *      （没有露在外面的遮罩可点），光靠底部那个「完成」得先滚到底——内容一多，
 *      这就是「卡在一整屏里出不来」。光看代码很像是对的，真机上才发现。
 */
test('设置页整屏：只改设置这一处，且整屏之后关得掉', () => {
  const from = css.indexOf('/* ---------- 设置页：整屏')
  const to = css.indexOf('.row {')
  assert.ok(from > 0 && to > from, '找不到设置页整屏那段样式，锚点变了先修测试')
  const block = css.slice(from, to)

  assert.match(block, /#settings \.sheet\s*\{[^}]*height:\s*100%/, '设置页要铺满整屏')
  assert.match(block, /#settings \.sheet\s*\{[^}]*max-height:\s*none/, '那句 86vh 的限高要解开')
  assert.match(block, /#settings \.sheet\s*\{[^}]*border-radius:\s*0/, '整屏了就不要那两角')

  // 底色**不许动**（2026-10-05 用户点名「底色毛玻璃不要换」）：
  // 也不许在这儿另铺一层去挡内容——那会叠在毛玻璃上，叠出更深的色。
  assert.ok(!/background:/.test(block), '整屏这一条不许改底色')
  assert.ok(!/backdrop-filter/.test(block), '也不许把毛玻璃关掉')

  // 共用那套不许被顶成整屏。
  const base = css.slice(css.indexOf('.sheet {'), css.indexOf('.sheet h2'))
  assert.match(base, /max-height:\s*86vh/, '.sheet 四处共用，另外三处照旧贴底')
  assert.match(base, /background:\s*var\(--glass\)/, '.sheet 的毛玻璃照旧')

  // 页眉在滚动区外面：内容滚它的，页眉不跟着走，底下就还是抽屉那层毛玻璃。
  assert.match(block, /#settings \.sheet\s*\{[^}]*display:\s*flex;\s*flex-direction:\s*column/,
    '整屏要排成一列：页眉一行、内容一行')
  assert.match(block, /#settings \.sheet\s*\{[^}]*overflow:\s*hidden/,
    '抽屉本身不滚，交给里面那一块滚')
  assert.match(block, /\.sheet-head\s*\{[^}]*flex:\s*0 0 auto/, '页眉固定，不参与滚动')
  assert.match(block, /#settings \.sheet-body\s*\{[^}]*overflow-y:\s*auto/, '滚动的是内容那一块')
  assert.match(block, /#settings \.sheet-body\s*\{[^}]*padding:\s*[^;}]*16px[^;}]*env\(safe-area-inset-bottom\)/,
    '左右 16px 和底部安全区从 .sheet 挪过来了，账不能丢')

  // 关闭口。
  assert.match(html, /<button class="btn" id="btnSettingsClose">关闭<\/button>/, '顶部要有那个关闭按钮')
  assert.match(html, /\$\('btnSettingsClose'\)\.addEventListener\('click'/, '而且它得真的接上')
  assert.ok(html.indexOf('id="btnSettingsClose"') < html.indexOf('class="sheet-body"'),
    '关闭口要在页眉里（滚动区之外），不然一滚就找不着了')
})

/**
 * 设置抽屉最底下那行版本号（2026-10-05 用户要「加一点设计感，比如两侧加横线」）。
 *
 * 钉的是那个**只能靠肉眼发现的坑**：为了做两侧横线得写 display: flex，
 * 而作者样式表里的 display 会盖掉 HTML `hidden` 自带的 display: none——
 * 少了 [hidden] 那一句，问不到版本时这行照样显示，变成一条空的分隔条。
 */
test('设置页的版本号那行：两侧横线用伪元素，且 hidden 还得管用', () => {
  const from = css.indexOf('/* 设置抽屉最底下那行 DSH 版本')
  const to = css.indexOf('.sheet .foot .btn {')
  assert.ok(from > 0 && to > from, '找不到版本号那段样式，锚点变了先修测试')
  const block = css.slice(from, to)

  assert.match(block, /\.version::before,\s*\n\s*\.sheet \.version::after/, '两侧横线用伪元素')
  assert.match(block, /content:\s*""/, '伪元素要有内容才画得出来')
  assert.match(block, /background:\s*var\(--line\)/, '线用现成的细线色，不新造')
  assert.match(block, /\.version\[hidden\]\s*\{\s*display:\s*none/, 'flex 会顶掉 hidden，必须补这一句')

  // 这一块同样不新造令牌、不碰圆角、不加动效（全页那几条断言也管着，这里钉最易写歪的）。
  const declared = [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])
  assert.deepEqual(declared, [], `这行不该声明新令牌：${JSON.stringify(declared)}`)
  assert.ok(!/border-radius/.test(block), '这行不该有圆角')
  assert.ok(!/animation|@keyframes/.test(block), '这行不该有动效')
})

/**
 * 插件页（2026-10-04 用户要求在设置里加插件入口；同日真机返修两处）。
 *
 * 两处都是"CSS 漏写"这一类：HTML 画出来了、脚本也接上了，但少了定位和缩进，
 * 光看代码很像是对的。所以这里把**观感契约**钉成断言。
 */
test('插件页面：是盖在设置上面的一层浮层，不是掉到输入框下面去', () => {
  const from = css.indexOf('/* ---------- 插件页面（2026-10-04）')
  const to = css.indexOf('/* 行负着左右两边的 16px')
  assert.ok(from > 0 && to > from, '找不到插件页那段样式，锚点变了先修测试')
  const block = css.slice(from, to)

  // ① 整屏浮层。少了 position:fixed/inset:0，它就留在正常文档流里，
  //    在页面上渲染成输入框下面的一截——2026-10-04 用户真机报的正是这条。
  assert.match(block, /#plugins\s*\{[^}]*position:\s*fixed/, '插件页要脱离文档流')
  assert.match(block, /#plugins\s*\{[^}]*inset:\s*0/, '要盖住整屏')
  assert.match(block, /#plugins\s*\{[^}]*display:\s*none/, '默认不显示')
  assert.match(block, /#plugins\.open\s*\{\s*display:\s*flex/, '点了才显示')

  // ② 它是从设置里点开的，层级必须比设置抽屉高一档：写死 z-index，
  //    别靠 DOM 先后顺序——顺序一变它就掉到设置下面。
  const zOf = (sel) => {
    const m = css.match(new RegExp(sel + '\\s*\\{[^}]*z-index:\\s*(\\d+)'))
    return m ? Number(m[1]) : null
  }
  const zPlugins = zOf('#plugins')
  const zSettings = zOf('#settings')
  assert.ok(zPlugins !== null && zSettings !== null, '两层的 z-index 都要写死')
  assert.ok(zPlugins > zSettings, `插件页要盖在设置上面（${zPlugins} > ${zSettings}）`)

  // ③ 两侧留白。.sa-list 带着 -16px（让分隔线横贯抽屉），行得自己补回来；
  //    少这一笔，文字就贴到屏幕上（用户报的「两侧没有留白」）。
  assert.match(block, /\.plugin-row\s*\{[^}]*padding:\s*\d+px\s+16px/, '行要有左右 16px 内缩')
  assert.match(block, /\.plugin-fold\s*>\s*summary\s*\{[^}]*margin:\s*[^;}]*16px/,
    '分组标题（可折那一层的 summary）同样内缩 16px')

  // ⑤ 分组可折可展（2026-10-05 用户要求，默认折叠）：
  //    用原生 details，所以要把浏览器自带的三角收掉、换成自己画的（不依赖字体）。
  assert.match(block, /\.plugin-fold\s*>\s*summary[^{]*\{[^}]*list-style:\s*none/,
    '原生三角要先收掉')
  assert.match(block, /\.plugin-fold\s*>\s*summary::-webkit-details-marker\s*\{\s*display:\s*none/,
    'webkit 那边也要收，不然会冒出两个三角')
  assert.match(block, /\.plugin-fold\s*>\s*summary::before\s*\{[^}]*border-left:\s*\d+px\s+solid\s+currentColor/,
    '小三角用 CSS 画（currentColor：深浅两套主题自动都对，不依赖字形）')
  assert.match(block, /\.plugin-fold\[open\]\s*>\s*summary::before/, '展开时三角要换个朝向')
  assert.ok(!/@keyframes|animation:/.test(block), '折叠不许带动效（全页那条白名单也管着）')

  // ④ 主题与护栏：不造新令牌（造了得在浅色里再写一份，漏一边就有元素在那个主题下隐身）、
  //    不碰那两个强调色、圆角只用现成那一档。
  const declared = [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])
  assert.deepEqual(declared, [], `插件页不该声明新令牌：${JSON.stringify(declared)}`)
  assert.ok(!block.includes('var(--act)') && !block.includes('var(--gold)'), '插件页不放强调色')
  for (const m of block.matchAll(/border-radius:\s*([^;]+);/g)) {
    assert.equal(m[1].trim(), 'var(--r)', `插件页只许用 var(--r)：${m[1].trim()}`)
  }
})

test('统一操作面板：指令行沿用菜单那一套，名字说明不溢出，小旗不折行', () => {
  // 面板里的行和打 / 弹出的菜单是同一份规则（不另写一套），所以这两条要一起看。
  const from = css.indexOf('.cmd-menu .cmd-row')
  const to = css.indexOf('/* ---------- 左侧导航栏 ---------- */')
  assert.ok(from > 0 && to > from, '找不到指令行那段样式，锚点变了先修测试')
  const rows = css.slice(from, to)
  assert.match(rows, /\.ops-cmds \.cmd-row/, '面板里的行要共用菜单那一套样式')
  assert.match(rows, /\.ops-cmds \.cmd-desc[^{]*\{[^}]*text-overflow:\s*ellipsis/,
    '一长串说明不许把行顶出屏幕')
  assert.match(rows, /\.ops-cmds \.cmd-desc[^{]*\{[^}]*white-space:\s*nowrap/)
  assert.match(rows, /\.ops-cmds \.cmd-flag[^{]*\{[^}]*white-space:\s*nowrap/,
    '「手机暂时带不了附件」那面小旗不折行，也别被挤没')
  assert.match(rows, /\.ops-cmds \.cmd-flag[^{]*\{[^}]*flex:\s*none/,
    '小旗固定宽度，让说明去省略')
})
