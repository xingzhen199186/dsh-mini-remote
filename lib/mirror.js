/**
 * 「进阶设置」：把电脑端界面（DSH Web GUI）经我们自己的端口转出去。
 *
 * ## 为什么要有这个东西
 *
 * 手机上那张遥控页是**专门为手机做的**，所以电脑上那些插件贡献的设置页它进不去。
 * 这个模块给你一条退路：**要改那些设置时，直接把电脑端的界面整个搬过来看**——
 * 不迁移任何页面，不逐个适配，**同一份界面**。
 *
 * ## 为什么必须经我们代理，不能直接连
 *
 * 实测：电脑端界面监听在 `127.0.0.1:19387`，**只绑回环**——手机根本够不着。
 * 而我们的端口本来就绑了局域网和 Tailscale，**手机够得着**。所以由我们中转。
 *
 * ## 认证：走正门，不绕过
 *
 * 那个界面要一个**按「权威域名」绑定、用本进程密钥签名**的 cookie（实测裸连回 401）。
 * 密钥是私有的，谁也拿不到——**我们也不去拿**。
 *
 * 走的是官方留的正门：宿主的 connection 服务有公开方法
 * `authenticatedUrl(baseUrl)`——「把本次启动的令牌加到应用地址上」。拿到的地址形如
 * `http://127.0.0.1:19387/?token=<令牌>`；**请求它一次，服务器就回 303 并铸出那个 cookie**
 * （官方 BrowserAuth.authorizeIndex 的原文：「A valid root query token mints the cookie
 * and redirects」）。
 *
 * 所以这个模块做的是：**服务端自己去走一次官方认证，把 cookie 收在自己手里**，
 * 之后每个转发请求替手机带上它。**手机全程碰不到任何官方凭据。**
 *
 * ## 两个必须钉死的细节
 *
 * ① **Host 头固定成目标自己的地址。** 官方那个 cookie 是**按 Host 签的**
 *    （requestAuthority 只看 `host` 头）：`payload.authority === 请求的 Host`。
 *    所以转发时必须让目标看到的 Host 和铸 cookie 时那一份**完全一致**，
 *    否则每个请求都 401。这里固定成上游自己的 `host:port`。
 * ② **不缓冲响应。** 那个界面的实时更新走 SSE（客户端用 EventSource、服务端发
 *    text/event-stream，实测不是 WebSocket）。一旦缓冲，界面就再也不刷新了。
 *    所以响应体一律 pipe，不攒。
 */
import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'

/** 这些头是「逐跳」的，不该被转发（RFC 7230 §6.1）。 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/**
 * 这些响应头会把「不许被嵌进框架」写死，我们要去掉——
 * 这个界面是要给手机看的（第一阶段开新标签，第二阶段可能就是内嵌）。
 * 去掉不等于放宽安全：能拿到这些响应的前提是**已经通过了我们自己的令牌**。
 */
const FRAME_BLOCKERS = new Set(['x-frame-options', 'content-security-policy'])

/**
 * 那条「受信任通道」的前缀。
 *
 * 装在这台机器上的 `dsh-remote-web-ui` 会在页面里装一条门控通道：它把手机上发的
 * 每个请求**改写成 `/remote/<原路径>`**，再带上设备令牌，由宿主那边认过令牌之后
 * 「以本机身份」重发一次。我们这边没有设备令牌，也不需要——
 * **因为我们的代理本来就从回环发出、Host 也固定成上游自己，宿主已经把我们当本机了。**
 *
 * 所以这里把前缀**剥掉**：`/remote/api/xxx` → `/api/xxx`。
 * 请求落到宿主时正是它想要的形状，那条通道于是「成功」，闸门自己就放下。
 */
const REMOTE_CHANNEL_PREFIX = '/remote'

/**
 * 这些路径可以让浏览器**长期留着**。
 *
 * 2026-10-06 量出来的：那 34 MB 里，**主程序包和插件包加起来 25 MB，上游一个缓存头都没给**
 * （首页 HTML 也没有；只有宠物立绘有 `no-cache` + etag）。浏览器于是只能"猜着缓存"，
 * 每次打开都可能重新拉一遍——**蜂窝下就是这么卡死的**。
 *
 * **为什么敢长期留**：这两类的地址里都带**内容指纹**——
 * `/assets/index-5SrrfWpU.js` 带哈希、`plugins/??a,b&rev=…` 带 rev。
 * **内容一变，地址就变**，所以旧的留着不会造成「看到旧代码」。
 *
 * 只给这两类，别的一律不碰（HTML 尤其不能缓存：它是外壳，还要我们注入）。
 */
const CACHEABLE = /^\/(assets|plugins)\//
const LONG_CACHE = 'public, max-age=604800'   // 7 天；地址带指纹，不需要更激进

/**
 * 告诉官方界面「你是这台主机的主人」。
 *
 * 官方界面把「配置面仅限本机」做成**客户端**判断（各客户端插件看
 * `connection.isLoopback`），而这个值由 `__DSH_TRANSPORT__.ownsHost` 推导出来。
 * 桌面外壳是在**任何启动项之前**把它设上的；这一页的服务端是我们，所以由我们授予。
 *
 * **必须尽早注入**（紧跟 `<head>`）：启动项是内联脚本，跑在 head 里，晚一步就读不到了。
 */
const HOST_HOOK = '<script>globalThis.__DSH_TRANSPORT__=globalThis.__DSH_TRANSPORT__||{};'
  + 'globalThis.__DSH_TRANSPORT__.ownsHost=true;</script>'

/**
 * **把别的插件的「移动端适配」挡在门外。**
 *
 * ## 为什么（2026-10-06 用户定的方向）
 *
 * 用户原话：「让我们的插件参考那个插件的方式来做『被搬过来的那个 DSH 界面』，
 * **而不是直接搬那个插件适配的界面**。等于电脑端设置界面实际上也应该是我们自己的插件的产物。」
 *
 * 这一页里的适配，**必须是我们自己做的**。可机器上装着的 `@linxin666/dsh-remote-web-ui`
 * 会**在运行时**往这一页里插一段适配样式、再往 `<body>` 上贴几个标记；它那些选择器
 * **写宽了**（`[class$="_overlay"] [class$="_panel"] …` 这类按类名后缀匹配），
 * 而官方界面的类名正好也是那几个，于是**官方面板被它一起改了**。
 *
 * **上一版我是在它的地基上打补丁**：它改了哪两处，我就把那两处掰回来。
 * 那是被动挨打——它以后多改一处，我就得再补一处。**现在改成从根上挡掉。**
 *
 * ## 挡哪几样
 *
 * · `remote-web-ui` 插的那段 `<style data-plugin-css="…">`——**里面还有没带 body 前缀的规则**，
 *   光摘标记挡不住它，必须连样式一起摘；
 * · `dsh-remote-portrait`——它的「适配生效」标记，整套 `body.… ` 规则靠它；
 * · `dsh-remote-compact-picker` / `dsh-remote-header-seated`——它另外两处改官方界面的标记。
 *
 * ## 后来又加了一个：`dsh-mobile-nav`（2026-10-06，用户真机报的）
 *
 * 用户报「设置页上方永远是一块只有图标的面板、占掉大半屏、名字要点一下才出来」。
 * 把这一页里所有样式表过了一遍，**改这套设置面板的只有两个插件**，其中真正**改布局**的是
 * `@dsh-external/dsh-mobile-nav/mobile.css`——这个 id 是 **`dsh-pocket`** 插件的客户端
 * （源码 `client/mobile/mobile.css.ts`，它自己给自己贴的名字）。它把面板的导航列表改成：
 *
 *     [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"]))
 *       > :first-child > :last-child { display: grid !important; grid-template-columns: repeat(3, 1fr) !important }
 *
 * ——「上方三列图标格子」就是这一条。它的特异性（0,6,1）**高于我们按 `[data-shortcut-modal]`
 * 写的规则**（0,2,0），两边都带 `!important` 时**特异性高的赢**，所以上一版我们那条
 * `flex-direction:row !important` 根本没生效（元素还是 `display:grid`，改方向没用）。
 * **补丁打不过它，把它的样式摘掉才是正解。**
 *
 * **摘它这一整份是安全的**：`mobile.css.ts` 整份都写在 `@media (max-width:1023px)` 里
 * （外加一段桌面端隐藏手机控件的守卫），**通篇都是手机适配，没有一条是界面正常运转必需**。
 * 实测：在镜像页里把这一整段摘掉，主页面截图**看不出变化**（它那套「框架 / 抽屉 / 悬浮按钮」
 * 规则靠 `[data-mobile-nav="frame"]` 这个标记，而这页里根本没有那个标记）。
 *
 * **故意不摘的**：`@linxin666/dsh-web-all/...../web-ui-settings.module.css`。它**不是纯适配**——
 * 同一份里还装着那个插件自己设置小节的正常样式（`.HfjcPG_section` / `_heading` / `_lede`…），
 * 整份摘掉会把那个小节的样式一起弄没。它对设置面板的唯一影响，是把第 5～8 个导航格的图标
 * 换成它自己画的，**不动布局**，留着无害。
 *
 * ## 代价（已经跟用户说清并获同意）
 *
 * 它自己那个「远程访问」设置页，在这一页里也会退回桌面样子。**这个代价该付**：
 * 镜像本来就是「电脑端界面」，本来就该是桌面样子；在别人的界面里塞手机样式，
 * 才是我们一直在收拾的那个烂摊子。
 *
 * ## 为什么盯着
 *
 * 它们都是**在运行时**插的样式：`remote-web-ui` 在竖屏/尺寸变化时会重新贴一遍，
 * `dsh-pocket` 也会在重新挂载时重插。所以不能只做一次。
 * 观察范围**故意收得很窄**（只看 head 的子节点、只看 body 的 class）：
 * 盯着整棵树会在这种重页面上白白烧掉性能。
 */
/**
 * ## 两层：通用规则 + 点名名单（2026-10-06 用户拍板「做吧」）
 *
 * 用户问：「如果我们安装了其他的远程遥控相关的 DSH 插件，都可能对这个页面造成影响？」
 * ——**会**。这一页搬的就是真的 DSH 界面，装了什么插件这里就有什么插件，
 * 而「手机适配」那一类插件本来就是冲着改界面来的，选择器写得很宽（`[aria-modal="true"]`、
 * `[class$="_navCell"]` 这种），**撞上官方的元素就改**。
 *
 * 只靠点名，等于**每装一个新插件就要再加一个名字**。所以补一层通用的：
 *
 * **通用层**：第三方（非 `@deepseek-ai/`）的样式表，**整份都写在窄屏条件里** → 摘掉。
 * 这类「手机适配」几乎都是这个形状（`dsh-pocket` 那份就是整份包在 `@media (max-width:1023px)` 里）。
 *
 * 判断**不拆字符串，交给浏览器的 CSS 解析器**（`style.sheet.cssRules`）：
 * 顶层规则**必须全是媒体查询、且条件里是窄屏**，才算「整份只在窄屏生效」。
 * 自己写正则去数大括号，遇到嵌套和注释就会判错。
 *
 * **点名层**：已知那两家**无论如何都摘**——它们有的规则并不在窄屏条件里（比如挂在 body 类名上的），
 * 通用层抓不到。
 *
 * ## 第三层：**摘标记**（2026-10-06 在真面板上量出根因之后补的）
 *
 * 「设置页导航只有图标、点一下才出字」的真凶是 `meow-smooth` 那个插件：它在面板上贴一个
 * `data-meow-smooth-settings="collapsed"`，一条 `opacity:0` 就把整排名字按成透明。
 * 它既躲过了点名层（标签上写的是 `data-plugin`，不是 `data-plugin-css`），
 * 也躲过了通用层（**它那几条选择器里一个类名都没有**，按类名搜根本搜不到）。
 *
 * 所以除了摘样式，**还要把面板上那个标记摘掉**：它的规则全部要求带那个标记，
 * 它的点击监听也只在状态是 `collapsed/expanded` 时才动手——标记一摘，两边同时失效。
 * 详见脚本里 `SETTINGS_MOBILE_ATTR` 那一段。
 *
 * **官方的包一律不动**（`@deepseek-ai/` 开头）：那是界面本身，摘了就把界面弄坏了。
 */
const STRIP_FOREIGN_ADAPT = `<script>(function(){
  // 点名名单：data-plugin-css 里含这些字样的一律摘（兜底，通用层抓不到的靠它）
  var STYLE_OWNERS = ["remote-web-ui", "dsh-mobile-nav"];
  // 挂在 body 上的「适配生效」标记，一并摘掉
  var BODY_CLASSES = ["dsh-remote-portrait", "dsh-remote-compact-picker", "dsh-remote-header-seated"];
  // 窄屏的判定上限：条件里的 max-width 不超过这个数就算窄屏
  var NARROW_MAX = 1280;
  /*
   * **第三条路：挂在面板上的「手机端设置页」标记**（2026-10-06 在真面板上量出来的）。
   *
   * meow-smooth 这个插件（源码 src/settings-mobile.ts）在窄屏把设置面板标成「收起态」：
   *   div[role="dialog"][data-meow-smooth-settings="collapsed"] > nav > div > button > span
   *     { flex:0; max-width:0; opacity:0 }
   * ——导航里的**名字整片透明**，只剩图标；而它同时在 document 上挂了个 capture 点击监听，
   * 点进导航时 preventDefault + stopPropagation、把标记改成 expanded，**字这才出来**
   * （顺带把那一次点击吃掉，所以点第一下还切不了页）。用户报的「只有图标、点一下字才出」
   * 一个字不差地就是它。
   *
   * **为什么前两轮都没抓到**：它那几条选择器里**一个类名都没有**（nav 底下直接到 button
   * 再到 span），按 navLabel 搜选择器搜不到；而它那份样式的标签上写的是
   * data-plugin="meow-smooth" 和 data-meow-settings-css，**压根没有 data-plugin-css**
   * ——上面两层（点名层、通用层）连看都没看它一眼。
   *
   * 所以补这一条：**把面板上那个标记摘掉**。摘掉之后它那些规则（全部要求带这个标记）
   * 和那个点击监听（状态不是 collapsed/expanded 就直接返回）**同时失效**——
   * 实测：摘掉后名字 opacity 立刻变 1、字出来、点标签能正常切页。
   *
   * **必须一直盯着**：关掉面板再打开时它会重新贴上去（实测过），所以不能摘一次就算完。
   */
  var SETTINGS_MOBILE_ATTR = "data-meow-smooth-settings";
  /*
   * **第四样：挂在 html 元素上的「卷起」标记**（2026-10-07 无头 Edge 加真触摸模拟量出来的）。
   *
   * 用户报「**主页面整片空白**（聊天页和别的非设置页都一样），只剩左上角鲸鱼按钮和立绘；
   * 设置页正常」，说这是回归。真凶是 meow-smooth 这个插件的另一条窄屏规则：
   *
   *   @media (max-width:1023px)
   *   html[data-meow-smooth-furled] [data-slot="root"] > [data-sidebar-collapsed]
   *     { grid-template-columns: 0px minmax(0px,1fr) 0px !important }
   *
   * 它把主框架那个网格**从一列改成三列**（0 / 1fr / 0），而这一页的 DOM 顺序跟它设想的不一样：
   * 官方的侧栏在 ≤768px 那段里是 position:absolute（脱流），于是**主栏成了第一个在流里的
   * 子元素、被塞进第 1 列那 0 个像素**——主栏宽度直接算成 0。
   * 活页面上连续量到的实况（390×844 视口、Emulation.setTouchEmulationEnabled 真触摸模拟）：
   *   主框架 grid-template-columns 算出来是 **0px 390px 0px**、
   *   主栏（[data-pane="conversation"]）**宽 0px**、
   *   欢迎语那个 span 被压成 **26×192 的竖排字**、输入框那一层 0 宽——
   *   整片内容都在，只是**每一层都被压成零宽**，屏幕上就只剩背景色（截图里面板关掉后
   *   只有鲸鱼按钮和立绘，跟用户那张截图一模一样）。
   *
   * **为什么不是我们摘错了东西**（用户的第一怀疑）：把整段 STRIP_FOREIGN_ADAPT 从网页里
   * 拿掉、原样重新加载，data-meow-smooth-furled 照样在、主栏照样是 **0px**。
   * 那个标记是 meow-smooth 自己贴的，跟我们摘不摘无关。前两层也抓不到它这条规则：
   * 它那份 style[data-plugin="meow-smooth"] **整份不是「只在窄屏」**（里面有没包媒体查询的
   * 规则，通用层判不过），选择器里也一个点名名单里的字都没有。
   *
   * **为什么摘标记就能治**：它这一套「卷起态」的规则**全部以 html[data-meow-smooth-furled]
   * 开头**（网格、隐藏侧栏那条竖线、会话头的 margin-left、它自己的悬浮球…）。
   * 标记一摘，整套同时失效，页面回到「没卷起」的布局——也就是这一页本来就该有的桌面样子。
   *
   * **为什么要一直盯着**：它跟设置面板那个标记是同一个性质，是在运行时贴上去的
   * （实测在应用启动后才出现），所以不能摘一次就算完。
   */
  var HTML_MOBILE_ATTR = "data-meow-smooth-furled";

  /** 这份样式是不是「整份只在窄屏生效」。 */
  function isNarrowOnly(tag) {
    try {
      var sheet = tag.sheet;
      if (!sheet || !sheet.cssRules || !sheet.cssRules.length) return false;
      for (var i = 0; i < sheet.cssRules.length; i += 1) {
        var r = sheet.cssRules[i];
        if (r.type !== 4) return false;   // 4 = CSSMediaRule，不是媒体查询就直接否掉
        var cond = String(r.conditionText || (r.media && r.media.mediaText) || "");
        var m = /max-width\\s*:\\s*(\\d+)/i.exec(cond);
        if (!m || parseInt(m[1], 10) > NARROW_MAX) return false;
      }
      return true;
    } catch (e) {
      // 读不到规则（跨源等）就当不是，宁可留着也不误摘
      return false;
    }
  }

  function strip() {
    try {
      var b = document.body;
      if (b && b.classList) {
        for (var i = 0; i < BODY_CLASSES.length; i += 1) b.classList.remove(BODY_CLASSES[i]);
      }
      // 面板上的「手机端设置页」标记（见上面那段说明）——它姓什么不重要，摘掉就是。
      var panels = document.querySelectorAll("[role=dialog]");
      for (var p = 0; p < panels.length; p += 1) {
        if (panels[p].hasAttribute(SETTINGS_MOBILE_ATTR)) panels[p].removeAttribute(SETTINGS_MOBILE_ATTR);
      }
      // 主界面那个「卷起」标记挂在 html 元素上（见上面 HTML_MOBILE_ATTR 那段说明）：
      // 不摘掉它，主栏的网格列就是 0px，整片主页面被压成零宽。
      var docEl = document.documentElement;
      if (docEl && docEl.hasAttribute(HTML_MOBILE_ATTR)) docEl.removeAttribute(HTML_MOBILE_ATTR);
      if (!document.head) return;
      // **样式标签上写的 data-plugin 也要看**：有插件（meow-smooth 就是）不用
      // data-plugin-css 那个约定，只写 data-plugin。只按前一个属性找，等于把这类整份漏掉。
      var st = document.head.querySelectorAll("style[data-plugin-css],style[data-plugin]");
      for (var j = 0; j < st.length; j += 1) {
        var tag = st[j];
        var v = String(tag.getAttribute("data-plugin-css") || tag.getAttribute("data-plugin") || "");
        if (v.indexOf("@deepseek-ai/") >= 0) continue;   // 官方的包不动
        var named = false;
        for (var k = 0; k < STYLE_OWNERS.length; k += 1) {
          if (v.indexOf(STYLE_OWNERS[k]) >= 0) { named = true; break; }
        }
        if (named || isNarrowOnly(tag)) tag.remove();
      }
    } catch (e) {}
  }

  strip();
  try {
    // **两个观察者，各自的范围都钉得很死**（原来是「看 head 的子节点 + body 自己的 class」，
    // 就是怕在这么重的页面上白烧性能，这条原则不变）。
    var mo = new MutationObserver(strip);
    if (document.head) mo.observe(document.head, { childList: true });
    if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    // 第二条只管**那两个标记**：设置面板那个挂在 body 深处的节点上，所以必须 subtree；
    // 但 attributeFilter 只有那两个属性名，别的属性怎么变都不会把我们叫醒。
    // （不跟上面合成一条：同一节点再 observe 一次是**替换**掉上一次，
    //   合成一条就得把 class 也放进 subtree 范围里——那才是真的会烧性能。）
    var moSettings = new MutationObserver(strip);
    if (document.body) {
      moSettings.observe(document.body, {
        attributes: true, subtree: true, attributeFilter: [SETTINGS_MOBILE_ATTR, HTML_MOBILE_ATTR],
      });
    }
    // 第三条只管 html 元素上那个「卷起」标记。**html 不在 body 里面**，
    // 上面那条 subtree 观察器够不着它，所以只能单独盯一个节点；
    // 不带 subtree、attributeFilter 只有一个名字，代价可以忽略。
    var moHtml = new MutationObserver(strip);
    if (document.documentElement) {
      moHtml.observe(document.documentElement, {
        attributes: true, attributeFilter: [HTML_MOBILE_ATTR],
      });
    }
  } catch (e) {}
})();</script>`


/**
 * **打开这一页就直接进设置**（2026-10-06 用户要的）。
 *
 * 用户原话：「我们现在打开那个页面，是正常的 DSH 网页端主页面，然后点设置打开设置页面，
 * 我们能否在移动端设置页点打开，打开的就是这个设置页面？」
 *
 * **官方没有网址入口**（读源码确认过：面板的开合是应用内部状态，不看地址），
 * 所以只能**替用户点一下那个「设置」按钮**。
 *
 * 那个按钮的可靠特征是 **`aria-haspopup="dialog"` + `aria-expanded`**
 * （官方渲染时写死的语义属性，不受类名哈希变化影响）。
 *
 * **只点一次**：用户把面板关掉之后**绝不能再弹回来**——否则他没法用底下那个主页面。
 * 所以点过就收手，连定时器一起停掉。
 *
 * 触发时机：那个按钮要等应用启动完才出现，所以**轮询等它**（最多两分钟），
 * 出现之后再等一小会儿（让它把各个设置小节也准备好），然后点。
 *
 * ## 点完**不再**「推一下」（2026-10-06 顾问群会诊后删掉的）
 *
 * 上一版在这里加了「打开设置后定时发 resize + 强制回流」的兜底，想逼界面把导航里的字画出来。
 * **顾问群明确提醒：那是盲目 hack，而且会污染以后的诊断**——它本身就是一次布局/重绘，
 * 会让「首帧到底画没画」这件事再也测不准。**已删。**
 *
 * 真根因找到了，而且**不是**这里（2026-10-06 在本地真面板上量出来的）：是
 * `meow-smooth` 那个插件在窄屏把面板标成「收起态」、用 `opacity:0` 把名字按透明。
 * 已经按 `STRIP_FOREIGN_ADAPT` 的第三层（摘标记）治掉，`ADAPT_CSS` 那边只留兜底，
 * 详见那两处的说明。这件事的教训：**别在猜出来的根因上做修复**——
 * 猜的那一版（改 `flex` / `min-width`）真机上一点用没有，因为藏字的是 `opacity`。
 * 真机上若还有怪现象，走 `DIAG_SCRIPT` 那条自报数据的路（`?diag=1`），
 * **而不是再叠一层定时兜底**。
 */
const AUTO_OPEN_SETTINGS = '<script>(function(){'
  + 'var done=false,tries=0,timer=null;'
  + 'function fire(){'
  + 'if(done)return;'
  + 'if(++tries>240){clearInterval(timer);return}'
  + 'var b=document.querySelector(\'button[aria-haspopup="dialog"][aria-expanded]\');'
  + 'if(!b)return;'
  + 'done=true;clearInterval(timer);'
  + 'setTimeout(function(){try{b.click()}catch(e){}},1200);'
  + '}'
  + 'timer=setInterval(fire,500);'
  + 'fire();'
  + '})();</script>'

/**
 * **我们自己**给这一页做的布局适配。
 *
 * 这是「我们自己的产物」那一半——见上面 STRIP_FOREIGN_ADAPT 的说明：
 * 先把别的插件的适配挡在门外，**要改什么由这里说了算**。
 *
 * 现在只有两条，都是**实测出来的**：
 *
 * ① **把设置面板那层浮层抬到侧栏上面。** 官方界面里侧栏是 `position:absolute; z-index:1100`，
 *    设置面板那层浮层是 `z-index:1000`——**侧栏比它高一百**。桌面端侧栏只占左半边，
 *    看不出来；手机屏窄，侧栏一展开就整屏盖住，点「设置」什么都看不见。
 *
 *    **第一版我把侧栏压到 20，那是反的，真机上立刻出问题**：面板的**遮罩**（同一层，
 *    1000）反过来盖住了侧栏，用户看到侧栏发暗、**点击落在遮罩上**——遮罩一收侧栏就消失，
 *    设置页也进不去。**所以要把面板抬上去，不能把侧栏压下去。**
 *
 * ② **底部让开手势条/圆角——这一条已经搬去外层页**（2026-10-07 搬的，理由在 `ADAPT_CSS`
 *    那一行的注释里）：`#mirrorFrame` 是外层页 lib/page.html 的元素，注进被镜像文档的规则
 *    一个像素都管不着它。顶部那条一直就在我们自己手里（page.html 的 `.mv-bar` 的
 *    `padding-top`），现在底部那条也回去了。
 *
 * **删掉的一条**：上一版这里还有「把官方设置面板的导航掰回竖排、字始终显示」——
 * 那是在**别的插件的地基上打补丁**（它改哪两处我就掰哪两处）。现在改成从根上挡掉
 * （见 STRIP_FOREIGN_ADAPT），**那两条补丁不需要了**。
 *
 * ③ **把设置面板的导航压成一条「可横向滑动的标签条」，把屏幕让给内容。**
 *
 *    2026-10-06 用户报：「上方的图标部分，下方点了图标的具体页面，然后上方页面一直固定在那，
 *    具体页面只有半个手机屏」。**读官方客户端源码确认过**：官方面板本来是「左边一列导航
 *    188px + 右边内容」，而**它自己的 `wide` 只影响侧栏那个按钮、完全不影响面板内部布局**——
 *    所以「横排在上方」是别人注入的样式干的（见 STRIP_FOREIGN_ADAPT）。
 *
 *    **是谁干的已经查清了**（2026-10-06）：是 `@dsh-external/dsh-mobile-nav`（`dsh-pocket`）
 *    那一条三列网格规则，特异性比我们高，所以上一版我们那条 `flex-direction:row` 打不过它
 *    ——现在按名单把它的样式整个摘掉（见 STRIP_FOREIGN_ADAPT），**这里不再跟谁抢优先级**，
 *    只按我们要的样子定下来：
 *    面板改成竖排（导航在上、内容在下），导航压成**一行、不折行、可横向滑动、名字露出来**。
 *    这样导航只占约 50px 高，**剩下的整屏都给内容**。
 *
 *    **选择器用 `[data-shortcut-modal="settings"]`**：这是官方渲染在面板上的固定标记
 *    （`role="dialog"`、`aria-modal="true"` 那一块），**不受类名哈希变化影响**，比按后缀猜稳。
 *
 * **不改的**：官方界面自己已经把侧栏做成抽屉了（`position:absolute` + 网格父元素）。
 * 我原以为要改它，注入试过才发现是白改——**动之前先试，别凭想象改**。
 *
 * ④ **把 `_content` 的高度链接上，让它能滚**（2026-10-07 真面板量出来的）。
 *
 *    用户报「点击图标出现的页面没有滚动条，也没法滚动往下拉」。**这次先怀疑的方向是错的**：
 *    我照着截图上「插件市场」四个字竖着排，判断「面板又变回横排、内容区被挤扁」，
 *    甚至打算再去追「哪个插件把面板改回横排」。
 *
 *    **量了才知道不是**：在真面板上逐张样式表 `matches()` 一遍，管着面板的规则只有两条
 *    ——官方那条 `.xxx_panel{display:flex;…}` 和**我们自己**那条 `flex-direction:column`，
 *    nav 的计算方向是 `row`、`_content` 是 `column`，**竖排好着呢**；
 *    我还在 390px 视口下把十几个导航格子逐个量了 rect：**全都在一条 55px 高的横条里**。
 *    截图里那四个竖排的字，是那个小节自己的标题栏窄，不是面板被挤扁。
 *
 *    **真正的病灶**：`_content` 缺 `min-height:0`，高度链断在这一层，
 *    于是「滚不动」——详见 `ADAPT_CSS` 里那一行上面的说明（有前后实测数字）。
 *
 *    教训跟上一轮一样：**别在猜出来的根因上做修复**。上一轮猜「官方 flex 为竖列设计」，
 *    真原因是别的插件的 `opacity:0`；这一轮猜「又变回横排了」，真原因是高度链断了。
 *    两次都是**先在真面板上量、再动手**才对的。
 *
 * ⑤⑥⑦ **「插件市场」那一节（`dsh-market`）**（2026-10-07 在真面板上量出来的，见下面逐条注释）：
 *    ⑤ 它的标题行是 `nowrap` 的 7 件东西挤 **286px**，中文按字断行 → 标题和按钮变竖排、
 *       最后一个按钮被裁掉 → **给它折行**；
 *    ⑥ 它自带一条窄屏规则把面板的导航整条藏掉（进了这一节就没导航、回不去别的节）
 *       → **按更高的特异性要回来**；
 *    ⑦ 它那排页签总宽 427px 而只有 286px、自己不滚 → 右边三个被裁掉 → **给它横向滚动**。
 *    三条都**锁在 `[data-dsh-market-root]` 里面**，只碰它这一节，别的插件/别的节一条都不动。
 *
 * ⑧–⑭ **同一节里「那块能滚的列表窗口」再做大**（2026-10-07 用户第二次报「窗口高度还是太矮」，
 *    逐项在真面板上量的，账写在下面逐条注释里）：面板撑高、官方那两处富余留白、市场自己的留白，
 *    以及**标题行里重复的信息**（图标 / 仓库名 / 版本号）。合起来列表窗口 **356 → 498px**，
 *    看卡片的地方 **204 → 378px**；**有用的东西一样没少**（三个按钮、搜索、分类、提示条、页签）。
 *    同样全部锁在市场根里——`:has()` 只在真的停在这一节时才命中（切走之后市场根会被卸载，
 *    活服务上实测过）。
 *    我们**自己**那排导航也顺手压矮了（⑮，见 `nav` 那两条）：它属于我们自己的适配，
 *    每高 1px 都是每个节的内容区少 1px，实测市场那一节**列表窗口 +10px**。
 *
 * ⑯ **同一节里「社区介绍」那一整格藏掉**（2026-10-07 用户第二次点名：「导出日志也可以隐藏」）：
 *    那一格 56px 里四件东西——纯介绍文字（36px，两行）、「申请收录插件 ↗」（18px，给作者用的）、
 *    一个空占位、「导出日志」（90×28，诊断按钮）。上一轮只藏了前两样、把导出日志留着
 *    （列表窗口 498 → 526px）；这一轮用户点名把导出日志也藏掉，于是**整格都藏**：
 *    **526 → 560px**、看卡片的地方 **406 → 440px**（+34 = 那个按钮 28 + `_head` 那道 6px 间隔）。
 *    **整格藏比「只把按钮也加进隐藏名单」多赚 6px**：那一格留在 DOM 里哪怕高度是 0，
 *    `_head` 的 flex gap 照样占一道。
 *
 * ⑰ **共用那条「内容区头」里的动作区藏掉**（2026-10-07 用户点名：「打开配置文件也可以隐藏」）。
 *    **这一条故意不在市场根里，它作用在每一个设置节**——那条头是面板自己的
 *    （`_content > _header`），16 个节实测长得一模一样：`_actions`（94×28，里面**只有**
 *    「打开配置文件」一个按钮，逐节点名数过）+ `wCInkW_close`（28×28）。
 *    所以它和「只给插件市场腾高度」不是一回事：写着共用就写在共用层，不假装它只在市场里。
 *
 *    **它一分高度都省不下**（真面板实测）：市场那一节 40px、别的节 54px（官方写死的
 *    `height:54px`），这两条**本来就由 ✕ 那一行撑着**——藏掉左边那件之后，头高、内容区高、
 *    能滚的像素**三个数一个都没变**。收益 0，只是少一个按钮；用户知情后仍要藏，所以照做，
 *    但账留在这里，别让后人以为它腾出了高度。
 *
 *    同一条里补的 `justify-content:flex-end` 是**给这条规则自己的副作用收尾**：官方那条头是
 *    `space-between`，而动作区自己带 `margin-left:auto`（实测解出来 188px）、被它顶在最右边；
 *    动作区一藏，只剩 ✕ 一个孩子，`space-between` 就把它放到最左边——✕ 从 x=324 跳到 x=34。
 *    ✕ 是用户唯一能退出面板的出口，不该因为它左边那件东西消失就换到另一头——
 *    固定成右对齐之后实测 ✕ 回到 **x=324**（与改前一致），仍然 28×28、点得中、点了就关。
 *
 * 类名按**后缀**命中：它的类名是「哈希_名字」，哈希每次构建都变，只有后半段稳。
 */
const SETTINGS_PANEL = '[data-shortcut-modal="settings"]'

const ADAPT_CSS = '<style id="mini-mirror-adapt">'
  // 抬到 1200 的**只许是设置面板那一层**（2026-10-07 收窄的）。
  //
  // 原先是 `[class*="_overlay"]` 一把抓——「按后缀命中」这种写法在我们自己手里也会失手：
  // 活服务上量到的实况（`document.querySelectorAll('[class*="_overlay"]')` 的每一个人）：
  //   · `.BynINW_overlayLayer`（官方浮层容器，原生 `z-index:20`）被抬成 **1200**；
  //   · `.RlGAzG_overlayAnchor`（原生没有 z-index）被抬成 **1200**；
  //   · 官方账号那一层 `.TaJwIq_overlay`（原生 `z-index:1001`、整屏）也在名单里；
  //   · 还有 tldraw 的 `.tlui-dialog__overlay` / `.tl-error-boundary__overlay`
  //     ——活那几份样式表里名字带 `_overlay` 的一共七八个，我们只想动其中一个。
  // 一个 `z-index:20` 的容器被抬到 1200，它的子树（`> *` 是 `pointer-events:auto`）就跟
  // 设置面板平级、还能按 DOM 顺序压上去——这就是「一把抓的选择器顺手把别人也改了」，
  // 和上一版「把侧栏压到 20」是同一类失手，只是方向反过来。
  //
  // 收窄成：**只有那个「直系子元素就是设置面板」的浮层**才抬。设置面板上的
  // `data-shortcut-modal="settings"` 是官方固定标记（理由见下面 ③ 那段），不随类名哈希变；
  // 活服务上全文档里这个标记只有一个，而一个元素只有一个父级，
  // 所以这条选择器**有且只有一个命中**——正好是设置面板那一层。
  // 官方结构（活服务上量的）：`wCInkW_overlay > wCInkW_mask + wCInkW_panel[data-shortcut-modal=settings]`。
  + '@media (max-width: 640px){[class*="_overlay"]:has(> [data-shortcut-modal="settings"]){z-index:1200 !important}}'
  // 底部让位那一条（原 `#mirrorFrame{padding-bottom:env(safe-area-inset-bottom,0px)}`）**搬走了**：
  // `#mirrorFrame` 在外层页 lib/page.html 里，这段样式却是注进**被镜像的那份文档**的
  // ——两个文档，那条规则从写下的那天起就没生效过（活服务上量到：框的 padding-bottom = 0px，
  // 而被镜像的那份 HTML 里躺着一份官方界面根本没有的 `#mirrorFrame` 规则）。
  // 现在写在 page.html 的 `#mirrorFrame` 上，**这里不留同一条**（留着等于误导后人去改它）。
  //
  // **面板高度也不要在这里收**（2026-10-07 量过之后决定不写）：
  // 参考插件给它那份面板补了 `max-height:calc(100dvh - 32px)`。那条在**它那个架构**下成立
  // （它用的是顶层文档，`dvh` 看得见地址栏），在我们这里不成立——镜像页跑在 iframe 里，
  // **嵌套视口的 `dvh` 等于框自己的高**（无头 Edge 实测：400px 的框里 vh=dvh=svh=lvh=400，
  // 1200px 的框里四个都是 1200；「地址栏差值」本来就是顶层帧才有的东西），
  // 到我们这儿它退化成 `100vh - 32px`；
  // 而官方面板的高度是 `min(800px, calc(100vh - 48px))`，**本来就比它矮 16px**，
  // 于是这条 max-height 永远轮不到生效（活服务上 844 / 600 / 500 三个视口高度都量过：
  // 面板高 796 / 552 / 452，而那条规则解出来是 812 / 568 / 468，挂上去面板高度一点没变），
  // 加进来就是一条**死规则**——正是 ① 刚清掉的那种。
  // 地址栏把面板顶出屏幕这件事，账在**外层页**（框的高度按可视区算），不在这里。
  // ③ 设置面板：导航压成一条可横向滑动的标签条（见上面那段说明）
  + '@media (max-width: 640px){'
  + SETTINGS_PANEL + '{flex-direction:column !important}'
  + SETTINGS_PANEL + ' [class*="_navTitle"]{display:none !important}'
  // ④ **内容区的高度链要接上，不然「能看见」但「滚不动」**（2026-10-07 真面板量出来的）。
  //
  // 用户报：「点击图标出现的页面没有滚动条，也没法滚动往下拉」。第一眼看像滚动坏了，
  // **其实是高度链断在 `_content` 这一层**——官方的规则里只写了
  //   `.xxx_content{flex:1 1 0%; min-width:0}`，**没有 `min-height:0`**。
  // 桌面横排时它恰好等于面板高（1500px 视口实测 panel 800 / nav 800 / content 800），
  // 所以官方自己看不出问题；**我们一改成竖排，导航在上面占掉 55px，这一层的
  // 「自动最小高度」（`min-height:auto` = 内容高）就顶穿了面板**：
  //   实测 panel 高 796（overflow:hidden）、content 高 **1425**、options 高 **1371**，
  //   而 `_options` 的 scrollHeight 也是 1371 —— **它能滚多少 = 0**。
  //   面板自己那点 `overflow:hidden` 只是把超出部分裁掉，裁掉的部分永远拉不回来。
  //
  // 补上 `min-height:0` 之后（同一次实测）：content 1425 → **741**、
  //   options 1371 → **687**、**能滚 684px**，位置和 `[class*="_options"]` 原本
  //   就写着的 `min-height:0` 对上了——**官方的滚动设计本来就是靠这一层收口，
  //   只是它漏写了 `_content`**。
  //
  // **故意不加媒体查询**：面板高是 `min(800px, calc(100vh - …))`，横排桌面端
  // 也只有 800px 高，一样需要这一层收口（只是它碰巧没露馅）。条件写得越少越不容易写错。
  //
  // **也不去想别的补法**（比如给 `_options` 写死高度、或者把面板改成 `overflow:auto`）：
  // 那是绕过官方的滚动结构另造一套；我们只把它缺的那一格补上，其余照旧。
  + SETTINGS_PANEL + ' [class*="_content"]{min-height:0 !important}'
  // **上下内边距 8px → 5px、格子高 34px → 30px**（2026-10-07 量的，也就是上面说的 ⑮）。
  // 这排导航是我们自己的东西，它每高 1px，下面每一个设置节的内容区就少 1px；
  // 在「插件市场」那一节这个换算最直接：实测**列表窗口 +10px**（356 → 366）。
  // 只压高度、不动字号（13px 照旧，读起来一样）——缩的是上下留白和格子高度，
  // 手机上 30px 的格子在这个「横向滑动的标签条」里仍然点得中。
  + SETTINGS_PANEL + ' nav[class*="_nav"]{'
  + 'flex-direction:row !important;flex-wrap:nowrap !important;width:auto !important;'
  + 'gap:6px !important;padding:5px 10px !important;overflow-x:auto !important;overflow-y:hidden !important}'
  + SETTINGS_PANEL + ' [class*="_navList"]{'
  + 'flex-direction:row !important;flex-wrap:nowrap !important;gap:6px !important;'
  + 'overflow-x:auto !important;overflow-y:hidden !important}'
  + SETTINGS_PANEL + ' [class*="_navCell"]{'
  + 'flex:none !important;height:30px !important;padding:0 12px !important;gap:6px !important}'
  // 名字：**首帧没字的真根因已经量出来了**（2026-10-06，在真面板上）。
  //
  // 上一版顾问群判断「官方 flex 是为竖列设计的、被我们改成横排后首帧被压到零宽」——
  // **真机验证证伪了**。后来在本地把真面板打开、逐张样式表 matches 一遍，真相是：
  // `meow-smooth` 那个插件把面板标成「收起态」，一条
  // `... > nav > div > button > span { flex:0; max-width:0; opacity:0 }`
  // 让名字**有宽度、有文字，但整片透明**（实测 rect 52×22、textContent 正常、opacity 0，
  // 而同一个格子里的 svg 图标 opacity 1——「图标在、字不在」）。
  // **真凶已经按第三层摘掉了**（见 STRIP_FOREIGN_ADAPT 里那个属性清扫）。
  //
  // 这几行仍然留着，而且补上 opacity / max-width：它们是**兜底**——
  // 万一真机上有哪一路没被摘干净（插件在别处的时机重新贴标记、或者别的插件用同一种
  // 「视觉隐藏」的手法），名字也不至于再隐身一次。实测过：`opacity:0` 不带 !important，
  // 我们这条带上就赢；`max-width:0` 会把 `width:max-content` 掐死，所以也必须一起覆盖。
  + SETTINGS_PANEL + ' [class*="_navLabel"]{'
  + 'flex:0 0 auto !important;min-width:max-content !important;width:max-content !important;'
  + 'max-width:none !important;opacity:1 !important;'
  + 'clip:auto !important;height:auto !important;position:static !important;'
  + 'overflow:visible !important;white-space:nowrap !important;font-size:13px !important}'
  // ⑤ **「插件市场」那一节的标题行要折行**（2026-10-07 在真面板上量出来的）。
  //
  // 用户截图里那一节整个是竖的：「插件市场」四个字竖着排、右边按钮也竖着排、
  // 最右边那个还缺了一半。逐张样式表 `matches()` 量下来，**跟我们摘的那些样式无关**——
  // 那一节自己的 `dshmarket/Market.module.css`（67179 字）一直躺在页面里，
  // 我们的通用层一条都没摘它（它 571 条顶层规则里只有 5 条是媒体查询，判不成「整份只在窄屏」）。
  // 病灶是它自己这一条：
  //   `.xxx_titleRow{display:flex;align-items:center;gap:10px}`   ← 没写 flex-wrap，默认 nowrap
  // 这一行里塞了 7 个东西（图标 22 + 标题 + 仓库名 66 + 版本 44 + 三个按钮），
  // 各自的最小宽度加起来 ≈ **308px**（gap 10×6 就占掉 60），而面板在手机上只给得出 **286px**。
  // 中文可以按字断行，于是浏览器把那几个「缩得动的」**全压到只剩一个字宽**——实测：
  //   标题 `H2._title` **16×96**（四个字竖着排）、三个按钮 **32 / 36 / 32** 宽（字竖着排）、
  //   最后一个按钮右缘 **359** > 市场区右缘 **342**（超 17px，被裁掉，用户看到的缺字就是它）。
  // 给它一条折行就够（同一次实测）：标题回到 **63×24**、按钮回到 **92 / 87 / 116** 宽、
  // 溢出 17px → **0**，整行 96 → 100px 高（换成三行，高度几乎没变）。
  // **选择器锁在市场根里面**（`[data-dsh-market-root]` 是它自己的固定标记）：
  // 只碰这一行，别的布局一条都不动；它以后改了类名，这条就自动失配而不是改坏别人。
  + SETTINGS_PANEL + ' [data-dsh-market-root] [class*="_titleRow"]{flex-wrap:wrap !important}'
  // ⑥ **进了这一节，把被它藏掉的导航要回来**。它自带一条窄屏规则：
  //   `@media (max-width:560px){ [role="dialog"]:has([data-dsh-market-root]) > nav{display:none} }`
  // ——进了「插件市场」，整条导航就被它藏了（实测 nav 计算 `display:none`、0×0；
  // 用户截图里那排图标也没了），而且**没有导航就切不回别的节**。
  // 那是它给「手机上的整页市场」写的，在这一页不该生效（方向：这一页的适配由我们定）。
  // 它的特异性 (0,2,1)；两边都带 `!important` 时**特异性高的赢**（这一条我们领教过多次），
  // 所以这里写到 (0,3,2)。`:has(…)` 保证只在它真的在页面里时才出手。
  // 实测：加上之后 nav 回到 **342×55**，和别的节排布完全一致。
  + SETTINGS_PANEL + '[role="dialog"]:has([data-dsh-market-root]) > nav{display:flex !important}'
  // ⑦ **同一节那排页签也要能划**：它 7 个页签总宽实测 **427px**（scrollWidth），
  // 给它的只有 **286px**；偏偏它自己不滚也不折行（`.tabs{display:flex;gap:2px}`），
  // 于是右边三个页签**被裁掉**（实测最右页签右缘 **479** > 市场区右缘 **342**，
  // 用户截图上「已屏」后面就断了）。给它一条横向滚动，裁掉的页签划得出来。
  // 只加滚动，不动它的大小和间距——页签条的高度和别处一样。
  + SETTINGS_PANEL + ' [data-dsh-market-root] [class*="_tabs"]{'
  + 'overflow-x:auto !important;overflow-y:hidden !important}'
  // ⑧⑨⑩⑪⑫⑬⑭ **把「插件市场」里那块能滚的列表窗口做大**（2026-10-07 逐项在真面板上量的）。
  //
  // 用户报：「显示那些供下载的插件的窗口高度还是太矮了」。先在活页面上把这一节的纵向账
  // 逐项量了一遍（390×844，量的是 `[data-dsh-market-root]` 里那个 `_body` 的 clientHeight，
  // 也就是**能滚的那个窗口**）：
  //   面板高 798 里，面板上下居中各留掉 23；我们的导航 55；内容区那条头（打开配置文件 + X）54；
  //   市场自己的 `_head` **307**（标题行 100 + 社区那格 56 + 页签 39 + 提示条 66 + 留白 46）；
  //   列表区自己上下留白 36；吸附的搜索/分类 116 —— 最后**只剩 356px** 给列表。
  // 下面的七条都是「该省的重复信息和富余留白」，**没有一条去藏有用的东西**：
  // 那三个按钮、搜索框、分类筛选、提示条、页签、导出日志全部照旧在（⑪ 藏掉的三样是
  // 图标、仓库名 `dsh-market`、版本号 `v1.66.6`——用户已经知道自己在哪一节，这三样是重复的）。
  //
  // **全部锁在市场根里**（`:has([data-dsh-market-root])` 或 `[data-dsh-market-root]`）：
  // 活服务上实测过「切到别的节之后市场根会被**卸载**」（`_options` 下挂着的市场数从 1 变 0），
  // 所以 `:has()` 只在真的停在这一节时才命中，别的节一个像素都不会动。
  //
  // ⑧ **面板本身撑高**：官方给面板的高度是 `min(800px, calc(100vh - 48px))` 再上下居中，
  //    在手机上白留掉上下各 23px。面板的父级是 `position:fixed; inset:0` 的浮层（实测 844 高），
  //    所以 `calc(100% - 10px)` 有确定的参照。实测 **798 → 836，列表窗口 +38px**。
  //    只在市场节生效——别的节照旧是官方那个高度。
  + SETTINGS_PANEL + ':has([data-dsh-market-root]){height:calc(100% - 10px) !important;max-height:none !important}'
  // ⑨ **内容区那条头的上内边距 20px → 6px**：官方 `.header{padding:20px 14px 8px 10px}`。
  //    那 20px 只是留白（量过：nav 底到按钮顶之间**没有任何元素**，也没有伪元素、没有拖拽把手），
  //    实测 **列表窗口 +14px**。
  //
  //    **`height:auto` 那半句不能省，它才是这条规则能不能生效的关键**（第一版就漏了，
  //    量出来一点没变）：官方给这条头写的是 `box-sizing:border-box; height:54px`
  //    ——高度写死了，光改内边距它纹丝不动（量到改前改后都是 54px，这条规则等于没写）。
  //    把高度交还给内容（28px）+ 内边距（6+6）之后才真的收到 40px。
  + SETTINGS_PANEL + ':has([data-dsh-market-root]) [class*="_content"] > [class*="_header"]{'
  + 'padding:6px 14px 6px 10px !important;height:auto !important}'
  // ⑩ **`_options` 那 24px 下内边距在这一节是白留的**：官方 `._options{padding:0 24px 24px}`，
  //    而市场根是 `height:100%`——正好量到「市场根 663 + 24 = 选项区 687」，
  //    这 24px 谁也用不到。实测去掉之后**列表窗口 +24px**。
  //    **只去掉下边那一条**，左右那 24px 留着（那是内容的左右留白）。
  //    按「内容区的直接子元素」点它（`[class*="_options"]` 这个子串在整棵面板里未必只有一个）。
  + SETTINGS_PANEL + ':has([data-dsh-market-root]) [class*="_content"] > [class*="_options"]{'
  + 'padding-bottom:0 !important}'
  // ⑪ **标题行里重复的信息藏掉**：前图标（22px）、仓库名 `dsh-market`、版本号 `v1.66.6`。
  //    用户定的线是「该省的只有重复的信息」——这一节在哪、叫什么，导航格子上已经写着并且高亮着。
  //    省下的宽度让两件事发生（实测）：那一行从**三行 100px 收到两行 66px**，
  //    「更新插件市场 / 全部更新 (7)」两个按钮回到标题同一行（**列表窗口 +34px**）。
  //    **三个按钮一个都不动**，`重启前都不再提醒` 也还在（它落到第二行）。
  //    **后两样都再写一遍 `_titleRow`**（不是省字）：`[class*="…"]` 是**子串**匹配，
  //    `_version` 这种名字要是不限定在标题行里，将来市场给卡片里的版本号起个
  //    `xxx_version` 的类名，就会被这条规则连卡片内容一起藏掉——那是「压扁/截断卡片」，
  //    用户明确不许。⑬ 那条 `_cats` 已经栽过一次（见那里的注释），这里先写死。
  + SETTINGS_PANEL + ' [data-dsh-market-root] [class*="_titleRow"] > svg,'
  + SETTINGS_PANEL + ' [data-dsh-market-root] [class*="_titleRow"] [class*="_repoLink"],'
  + SETTINGS_PANEL + ' [data-dsh-market-root] [class*="_titleRow"] [class*="_version"]{display:none !important}'
  // ⑫ **市场头部那几块之间的留白**：`gap 12px → 6px`、`padding 4px 4px 6px → 4px 4px 2px`。
  //    四块之间本来有三道 12px 的空档（36px），收成 6px。实测 **列表窗口 +22px**。
  //    用**直接子元素** `>`：`_head` 这个名字短，`[class*="_head"]` 会连 `_header` 一起命中
  //    （官方面板那条头就叫 `_header`），所以这里按「市场根的直接子元素」来点它。
  + SETTINGS_PANEL + ' [data-dsh-market-root] > [class*="_head"]{gap:6px !important;padding:4px 4px 2px !important}'
  // ⑬ **吸附头的留白**（搜索那一行 + 分类那一行，它 `position:sticky` 钉在列表顶上，
  //    所以它每高 1px，**看卡片的地方就少 1px**，而且是**一直在少**）：
  //    `_tabSearchRow{padding:0 4px 12px}` → 下边 6px；`_cats{padding:12px 4px 4px}` → `6px 4px 2px`。
  //    实测吸附头 **116 → 102**，看卡片的地方 +14px。**搜索框和分类筛选一个都不动**，只收留白。
  //
  //    **第一版写的是 `[class*="_cats"]`，量出来反而高了 8px**（72 → 80）：子串匹配把
  //    `_catsRow`（56 → 72）和 `_catsWrap`（56 → 64）也一起命中了，三层各自多了一层内边距。
  //    所以这两条都按**吸附头的直接子元素**点（`_stickyHead > _tabSearchRow` / `_stickyHead > _cats`）。
  //    ——跟本文件开头那些「按后缀命中」的教训是同一个坑，只是这次是我们自己踩的。
  + SETTINGS_PANEL + ' [data-dsh-market-root] [class*="_stickyHead"] > [class*="_tabSearchRow"]{'
  + 'padding-bottom:6px !important}'
  + SETTINGS_PANEL + ' [data-dsh-market-root] [class*="_stickyHead"] > [class*="_cats"]{'
  + 'padding:6px 4px 2px !important}'
  // ⑭ **列表滚动区自己的上下留白**：`padding:12px 4px 24px` → `6px 4px 12px`。
  //    这两条**不改变滚动窗口的高度**（窗口高是外面 flex 算好的），改的是**窗口里能看见卡片的净高**：
  //    实测看卡片的地方 **+18px**（上 6 + 下 12）。列表有 5000 多 px，下边那点留白只在滚到底时才看得见。
  //    同样用直接子元素（`_body` 也是短名字）。
  + SETTINGS_PANEL + ' [data-dsh-market-root] > [class*="_body"]{'
  + 'padding-top:6px !important;padding-bottom:12px !important}'
  // ⑯ **「社区介绍」那一整格都藏**（2026-10-07 用户第二次点名：「导出日志也可以隐藏」）。
  //
  // 真面板上把这一格拆开量了一遍（390×844，`[data-dsh-market-root] > _head > _sub`，
  // 整格 56px 高，四件东西）：
  //   ① 介绍文字 `span`——**一个 class 都没有**（这一格里唯一没有 class 的元素），
  //      188×36（两行 18px），**整格的高度就是它撑起来的**；
  //   ② 「申请收录插件 ↗」`a._submitLink`——188×18，**给插件作者用的入口**；
  //   ③ `span._grow`——空占位，这一档宽度下它自己就是 `display:none`，不占高；
  //   ④ 「导出日志」`button._exportLogBtn`——90×28，**排查问题时用的按钮**。
  //
  // **上一轮只藏前两件、把导出日志留着**（那是我们主动做的偏离，用户当时没点名它）；
  // 这一轮用户点名「导出日志也可以隐藏」，四件一起走。实测（`scratch/mkt-hide2.txt`）：
  //   上一轮（只藏前两件）→ 那一格 28px、列表窗口 **526px**、看卡片 **406px**；
  //   **这一轮（整格都藏）→ 那一格 0px、列表窗口 **560px**、看卡片 **440px**。
  //   **+34 = 导出日志那 28px + `_head` 那一道 6px 的间隔**。
  //   这也是为什么藏整格比「只把 `_exportLogBtn` 加进隐藏名单」更划算，多赚那 6px：
  //   那一格留在 DOM 里哪怕高度是 0，`_head` 的 flex gap 照样占一道。
  //
  // 两道锁，都是子串匹配踩过的坑：
  //   · `[class*="_sub"]` **会同时命中 `_submitLink`**（`_sub` 是它的前缀子串）。
  //     所以按「市场根 > `_head` > `_sub`」的**直接子元素**链来点：那个 `a` 不在这条链上，
  //     自然不匹配；`_head` 也必须带 `>`（`[class*="_head"]` 还会命中官方面板那条
  //     `_header`，⑫ 已经栽过一次）。
  //   · 再加一道 `:has(> [class*="_submitLink"])`，要求「这一格确实是我们量过的那个形状」——
  //     **整格藏比只藏两个子元素下手更重**，更该有这道闸：将来市场改结构时**失配**
  //     （什么都不藏）比**误伤**（藏了别人）好。
  + SETTINGS_PANEL + ' [data-dsh-market-root] > [class*="_head"] > [class*="_sub"]'
  + ':has(> [class*="_submitLink"]){display:none !important}'
  // ⑰ **共用那条「内容区头」里的动作区**（2026-10-07 用户点名：「打开配置文件也可以隐藏」）。
  //    **这一条故意不带市场限定**——理由见文件开头 ⑰ 那一段：那条头是面板自己的，
  //    16 个设置节实测一模一样，`_actions` 里**只有「打开配置文件」一个按钮**。
  //    所以它影响**每一个**设置节，藏的是「每个节都能开配置文件」这个入口。
  //    **收益 0**（真面板实测：头高 40/54、内容区高、能滚的像素三个数前后一个都没变）：
  //    那一条头的高度本来就是 ✕ 撑着的。
  //    用「内容区的直接子元素」把 `_header` 钉住，再点它的直接子 `_actions`——
  //    `_action` 这个子串在别的插件里也可能出现，链子写全才锁得住。
  + SETTINGS_PANEL + ' [class*="_content"] > [class*="_header"] > [class*="_actions"]{display:none !important}'
  //    右对齐这一条是**给上面那条规则自己的副作用收尾**：官方那条头是 `space-between`，
  //    而动作区自己带 `margin-left:auto`（实测解出来 188px）、被它顶在最右边；动作区一藏，
  //    只剩 ✕ 一个孩子，`space-between` 就把它放到最左边——✕ 从 x=324 跳到 x=34。
  //    ✕ 是用户唯一能退出面板的出口，不该因为它左边那件东西消失就换到另一头。
  //    实测加上之后 ✕ 回到 **x=324**，28×28 原位、真指针点得中、点了面板就关。
  + SETTINGS_PANEL + ' [class*="_content"] > [class*="_header"]{justify-content:flex-end !important}'
  + '}'
  + '</style>'

/**
 * **诊断模式**：只在 `?diag=1` 时注入（开关在 `lib/server.js` 的镜像路由那一段）。
 *
 * ## 为什么非要让真机自己报数据
 *
 * 「进设置后导航栏只有图标、随便点一下文字才出来」这件事，2026-10-06 之前所有结论
 * **都是用一个假面板（拿官方真实类名拼的）在本地量出来的**，量不到真机上的运行时状态：
 * 运行时挂上去的行内样式、`color` / `-webkit-text-fill-color` / `opacity` / `visibility`、
 * 字体有没有到、有没有透明层盖在字上面。本地又复现不了（无头浏览器里那个「设置」按钮
 * 在折叠侧栏内、尺寸 0×0，点不开；程序化点开之后页面又因加载十几个设置小节卡死）。
 * **那就让真机自己把数据报回来。**
 *
 * ## 一次打开就定死根因：采几批样本对比
 *
 *   · `baseline`       面板出现 4 秒后、**用户还没碰屏幕**时的样子（避开入场动画）；
 *   · `pointerdown`     手指按下那一刻，**capture 阶段同步取**——早于页面任何处理；
 *   · `after-click-*`   按下之后 0.3 / 1.2 / 3 秒的样子，看到底是哪个属性变好了。
 *
 * 每批都带上**同一个格子里那个 `svg` 图标**做对照：图标看得见、字看不见，
 * **两者的差异本身就是最强的线索**；再沿祖先链逐层量一遍，看宽度塌在哪一层。
 *
 * ## 上报口与日志
 *
 * POST 回我们自己的 `/mini/api/mirror-diag`（同源，靠入口那一下写下的 cookie 过关），
 * 服务端追加写到 `scratch/diag.log`。**用户不用看日志**，开发者来读。
 *
 * 屏幕上那条黑底小条（`pointer-events:none`，贴在屏幕底部）是给用户看的：
 * 告诉他「什么时候该点」以及「上报成没成功」——他只做两件事：打开、点一下。
 * **贴在底部**是必须的：压在导航条上的话，命中测试会先命中它自己，
 * 「有没有透明层盖着字」那一条就白测了；下面 `stack()` 里还把它自己过滤掉。
 *
 * ## 注入顺序
 *
 * 排在 `ADAPT_CSS` **之后**：量到的必须是「我们的适配已经生效」之后的样子，
 * 那才是用户实际看到的状态。
 */
const DIAG_SCRIPT = `<script>(function(){
  var LOG = '/mini/api/mirror-diag';
  var PANEL = '[data-shortcut-modal="settings"]';
  var CHIP = 'mini-mirror-diag-chip';
  var session = Math.random().toString(36).slice(2, 10);
  var sent = {};
  var chip = null;

  function say(text){
    try {
      if (!chip) {
        chip = document.createElement('div');
        chip.id = CHIP;
        chip.setAttribute('style', 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;'
          + 'background:rgba(17,24,39,.92);color:#fff;font:12px/1.6 sans-serif;padding:6px 10px;'
          + 'pointer-events:none;text-align:center');
        (document.body || document.documentElement).appendChild(chip);
      }
      // body 是后来才建出来的（这段脚本插在 head 最前面），建出来就把小条挪进去。
      if (document.body && chip.parentElement !== document.body) document.body.appendChild(chip);
      chip.textContent = text;
    } catch (e) {}
  }

  function round(n){ return Math.round(n * 10) / 10 }
  function rect(el){ var r = el.getBoundingClientRect();
    return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) } }
  function name(el){
    if (!el) return null;
    var c = el.className;
    if (c && c.baseVal !== undefined) c = c.baseVal;   // svg 的 className 是个对象
    return el.tagName + '.' + String(c || '').slice(0, 120);
  }
  /** 这个点上从上到下压着谁——用来发现「透明层盖在字上面」。 */
  function stack(el){
    if (!el) return null;
    var r = el.getBoundingClientRect();
    var x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    var list = [];
    try { list = document.elementsFromPoint(x, y) } catch (e) { return ['elementsFromPoint 不可用'] }
    return list.filter(function (e) { return e && e.id !== CHIP })
      .slice(0, 5).map(function (e) { return name(e) });
  }
  function styleOf(el){
    var s = getComputedStyle(el);
    return {
      color: s.color, webkitTextFillColor: s.webkitTextFillColor, opacity: s.opacity,
      visibility: s.visibility, display: s.display, width: s.width, height: s.height,
      overflow: s.overflow, overflowX: s.overflowX, whiteSpace: s.whiteSpace,
      textOverflow: s.textOverflow, flex: s.flex, minWidth: s.minWidth, position: s.position,
      clip: s.clip, webkitBackgroundClip: s.webkitBackgroundClip,
      backgroundClip: s.backgroundClip, mixBlendMode: s.mixBlendMode, filter: s.filter,
      transform: s.transform, fontFamily: s.fontFamily, fontSize: s.fontSize,
      fontWeight: s.fontWeight, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing,
      textIndent: s.textIndent, textRendering: s.textRendering, colorScheme: s.colorScheme,
      zIndex: s.zIndex,
    };
  }
  function box(el){
    return { what: name(el), rect: rect(el), inline: el.getAttribute('style'),
      offset: { w: el.offsetWidth, h: el.offsetHeight },
      scroll: { w: el.scrollWidth, h: el.scrollHeight },
      client: { w: el.clientWidth, h: el.clientHeight } };
  }
  /** 沿祖先链逐层量——看宽度到底塌在哪一层。 */
  function chain(el){
    var out = [], n = el, guard = 0;
    while (n && n.nodeType === 1 && guard < 10) {
      var s = getComputedStyle(n);
      out.push({ what: name(n), rect: rect(n), display: s.display, flex: s.flex,
        minWidth: s.minWidth, width: s.width, overflow: s.overflow, overflowX: s.overflowX,
        position: s.position, zIndex: s.zIndex, opacity: s.opacity, visibility: s.visibility });
      n = n.parentElement; guard += 1;
    }
    return out;
  }
  function fonts(){
    var faces = [];
    try {
      document.fonts.forEach(function (f) {
        if (faces.length < 20) faces.push(f.family + ' / ' + f.weight + ' / ' + f.status);
      });
    } catch (e) {}
    return { status: document.fonts.status, size: document.fonts.size, faces: faces };
  }

  function collect(phase){
    var out = { session: session, phase: phase, at: Date.now(),
      since: round(performance.now()), ua: navigator.userAgent,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
        narrow: matchMedia('(max-width:640px)').matches,
        vv: window.visualViewport
          ? { w: round(visualViewport.width), h: round(visualViewport.height), scale: round(visualViewport.scale) }
          : null },
      visibility: document.visibilityState };
    var panel = document.querySelector(PANEL);
    if (!panel) { out.panel = null; return out }
    out.panel = { rect: rect(panel) };
    var label = panel.querySelector('[class*="_navLabel"]');   // 只看**第一个**
    out.labelCount = panel.querySelectorAll('[class*="_navLabel"]').length;
    if (label) {
      out.label = box(label);
      out.label.text = label.textContent;
      out.label.textLen = String(label.textContent || '').length;
      // 字在不在 DOM 里，和「画没画出来」是两件事——先分开。
      out.label.textNodes = (function () {
        var n = 0;
        for (var i = 0; i < label.childNodes.length; i += 1) {
          if (label.childNodes[i].nodeType === 3) n += 1;
        }
        return n;
      })();
      out.label.clientRects = label.getClientRects().length;
      out.label.computed = styleOf(label);
      out.label.hitAtLabel = stack(label);
      out.label.html = String(label.outerHTML || '').slice(0, 500);
    }
    var cell = label ? label.closest('button,[class*="_navCell"]') : panel.querySelector('[class*="_navCell"]');
    if (cell) { out.cell = box(cell); out.cell.hitAtCell = stack(cell) }
    // 对照组：同一个格子里的图标。图标可见而文字不可见，差异就藏在这两坨里。
    var icon = cell ? cell.querySelector('svg') : null;
    if (icon) { out.icon = box(icon); out.icon.computed = styleOf(icon); out.icon.hitAtIcon = stack(icon) }
    var list = panel.querySelector('nav[class*="_nav"]');
    if (list) {
      var ls = getComputedStyle(list);
      out.nav = { what: name(list), rect: rect(list), display: ls.display,
        flexDirection: ls.flexDirection, overflowX: ls.overflowX, flexWrap: ls.flexWrap,
        scrollLeft: list.scrollLeft, scrollWidth: list.scrollWidth, clientWidth: list.clientWidth };
    }
    out.ancestors = chain(label || cell);
    out.fonts = fonts();
    return out;
  }

  function post(phase, data){
    if (sent[phase]) return;
    sent[phase] = 1;
    fetch(LOG, { method: 'POST', headers: { 'content-type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(data) })
      .then(function (r) {
        return r.text().then(function (t) {
          return { ok: r.ok, status: r.status, text: String(t || '').slice(0, 200) };
        });
      }, function (e) { return { ok: false, status: 0, text: String((e && e.message) || e) } })
      .then(function (res) {
        if (!res.ok) say('上报失败（' + phase + ' 那批）：' + res.status + ' ' + res.text);
        else if (phase === 'baseline') say('首帧样本已上报 ✅ 现在请在设置页上随便点一下屏幕');
        else if (phase === 'after-click-3000') say('点击后的样本也上报了 ✅ 可以关掉这一页了');
      })
      .catch(function (e) { say('上报失败：' + String((e && e.message) || e)) });
  }
  function taken(phase){ post(phase, collect(phase)) }

  function onPanel(){
    say('设置面板已出现，4 秒后取第一份样本（现在先别碰屏幕）…');
    setTimeout(function () { taken('baseline') }, 4000);
    var armed = false;
    function onDown(){
      if (armed) return;
      armed = true;
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('touchstart', onDown, true);
      taken('pointerdown');   // 按下那一刻同步取，早于页面任何处理
      setTimeout(function () { taken('after-click-300') }, 300);
      setTimeout(function () { taken('after-click-1200') }, 1200);
      setTimeout(function () { taken('after-click-3000') }, 3000);
    }
    // pointerdown 是新标准；touchstart 兜一层，免得某个 WebView 只发后者。
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('touchstart', onDown, true);
  }

  say('诊断模式已开启，正在等设置面板出现…');
  var wait = setInterval(function () {
    if (!document.querySelector(PANEL)) return;
    clearInterval(wait);
    onPanel();
  }, 300);
  // 两分钟等不到就收手（和「自动打开」那一段同一个上限），别一直空转。
  setTimeout(function () { clearInterval(wait) }, 120000);
})();</script>`

/** 把 `/remote` 前缀剥掉（见上面 REMOTE_CHANNEL_PREFIX 的说明）。 */
function stripRemotePrefix(rawUrl) {
  if (rawUrl === REMOTE_CHANNEL_PREFIX) return '/'
  if (rawUrl.startsWith(`${REMOTE_CHANNEL_PREFIX}/`)) return rawUrl.slice(REMOTE_CHANNEL_PREFIX.length)
  return rawUrl
}

/**
 * 把几样东西插进 HTML 的**最前面**：官方界面要的「你是主机」标记、
 * **我们自己**的适配（含「把别的插件的适配挡在门外」那一段），
 * 以及**只在诊断模式**（`?diag=1`）下额外加上去的那段采样脚本。
 *
 * 插在 `<head>` 之后：启动项是内联脚本、跑在 head 里，晚一步就读不到了。
 * 找不到 `<head>` 就退回插在开头——**宁可位置差一点，也不要什么都不插**：
 * 少了它，界面会把自己当成远程客户端，配置面整片不给。
 *
 * `diag` 缺省就是关的：**正常路径一个字节都不多**（这一条有测试钉着）。
 */
function injectHostHook(html, diag) {
  const inject = HOST_HOOK + STRIP_FOREIGN_ADAPT + AUTO_OPEN_SETTINGS + ADAPT_CSS
    + (diag ? DIAG_SCRIPT : '')
  const at = html.search(/<head[^>]*>/i)
  if (at >= 0) {
    const end = html.indexOf('>', at) + 1
    return html.slice(0, end) + inject + html.slice(end)
  }
  return inject + html
}

/**
 * 建一个镜像代理。
 *
 * @param {object} opts
 * @param {string | () => (string | null)} opts.upstream 上游地址（电脑端界面），
 *        如 `http://127.0.0.1:19387`。**可以传函数，而且推荐传函数**——宿主的 webServer
 *        服务就绪得晚，地址要到那一刻才知道（见 lib/index.js 里 mirrorUpstream 那段）。
 * @param {() => string | null} opts.tokenUrl 取「带官方令牌的地址」；拿不到返回 null。
 *        由插件注入（见 lib/index.js 里对 connection.authenticatedUrl 的调用）——
 *        这个模块**不认识宿主**，只认识一个返回字符串的函数，好测。
 * @param {(msg:string) => void} [opts.log]
 * @returns {{ handle, reset, available, stats }}
 */
export function createMirror({ upstream, tokenUrl, log }) {
  /** 上游地址**解析一次就记住**：它的 Host 要用来签 cookie，不能每次变。 */
  let target = null
  let targetHost = null

  function resolve() {
    if (target) return target
    const raw = typeof upstream === 'function' ? upstream() : upstream
    if (!raw) return null
    try {
      target = new URL(raw)
    } catch {
      return null
    }
    // 固定成上游自己的 host:port——官方 cookie 的「权威域名」按 Host 签，必须每次都一样。
    targetHost = target.host
    return target
  }

  /**
   * 等上游地址就绪——**宿主刚起来那一小段里它是问不到的**。
   *
   * 2026-10-06 真机（用户报「又一直在转进不去」）：重启完立刻打开镜像，我们问不到界面
   * 地址就回了 502；而那个界面外壳**拿到 502 不会重试**，于是永远卡在
   * 「Loading plugins…」——**等宿主起来了也不会自己好**，必须手动重开一次。
   * 这就是那句「重开一下就好了」的来历。所以这里等一下再试。
   *
   * 只在「还没解析出来」时等；一旦解析成功，`resolve()` 立刻返回，不引入任何延迟。
   */
  async function resolveReady(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const up = resolve()
      if (up) return up
      if (Date.now() >= deadline) return null
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  /** 官方会话 cookie。**只存在服务端**，绝不转发给手机。 */
  let cookie = null
  /** 正在铸的那一次；并发请求共用，不重复铸。 */
  let minting = null
  let mints = 0
  let lastError = null

  function note(msg) {
    lastError = msg
    if (log) log(msg)
  }

  /**
   * 走一次官方认证，把 cookie 拿到手。
   *
   * 拿到的是 303 + `set-cookie: dsh-auth-<hash>=v1.<payload>.<sig>`，
   * 我们只要那个 cookie，不要它跳转的目的地（跳转是给浏览器看的）。
   */
  function mint() {
    if (minting) return minting
    minting = new Promise((resolvePromise, reject) => {
      // **这里也要等**（和 forward 同一个道理）：宿主刚起来时地址还问不到，
      // 而铸 cookie 是每次转发的前置步骤——这里立刻失败，前面那些等待就白等了。
      resolveReady().then((up) => {
      if (!up) {
        reject(new Error('这台电脑上找不到可用的电脑端界面地址。'))
        return
      }
      const url = tokenUrl ? tokenUrl() : null
      if (!url) {
        reject(new Error('这台电脑上的 DSH 没提供「带令牌的界面地址」的能力。'))
        return
      }
      let parsed
      try {
        parsed = new URL(url)
      } catch (err) {
        reject(new Error(`拿到的地址不是合法地址：${String(url).slice(0, 120)}`))
        return
      }
      const req = httpRequest({
        protocol: up.protocol,
        hostname: up.hostname,
        port: up.port,
        // 用带令牌的那条路径+查询去问（一般是 `/?token=xxx`）。
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        // ① 固定 Host：cookie 的权威域名靠它，铸和用必须是同一份。
        headers: { host: targetHost, accept: 'text/html' },
      }, (res) => {
        const setCookie = res.headers['set-cookie']
        const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : [])
        // 只要官方那枚会话 cookie；`dsh-auth-` 是官方 BrowserAuth 里的 COOKIE_PREFIX。
        const hit = list.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('dsh-auth-'))
        // 无论成没成都要把响应体读完，否则连接不释放。
        res.resume()
        res.on('end', () => {
          if (hit) resolvePromise(hit)
          else reject(new Error(`官方认证没有给出会话 cookie（状态 ${res.statusCode}）。`))
        })
      })
      req.on('error', (err) => reject(new Error(`连不上电脑端界面（${up.host}）：${err.message}`)))
      // 这一步是本机回环，不该拖太久。
      req.setTimeout(8000, () => req.destroy(new Error('官方认证超时')))
      req.end()
      }).catch(reject)
    }).then((value) => {
      cookie = value
      mints += 1
      lastError = null
      return value
    }).catch((err) => {
      note(err.message)
      throw err
    }).finally(() => {
      minting = null
    })
    return minting
  }

  async function ensureCookie() {
    if (cookie) return cookie
    return mint()
  }

  /** 把手机这一侧的请求头整理成给上游的。 */
  function upstreamHeaders(req) {
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase()
      if (HOP_BY_HOP.has(key)) continue
      // ② 我们自己那枚令牌的 cookie 不给上游；上游不认识它。
      if (key === 'cookie') continue
      if (key === 'host') continue
      headers[key] = v
    }
    headers.host = targetHost
    // **`Origin` 也固定成上游自己。**
    //
    // 上游只认自己的来源，看到 `http://<手机那头>:3090` 就回 403。而**浏览器发 POST
    // 和 WebSocket 握手时一定会带 `Origin`**（普通 GET 不带）——所以症状很有欺骗性：
    // 页面、脚本、样式全都正常加载，**只有那些 POST 出来的数据全空**，界面上就是
    // 「权限那栏写着 403」「插件那一列只剩图标」。2026-10-06 两次真机都栽在这一个头上，
    // 第二次是 WebSocket 那条（当时只修了它），这一次是普通 POST。
    headers.origin = `http://${targetHost}`
    if (cookie) headers.cookie = cookie
    // **压缩照旧转发（不再摘掉 `accept-encoding`）。**
    //
    // 第一版把它摘了，理由是「HTML 保持明文好注入」——**但那只对 HTML 成立，
    // 我把所有东西都关掉了**：整个界面裸着搬，一次 34 MB（2026-10-06 量出来的，
    // 121 个请求）。本机把那些东西压一遍是原体积的 24%～29%。
    // 现在照旧转发；HTML 那一份在 writeOut 里单独解开再注入。
    return headers
  }

  /** 一次转发。返回上游响应，交给调用方决定是一遍过还是重试。 */
  function forward(req, res, headers) {
    return new Promise((resolvePromise, reject) => {
      // 等上游就绪（宿主刚起来那一段问不到地址，见 resolveReady 的说明）。
      resolveReady().then((up) => {
        if (!up) {
          reject(new Error('这台电脑上找不到可用的电脑端界面地址。'))
          return
        }
      const call = httpRequest({
        protocol: up.protocol,
        hostname: up.hostname,
        port: up.port,
        // 剥掉那条门控通道的前缀（见 REMOTE_CHANNEL_PREFIX）。
        path: stripRemotePrefix(req.url),
        method: req.method,
        headers,
      }, (upRes) => resolvePromise(upRes))
      call.on('error', reject)
      // 上游是本机回环，但如果是一条 SSE 长连接，**不能设总超时**，只能设建连超时。
      call.setTimeout(15000, () => call.destroy(new Error('转发超时')))
      // 请求体直接管道过去（上传之类）；GET 没有体，pipe 也无害。
      req.pipe(call)
      }).catch(reject)
    })
  }

  function writeOut(upRes, res, reqUrl, diag) {
    const headers = {}
    for (const [k, v] of Object.entries(upRes.headers)) {
      const key = k.toLowerCase()
      if (HOP_BY_HOP.has(key)) continue
      if (FRAME_BLOCKERS.has(key)) continue
      // 官方那枚会话 cookie **不转发给手机**：它只属于服务端这一侧。
      if (key === 'set-cookie') continue
      headers[key] = v
    }

    // **给带内容指纹的静态资源补上长期缓存**（见 CACHEABLE 的说明）。
    // 只补「上游本来没给」的：它给了 `no-cache` 之类就尊重它，别去覆盖别人的判断。
    const path = String(reqUrl ?? '').split('?')[0]
    if (upRes.statusCode === 200 && CACHEABLE.test(path) && !headers['cache-control']) {
      headers['cache-control'] = LONG_CACHE
    }

    // HTML 要**改一处再发**：注入「你是主机」那个标记（见 HOST_HOOK）和那段适配样式。
    // 这一步要缓冲，所以只对 HTML 做——**其余一律照旧直接管道**，
    // 那条常驻连接（SSE）绝不能因为这里多等一下而卡住。
    const type = String(upRes.headers['content-type'] ?? '')
    if (type.includes('text/html')) {
      const chunks = []
      upRes.on('data', (chunk) => chunks.push(chunk))
      upRes.on('end', () => {
        let buf = Buffer.concat(chunks)
        // 上游可能按压缩发的（上面不再摘 `accept-encoding` 了）。**先解开再注入**，
        // 然后明文发出去：就这一份文档，几十 KB，不值得再压回去。
        const enc = String(upRes.headers['content-encoding'] ?? '').toLowerCase()
        try {
          if (enc.includes('br')) buf = brotliDecompressSync(buf)
          else if (enc.includes('gzip')) buf = gunzipSync(buf)
          else if (enc.includes('deflate')) buf = inflateSync(buf)
        } catch (err) {
          // 解不开就别动它——**宁可注入不了，也不能把一份好文档弄坏**。
          note(`HTML 解压失败，原样转发：${err.message}`)
          res.writeHead(upRes.statusCode ?? 502, headers)
          res.end(buf)
          return
        }
        const patched = injectHostHook(buf.toString('utf8'), diag)
        delete headers['content-length']      // 长度变了，让 Node 自己算
        delete headers['content-encoding']    // 发的是明文
        res.writeHead(upRes.statusCode ?? 502, headers)
        res.end(patched)
      })
      upRes.on('error', () => { try { res.end() } catch { /* 已经断了 */ } })
      return
    }

    res.writeHead(upRes.statusCode ?? 502, headers)
    // ③ 不缓冲：直接管道，SSE 才流得动。
    upRes.pipe(res)
  }

  /**
   * 转发一条 WebSocket（`Upgrade: websocket`）。
   *
   * **为什么非做不可**（2026-10-06 真机报「一直正在重新连接」之后查出来的）：
   * 手机和宿主之间那条**常驻连接**就是 WebSocket——官方客户端里写着
   * `url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'`，路径 `/api/remote.mux`。
   * 它建不起来，界面就一直在重连，而且**看起来像一堆不相干的显示毛病**：
   * 插件那一列只剩图标没有文字、权限那栏写「permission catalog has no active Host connection」
   * ——其实全是同一条连接没通。
   *
   * 和普通转发只有两处不同：
   *   ① `Upgrade` / `Connection` 这两个头**必须原样留着**——它们是握手本身，
   *      上面那个 upstreamHeaders() 会按「逐跳头」把它们摘掉，这里补回来；
   *   ② 握手之后这条 TCP 连接要**双向裸转**，不能再按 HTTP 解析。
   */
  async function upgrade(req, socket, head) {
    try {
      await ensureCookie()
    } catch (err) {
      note(err.message)
      socket.destroy()
      return
    }
    const up = await resolveReady()
    // 上游永远是本机回环的 http；真出现别的协议就如实拒绝，不硬猜。
    if (!up || up.protocol !== 'http:') {
      note(`不支持把 WebSocket 转给 ${up ? up.protocol : '（没有上游）'}`)
      socket.destroy()
      return
    }

    const headers = upstreamHeaders(req)
    if (req.headers.upgrade) headers.upgrade = req.headers.upgrade
    headers.connection = 'Upgrade'
    // `Origin` 已经在 upstreamHeaders() 里统一换过了（普通 POST 和握手是同一个坑）。

    const call = netConnect({ host: up.hostname, port: up.port })
    call.on('error', () => socket.destroy())
    socket.on('error', () => call.destroy())
    // 两头任意一端断开，另一端也要跟着断——**否则会漏套接字**：
    // 手机那边关掉页面时，这条到上游的连接会一直挂着（测试里表现为
    // `server.close()` 永远等不到，真机上表现为连接越攒越多）。
    socket.on('close', () => call.destroy())
    call.on('close', () => socket.destroy())

    call.on('connect', () => {
      const lines = [`${req.method} ${stripRemotePrefix(req.url)} HTTP/1.1`]
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`)
      call.write(`${lines.join('\r\n')}\r\n\r\n`)
      // 握手请求后面可能已经跟了一段数据（head），不能丢。
      if (head && head.length) call.write(head)
      socket.pipe(call)
      call.pipe(socket)
    })
  }

  /**
   * 转发一条请求。
   *
   * `opts.diag` = 「这一页是诊断模式打开的」，由 `lib/server.js` 从 `?diag=1` 里读出来传进来
   * （查询串在入口那一下就被整个丢掉了，所以只能这么传，不能到这儿再自己解析）。
   * **缺省是关的**：正常路径注入的东西一个字节都不变。
   */
  async function handle(req, res, opts) {
    const diag = Boolean(opts && opts.diag)
    try {
      await ensureCookie()
    } catch (err) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`拿不到电脑端界面的访问凭据：${err.message}\n`)
      return
    }

    let upRes
    try {
      upRes = await forward(req, res, upstreamHeaders(req))
    } catch (err) {
      note(err.message)
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`转发到电脑端界面失败：${err.message}\n`)
      return
    }

    // 401 = 那枚 cookie 不认了（进程重启过、或者过期）。重铸一次再试一遍。
    // 只重试一次：再来一次还是 401，说明不是「cookie 陈旧」这么简单，
    // 该把真实原因露出来，而不是在这里转圈。
    if (upRes.statusCode === 401) {
      upRes.resume()
      cookie = null
      try {
        await ensureCookie()
        upRes = await forward(req, res, upstreamHeaders(req))
      } catch (err) {
        note(err.message)
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(`重新取凭据后仍然失败：${err.message}\n`)
        return
      }
    }

    writeOut(upRes, res, req.url, diag)
  }

  return {
    handle,
    upgrade,
    /**
     * 「现在能不能用」——上游地址解析得出来才算能用。
     *
     * 界面那一侧靠它决定要不要露出这一项：宿主的 webServer 就绪得晚，
     * 插件加载的那一刻往往还问不到地址，所以**不能只看「建没建出这个镜像」**。
     */
    available: () => Boolean(resolve()),
    /** 上游会话可能会失效（例如 DSH 重启），提供一个显式作废的入口给测试和上层用。 */
    reset: () => { cookie = null },
    stats: () => ({ mints, lastError }),
  }
}
