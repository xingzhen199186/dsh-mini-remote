/**
 * **结构依赖清单**：我们这层手机适配，靠官方界面上的哪些「标记」活着。
 *
 * ## 这张清单是给谁看的
 *
 * 官方界面的类名是「哈希_名字」（`wCInkW_panel`），**哈希每次构建都变**，所以我们的选择器
 * 一律按**后半段**（`[class*="_panel"]`）或**固定属性**（`[data-shortcut-modal="settings"]`）命中。
 * 这些「后半段」和「属性名」就是这一页的全部地基：官方一改，我们的适配就失配。
 *
 * 失配分两类，**清单里必须一眼看出是哪类**（这是用户点名要的）：
 *   · `safe`  —— 只是「这一条不生效」，界面退回官方样子，不会更糟（能忍）；
 *   · `danger`—— **可能误伤**：选择器按子串匹配，将来官方（或别的插件）把同一个子串用到
 *                另一个元素上，我们就会去改一个**从来没量过**的东西（不能忍）。
 *   · `guard` —— 管的是「别的插件的适配不许进这一页」，失配的后果是别人盖上来。
 *
 * ## 为什么这份清单不会「悄悄过期」
 *
 * 它是**唯一真相**，而且是可执行的：`tools/structure-check.mjs` 拿它对着活界面逐条查；
 * `test/structure-deps.test.mjs` 盯着它和 `lib/mirror.js` 一致——
 *   ① 清单里每条 `codeText` 必须**原样**出现在 `lib/mirror.js` 真正发出去的那三段产物里
 *      （`ADAPT_CSS` / `STRIP_FOREIGN_ADAPT` / `DIAG_SCRIPT`）。改了代码没改清单 → 测试红。
 *   ② 从三段产物里**抽出来**的标记集合，必须**一条不差**地被清单覆盖。
 *      加了新依赖没登记 → 测试红。
 * 所以它不是手抄件：手抄件会走样，这两条不会。
 *
 * ## 用法
 *
 *   node tools/structure-check.mjs            # 对着活界面逐条查，中文报告，失配非零退出
 *   node tools/structure-check.mjs --table    # 把这份清单渲染成一张 markdown 表
 *
 * ## 术语
 *
 * 「产物」= `lib/mirror.js` 里真正注进被镜像文档的那三段字符串。
 * 「侦查范围」（`scope`）：`page` = 页面一加载就有；`panel` = 要打开设置面板才有；
 * `market` = 还要切到「插件市场」那一节才有。**这个字段是给检查脚本用的**：
 * 不然「要打开面板才有的标记」会被当成失配误报。
 */

/**
 * 三段产物在 `lib/mirror.js` 里的名字。
 *
 * 检查脚本和测试**都从这里取**，不另抄一份：`DIAG_SCRIPT` 只在 `?diag=1` 时注进去，
 * 但它用的标记和 `ADAPT_CSS` 是同一批，所以也要一起算进「代码里出现过的标记」。
 */
export const PRODUCT_NAMES = ['ADAPT_CSS', 'STRIP_FOREIGN_ADAPT', 'DIAG_SCRIPT']

/* ------------------------------------------------------------------ *
 * 清单本体
 * ------------------------------------------------------------------ */

/**
 * 一条 = 一个标记（类名后半段 / 属性名 / 属性值 / 别人的字符串标记）。
 *
 * 字段：
 *   id        稳定 id，给 `--fault <id>` 自检和报告用
 *   group     撑的是哪一件事（报告按它分组），括号里是 `lib/mirror.js` 上那条注释的编号
 *   marker    打印给人看的标记
 *   scope     page | panel | market —— 见文件头
 *   expect    present = 活页面上必须有；absent = 活页面上必须没有（我们摘掉的东西）
 *   probe     真正拿去 `querySelectorAll` 的选择器
 *   onlyIf    可选：先查这条，一个都没有就报「不适用」，不当失配（别的插件没装的情形）
 *   tokens    它覆盖了抽取器会抽到的哪些标记（一致性测试逐条核对，不许漏也不许多）
 *   codeText  必须在三段产物里**原样**出现的那段代码（清单和代码的铆钉）
 *   where     在哪用
 *   why       为什么需要它
 *   fail      失配了会怎样（人话）
 *   harm      safe | danger | guard
 *   guard     有没有形状闸/兜底
 */
export const MARKERS = [
  /* ---------------- 侧栏那一列（不打开面板就在） ---------------- */
  {
    id: 'sidebar-pane',
    group: '⑱ 侧栏能滚（最底下的「设置」够得着）',
    marker: '[data-pane="sidebar"]',
    scope: 'page',
    expect: 'present',
    probe: '[data-pane="sidebar"]',
    tokens: ['attr:data-pane'],
    codeText: '[data-pane="sidebar"]{overflow-y:auto !important',
    where: 'lib/mirror.js · ADAPT_CSS ⑱；同一段说明里也写着它量到的那几个数',
    why: '侧栏那一列上官方渲染的固定标记（不是类名哈希），全文档只有一个。官方把这一列写成 '
      + '`overflow:hidden`，而它 scrollHeight 696 / clientHeight 599——最底下的「设置」整条被裁在屏幕外。',
    fail: '侧栏少一条命中的话，「放开纵向滚动」这条不生效：手机上再也够不着「设置」，'
      + '而点设置是进面板的唯一入口——等于面板整个进不去。这一条**必须**绿。',
    harm: 'safe',
    guard: '按属性+值点它（官方固定标记），比按类名后缀猜稳；`overflow-x:hidden` 一起写着，收起态不会被撑出横向滚动',
  },
  {
    id: 'region-area',
    group: '⑲ 中间那块不参与压缩（「工作区 / 历史会话」要整条排出来）',
    marker: '[class*="_regionArea"]',
    scope: 'page',
    expect: 'present',
    probe: '[class*="_regionArea"]',
    tokens: ['class:_regionArea'],
    codeText: '[class*="_regionArea"]{flex:0 0 auto !important}',
    where: 'lib/mirror.js · ADAPT_CSS ⑲',
    why: '侧栏里装「工作区 / 会话列表」的那一层。它是那一列里唯一的 `flex:1 1 0%`，'
      + '⑱ 让列能滚之后它第一个被让掉——实测高 0、列表窗口只剩 16px、7 条会话一条都看不见。',
    fail: '失配 = ⑲ 那条不生效：「工作区 / 历史会话」又变回一整块空白（用户 2026-10-08 报的那个）。',
    harm: 'danger',
    guard: '**没有任何形状闸**：裸选择器、按子串命中、而且不锁在侧栏里。'
      + '这是清单里最该盯的一条——将来官方或别的插件只要有一个类名带 `_regionArea`，'
      + '我们就会去改它的 `flex`（不该动的地方被动）。'
      + '注：它整条在 `@media (max-width:640px)` 里，只有窄屏才生效。',
  },

  /* ---------------- 设置面板：浮层与整块 ---------------- */
  {
    id: 'panel-overlay',
    group: '① 面板那层浮层抬到侧栏上面（z-index 1200）',
    marker: '[class*="_overlay"]（要求它的直系子就是设置面板）',
    scope: 'panel',
    expect: 'present',
    probe: '[class*="_overlay"]:has(> [data-shortcut-modal="settings"])',
    tokens: ['class:_overlay'],
    codeText: '[class*="_overlay"]:has(> [data-shortcut-modal="settings"]){z-index:1200 !important}',
    where: 'lib/mirror.js · ADAPT_CSS ①（旁边那段注释记着为什么收窄成这一条）',
    why: '官方侧栏是 `position:absolute; z-index:1100`，面板那层浮层只有 1000——**侧栏比它高一百**。'
      + '手机屏窄，侧栏一展开就整屏盖住，点「设置」什么都看不见。',
    fail: '这条不生效：手机上打开设置，面板被侧栏整个盖住（点不着、看不见），进不了设置。',
    harm: 'safe',
    guard: '**有形状闸**：`:has(> [data-shortcut-modal="settings"])` 要求「这一层确实是面板的浮层」。'
      + '上一版是 `[class*="_overlay"]` 一把抓，把官方浮层容器（原生 z-index:20）和 tldraw 的浮层'
      + '一起抬到 1200，那才是误伤——现在这一层只可能命中一个元素。',
  },
  {
    id: 'settings-panel',
    group: '设置面板本体（整层适配的入口）',
    marker: '[data-shortcut-modal="settings"]',
    scope: 'panel',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"]',
    tokens: ['attr:data-shortcut-modal'],
    codeText: '[data-shortcut-modal="settings"]{flex-direction:column !important}',
    where: 'lib/mirror.js · `SETTINGS_PANEL` 这个常量，ADAPT_CSS 里二十几条规则都挂在它上面；'
      + 'DIAG_SCRIPT 也用它等面板出现',
    why: '官方渲染在设置面板那一块上的固定标记（`role="dialog"`、`aria-modal="true"` 那一块），'
      + '**不受类名哈希变化影响**。我们整层面板适配的锚点。',
    fail: '它没了 = 面板上所有适配同时不生效：导航不会变成横条、内容区滚不动、市场那一节也不会被让出高度。'
      + '这是清单里后果最大的一条（但它同时是闸门：失配时我们什么都不做，不会误伤）。',
    harm: 'safe',
    guard: '本身是固定属性（不是哈希类名）；`①` 那条还用 `:has()` 要求「它确实是浮层的直系子」',
  },

  /* ---------------- 设置面板：导航那一条横条 ---------------- */
  {
    id: 'nav-title',
    group: '③ 面板竖排 + 导航压成一条可横滑的标签条',
    marker: '[class*="_navTitle"]',
    scope: 'panel',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [class*="_navTitle"]',
    tokens: ['class:_navTitle'],
    codeText: '[class*="_navTitle"]{display:none !important}',
    where: 'lib/mirror.js · ADAPT_CSS ③ 第三条规则' ,
    why: '导航条顶上那个「设置」大标题。面板改成竖排之后它白占一行高度，藏掉把高度让给内容。',
    fail: '不生效：设置面板顶上多白占一行（高度少一点），功能不受影响。',
    harm: 'safe',
    guard: '锁在 `[data-shortcut-modal="settings"]` 里面；名字足够专有（不会撞上 `_navCell` 之类）',
  },
  {
    id: 'nav-root',
    group: '③ 面板竖排 + 导航压成一条可横滑的标签条',
    marker: 'nav[class*="_nav"]',
    scope: 'panel',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] nav[class*="_nav"]',
    tokens: ['class:_nav'],
    codeText: 'nav[class*="_nav"]{flex-direction:row !important',
    where: 'lib/mirror.js · ADAPT_CSS ③ 与 ⑮ 两条都点它（⑮ 把格子压矮、⑱ 让它在市场节不被藏）',
    why: '设置面板的导航容器。官方是「左边一列 188px」，我们把它压成**一行、不折行、可横向滑动**，'
      + '于是导航只占约 50px 高，剩下的整屏都给内容。',
    fail: '不生效：手机上面板又变回「左边一列导航」，内容区被挤成半屏（用户 2026-10-06 报的那条）。',
    harm: 'danger',
    guard: '锁在面板里，但 `_nav` 这个子串**很短**：面板里（或某个插件自己的设置节里）'
      + '若出现另一个 `<nav class="xxx_nav">`，它也会被我们压成横条——那是没量过的东西。'
      + '形状闸没有；靠的是「面板里只有官方这一个 nav」这个当时的观察。',
  },
  {
    id: 'nav-list',
    group: '③ 面板竖排 + 导航压成一条可横滑的标签条',
    marker: '[class*="_navList"]',
    scope: 'panel',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [class*="_navList"]',
    tokens: ['class:_navList'],
    codeText: '[class*="_navList"]{flex-direction:row !important',
    where: 'lib/mirror.js · ADAPT_CSS ③',
    why: '导航格子那一排的容器。要跟 `nav` 一起改成横排，否则格子还是竖着码。',
    fail: '不生效：导航容器横了、里面那排格子还是竖的，格子会挤成一团。',
    harm: 'safe',
    guard: '锁在面板里；`_navList` 比 `_nav` 专有（不会命中 `nav` 容器自己）',
  },
  {
    id: 'nav-cell',
    group: '③ 面板竖排 + 导航压成一条可横滑的标签条（⑮ 压矮）',
    marker: '[class*="_navCell"]',
    scope: 'panel',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [class*="_navCell"]',
    tokens: ['class:_navCell'],
    codeText: '[class*="_navCell"]{flex:none !important;height:30px !important',
    where: 'lib/mirror.js · ADAPT_CSS ③/⑮；DIAG_SCRIPT 也拿它找「字在不在」的那个格子',
    why: '导航里每一个格子（图标+名字）。要压到 30px 高、不参与压缩，'
      + '这样每一个设置节的内容区都能多分到高度（实测市场那一节列表窗口 +10px）。',
    fail: '不生效：导航条变高，每个设置节的内容区跟着少一截（不高不低，只是白占）。',
    harm: 'safe',
    guard: '锁在面板里；在真机上量过它「高 34 → 30 仍然点得中」',
  },
  {
    id: 'nav-label',
    group: '③ 导航名字一定可见（真根因的兜底）',
    marker: '[class*="_navLabel"]',
    scope: 'panel',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [class*="_navLabel"]',
    tokens: ['class:_navLabel'],
    codeText: '[class*="_navLabel"]{',
    where: 'lib/mirror.js · ADAPT_CSS ③ 末尾那几条；DIAG_SCRIPT 用它取「名字那一个」的样本',
    why: '导航格子里那行**文字**。用户 2026-10-06 报「只有图标、点一下才出字」，真凶是别的插件'
      + '（meow-smooth）给面板贴了个「收起态」标记、一条 `opacity:0` 把整排名字按成透明。'
      + '真凶已按摘标记治掉，**这几行是兜底**：万一哪一路没摘干净，名字也不会再隐身。',
    fail: '不生效 = 少了一道兜底（正常路径下名字本来就看得见，因为真凶被摘了）。'
      + '所以这一条失配**本身不改变现状**，但「真凶又回来」时就没有第二道防线了。',
    harm: 'safe',
    guard: '锁在面板里；兜底本身不需要形状闸（它只让字可见，不会藏东西）',
  },
  {
    id: 'panel-content',
    group: '④ 内容区的高度链要接上（不然「能看见」但「滚不动」）',
    marker: '[class*="_content"]',
    scope: 'panel',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [class*="_content"]',
    tokens: ['class:_content'],
    codeText: '[class*="_content"]{min-height:0 !important}',
    where: 'lib/mirror.js · ADAPT_CSS ④（这是整份清单里唯一一条故意不带媒体查询的）',
    why: '官方给面板内容区写的是 `flex:1 1 0%`，**漏了 `min-height:0`**。桌面横排时恰好等于面板高，'
      + '看不出问题；我们一改成竖排，这一层的「自动最小高度」就顶穿面板——实测能滚 0px。',
    fail: '不生效 = 面板里那 16 个设置节**能看见但滚不动**（用户 2026-10-07 报的那条）。',
    harm: 'safe',
    guard: '锁在面板里、只补一格 `min-height:0`（不另造滚动结构）；子串 `_content` 在面板里还可能命中更里层的元素，'
      + '但那最多是给它也加一条无害的 `min-height:0`',
  },
  {
    id: 'panel-role-dialog',
    group: '⑥ 「插件市场」那一节：把被它藏掉的导航要回来',
    marker: '[role="dialog"]',
    scope: 'panel',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"][role="dialog"]',
    tokens: ['role:dialog'],
    codeText: '[data-shortcut-modal="settings"][role="dialog"]:has([data-dsh-market-root]) > nav{display:flex !important}',
    where: 'lib/mirror.js · ADAPT_CSS ⑥；**STRIP_FOREIGN_ADAPT 里也用 `[role=dialog]` 找面板**'
      + '（摘 `data-meow-smooth-settings` 那个标记）',
    why: '（a）⑥ 那条要赢过市场插件写的 `[role=\"dialog\"]:has(...)>nav{display:none}`（特异性 (0,2,1)），'
      + '所以我们的选择器必须带上同一个 `[role="dialog"]` 才够具体；'
      + '（b）护栏脚本也靠它在页面深处找设置面板。',
    fail: '（a）失配：⑥ 那条压不住市场插件的规则——**进了「插件市场」，整条导航被藏掉，切不回别的节**；'
      + '（b）失配：护栏少一条找面板的路，meow-smooth 那个「收起态」标记可能摘不干净。',
    harm: 'safe',
    guard: '属性选择器（不是类名哈希）；⑥ 那条另带 `:has([data-dsh-market-root])`，只在真的停在这一节时才出手',
  },

  /* ---------------- 设置面板：内容区那条头 ---------------- */
  {
    id: 'content-header',
    group: '⑨⑰ 内容区那条头（市场节收留白；共用节把动作区藏掉并右对齐）',
    marker: '[class*="_header"]',
    scope: 'panel',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [class*="_content"] > [class*="_header"]',
    tokens: ['class:_header'],
    codeText: '[class*="_content"] > [class*="_header"]{justify-content:flex-end !important}',
    where: 'lib/mirror.js · ADAPT_CSS ⑨（市场节的留白）与 ⑰（共用那条头）',
    why: '官方那条「内容区头」（16 个设置节长得一模一样）：右边是 ✕（唯一出口），左边是设置节标题/动作。'
      + '⑰ 藏掉左边那件之后要靠 `justify-content:flex-end` 把 ✕ 摁回右边（实测 x=324，与改前一致）。',
    fail: '（⑰）不生效：✕ 会因为左边那件东西消失而跑到最左边（x=324 → x=34）——**出口换位置本身就是坑**；'
      + '（⑨）不生效：市场节的头部高度收不下来，列表窗口少 40px 左右。',
    harm: 'safe',
    guard: '按「内容区的**直接子元素**」点它（`>`）——这条链是给 `_head`/`_header` 这种短名字的专用闸',
  },
  {
    id: 'content-actions',
    group: '⑰ 共用那条头里的动作区藏掉（用户点名要藏）',
    marker: '[class*="_actions"]',
    scope: 'panel',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [class*="_content"] > [class*="_header"] > [class*="_actions"]',
    tokens: ['class:_actions'],
    codeText: '[class*="_content"] > [class*="_header"] > [class*="_actions"]{display:none !important}',
    where: 'lib/mirror.js · ADAPT_CSS ⑰',
    why: '那条头里的动作区，真面板上拆开量过：**里面只有「打开配置文件」一个按钮**（94×28）。'
      + '用户点名要藏掉这个入口（2026-10-07）。',
    fail: '不生效：每个设置节右上角又出现「打开配置文件」。**收益本来就是 0**（那行高度由 ✕ 撑着），'
      + '所以失配不影响布局，只影响「入口露不露」。',
    harm: 'danger',
    guard: '有「直接子元素」链（`_content > _header > _actions`）当形状闸，但 `_actions` 本身是通用子串：'
      + '将来某个节点被做成 `_content > _header > _actions` 的形状、里面装的不是那一个按钮，'
      + '就会被我们整个藏掉——**藏错东西比不藏更糟**，所以列进「可能误伤」。',
  },
  {
    id: 'content-options',
    group: '⑩ 市场节：`_options` 那 24px 下内边距是白留的',
    marker: '[class*="_options"]',
    scope: 'market',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"]:has([data-dsh-market-root]) [class*="_content"] > [class*="_options"]',
    tokens: ['class:_options'],
    codeText: ':has([data-dsh-market-root]) [class*="_content"] > [class*="_options"]{padding-bottom:0 !important}',
    where: 'lib/mirror.js · ADAPT_CSS ⑩（旁边写着为什么按「内容区的直接子元素」点它）',
    why: '面板的滚动容器（`_options`）。官方给它 `padding:0 24px 24px`，而市场根是 `height:100%`'
      + '——那 24px 谁也用不到。去掉下边那条，列表窗口 +24px。',
    fail: '不生效：市场那一节的列表窗口少 24px（不多不少，就是这 24px）。',
    harm: 'safe',
    guard: '有形状闸：`:has([data-dsh-market-root])` + 直接子元素链（`_options` 这个子串在整棵面板里未必只有一个）',
  },

  /* ---------------- 插件市场那一节 ---------------- */
  {
    id: 'market-root',
    group: '⑤–⑯ 插件市场那一节的闸门（只碰这一节）',
    marker: '[data-dsh-market-root]',
    scope: 'market',
    expect: 'present',
    probe: '[data-dsh-market-root]',
    tokens: ['attr:data-dsh-market-root'],
    codeText: '[data-dsh-market-root] [class*="_titleRow"]{flex-wrap:wrap !important}',
    where: 'lib/mirror.js · ADAPT_CSS ⑤⑦⑪⑫⑬⑭⑯ 全部锁在它里面，⑧⑨⑩ 用 `:has()` 停在它上面',
    why: '「插件市场」那个设置节自己的固定标记（不是类名哈希）。它是**这一整组适配的范围锁**：'
      + '活服务上实测过「切到别的节之后市场根会被卸载」，所以 `:has()` 只在真的停在这一节时才命中。',
    fail: '它没了 = ⑤–⑯ 那十几条全部不生效（标题行又变竖排、页签被裁、列表窗口又矮回去），'
      + '而且 **`:has()` 也一起失效**——不会误伤别的节，只是市场节回到官方那副挤扁的样子。',
    harm: 'safe',
    guard: '本身就是闸门（其余市场规则都写成它的后代或 `:has(它)`）',
  },
  {
    id: 'market-title-row',
    group: '⑤ 市场标题行要折行（不然七件东西挤成一竖排）',
    marker: '[class*="_titleRow"]',
    scope: 'market',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [data-dsh-market-root] [class*="_titleRow"]',
    tokens: ['class:_titleRow'],
    codeText: '[data-dsh-market-root] [class*="_titleRow"]{flex-wrap:wrap !important}',
    where: 'lib/mirror.js · ADAPT_CSS ⑤（折行）与 ⑪（藏掉里面重复的那三样）',
    why: '市场节自己那条 `.xxx_titleRow{display:flex;gap:10px}` **没写 flex-wrap**（默认 nowrap），'
      + '而这一行塞了 7 件东西、最小宽度加起来 ≈308px，面板只给得出 286px——中文被压成一字一行、'
      + '最后一个按钮被裁掉。给它折行就够。',
    fail: '不生效：「插件市场」四个字又竖着排、右边按钮也被压竖、最右边那个缺一半（用户截图里那样）。',
    harm: 'safe',
    guard: '锁在 `[data-dsh-market-root]` 里面（只碰这一节）；`_titleRow` 这个名字专有，别处没见',
  },
  {
    id: 'market-repo-link',
    group: '⑪ 藏掉标题行里重复的信息（图标 / 仓库名 / 版本号）',
    marker: '[class*="_repoLink"]',
    scope: 'market',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [data-dsh-market-root] [class*="_titleRow"] [class*="_repoLink"]',
    tokens: ['class:_repoLink'],
    codeText: '[class*="_titleRow"] [class*="_repoLink"]',
    where: 'lib/mirror.js · ADAPT_CSS ⑪',
    why: '标题行里那个 `dsh-market` 仓库名（66px）。用户在导航格子上已经看到「插件市场」，这是重复信息。',
    fail: '不生效：标题行里多回一个仓库名，那一行可能多占一行高度（列表窗口少一点）。',
    harm: 'danger',
    guard: '限定在「市场根 → 标题行」里面（不是裸的 `[class*="_repoLink"]`），但 `_repoLink` 是个链接类名，'
      + '将来标题行里多出别的链接、名字又带这个子串，就会被一起藏掉（藏错东西）',
  },
  {
    id: 'market-version',
    group: '⑪ 藏掉标题行里重复的信息（图标 / 仓库名 / 版本号）',
    marker: '[class*="_version"]',
    scope: 'market',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [data-dsh-market-root] [class*="_titleRow"] [class*="_version"]',
    tokens: ['class:_version'],
    codeText: '[class*="_titleRow"] [class*="_version"]{display:none !important}',
    where: 'lib/mirror.js · ADAPT_CSS ⑪（注释里专门交代了为什么再写一遍 `_titleRow`）',
    why: '标题行里那个版本号 `v1.66.6`（44px）。同样是重复信息。',
    fail: '不生效：标题行多回一个版本号（列表窗口少一点）。',
    harm: 'danger',
    guard: '同样限定在「市场根 → 标题行」里。**`_version` 是最像卡片字段的名字**——注释里写着：'
      + '要是不限定在标题行里，将来市场给卡片里的版本号起个 `xxx_version`，'
      + '就会被这条规则连卡片内容一起藏掉（用户明确不许「压扁/截断卡片」）。',
  },
  {
    id: 'market-tabs',
    group: '⑦ 市场那排页签也要能划（右边三个被裁掉了）',
    marker: '[class*="_tabs"]',
    scope: 'market',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [data-dsh-market-root] [class*="_tabs"]',
    tokens: ['class:_tabs'],
    codeText: '[class*="_tabs"]{overflow-x:auto !important',
    where: 'lib/mirror.js · ADAPT_CSS ⑦',
    why: '市场那排页签 7 个总宽实测 427px，而市场区只给 286px；它自己不滚也不折行，'
      + '于是右边三个被裁掉（用户截图里「已屏」后面就断了）。',
    fail: '不生效：右边三个页签又被裁掉（点不到、看不到）。',
    harm: 'danger',
    guard: '锁在 `[data-dsh-market-root]` 里，但**没有形状闸**：`_tabs` 是通用子串，'
      + '市场里只要有一张卡片自己也带 `_tabs`（比如卡片内的切换），就会被我们加上横向滚动条。',
  },
  {
    id: 'market-head',
    group: '⑫ 市场头部几块之间的留白收一收',
    marker: '[class*="_head"]',
    scope: 'market',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [data-dsh-market-root] > [class*="_head"]',
    tokens: ['class:_head'],
    codeText: '[data-dsh-market-root] > [class*="_head"]{gap:6px !important',
    where: 'lib/mirror.js · ADAPT_CSS ⑫',
    why: '市场根下面那个头部堆栈（标题行 / 社区那格 / 页签 / 提示条）。四块之间本来三道 12px 空档（36px），收成 6px。',
    fail: '不生效：市场头部多占约 18px，列表窗口跟着少同样多。',
    harm: 'safe',
    guard: '**有形状闸**：按「市场根的直接子元素」点（`>`）——注释里写着 `[class*="_head"]` 会连 `_header` 一起命中，'
      + '所以必须带 `>`',
  },
  {
    id: 'market-sticky-head',
    group: '⑬ 吸附头的留白（它每高 1px，看卡片的地方就少 1px）',
    marker: '[class*="_stickyHead"]',
    scope: 'market',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [data-dsh-market-root] [class*="_stickyHead"]',
    tokens: ['class:_stickyHead'],
    codeText: '[class*="_stickyHead"] > [class*="_tabSearchRow"]{',
    where: 'lib/mirror.js · ADAPT_CSS ⑬',
    why: '市场里那两条 `position:sticky` 钉在列表顶上的行（搜索 + 分类）。它一直在列表上方占高，'
      + '所以它每高 1px，看卡片的地方就**一直**少 1px。',
    fail: '不生效：吸附头多占 14px，看卡片的地方一直少 14px。',
    harm: 'safe',
    guard: '锁在市场根里；名字专有',
  },
  {
    id: 'market-tab-search-row',
    group: '⑬ 吸附头的留白（搜索那一行）',
    marker: '[class*="_tabSearchRow"]',
    scope: 'market',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [data-dsh-market-root] [class*="_stickyHead"] > [class*="_tabSearchRow"]',
    tokens: ['class:_tabSearchRow'],
    codeText: '[class*="_stickyHead"] > [class*="_tabSearchRow"]{padding-bottom:6px !important}',
    where: 'lib/mirror.js · ADAPT_CSS ⑬',
    why: '吸附头里「搜索框 + 全部/待更新 那一排」那一行。下内边距 12px → 6px。**搜索框本身一个像素不动。**',
    fail: '不生效：这一行多占 6px（看卡片的地方少 6px）。',
    harm: 'safe',
    guard: '**有形状闸**：按「吸附头的直接子元素」点（`>`）',
  },
  {
    id: 'market-cats',
    group: '⑬ 吸附头的留白（分类那一行）',
    marker: '[class*="_cats"]',
    scope: 'market',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [data-dsh-market-root] [class*="_stickyHead"] > [class*="_cats"]',
    tokens: ['class:_cats'],
    codeText: '[class*="_stickyHead"] > [class*="_cats"]{padding:6px 4px 2px !important}',
    where: 'lib/mirror.js · ADAPT_CSS ⑬（注释里记着第一版写 `[class*="_cats"]` 反而高了 8px 的账）',
    why: '吸附头里「分类筛选」那一行。**分类筛选一个都不动**，只收留白。',
    fail: '不生效：这一行多占 8px。',
    harm: 'safe',
    guard: '**有形状闸**：必须写成「吸附头的直接子元素」——第一版按子串写，'
      + '把 `_catsRow`（56→72）和 `_catsWrap`（56→64）也一起命中，三层各多一层内边距，反而高了 8px。'
      + '这是**我们自己踩过的那个坑**，现在写成直接子元素链就锁住了。',
  },
  {
    id: 'market-body',
    group: '⑭ 列表滚动区自己的上下留白',
    marker: '[class*="_body"]',
    scope: 'market',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [data-dsh-market-root] > [class*="_body"]',
    tokens: ['class:_body'],
    codeText: '[data-dsh-market-root] > [class*="_body"]{',
    where: 'lib/mirror.js · ADAPT_CSS ⑭',
    why: '市场里那个**能滚的列表窗口**（量高度量的就是它的 clientHeight）。'
      + '它自己的 `padding:12px 4px 24px` 收成 `6px 4px 12px`——**不改窗口高度**，改的是窗口里能看见卡片的净高（+18px）。',
    fail: '不生效：列表窗口里上下各留掉一截白，看卡片的地方少 18px（滚动窗口高度本身不变）。',
    harm: 'safe',
    guard: '**有形状闸**：按「市场根的直接子元素」点（`_body` 也是短名字）',
  },
  {
    id: 'market-sub',
    group: '⑯ 「社区介绍」那一整格藏掉（含导出日志，用户第二次点名）',
    marker: '[class*="_sub"]',
    scope: 'market',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [data-dsh-market-root] > [class*="_head"] > [class*="_sub"]:has(> [class*="_submitLink"])',
    tokens: ['class:_sub'],
    codeText: '[class*="_head"] > [class*="_sub"]',
    where: 'lib/mirror.js · ADAPT_CSS ⑯',
    why: '市场头部里那一格（介绍文字 + 「申请收录插件 ↗」 + 空占位 + 「导出日志」）。'
      + '用户点名把导出日志也藏掉，于是整格都藏——**整格藏比只藏几个子元素多赚 6px**'
      + '（那格留在 DOM 里哪怕高 0，`_head` 的 flex gap 照样占一道）。',
    fail: '不生效：那一格又回来：多条介绍文字、给作者用的入口、排查用的「导出日志」；'
      + '列表窗口少 34px（28 + 6）。',
    harm: 'safe',
    guard: '**两道闸**：① 按「市场根 > `_head` > `_sub`」的**直接子元素**链点'
      + '（`[class*="_sub"]` 会同时命中 `_submitLink`——`_sub` 是它的前缀子串）；'
      + '② 再加 `:has(> [class*="_submitLink"])`，要求「这一格确实是我们量过的那个形状」。'
      + '**整格藏比藏两个子元素下手更重，所以更该有这道闸**：将来市场改结构时，'
      + '失配（什么都不藏）比误伤（藏了别人）好。',
  },
  {
    id: 'market-submit-link',
    group: '⑯ 上面那道形状闸里的标记',
    marker: '[class*="_submitLink"]',
    scope: 'market',
    expect: 'present',
    probe: '[data-shortcut-modal="settings"] [data-dsh-market-root] > [class*="_head"] > [class*="_sub"] > [class*="_submitLink"]',
    tokens: ['class:_submitLink'],
    codeText: ':has(> [class*="_submitLink"]){display:none !important}',
    where: 'lib/mirror.js · ADAPT_CSS ⑯ 的 `:has()` 那半句',
    why: '「申请收录插件 ↗」那个链接（188×18，给插件作者用的入口）。'
      + '它在这里有第二个身份：**它是那道形状闸的钥匙**——那一格必须长成「里面有个 `_submitLink`」才动手。',
    fail: '市场把「申请收录」那个链接去掉的话：⑯ 那条**故意什么都不做**（`:has()` 不成立）'
      + '——这是设计好的失败方向（宁可整格不藏，也不乱藏），但那一格就会重新占掉 34px。',
    harm: 'safe',
    guard: '它就是闸本身：它不在，闸就不开，规则自动哑火（**失配就什么都不做**）',
  },

  /* ---------------- 护栏：别的插件的适配不许进来 ---------------- */
  {
    id: 'guard-official-prefix',
    group: '护栏 · 官方包在样式标签上写的「我是官方」前缀',
    marker: 'style[data-plugin-css*="@deepseek-ai/"], style[data-plugin*="@deepseek-ai/"]',
    scope: 'page',
    expect: 'present',
    probe: 'style[data-plugin-css*="@deepseek-ai/"], style[data-plugin*="@deepseek-ai/"]',
    tokens: ['attr:data-plugin-css', 'attr:data-plugin', 'str:@deepseek-ai/'],
    codeText: 'indexOf("@deepseek-ai/")',
    where: 'lib/mirror.js · STRIP_FOREIGN_ADAPT 的通用层（`v.indexOf("@deepseek-ai/") >= 0` 那一行就是「官方的包一律不动」）',
    why: '护栏分两层。「点名层」只摘名单里那两家；「通用层」摘**所有**整份只在窄屏生效的第三方样式表。'
      + '通用层要能不误伤官方，全靠官方在样式标签的 `data-plugin-css` / `data-plugin` 里'
      + '写着 `@deepseek-ai/…` 这个前缀。',
    fail: '**这条失配是「可能误伤」里最重的一种**：官方不再写这个前缀（或换成别的写法）之后，'
      + '通用层的「跳过官方」判断就落空——官方自己那些**整份包在媒体查询里**的样式表'
      + '会被我们当第三方的摘掉，界面会缺样式。'
      + '（当前实测：这一页有几十份官方样式表都带着这个前缀，判据成立。）',
    harm: 'guard',
    guard: '无形状闸，它是判据本身的锚；**只有它出现**才能证明「官方包不动」这条还能判',
  },
  {
    id: 'guard-foreign-markers',
    group: '护栏 · 别的插件的适配标记与样式，活页面上一个都不该有',
    marker: 'body 上那三个 dsh-remote-* 类名，以及带 remote-web-ui / dsh-mobile-nav 的样式标签',
    scope: 'page',
    expect: 'absent',
    probe: 'body.dsh-remote-portrait, body.dsh-remote-compact-picker, body.dsh-remote-header-seated, '
      + 'style[data-plugin-css*="remote-web-ui"], style[data-plugin*="remote-web-ui"], '
      + 'style[data-plugin-css*="dsh-mobile-nav"], style[data-plugin*="dsh-mobile-nav"]',
    tokens: ['str:remote-web-ui', 'str:dsh-mobile-nav', 'str:dsh-remote-portrait',
      'str:dsh-remote-compact-picker', 'str:dsh-remote-header-seated'],
    codeText: 'var STYLE_OWNERS = ["remote-web-ui", "dsh-mobile-nav"];',
    where: 'lib/mirror.js · STRIP_FOREIGN_ADAPT 的「点名层」（`STYLE_OWNERS` 与 `BODY_CLASSES` 两个名单）',
    why: '`@linxin666/dsh-remote-web-ui` 会往这一页插适配样式、再往 `<body>` 贴三个标记'
      + '（`dsh-remote-portrait` / `dsh-remote-compact-picker` / `dsh-remote-header-seated`）；'
      + '`@dsh-external/dsh-mobile-nav`（dsh-pocket）会用一条三列网格把设置面板改成「上方三列图标格子」。'
      + '它们的选择器都写得很宽，撞上官方的元素就改。所以**按名单整个摘掉**，不让它们进来。',
    fail: '失配 = 我们没挡住：那两家（或改名后的同一家）的样式会重新生效，'
      + '症状是设置页导航又变成「只有图标、点一下才出字」或者「上方三块图标格」。'
      + '**注意这是「红才说明问题」的一条**：这两家没装的时候它本来就绿，绿不代表挡得住。',
    harm: 'guard',
    guard: '**这一条反过来查**：查的是「活页面上不该看到」。名字一旦被它们改掉，'
      + '这条会变绿（因为查不到）——真正的证据是**红**，所以它只能证明「没漏」，不能证明「挡得住」',
  },
  {
    id: 'guard-meow-smooth',
    group: '护栏 · meow-smooth 那两个「收起态」标记要一直被摘掉',
    marker: '[data-meow-smooth-settings]、html[data-meow-smooth-furled]',
    scope: 'page',
    expect: 'absent',
    probe: '[data-meow-smooth-settings], [data-meow-smooth-furled]',
    onlyIf: 'style[data-plugin="meow-smooth"], style[data-meow-settings-css]',
    tokens: ['attr:data-meow-smooth-settings', 'attr:data-meow-smooth-furled'],
    codeText: 'var SETTINGS_MOBILE_ATTR = "data-meow-smooth-settings";',
    where: 'lib/mirror.js · STRIP_FOREIGN_ADAPT 的第三、第四层（两个属性名各一个常量）',
    why: '`meow-smooth` 这一个插件干过两件要命的事：'
      + '① 把一个 `data-meow-smooth-settings="collapsed"` 贴到设置面板上，一条 `opacity:0` 让整排导航名字'
      + '**整片透明**（用户报「只有图标、点一下字才出」）；'
      + '② 把一个 `data-meow-smooth-furled` 贴到 `<html>` 上，一条窄屏网格规则把主框架改成三列，'
      + '主栏被塞进 0px 那一列——**主页面整片空白**（用户 2026-10-08 报的回归）。'
      + '两个标记都是**运行时贴上去的**，所以摘了还要一直盯着（两个 MutationObserver）。',
    fail: '失配 = 我们摘不掉它们了（插件改了属性名，或者观察器没挂上）：'
      + '① 会让导航名字整片透明；② 会让**主页面整片空白**（只剩鲸鱼按钮和立绘）。'
      + '这两条都是用户真机报过的原样症状。',
    harm: 'guard',
    guard: '有 `onlyIf`：那个插件**没装**时这条报「不适用」，不算失配（不然会天天红）。'
      + '它装着的时候这条才有意义——当前实测它就装着（2 份样式表），而两个标记都为 0，判据成立',
  },
]

/* ------------------------------------------------------------------ *
 * 从 lib/mirror.js 里取出真正的产物
 * ------------------------------------------------------------------ */

/**
 * 把 `lib/mirror.js` 的源码里那三段产物**求值取出来**（不是抄一遍）。
 *
 * 为什么要「求值」而不是切片文本：`ADAPT_CSS` 是用一串 `+` 拼起来的表达式，旁边还夹着
 * 大段 `// 注释`；`STRIP_FOREIGN_ADAPT` 是模板串，里面夹着块注释（斜杠星号那种）。
 * 直接对着源码做正则，会把**注释里提到过的类名**也当成依赖抽出来（试过，真的会），
 * 于是清单里多出一堆根本不存在的标记。求值之后拿到的就是浏览器真正看到的那份字符串。
 *
 * @param {string} source `lib/mirror.js` 的内容
 * @returns {{ADAPT_CSS: string, STRIP_FOREIGN_ADAPT: string, DIAG_SCRIPT: string}}
 */
export function readProducts(source) {
  const settingsLine = source.match(/const SETTINGS_PANEL = .*/)
  if (!settingsLine) throw new Error('lib/mirror.js 里找不到 `const SETTINGS_PANEL = …`')
  const out = { SETTINGS_PANEL: new Function(`${settingsLine[0]}\nreturn SETTINGS_PANEL`)() }
  for (const name of PRODUCT_NAMES) {
    const literal = readAssignmentLiteral(source, name)
    out[name] = new Function(
      `const SETTINGS_PANEL = ${JSON.stringify(out.SETTINGS_PANEL)};\nreturn (${literal})`,
    )()
  }
  return out
}

/** 取出 `const NAME = <字面量或表达式>` 右边那一段源码文本。 */
function readAssignmentLiteral(source, name) {
  const at = source.indexOf(`const ${name} = `)
  if (at < 0) throw new Error(`lib/mirror.js 里找不到 \`const ${name} = \``)
  const start = at + `const ${name} = `.length
  if (source[start] === '`') {
    // 模板串：走到没有被转义的那个反引号为止
    let i = start + 1
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue }
      if (source[i] === '`') return source.slice(start, i + 1)
      i += 1
    }
    throw new Error(`${name} 的模板串没有收尾`)
  }
  // 表达式：切到下一条顶层文档注释之前（`ADAPT_CSS` 就是这个形状）
  const end = source.indexOf('\n\n/**', start)
  if (end < 0) throw new Error(`${name} 的表达式找不到结尾`)
  return source.slice(start, end).trim()
}

/** 把脚本里的注释去掉——注释里提到过的东西不算依赖。 */
function stripScriptComments(script) {
  return script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 从三段产物里抽出「我们依赖的官方标记」，归一成一套记号：
 *
 *   `class:_content`     类名后半段（按子串命中）
 *   `attr:data-pane`     属性选择器里的属性名
 *   `role:dialog`        `[role=…]`
 *   `str:remote-web-ui`  护栏名单里那些字符串标记（别人的插件名 / body 类名 / 前缀）
 *
 * @param {ReturnType<typeof readProducts>} products
 * @returns {Set<string>}
 */
export function extractTokens(products) {
  const tokens = new Set()
  const scan = (text) => {
    for (const m of text.matchAll(/\[class\*=\\?["']([^"'\]]+)\\?["']\]/g)) tokens.add(`class:${m[1]}`)
    for (const m of text.matchAll(/\[(data-[a-z0-9-]+)/g)) tokens.add(`attr:${m[1]}`)
    for (const m of text.matchAll(/\[role=?(?:"([a-z]+)"|([a-z]+))\]/g)) tokens.add(`role:${m[1] || m[2]}`)
    for (const m of text.matchAll(/"([^"\n]{2,60})"/g)) {
      const v = m[1]
      if (v === '@deepseek-ai/') tokens.add(`str:${v}`)
      else if (/^data-[a-z0-9-]+$/.test(v)) tokens.add(`attr:${v}`)
      else if (/^(dsh-[a-z0-9-]+|remote-web-ui)$/.test(v)) tokens.add(`str:${v}`)
    }
  }
  scan(products.ADAPT_CSS)
  scan(stripScriptComments(products.STRIP_FOREIGN_ADAPT))
  scan(stripScriptComments(products.DIAG_SCRIPT))
  return tokens
}

/** 清单里声明覆盖的标记（各条 `tokens` 的并集）。 */
export function declaredTokens(rows = MARKERS) {
  return new Set(rows.flatMap((r) => r.tokens))
}

/** 每条 `codeText` 必须出现的那些产物文本。 */
export function productTexts(products) {
  return PRODUCT_NAMES.map((name) => products[name])
}

/* ------------------------------------------------------------------ *
 * 判定
 * ------------------------------------------------------------------ */

/** 自检注入：把某一条的侦查选择器换成一条**永远查不到**的，看报告会不会准确报出它。 */
export const FAULT_PROBE = '[data-mini-structure-selfcheck-missing]'

/**
 * 单条判定。**纯函数**，所以能单测。
 *
 * @param {object} row 清单里的一条
 * @param {{count: number, onlyIfCount?: number, faulted?: boolean}} observed
 * @returns {{state: 'ok'|'missing'|'unexpected'|'not-applicable', ok: boolean, title: string, detail: string}}
 */
export function judge(row, observed) {
  const count = Number(observed.count) || 0
  const faulted = Boolean(observed.faulted)
  if (row.onlyIf !== undefined && !observed.onlyIfCount) {
    return {
      state: 'not-applicable',
      ok: true,
      title: '不适用',
      detail: `「${row.onlyIf}」在页面上一个都没有，说明它管的那件事现在不在这台机器上——不算失配。`,
    }
  }
  const present = count > 0
  const want = row.expect === 'absent' ? false : true
  if (present === want) {
    return {
      state: 'ok',
      ok: true,
      title: '还在',
      detail: row.expect === 'absent'
        ? `查了 0 个（本来就该是 0 个：这是我们要摘掉的东西）。`
        : `查到 ${count} 个。`,
    }
  }
  return {
    state: row.expect === 'absent' ? 'unexpected' : 'missing',
    ok: false,
    title: row.expect === 'absent' ? '不该在的出现了' : '没了',
    detail: row.expect === 'absent'
      ? `查到 ${count} 个——本该一个都没有。`
      : `一个都没查到${faulted ? '（**这是自检故意注入的**）' : ''}。`,
  }
}

/* ------------------------------------------------------------------ *
 * 版本区间（只认我们自己声明的那两种形状，够用就好）
 * ------------------------------------------------------------------ */

/** 把 `0.2.0-rc.2` 拆成 `{nums:[0,2,0], pre:['rc',2]}`；拆不动就返回 null。 */
export function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text || '').trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** semver 的先后：有预发布号的比没有的小（`1.0.0-rc.1 < 1.0.0`）。 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1
  }
  if (!pa.pre.length && !pb.pre.length) return 0
  if (!pa.pre.length) return 1
  if (!pb.pre.length) return -1
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; continue }
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * 判一个版本在不在 `>=a <b` 这种区间里。
 *
 * **只支持我们真的会写的形状**（`engines.dsh` 和 `peerDependencies` 里就是这一种）：
 * 空格分开的若干条 `>=` / `<` / `<=` / `>`。别的形状（`^`、`~`、`||`）一律返回 `null`
 * ——**说不知道，比猜一个结论好**。
 *
 * @returns {boolean|null} null = 这个区间写法我不认识
 */
export function satisfiesRange(version, range) {
  if (!parseVersion(version)) return null
  const parts = String(range || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  for (const part of parts) {
    const m = /^(>=|<=|>|<)(.+)$/.exec(part)
    if (!m) return null
    if (!parseVersion(m[2])) return null
    const cmp = compareVersions(version, m[2])
    const ok = m[1] === '>=' ? cmp >= 0
      : m[1] === '<=' ? cmp <= 0
        : m[1] === '>' ? cmp > 0
          : cmp < 0
    if (!ok) return false
  }
  return true
}

/* ------------------------------------------------------------------ *
 * 报告用的渲染
 * ------------------------------------------------------------------ */

/** 一行一行拼成一张 markdown 表（`--table` 用的就是它）。 */
export function renderTable(rows = MARKERS) {
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
  // 标记那一格套反引号变成代码体；**它自己带反引号时不套**，不然整格的代码体会断在半路。
  const code = (s) => (String(s).includes('`') ? esc(s) : `\`${esc(s)}\``)
  const harm = { safe: '只是不生效', danger: '**可能误伤**', guard: '护栏（挡别人）' }
  const scope = { page: '一直都有', panel: '要开面板', market: '要进市场节' }
  const head = '| 组 | 标记 | 在哪用 | 为什么需要它 | 失配的后果 | 误伤风险 | 兜底（形状闸） |\n'
    + '| --- | --- | --- | --- | --- | --- | --- |'
  const body = rows.map((r) => `| ${esc(r.group)} | ${code(r.marker)}<br>（${scope[r.scope]}） `
    + `| ${esc(r.where)} | ${esc(r.why)} | ${esc(r.fail)} | ${harm[r.harm]} | ${esc(r.guard)} |`)
  return `${head}\n${body.join('\n')}\n`
}
