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
 * ## 挡哪三样
 *
 * · 它插的那段 `<style data-plugin-css="…">`——**里面还有没带 body 前缀的规则**，
 *   光摘标记挡不住它，必须连样式一起摘；
 * · `dsh-remote-portrait`——它的「适配生效」标记，整套 `body.… ` 规则靠它；
 * · `dsh-remote-compact-picker` / `dsh-remote-header-seated`——它另外两处改官方界面的标记。
 *
 * ## 代价（已经跟用户说清并获同意）
 *
 * 它自己那个「远程访问」设置页，在这一页里也会退回桌面样子。**这个代价该付**：
 * 镜像本来就是「电脑端界面」，本来就该是桌面样子；在别人的界面里塞手机样式，
 * 才是我们一直在收拾的那个烂摊子。
 *
 * ## 为什么盯着
 *
 * 它会在竖屏/尺寸变化时**重新贴一遍**，所以不能只做一次。
 * 观察范围**故意收得很窄**（只看 head 的子节点、只看 body 的 class）：
 * 盯着整棵树会在这种重页面上白白烧掉性能。
 */
const STRIP_FOREIGN_ADAPT = '<script>(function(){'
  + 'var BODY_CLASSES=["dsh-remote-portrait","dsh-remote-compact-picker","dsh-remote-header-seated"];'
  + 'function strip(){'
  + 'try{'
  + 'var b=document.body;'
  + 'if(b&&b.classList){for(var i=0;i<BODY_CLASSES.length;i+=1)b.classList.remove(BODY_CLASSES[i]);}'
  + 'if(!document.head)return;'
  + 'var st=document.head.querySelectorAll("style[data-plugin-css]");'
  + 'for(var j=0;j<st.length;j+=1){'
  + 'var v=String(st[j].getAttribute("data-plugin-css")||"");'
  + 'if(v.indexOf("remote-web-ui")>=0)st[j].remove();'
  + '}'
  + '}catch(e){}'
  + '}'
  + 'strip();'
  + 'try{'
  + 'var mo=new MutationObserver(strip);'
  + 'if(document.head)mo.observe(document.head,{childList:true});'
  + 'if(document.body)mo.observe(document.body,{attributes:true,attributeFilter:["class"]});'
  + '}catch(e){}'
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
 * ② **底部让开手势条/圆角。** 顶部那条由我们自己的横条管（见 page.html 的 `.mv-bar`），
 *    这里管底下。
 *
 * **删掉的一条**：上一版这里还有「把官方设置面板的导航掰回竖排、字始终显示」——
 * 那是在**别的插件的地基上打补丁**（它改哪两处我就掰哪两处）。现在改成从根上挡掉
 * （见 STRIP_FOREIGN_ADAPT），**那两条补丁不需要了**：界面回到干净的官方样子，
 * 本来就没有那些毛病。
 *
 * **不改的**：官方界面自己已经把侧栏做成抽屉了（`position:absolute` + 网格父元素）。
 * 我原以为要改它，注入试过才发现是白改——**动之前先试，别凭想象改**。
 *
 * 类名按**后缀**命中：它的类名是「哈希_名字」，哈希每次构建都变，只有后半段稳。
 */
const ADAPT_CSS = '<style id="mini-mirror-adapt">'
  + '@media (max-width: 640px){[class*="_overlay"]{z-index:1200 !important}}'
  + '#mirrorFrame{padding-bottom:env(safe-area-inset-bottom,0px);box-sizing:border-box}'
  + '</style>'

/** 把 `/remote` 前缀剥掉（见上面 REMOTE_CHANNEL_PREFIX 的说明）。 */
function stripRemotePrefix(rawUrl) {
  if (rawUrl === REMOTE_CHANNEL_PREFIX) return '/'
  if (rawUrl.startsWith(`${REMOTE_CHANNEL_PREFIX}/`)) return rawUrl.slice(REMOTE_CHANNEL_PREFIX.length)
  return rawUrl
}

/**
 * 把两样东西插进 HTML 的**最前面**：官方界面要的「你是主机」标记，
 * 以及**我们自己**的适配（含「把别的插件的适配挡在门外」那一段）。
 *
 * 插在 `<head>` 之后：启动项是内联脚本、跑在 head 里，晚一步就读不到了。
 * 找不到 `<head>` 就退回插在开头——**宁可位置差一点，也不要什么都不插**：
 * 少了它，界面会把自己当成远程客户端，配置面整片不给。
 */
function injectHostHook(html) {
  const inject = HOST_HOOK + STRIP_FOREIGN_ADAPT + ADAPT_CSS
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

  function writeOut(upRes, res, reqUrl) {
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
        const patched = injectHostHook(buf.toString('utf8'))
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

  async function handle(req, res) {
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

    writeOut(upRes, res, req.url)
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
