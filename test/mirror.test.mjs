/**
 * 「进阶设置（电脑端界面）」：镜像代理 + 那条路由的门。
 *
 * 这一组测的不是「能不能转发」——那是表面。真正要钉住的是**三件容易悄悄坏掉的事**：
 *
 *   ① **关着的时候那条路由根本不存在**。这是权限开关，如果只是前端藏起来、
 *      后端还开着，那就等于没关。所以关着时必须和「没这个功能」一模一样（404）。
 *   ② **不认得令牌的人进不来**。开了之后这条路由等于把整个电脑端设置面交出去。
 *   ③ **官方那枚会话 cookie 绝不发给手机**。它只属于服务端这一侧；发出去就等于
 *      把官方凭据漏给了持有我们令牌的人。
 *
 * 另外还有几条「转发本身」的正确性：Host 必须固定（官方 cookie 按 Host 签）、
 * 不许带「禁止被嵌」的响应头、上游 401 时重铸一次。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { gzipSync } from 'node:zlib'

import { createMirror } from '../lib/mirror.js'
import { createMiniServer } from '../lib/server.js'

/** 起一个服务器并等它真的在听，返回 { server, port, close }。 */
async function listen(handler) {
  const server = createServer(handler)
  // 升级过的连接**不算普通连接**，`server.close()` 会一直等它——不记下来就会挂住测试。
  const upgraded = new Set()
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    server,
    port: server.address().port,
    close: () => new Promise((r) => {
      for (const s of upgraded) s.destroy()
      server.closeAllConnections?.()
      server.close(r)
    }),
  }
}

/**
 * 一个「像电脑端界面」的假上游。
 *
 * 它复刻官方那两个要点：`/` 带对的 token 才回 303 + `dsh-auth-*` cookie；
 * 其余请求**要看 cookie**，没有就 401。这样镜像那边的行为才有得测。
 */
async function fakeApp() {
  const seen = []
  /**
   * 「接下来这几次请求就算 cookie 是对的也回 401」。
   *
   * 用它来模拟真机上最常见的那种失效：**DSH 进程重启过，旧 cookie 作废了**。
   * （另一种失效是「压根铸不出来」，那条走 `tokenUrl` 返回垃圾——两条要分开测，
   * 因为代码里的处理不一样。）
   */
  let rejectNext = 0
  const app = await listen((req, res) => {
    seen.push({
      url: req.url,
      host: req.headers.host,
      origin: req.headers.origin ?? null,
      acceptEncoding: req.headers['accept-encoding'] ?? null,
      cookie: req.headers.cookie ?? null,
      method: req.method,
    })
    const url = new URL(req.url, 'http://x')
    // 认证入口：带对的 token 才铸 cookie（官方 BrowserAuth.authorizeIndex 的形状）。
    if (url.pathname === '/' && url.searchParams.get('token') === 'LAUNCH-TOKEN') {
      // 认证这一步不该被 rejectNext 影响：它测的是「旧 cookie 过期后重铸」，
      // 不是「连认证入口都进不去」。
      res.writeHead(303, {
        location: './',
        'set-cookie': 'dsh-auth-abc123=v1.payload.sig; Path=/; HttpOnly',
      })
      res.end()
      return
    }
    // 其余一律要 cookie（除了我们专门用来造 401 的那条）。
    const stale = rejectNext > 0
    if (stale) rejectNext -= 1
    if (stale || !/dsh-auth-/.test(String(req.headers.cookie ?? ''))) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh web authentication required')
      return
    }
    if (url.pathname === '/blocked') {
      res.writeHead(200, {
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
        'content-type': 'text/html',
      })
      // 像个真页面：有 head，head 里还有一段内联启动脚本。
      // （第一版夹具只有一句 `<html>hi</html>`，于是「插在 head 里」那条断言测了个空。）
      res.end('<html><head><script>boot()</script></head><body>hi</body></html>')
      return
    }
    if (url.pathname === '/no-head') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<p>没有 head 的一段</p>')
      return
    }
    if (url.pathname === '/gz') {
      // 上游**压缩着发** HTML——我们把 `accept-encoding` 照旧转发了，它就会这么干。
      const buf = gzipSync(Buffer.from('<html><head><script>boot()</script></head><body>hi</body></html>'))
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-encoding': 'gzip',
        'content-length': buf.length,
      })
      res.end(buf)
      return
    }
    if (url.pathname === '/boom') {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('upstream boom')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'yes' })
    res.end('上游内容 ' + url.pathname)
  })
  // 同一个假上游也接 WebSocket 握手（真上游是同一个进程，当然两样都接）。
  // 回一句最小可用的 101，然后把收到的字节原样弹回去——够验「握手转没转、字节通不通」了。
  app.server.on('upgrade', (req, socket, head) => {
    seen.push({
      url: req.url,
      host: req.headers.host,
      origin: req.headers.origin ?? null,
      cookie: req.headers.cookie ?? null,
      upgrade: req.headers.upgrade ?? null,
      method: req.method,
    })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    if (head && head.length) socket.write(head)
    socket.on('data', (chunk) => socket.write(chunk))
  })
  return {
    ...app,
    seen,
    /** 让接下来 n 次请求即使 cookie 对也回 401。 */
    rejectNext(n) { rejectNext = n },
  }
}

/** 在镜像前面再套一个真服务器，这样可以用 fetch 打它（更接近真机）。 */
async function front(mirror) {
  const s = await listen((req, res) => { mirror.handle(req, res) })
  // 也要收 upgrade——真机上的路由口径见 lib/server.js（我们自己的地盘不转）。
  s.server.on('upgrade', (req, socket, head) => {
    const p = String(req.url ?? '/').split('?')[0]
    if (p === '/mini' || p === '/mini/' || p.startsWith('/mini/')) { socket.destroy(); return }
    mirror.upgrade(req, socket, head)
  })
  return s
}

test('镜像：转发到上游，并把 Host 固定成上游自己（官方 cookie 按 Host 签）', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  // 用纯 ASCII 路径：`req.url` 是**百分号编码**的，拿中文当路径会让断言莫名对不上。
  const res = await fetch(`http://127.0.0.1:${f.port}/some/path`)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '上游内容 /some/path')

  // ① 第一次请求会先走认证那一步（去问上游首页），之后才是真正那次转发。
  const real = app.seen.filter((s) => s.url.startsWith('/some/path'))
  assert.equal(real.length, 1, '真正那次只转发一遍')
  assert.equal(real[0].host, `127.0.0.1:${app.port}`,
    'Host 必须是上游自己的地址——官方 cookie 的权威域名就是按它签的，换一个每个请求都 401')
  assert.match(String(real[0].cookie), /dsh-auth-/, '转发时要替手机带上官方 cookie')
})

test('镜像：`Origin` 要换成上游自己（POST 和 WebSocket 都会带它，带错就 403）', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  // 浏览器发 POST 一定带 Origin（普通 GET 不带）——「页面全好、数据全空」就是这么来的。
  await fetch(`http://127.0.0.1:${f.port}/api/thing`, {
    method: 'POST',
    headers: { origin: 'http://192.168.1.2:3090', 'content-type': 'application/json' },
    body: '{}',
  })
  const hit = app.seen.filter((s) => s.method === 'POST').pop()
  assert.ok(hit, '上游应当收到这次 POST')
  assert.equal(hit.origin, `http://127.0.0.1:${app.port}`,
    'Origin 要换成上游自己。实测过：不带 Origin → 200；带手机那个 → 403；带上游自己的 → 200。'
    + '症状很有欺骗性——页面、脚本、样式全都正常加载，**只有那些 POST 出来的数据全空**')
})

test('镜像：官方那枚会话 cookie 绝不转发给手机', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  // 打认证入口那一趟：上游会回 set-cookie，镜像**不能**把它带给手机。
  const res = await fetch(`http://127.0.0.1:${f.port}/`)
  const setCookie = res.headers.get('set-cookie')
  assert.equal(setCookie, null,
    '官方会话 cookie 只属于服务端这一侧；发给手机等于把官方凭据漏出去了')
})

test('镜像：去掉「禁止被嵌」的响应头', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const res = await fetch(`http://127.0.0.1:${f.port}/blocked`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-frame-options'), null, 'x-frame-options 要去掉')
  assert.equal(res.headers.get('content-security-policy'), null, 'CSP 的 frame-ancestors 要去掉')
  const body = await res.text()
  assert.ok(body.includes('hi</body>'), '上游的正文要原样留着')
  assert.match(body, /ownsHost/, 'HTML 里要注入「你是主机」那个标记（见下面那条测试）')
})

/**
 * 这两条是「消化原理之后只实现我们要的那部分」的结果（2026-10-06）。
 *
 * 装在这台机器上的 `dsh-remote-web-ui` 会把手机上发的请求改写成 `/remote/<原路径>`
 * 并带上设备令牌——没有令牌就 401，于是它显示「此设备未配对」那道闸门。
 *
 * 我们不需要设备令牌：**我们的代理本来就从回环发出、Host 也固定成上游自己**，
 * 宿主已经把我们当本机了。所以只要把前缀剥掉，那条通道就会「成功」。
 * 再加上告诉界面「你是主机」的那个标记，配置面就整片打开。
 */
test('镜像：把那条门控通道的前缀剥掉（我们的代理本来就是那条通道）', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const res = await fetch(`http://127.0.0.1:${f.port}/remote/api/session/list?x=1`)
  assert.equal(res.status, 200)
  const hit = app.seen.filter((s) => s.url.startsWith('/api/session/list'))
  assert.equal(hit.length, 1, '应当以剥掉前缀后的路径去问上游')
  assert.equal(hit[0].url, '/api/session/list?x=1',
    '`/remote/api/...` → `/api/...`；查询串要留着')
  // 不带前缀的照旧原样转发
  const plain = await fetch(`http://127.0.0.1:${f.port}/api/other`)
  assert.equal(plain.status, 200)
  assert.equal(await plain.text(), '上游内容 /api/other')
})

test('镜像：那个「你是主机」的标记要插在最前面（启动项是内联脚本，晚一步就读不到）', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const body = await (await fetch(`http://127.0.0.1:${f.port}/blocked`)).text()
  const hookAt = body.indexOf('ownsHost')
  const headAt = body.indexOf('<head')
  assert.ok(hookAt > 0, '要注入那个标记')
  assert.ok(hookAt < body.indexOf('</head>'),
    '要插在 head 里——官方界面的启动项就是内联脚本，跑在 head 里')
  assert.ok(headAt < hookAt, '插在 <head> 之后、其余内容之前')
  assert.ok(hookAt < body.indexOf('<script>boot()'),
    '要排在那段启动脚本前面，晚一步它就读不到了')

  // 没有 head 的碎片：退回插在最前面——宁可位置差一点，也不要什么都不插
  const noHead = await (await fetch(`http://127.0.0.1:${f.port}/no-head`)).text()
  assert.match(noHead, /^<script>globalThis\.__DSH_TRANSPORT__/, '没有 head 就插在最前面')
})

/**
 * 手机上那两条布局适配（2026-10-06，用户选定「只做布局」）。
 *
 * 都是**实测出来的**：
 * · 侧栏 `z-index:1100`，设置面板那层浮层 `1000`——**侧栏高一百**，窄屏下整屏盖住面板，
 *   点「设置」什么都看不见。
 * · **第一版把侧栏压到 20，那是反的，真机立刻出问题**：面板的**遮罩**（同一层）反过来
 *   盖住侧栏，用户看到侧栏发暗、**点击落在遮罩上**——遮罩一收侧栏就消失，设置页也进不去。
 *   **所以要把面板抬上去（1200），不能把侧栏压下去。**
 */
test('镜像：手机布局适配（把设置面板抬到侧栏上面，而且只抬那一层）', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const body = await (await fetch(`http://127.0.0.1:${f.port}/blocked`)).text()
  // 抬起来的**只许是设置面板那一层**（2026-10-07 收窄）：官方结构是
  // `wCInkW_overlay > wCInkW_mask + wCInkW_panel[data-shortcut-modal=settings]`，
  // 用 `:has(> …)` 钉住它。**新旧两条不许都在**——都留着等于没收窄。
  assert.match(body, /\[class\*="_overlay"\]:has\(> \[data-shortcut-modal="settings"\]\)\{z-index:1200/,
    '要把设置面板那层浮层抬到侧栏（1100）上面，而且只抬这一层')
  assert.ok(!/\[class\*="_overlay"\]\{z-index:1200/.test(body),
    '一把抓的旧写法必须删掉：它连官方的浮层容器（原生 z-index:20）和账号那一层'
    + '（z-index:1001）一起抬到 1200，实测过')
  assert.ok(!/_sidebarCol"\]\{z-index/.test(body),
    '**不许把侧栏压下去**——第一版就是这么写的：遮罩反过来盖住侧栏、点击落在遮罩上，'
    + '真机上「一点侧栏就消失、还进不去设置」')
  // 底部安全区那一条**不在这一页里**（2026-10-07 搬去外层页）：`#mirrorFrame` 是外层页的
  // 元素，注进被镜像文档的规则一个像素都管不着它——所以这里连提都不该提。
  assert.ok(!/mirrorFrame/.test(body),
    '`#mirrorFrame` 的样式要写在外层页 lib/page.html 里，不许再注进被镜像的这份文档')
  // 面板高度也不许按 `dvh` 收（2026-10-07 量过之后没写）：镜像页跑在 iframe 里，
  // **嵌套视口的 dvh 等于框自己的高**（无头 Edge 实测：400px 的框里 vh=dvh=svh=lvh=400，
  // 1200px 的框里四个都是 1200），到这儿它退化成 `100vh - 32px`，
  // 而官方面板本来就比它矮 16px（`min(800px, calc(100vh - 48px))`）——永远轮不到生效。
  assert.ok(!/dvh/.test(body),
    '镜像页里不许用 dvh 收高度：iframe 里的 dvh 看不见地址栏，这条会是一条死规则')
  assert.ok(body.indexOf('mini-mirror-adapt') < body.indexOf('</head>'), '这段样式要在 head 里')
})

/**
 * **把别的插件的「移动端适配」挡在门外**（2026-10-06 用户定的方向）。
 *
 * 用户原话：「让我们的插件参考那个插件的方式来做『被搬过来的那个 DSH 界面』，
 * **而不是直接搬那个插件适配的界面**。等于电脑端设置界面实际上也应该是我们自己的插件的产物。」
 *
 * 机器上装着两家会在运行时改这一页的适配：
 *
 * · `@linxin666/dsh-remote-web-ui` —— 插适配样式、往 `<body>` 贴标记，选择器按类名后缀匹配，
 *   而官方界面的类名正好也是那几个，于是官方面板被它一起改了；
 * · `@dsh-external/dsh-mobile-nav` —— **`dsh-pocket` 插件客户端给自己起的名字**。
 *   2026-10-06 用户报「设置页上方永远是一块三列图标格子、占掉大半屏」，
 *   逐条比对后确认就是它这一条：
 *     `[aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"]))
 *      > :first-child > :last-child { display: grid !important; grid-template-columns: repeat(3, 1fr) !important }`
 *   它的特异性（0,6,1）比我们按 `[data-shortcut-modal="settings"]` 写的规则（0,2,0）高，
 *   两边都带 `!important` 时**特异性高的赢**——所以上一版我们那条 `flex-direction:row !important`
 *   是白写的（元素还是 `display:grid`，改方向没用）。**补丁打不过它，只能把它的样式摘掉。**
 *
 * **上一版是在它们的地基上打补丁**（它们改哪两处我就掰哪两处）——被动挨打。
 * 现在改成从根上挡掉：按名单摘掉它们插的样式、摘掉那几个标记，并持续盯着（它们会重插）。
 */
test('镜像：把别的插件的移动端适配挡在门外（这一页的适配由我们自己来）', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const body = await (await fetch(`http://127.0.0.1:${f.port}/blocked`)).text()

  assert.match(body, /dsh-remote-portrait/, '要摘掉它那个「适配生效」标记')
  assert.match(body, /dsh-remote-compact-picker/, '它另外两处改官方界面的标记也要摘')
  assert.match(body, /dsh-remote-header-seated/, '同上')
  assert.match(body, /data-plugin-css/, '还要摘掉它插的那段样式——里面有没带标记的规则，光摘标记挡不住')
  assert.match(body, /MutationObserver/, '它会在尺寸变化时重插，所以要盯着')
  // （观察范围那条断言搬到下面「第三层：摘标记」去了：现在除了 body 的 class，
  //   还要盯面板上那个标记，范围仍然钉死在属性名上。）

  // **通用层**（2026-10-06 用户问「装了别的遥控插件是不是也会影响」之后加的）：
  // 只靠点名等于每装一个新插件就要再加一个名字，所以补一层——
  // 第三方（非官方的包）的样式表，整份只写在窄屏条件里的，一律摘掉。
  assert.match(body, /isNarrowOnly/, '要有「整份只在窄屏生效」的判断')
  assert.match(body, /cssRules/, '判断要交给浏览器的 CSS 解析器，别自己拆字符串数大括号')
  assert.match(body, /r\.type !== 4/, '顶层规则必须全是媒体查询才算数')
  assert.match(body, /@deepseek-ai\//, '**官方的包一律不动**——那是界面本身，摘了就把界面弄坏')
  assert.match(body, /NARROW_MAX/, '窄屏要有个上限值，不能把宽屏媒体查询也算进去')

  // 我们自己的适配必须还在
  assert.match(body, /mini-mirror-adapt/, '这一页的适配仍然由我们自己提供')

  // **那段脚本必须语法正确**：真机上它一报错就等于没挡，而且是静默的。
  const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const stripper = scripts.find((s) => s.includes('dsh-remote-portrait'))
  assert.ok(stripper, '要能找到那段挡人的脚本')
  assert.doesNotThrow(() => new Function(stripper), '那段脚本必须能通过语法解析')

  // **按名单摘**：名单里必须同时有两家，而且判断依据是 `data-plugin-css` 里那一段名字。
  assert.match(stripper, /STYLE_OWNERS\s*=\s*\[[^\]]*"remote-web-ui"[^\]]*\]/,
    '名单里要有 remote-web-ui')
  assert.match(stripper, /STYLE_OWNERS\s*=\s*\[[^\]]*"dsh-mobile-nav"[^\]]*\]/,
    '名单里要有 dsh-mobile-nav——就是 dsh-pocket 那段把设置导航改成三列网格的适配')
  assert.match(stripper, /data-plugin-css/, '判断归属看的是 data-plugin-css 这个标记')
  assert.match(stripper, /indexOf\(STYLE_OWNERS\[k\]\)/,
    '按名单逐个比对，以后再加一家只改名单这一行，不用再动摘除逻辑')

  // **第三层：摘标记**（2026-10-06 在真面板上量出根因之后补的）。
  // `meow-smooth` 用 `opacity:0` 把导航名字按成透明，而它那几条选择器里
  // **一个类名都没有**——按类名搜选择器永远搜不到它。
  assert.match(stripper, /data-meow-smooth-settings/,
    '要把面板上那个「手机端设置页」标记摘掉——真凶就是它把名字按成透明的')
  assert.match(stripper, /removeAttribute\(SETTINGS_MOBILE_ATTR\)/,
    '摘的是那个标记本身：它的规则和它的点击监听都只在有标记时才动手，摘掉两边一起失效')
  assert.match(stripper, /subtree:\s*true/,
    '那个标记挂在面板上（body 深处的节点），所以这一条观察必须管到子树')
  assert.match(stripper, /attributeFilter:\s*\[SETTINGS_MOBILE_ATTR\]/,
    '范围只钉在这一个属性名上——别的属性怎么变都不叫醒它，重页面上不能白烧性能')
  assert.match(stripper, /moSettings/,
    '单独开一个观察者：合成一条就得把 class 也放进 subtree 范围里（同一节点再 observe 是替换，'
    + '不是叠加），那才是真的会烧性能')
  assert.match(stripper, /style\[data-plugin-css\],\s*style\[data-plugin\]/,
    '**`style[data-plugin]` 也要看**：meow-smooth 那份样式写的是 data-plugin，'
    + '只按 data-plugin-css 找等于把这类整份漏掉')
  assert.match(stripper, /getAttribute\("data-plugin"\)/,
    '两个属性里的名字都要能取到，名单和通用层才都看得到它')
})

/**
 * **打开镜像就直接进设置**（2026-10-06 用户要的）。
 *
 * 用户原话：「我们能否在移动端设置页点打开，打开的就是这个设置页面？」
 *
 * 官方**没有网址入口**（读源码确认：面板开合是应用内部状态，不看地址），
 * 所以只能替用户点一下那个「设置」按钮——它的可靠特征是
 * `aria-haspopup="dialog"` + `aria-expanded`（官方渲染时写死的语义属性，不受类名哈希影响）。
 *
 * **只点一次**是关键：用户关掉面板之后绝不能再弹回来，否则他没法用底下那个主页面。
 */
test('镜像：打开就直接进设置（替用户点一次，之后绝不再弹）', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const body = await (await fetch(`http://127.0.0.1:${f.port}/blocked`)).text()
  assert.match(body, /aria-haspopup="dialog"/, '要按那个语义标记找「设置」按钮')
  assert.match(body, /aria-expanded/, '按钮上还有 aria-expanded，两个一起才稳')

  const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const opener = scripts.find((s) => s.includes('aria-haspopup'))
  assert.ok(opener, '要能找到那段自动打开的脚本')
  assert.doesNotThrow(() => new Function(opener), '那段脚本必须能通过语法解析')
  assert.match(opener, /done\s*=\s*true/, '点过就要收手')
  assert.match(opener, /clearInterval/, '点过要把定时器停掉——不能反复弹回来')

  // **不再有定时兜底**（2026-10-06 顾问群会诊后删掉的）：
  // 「打开设置后定时发 resize + 强制回流」是盲目 hack，而且它本身就是一次布局/重绘，
  // **会让「首帧到底画没画」再也测不准**。真根因已按顾问建议从样式上根治，见下一条测试。
  assert.ok(!/dispatchEvent\(new Event\("resize"\)\)/.test(opener), '不许留定时重排兜底')
  assert.ok(!/offsetHeight/.test(opener), '不许留强制回流兜底')
})

/**
 * **设置面板：导航压成一条可横向滑动的标签条**（2026-10-06 用户报的）。
 *
 * 用户原话：「上方的图标部分，下方点了图标的具体页面，然后上方页面一直固定在那，
 * 具体页面只有半个手机屏，这一块能优化吗？」
 *
 * 读官方源码确认：官方面板本来是「左边一列导航 188px + 右边内容」，
 * 而它自己的 `wide` **只影响侧栏那个按钮、完全不影响面板内部布局**。
 * 「横排在上方」是 `@dsh-external/dsh-mobile-nav`（`dsh-pocket`）注入的三列网格规则干的
 * ——现在那条已被按名单摘掉（见上面那条测试），这里只按我们要的样子定下来：
 * 面板竖排、导航一行不折行可横向滑动、名字露出来。
 *
 * **「名字被藏」这件事的真相**（2026-10-06 在活的镜像页里逐条比对）：
 * 没有任何规则藏它——只有官方那条 `white-space:nowrap + text-overflow:ellipsis + flex:1`
 * （实测计算宽度 76px、可见）。旧注释说的「官方用 clip + 1px 视觉隐藏」是把面板右上角
 * **关闭按钮**的 `hiddenLabel` 看成它了。那几行规则**留着当保险**：真有插件再用
 * 「视觉隐藏」那套把名字藏起来时，这里能把它放回来。
 *
 * 选择器用 `[data-shortcut-modal="settings"]`——官方渲染在面板上的固定标记，不受类名哈希影响。
 */
test('镜像：设置面板的导航压成一条可滑动的标签条，把屏幕让给内容', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const body = await (await fetch(`http://127.0.0.1:${f.port}/blocked`)).text()
  assert.match(body, /\[data-shortcut-modal="settings"\]\{flex-direction:column !important\}/,
    '面板要改成竖排：导航在上、内容在下')
  assert.match(body, /\[data-shortcut-modal="settings"\] nav\[class\*="_nav"\]\{[^}]*flex-wrap:nowrap !important/,
    '导航要**一行不折行**——折成三列网格就是它占掉半个屏幕的原因')
  assert.match(body, /\[data-shortcut-modal="settings"\] nav\[class\*="_nav"\]\{[^}]*overflow-x:auto !important/,
    '一行放不下就横向滑动')
  assert.match(body, /\[data-shortcut-modal="settings"\] \[class\*="_navLabel"\]\{[^}]*clip:auto !important/,
    '名字要保证露出来（实测现在没有规则藏它，这几行是保险）')
})

/**
 * **导航名字要按内容取宽、不参与收缩**（首帧没字的兜底，以及真根因的说明）。
 *
 * 上一版这里写着「首帧没字的根因就是官方的 flex 为竖列设计」——**那个判断真机验证是错的**。
 * 2026-10-06 在本地把真面板打开、逐张样式表 `matches()` 一遍，真凶是 `meow-smooth`：
 * 狭窄屏下面板被标成「收起态」，一条 `... > button > span { flex:0; max-width:0; opacity:0 }`
 * 让名字**有宽度、有文字、整片透明**（实测 rect 52×22、textContent="通用设置"、opacity 0，
 * 同一个格子里的 svg 图标 opacity 1）。
 *
 * 真凶已按第三层（摘标记）治掉；`ADAPT_CSS` 这几行留作兜底，**所以必须连 opacity 和
 * max-width 一起钉住**：只改 flex 而漏掉 opacity，正是上一版「改了却没用」的原因；
 * 漏掉 max-width，`width:max-content` 会被插件那条 `max-width:0` 掐死。
 */
test('镜像：导航名字要「按内容取宽 + 一定可见」（真根因的兜底）', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const body = await (await fetch(`http://127.0.0.1:${f.port}/blocked`)).text()
  assert.match(body, /\[class\*="_navLabel"\]\{[^}]*flex:0 0 auto !important/,
    '名字要按内容取宽——不伸不缩')
  assert.match(body, /\[class\*="_navLabel"\]\{[^}]*min-width:max-content !important/,
    '**min-width 必须一起覆盖**——只改 flex 而留着官方的 min-width:0，收缩那条路还开着')
  assert.match(body, /\[class\*="_navLabel"\]\{[^}]*width:max-content !important/,
    '宽度也钉成按内容')
  // 真根因量出来之后补的两条兜底：藏字的是 opacity，掐宽度的是 max-width。
  assert.match(body, /\[class\*="_navLabel"\]\{[^}]*opacity:1 !important/,
    'opacity 必须钉死：真凶就是它（meow-smooth 的 collapsed 态把名字按成 opacity:0）')
  assert.match(body, /\[class\*="_navLabel"\]\{[^}]*max-width:none !important/,
    'max-width 也要覆盖：插件那条 max-width:0 会把 width:max-content 掐死')
})

/**
 * **内容区的高度链要接上：`_content` 必须有 `min-height:0`**（2026-10-07 真面板量出来的）。
 *
 * 用户报「点击图标出现的页面没有滚动条，也没法滚动往下拉」。第一眼像滚动坏了，
 * **其实是高度链断在 `_content` 这一层**：官方只写了
 * `.xxx_content{flex:1 1 0%; min-width:0}`，**没有 `min-height:0`**。
 * 桌面横排时它恰好等于面板高（1500px 视口实测 panel 800 / content 800），看不出问题；
 * 我们一改竖排，导航在上面占 55px，这一层的「自动最小高度」（`min-height:auto` = 内容高）
 * 就顶穿了面板——实测 panel 高 796（`overflow:hidden`）、content 高 **1425**、
 * options 高 **1371**，而 `_options` 的 scrollHeight 也是 1371，**能滚多少 = 0**。
 *
 * 补 `min-height:0` 之后（同一次实测）content 1425 → **741**、options 1371 → **687**、
 * **能滚 684px**，跟 `_options` 本来就写着的 `min-height:0` 对上了。
 *
 * 所以这条测试守的是两件事：**这一格要在**，而且**要钉在 `_content` 上**——
 * 写错成 `_options` 是没用的（它本来就有），写漏了用户就滚不动。
 */
test('镜像：设置面板的内容区要有 `min-height:0`（不然滚不动，只有 0px 可滚）', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const body = await (await fetch(`http://127.0.0.1:${f.port}/blocked`)).text()
  // 面板竖排（导航在上、内容在下）仍然要在——这是「内容区拿到整屏高度」的前提
  assert.match(body, /\[data-shortcut-modal="settings"\]\{flex-direction:column !important\}/,
    '面板还是竖排：导航在上、内容在下')
  // 这一条是本轮新加的：竖排之后 `_content` 必须能被压到面板剩下的高度，否则滚不动
  assert.match(body, /\[data-shortcut-modal="settings"\] \[class\*="_content"\]\{min-height:0 !important\}/,
    '内容区要 `min-height:0 !important`——官方的 `_content` 漏了这一格，竖排之后它会被内容顶穿，'
    + '`_options` 因此拿到和内容一样高的高度，可滚距离变成 0')
  // 我们**没有**去动官方那层真正滚动的容器：它的 overflow-y:auto 与 min-height:0 都照旧
  assert.doesNotMatch(body, /\[class\*="_options"\]\{[^}]*overflow-y:hidden/,
    '真正滚动的那一层（`_options`）不能被我们改成 hidden')
})

/**
 * **「插件市场」这一节不能被挤成竖排、导航不能被它藏掉**（2026-10-07 真面板量出来的）。
 *
 * 用户报：「其他都 ok 了，只有这个页面……滚动页面的高度太窄了」，截图里那一节整个是竖的。
 * 逐张样式表 `matches()` 量下来，**跟我们摘掉的那些样式无关**：
 * 那一节自己的 `dshmarket/Market.module.css` 一直躺在页面里（它 571 条顶层规则里只有 5 条是
 * 媒体查询，通用层判不成「整份只在窄屏」）。真正做事的是它自己的三条：
 *
 *   · `.xxx_titleRow{display:flex;align-items:center;gap:10px}`——**没写 flex-wrap**，
 *     7 件东西（图标 22 + 标题 + 仓库名 66 + 版本 44 + 三个按钮）最小宽度加起来 ≈308px
 *     （gap 10×6 占掉 60），而手机上只给得出 286px → 中文按字断行，标题被压成 **16×96**、
 *     按钮被压成 32/36/32 宽，最后一个按钮右缘 **359** 超出市场区右缘 **342**（被裁掉）；
 *   · `@media (max-width:560px){ [role="dialog"]:has([data-dsh-market-root]) > nav{display:none} }`
 *     ——进了这一节整条导航被藏（实测 0×0），**而且没有导航就切不回别的节**；
 *   · `.tabs{display:flex;gap:2px}`——7 个页签总宽 **427px** 挤 **286px**、自己不滚也不折行，
 *     右边三个页签被裁掉（最右右缘 **479** > 342）。
 *
 * 三条都在我们自己的 `ADAPT_CSS` 里盖过去（用户定的方向：这一页的适配由我们定），
 * 而且**必须锁在 `[data-dsh-market-root]` 里面**——只碰它这一节，不许波及别的插件和别的节。
 */
test('镜像：插件市场那一节——标题行折行、导航要回来、页签条可滑', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const body = await (await fetch(`http://127.0.0.1:${f.port}/blocked`)).text()

  // ⑤ 标题行折行：不加这条，7 件东西在 nowrap 里把中文挤成一字一行。
  assert.match(body,
    /\[data-shortcut-modal="settings"\] \[data-dsh-market-root\] \[class\*="_titleRow"\]\{flex-wrap:wrap !important\}/,
    '市场那一节的标题行要能折行——实测它是 nowrap，286px 里挤 308px 的最小宽度，'
    + '标题被压成 16px 宽（竖排）、最后一个按钮被裁掉')
  // ⑥ 导航要回来：它自己那条窄屏规则把 nav 藏了，特异性 (0,2,1)，
  //    所以我们必须写得更具体（(0,3,2)）并且带 !important，否则压不住。
  assert.match(body,
    /\[data-shortcut-modal="settings"\]\[role="dialog"\]:has\(\[data-dsh-market-root\]\) > nav\{display:flex !important\}/,
    '进了市场那一节，被它藏掉的导航要按更高的特异性要回来——'
    + '它那条是 @media (max-width:560px){[role="dialog"]:has([data-dsh-market-root]) > nav{display:none}}')
  // ⑦ 页签条可滑：它自己不滚也不折行，右边三个页签被裁掉。
  assert.match(body,
    /\[data-shortcut-modal="settings"\] \[data-dsh-market-root\] \[class\*="_tabs"\]\{overflow-x:auto !important/,
    '那排页签要能横向划——实测 7 个页签 427px 挤 286px，右边三个被裁掉')
  // 这两样**各只许有「一条规则」**，而且规则数要写死——
  // 2026-10-07 加了 ⑪（藏标题行里的重复信息），`_titleRow` 于是合理地有了**两条**规则
  // （⑤ 折行一条、⑪ 藏重复信息一条）。所以这里**按规则数**查，不按「字符串出现次数」查：
  // 按出现次数查的话，`_titleRow` 在 ⑪ 的选择器列表里写一次就会被判成「重复」。
  const rulesOf = (name) => [...body.matchAll(new RegExp(
    `\\[data-shortcut-modal="settings"\\][^{}]*\\[class\\*="${name}"\\][^{}]*\\{[^}]*\\}`, 'g'))]
  assert.equal(rulesOf('_titleRow').length, 2, '标题行两条规则：⑤ 折行、⑪ 藏重复信息')
  assert.equal(rulesOf('_tabs').length, 1, '页签条一条规则：⑦ 横向滚动')

  // **每一条都必须锁在市场根里面**：只碰它这一节，别的插件/别的节一条都不许动。
  const marketRules = [...body.matchAll(/\[data-shortcut-modal="settings"\][^{}]*_titleRow[^{}]*\{[^}]*\}/g)]
  assert.equal(marketRules.length, 2, '标题行两条规则（⑤、⑪）')
  assert.ok(marketRules.every((m) => m[0].includes('[data-dsh-market-root]')),
    '每一条都要带 [data-dsh-market-root] 限定——不带就等于全局面板通用规则，会碰到别人')
  assert.doesNotMatch(body, /\[data-shortcut-modal="settings"\]\[role="dialog"\] > nav\{display:flex/,
    '要导航那条也必须带 :has([data-dsh-market-root]) 限定，不许变成「所有节的导航」通用规则')
})

/**
 * **「插件市场」那块能滚的列表窗口要尽量大**（2026-10-07 用户第二次报「窗口高度还是太矮」）。
 *
 * 逐项在活页面的真面板上量过之后定的七条（⑧–⑭），加我们那排导航压矮（⑮）：
 *   ⑧ 面板撑高（官方 `min(800px, calc(100vh - 48px))` 再居中，手机上白留上下各 23px）  +38px
 *   ⑨ 内容区那条头的上内边距 20px → 6px（那里**没有任何元素**，也不是拖拽把手）        +14px
 *   ⑩ `_options` 的下内边距 24px（市场根是 height:100%，这 24px 谁也用不到）           +24px
 *   ⑪ 标题行里重复的信息（图标 / 仓库名 / 版本号）藏掉，那一行从三行收到两行            +34px
 *   ⑫ 市场头部的 gap 12→6、padding 4/4/6→4/4/2                                        +22px
 *   ⑬ 吸附头（搜索 + 分类）的留白收掉（它钉在顶上，每 1px 都是**一直**少 1px 卡片）     +14px*
 *   ⑭ 列表滚动区自己的上下留白 12/24 → 6/12                                            +18px*
 *   ⑮ 我们那排导航：格子 34→30、上下内边距 8→5                                          +10px
 * 合起来**列表窗口 356 → 498px**、**看卡片的地方 204 → 378px**（* 两条只进「看卡片的地方」）。
 *
 * **这一条测试守的是「别把有用的东西省掉」**：用户划的线是「该省的只有重复的信息」——
 * 那三个按钮、搜索框、分类筛选、提示条、页签、导出日志**一个都不许被藏**。
 * 所以下面既查「该省的在」，也查「不该省的**不在**我们的隐藏名单里」。
 */
test('镜像：插件市场那块列表窗口——撑高、收留白、只藏重复信息', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const body = await (await fetch(`http://127.0.0.1:${f.port}/blocked`)).text()
  const P = '\\[data-shortcut-modal="settings"\\]'

  // ⑧ 面板撑高。**必须带 :has([data-dsh-market-root])**——不带就是所有设置节的面板一起变高。
  assert.match(body,
    new RegExp(`${P}:has\\(\\[data-dsh-market-root\\]\\)\\{height:calc\\(100% - 10px\\) !important`),
    '市场那一节的面板要撑到框满（官方高度是 min(800px, 100vh-48px) 再居中，'
    + '手机上白留上下各 23px；面板父级是 position:fixed; inset:0 的浮层，实测 844 高，'
    + '所以 calc(100% - 10px) 有确定参照，实测 798 → 836）')
  // ⑨ 内容区那条头的上内边距。**`height:auto` 必须一起写**：官方那条头是
  //    `box-sizing:border-box; height:54px`——高度写死了，光改内边距它一点不动（第一版就是这么哑掉的）。
  assert.match(body,
    new RegExp(`${P}:has\\(\\[data-dsh-market-root\\]\\) \\[class\\*="_content"\\] > \\[class\\*="_header"\\]`
      + '\\{padding:6px 14px 6px 10px !important;height:auto !important\\}'),
    '那条头（打开配置文件 + X）的上内边距 20px → 6px，**而且要把写死的 height 交还给内容**——'
    + '官方是 `box-sizing:border-box; height:54px`，只改内边距量出来纹丝不动；'
    + '量过 nav 底到按钮顶之间**没有任何元素**、也没有伪元素和拖拽把手，那 20px 只是留白')
  // ⑩ `_options` 的下内边距：只去掉下边那一条，左右那 24px 留着；
  //    而且按「内容区的**直接子元素**」点它（`_options` 这个子串在整棵面板里未必只有一个）。
  assert.match(body,
    new RegExp(`${P}:has\\(\\[data-dsh-market-root\\]\\) \\[class\\*="_content"\\] > \\[class\\*="_options"\\]`
      + '\\{padding-bottom:0 !important\\}'),
    '`_options` 的下内边距 24px 在市场节是白留的（市场根 height:100%，正好差这 24px）')
  // ⑪ 藏掉的三样：前图标、仓库名、版本号。**一样都不许多藏**。
  //    三样都限定在 `_titleRow` 里——`[class*="…"]` 是子串匹配，不限定的话将来市场给卡片里的
  //    版本号起个 `xxx_version` 的类名就会被连卡片一起藏掉。
  assert.match(body,
    new RegExp(`${P} \\[data-dsh-market-root\\] \\[class\\*="_titleRow"\\] > svg,`
      + `${P} \\[data-dsh-market-root\\] \\[class\\*="_titleRow"\\] \\[class\\*="_repoLink"\\],`
      + `${P} \\[data-dsh-market-root\\] \\[class\\*="_titleRow"\\] \\[class\\*="_version"\\]\\{display:none !important\\}`),
    '标题行里重复的三样（前图标 / 仓库名 dsh-market / 版本号 v1.66.6）藏掉，'
    + '那一行从三行 100px 收到两行 66px，两个更新按钮回到标题同一行')
  // ⑫⑬⑭ 三处留白。**都用「直接子元素」**——⑬ 第一版写成 `[class*="_cats"]`，
  //    子串匹配把 `_catsRow` / `_catsWrap` 也一起命中，量出来反而高了 8px（72 → 80）。
  assert.match(body,
    new RegExp(`${P} \\[data-dsh-market-root\\] > \\[class\\*="_head"\\]`
      + '\\{gap:6px !important;padding:4px 4px 2px !important\\}'),
    '市场头部的留白：四块之间的三道 12px 空档收成 6px；`_head` 按「市场根的直接子元素」点，'
    + '免得 `[class*="_head"]` 连官方面板那条 `_header` 一起命中')
  assert.match(body,
    new RegExp(`${P} \\[data-dsh-market-root\\] \\[class\\*="_stickyHead"\\] > \\[class\\*="_tabSearchRow"\\]`
      + '\\{padding-bottom:6px !important\\}'),
    '吸附头搜索那一行的下留白 12px → 6px（它钉在顶上，每 1px 都是**一直**少 1px 卡片）')
  assert.match(body,
    new RegExp(`${P} \\[data-dsh-market-root\\] \\[class\\*="_stickyHead"\\] > \\[class\\*="_cats"\\]`
      + '\\{padding:6px 4px 2px !important\\}'),
    '吸附头分类那一行的留白 12/4 → 6/2（同上）。**必须限定成吸附头的直接子元素**：'
    + '写成 `[class*="_cats"]` 会连 `_catsRow`（56→72）和 `_catsWrap`（56→64）一起命中，'
    + '实测反而高了 8px')
  assert.match(body,
    new RegExp(`${P} \\[data-dsh-market-root\\] > \\[class\\*="_body"\\]`
      + '\\{padding-top:6px !important;padding-bottom:12px !important\\}'),
    '列表滚动区自己的上下留白 12/24 → 6/12——它不改变滚动窗口的高度，改的是窗口里能看见卡片的净高')

  // ⑮ 我们那排导航（**我们自己的东西**，所以不带市场限定；它属于我们自己的适配）。
  assert.match(body, /\[class\*="_navCell"\]\{flex:none !important;height:30px !important/,
    '我们那排导航的格子 34px → 30px——它每高 1px，每个节的内容区就少 1px，'
    + '市场那一节实测列表窗口 +10px；只压高度、字号 13px 不动')
  assert.match(body, /nav\[class\*="_nav"\]\{[^}]*padding:5px 10px !important/,
    '我们那排导航的上下内边距 8px → 5px')

  // **「别把有用的东西藏掉」那一条，用反向断言把住**：
  // 凡是我们写的隐藏规则，选择器里**不许**出现这些有用的东西。
  const hides = [...body.matchAll(/[^{}]*\{[^}]*display:none !important[^}]*\}/g)].map((m) => m[0])
  const useful = ['_banner', '_tabs', '_tab\\b', '_search', '_cats', '_button', '_pager',
    '_repoLink', '_version']
  // `_repoLink` / `_version` 是**该藏的**（重复信息），单独拿出来对照，剩下的都不许出现。
  const mustKeep = useful.filter((k) => k !== '_repoLink' && k !== '_version')
  for (const rule of hides) {
    for (const k of mustKeep) {
      assert.ok(!new RegExp(k).test(rule),
        `隐藏规则里不许出现 ${k}——用户划的线是「该省的只有重复的信息」，`
        + `提示条 / 页签 / 搜索 / 分类 / 按钮 / 分页 都要留着。规则：${rule.slice(0, 160)}`)
    }
  }
  // 那三样重复信息**确实**被藏了（跟上面那条反向断言配成一对）。
  assert.ok(hides.some((r) => r.includes('_repoLink') && r.includes('_version')),
    '仓库名和版本号这两样重复信息要真的被藏掉')
})

/**
 * **压缩照旧转发**（2026-10-06）。
 *
 * 第一版把 `accept-encoding` 摘掉了，理由是「HTML 保持明文好注入」——**但那只对 HTML
 * 成立，我把所有东西都关掉了**：整个界面裸着搬，一次 34 MB（121 个请求）。
 * 本机压一遍是原体积的 24%～29%。现在照旧转发；HTML 那一份单独解开再注入。
 */
test('镜像：`accept-encoding` 照旧转发（压缩是省流量的大头）', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  await fetch(`http://127.0.0.1:${f.port}/some/path`, {
    headers: { 'accept-encoding': 'gzip, br' },
  })
  const hit = app.seen.filter((s) => s.url.startsWith('/some/path')).pop()
  assert.match(String(hit?.acceptEncoding), /gzip/,
    '`accept-encoding` 要照旧转发给上游。摘掉它 = 整个界面裸着搬（实测 34 MB），'
    + '而压缩后只剩两三成')
})

test('镜像：上游压缩着发 HTML 时，解开、注入、明文发出去', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const res = await fetch(`http://127.0.0.1:${f.port}/gz`, { headers: { 'accept-encoding': 'gzip' } })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-encoding'), null, '发给手机的应当是明文（已经解开过了）')
  const body = await res.text()
  assert.match(body, /ownsHost/, '压缩过的 HTML 也要能注入那个标记')
  assert.ok(body.includes('hi</body>'), '正文要完好')
})

/**
 * **给带内容指纹的静态资源补长期缓存**（2026-10-06）。
 *
 * 量出来的：34 MB 里，主程序包和插件包加起来 25 MB，**上游一个缓存头都没给**
 * （首页 HTML 也没有）。浏览器只能"猜着缓存"，每次打开都可能重新拉——蜂窝下就是这么卡死的。
 *
 * 敢长期留，是因为这两类地址里都带**内容指纹**（`index-5SrrfWpU.js` 的哈希、
 * `plugins/??a,b&rev=…` 的 rev）：**内容一变地址就变**，旧的留着不会让人看到旧代码。
 */
test('镜像：给带指纹的静态资源补长期缓存，HTML 绝不缓存', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const asset = await fetch(`http://127.0.0.1:${f.port}/assets/index-abc.js`)
  assert.match(String(asset.headers.get('cache-control')), /max-age=604800/,
    '带哈希的主程序包要能长期留')

  const combo = await fetch(`http://127.0.0.1:${f.port}/plugins/??a/client.js,b/client.js&rev=1`)
  assert.match(String(combo.headers.get('cache-control')), /max-age=604800/,
    '带 rev 的插件包也要能长期留')

  // HTML 是外壳，还要我们注入，**绝不能缓存**
  const html = await fetch(`http://127.0.0.1:${f.port}/blocked`)
  assert.equal(html.headers.get('cache-control'), null, 'HTML 不能带长期缓存')

  // 上游给了自己的判断就尊重它，别去覆盖
  const pet = await fetch(`http://127.0.0.1:${f.port}/pet/whale.webp`)
  assert.ok(!String(pet.headers.get('cache-control')).includes('604800'),
    '不在那两类里的资源，一律不碰')
})

test('镜像：不是 HTML 的一律不碰（那条常驻连接绝不能因为注入而被缓冲）', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const res = await fetch(`http://127.0.0.1:${f.port}/some/path`)
  const body = await res.text()
  assert.ok(!body.includes('ownsHost'), '不是 HTML 就不要注入')
  assert.equal(body, '上游内容 /some/path')
})

test('镜像：官方 cookie 认不出来了（401）就重铸一次再试', async (t) => {
  const app = await fakeApp()
  // 模拟真机上最常见的那种失效：**DSH 重启过，旧 cookie 作废**。
  // 注意这里 `tokenUrl` 一直是好的——失效的是**手里那枚 cookie**，
  // 不是「铸不出来」（那种走另一条测试）。
  app.rejectNext(1)
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const res = await fetch(`http://127.0.0.1:${f.port}/x`)
  assert.equal(res.status, 200, '重铸之后应当拿到正常响应')
  assert.equal(await res.text(), '上游内容 /x')
  // 认证那一步（问上游首页）应当发生过两次：第一次铸出来，401 之后再铸一次。
  const auths = app.seen.filter((s) => s.url.includes('token=LAUNCH-TOKEN'))
  assert.equal(auths.length, 2, `401 之后应当重铸一次（实际走了 ${auths.length} 次认证）`)
})

test('镜像：上游地址可以传函数（webServer 就绪得晚），而且只解析一次', async (t) => {
  const app = await fakeApp()
  let calls = 0
  const mirror = createMirror({
    // 真机上这里是一个「去问 webServer 端口」的函数。**这一条是补写的**：
    // 把上游改成函数形态时我漏改了一处内部引用，四条测试当场全红——
    // 说明原先根本没有覆盖到这条路。
    upstream: () => { calls += 1; return `http://127.0.0.1:${app.port}` },
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  assert.equal(mirror.available(), true, '解析得出来才算可用')

  await fetch(`http://127.0.0.1:${f.port}/a`)
  await fetch(`http://127.0.0.1:${f.port}/b`)
  assert.equal(calls, 1,
    '只解析一次就记住——Host 要用来签官方 cookie，每次重新解析就可能换来换去')
})

test('镜像：上游地址解析不出来时说自己不可用，而且如实报错不硬闯', async (t) => {
  const mirror = createMirror({
    upstream: () => null,
    tokenUrl: () => 'http://127.0.0.1:1/?token=x',
  })
  const f = await front(mirror)
  t.after(() => f.close())

  assert.equal(mirror.available(), false,
    '没有可镜像的界面时要说不可用——界面那一侧靠这个决定要不要露出这一项')
  const res = await fetch(`http://127.0.0.1:${f.port}/x`)
  assert.equal(res.status, 502)
  assert.match(await res.text(), /找不到可用的电脑端界面地址/)
})

/**
 * **宿主刚起来那一小段里要等，不能立刻回 502。**
 *
 * 2026-10-06 真机（用户报「又一直在转进不去」）：重启完立刻打开镜像，我们问不到界面
 * 地址就回 502；而那个界面外壳**拿到 502 不会重试**，于是永远卡在「Loading plugins…」，
 * 等宿主起来了也不会自己好——必须手动重开一次。这就是「重开一下就好了」的来历。
 */
test('镜像：上游还没就绪时要等一等，不要立刻回 502', async (t) => {
  const app = await fakeApp()
  let tries = 0
  const mirror = createMirror({
    // 头几次问不到（宿主还在起），第四次才有——真机上就是这个形状。
    upstream: () => {
      tries += 1
      return tries < 4 ? null : `http://127.0.0.1:${app.port}`
    },
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const res = await fetch(`http://127.0.0.1:${f.port}/api/whatever`)
  assert.equal(res.status, 200,
    '要等上游就绪再转发。立刻回 502 的话，界面外壳不会重试，就永远卡在「Loading plugins…」')
  assert.ok(tries >= 4, '确实等了几轮才拿到地址')
})

test('镜像：拿不到「带令牌的地址」时如实报错，不假装能转发', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => null,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const res = await fetch(`http://127.0.0.1:${f.port}/x`)
  assert.equal(res.status, 502)
  assert.match(await res.text(), /凭据/)
})

// ---------------------------------------------------------------------------
// 路由那一层：门必须真的关得上
// ---------------------------------------------------------------------------

/** 只给镜像那一段用得上的最小服务外壳；其余路径不碰，所以桩可以很薄。 */
async function bootServer({ mirror = null, mirrorEnabled = () => true } = {}) {
  const port = await (async () => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const p = probe.address().port
    await new Promise((r) => probe.close(r))
    return p
  })()

  const instance = await createMiniServer({
    store: { snapshot: () => ({}), state: {} },
    config: { port, defaultMode: 'minimal' },
    token: 'TOKEN-123',
    bindAddresses: ['127.0.0.1'],
    log: { info: () => {}, warn: () => {} },
    nav: undefined,
    tree: {},
    browse: {},
    build: 'test',
    mirror,
    mirrorEnabled,
  })
  return {
    base: `http://127.0.0.1:${instance.port}`,
    port: instance.port,
    close: () => instance.close(),
  }
}

/** 一个永远回 200 的镜像桩，用来证明「请求到底有没有走到代理那一步」。 */
function stubMirror(log, optsLog) {
  return {
    handle: async (req, res, opts) => {
      log.push(req.url)
      // 第三个参数（`{ diag }`）也要留痕：诊断开关就是靠它传到镜像那边的。
      if (optsLog) optsLog.push(opts)
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>mirror</html>')
    },
    upgrade: (req, socket) => {
      log.push('upgrade ' + req.url)
      socket.destroy()
    },
  }
}

/**
 * 升级请求的接线（2026-10-06 补）。
 *
 * WebSocket **不走 onRequest**——它是一条 `Upgrade` 握手，Node 单独发 `upgrade` 事件。
 * 所以上面那些「路由门」的测试**一条都没覆盖到它**：写漏了那个监听，HTTP 全绿、
 * 界面上却一直「正在重新连接」。这条专门盯接线本身，口径和 HTTP 那边一致：
 * **我们自己的地盘不转、开关关着一个都不接。**
 */
test('路由门：升级请求也要接线，而且口径和 HTTP 一致', async (t) => {
  const hit = []
  const on = { value: true }
  const s = await bootServer({ mirror: stubMirror(hit), mirrorEnabled: () => on.value })
  t.after(s.close)

  const { connect } = await import('node:net')
  const attempt = async (pathAndQuery) => {
    const sock = connect(s.port, '127.0.0.1')
    await once(sock, 'connect')
    sock.write(`GET ${pathAndQuery} HTTP/1.1\r\nHost: phone\r\nUpgrade: websocket\r\n`
      + 'Connection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n')
    await new Promise((r) => setTimeout(r, 250))
    sock.destroy()
  }

  await attempt('/mini/mirror/api/remote.mux')
  assert.deepEqual(hit, ['upgrade /api/remote.mux'],
    '**这条才是真机上真正会发生的**：官方那条连接按页面的 base（`/mini/mirror/`）解析，'
    + '请求落在 `/mini/mirror/api/remote.mux` 上——它必须被转，而且前缀要剥掉。'
    + '（第一版把它当「我们自己的地盘」拒掉了，界面就永远在重连。）')

  hit.length = 0
  await attempt('/api/remote.mux?token=TOKEN-123')
  assert.deepEqual(hit, ['upgrade /api/remote.mux'],
    '绝对路径形态也要转：我们自己的 token 参数要摘掉，其余原样')

  hit.length = 0
  await attempt('/mini/something')
  assert.deepEqual(hit, [], '我们自己的地盘（不在镜像前缀下面的）不转给上游')

  hit.length = 0
  on.value = false
  await attempt('/mini/mirror/api/remote.mux')
  assert.deepEqual(hit, [], '开关关着时一个都不接——不给一条绕过开关的通道')
})

test('路由门：开关关着时，那条代理路由**根本不存在**（不是前端藏起来）', async (t) => {
  const hit = []
  const s = await bootServer({ mirror: stubMirror(hit), mirrorEnabled: () => false })
  t.after(s.close)

  // 界面的绝对路径、入口路径，两条都不该通。
  for (const p of ['/api/whatever', '/mini/mirror']) {
    const res = await fetch(`${s.base}${p}?token=TOKEN-123`, { redirect: 'manual' })
    assert.equal(res.status, 404, `${p} 关着时应当是 404（查无此路），不是 401 也不是 200`)
  }
  assert.deepEqual(hit, [], '关着的时候一次都不该转发出去')
})

test('路由门：开着但没带令牌 → 401；带了才转发', async (t) => {
  const hit = []
  const s = await bootServer({ mirror: stubMirror(hit), mirrorEnabled: () => true })
  t.after(s.close)

  const no = await fetch(`${s.base}/api/whatever`, { redirect: 'manual' })
  assert.equal(no.status, 401, '没有令牌一律 401')
  assert.deepEqual(hit, [], '没认出来就不许往回转发')

  const yes = await fetch(`${s.base}/api/whatever?token=TOKEN-123`, { redirect: 'manual' })
  assert.equal(yes.status, 200)
  assert.equal(await yes.text(), '<html>mirror</html>')
  assert.deepEqual(hit, ['/api/whatever'],
    '认出来了就原样转发（路径不带我们的前缀）；我们自己的 token 参数要摘掉')
})

test('路由门：入口那一下写成 cookie，并且补上尾斜杠', async (t) => {
  const hit = []
  const s = await bootServer({ mirror: stubMirror(hit), mirrorEnabled: () => true })
  t.after(s.close)

  // 不带尾斜杠的入口：写 cookie，然后 302 到带斜杠的那条。
  const bare = await fetch(`${s.base}/mini/mirror?token=TOKEN-123`, { redirect: 'manual' })
  assert.equal(bare.status, 302)
  assert.equal(bare.headers.get('location'), '/mini/mirror/')
  const cookie = bare.headers.get('set-cookie')
  assert.ok(cookie, '入口必须顺手把 cookie 写上——否则界面里那些 /api/... 全是 401')
  assert.match(cookie, /Path=\//, 'cookie 要覆盖整个站，不然 /api/... 带不上')
  assert.deepEqual(hit, [], '补斜杠这一步不该往上游转发')

  // 带尾斜杠的入口：这就是上游的首页。
  // **尾斜杠不是洁癖**：外壳写着 `<base href="./">`，少这一个字符，
  // 它引用的脚本会解析到 /mini/assets/... 上（我们自己的地盘），全 404、界面白屏。
  // （真机上这一步靠上一条写下的 cookie 过关；这里 fetch 不共享 cookie，所以显式带令牌。）
  // **查询串整个丢掉**：里面只有我们的令牌，上游不认识它，留着反而会被它那些
  // 精确匹配的路由判成不匹配。
  const slash = await fetch(`${s.base}/mini/mirror/?token=TOKEN-123`, { redirect: 'manual' })
  assert.equal(slash.status, 200)
  assert.deepEqual(hit, ['/'], '带斜杠的入口映射到上游的首页，且不带查询串')
})

test('路由门：挂载前缀要剥掉（界面用相对路径，靠的就是它）', async (t) => {
  const hit = []
  const s = await bootServer({ mirror: stubMirror(hit), mirrorEnabled: () => true })
  t.after(s.close)

  // 外壳里的 `./assets/index-xxx.js`，在 `/mini/mirror/` 下会解析成这个地址。
  const res = await fetch(`${s.base}/mini/mirror/assets/index-abc.js?rev=1&token=TOKEN-123`,
    { redirect: 'manual' })
  assert.equal(res.status, 200)
  assert.deepEqual(hit, ['/assets/index-abc.js?rev=1'],
    '前缀要剥掉再转发、其余查询串留着——不剥的话上游看到 /mini/mirror/assets/... 会 404')
})

/**
 * 前缀下面**不是只有 GET**（2026-10-06 真机：界面上整片「加载不出来」）。
 *
 * 界面外壳写着 `<base href="./">`，所以**它所有请求都带这个前缀**——包括那些 POST：
 * `/mini/mirror/api/session/list`、`settings/describe`、`agentPresets/list` …
 * 当时这里限制成「只收 GET」，那些 POST 全掉进我们自己的 404。
 *
 * 前缀下面的路径**本来就只可能是界面的**（我们自己的接口都在 `/mini/api/`），
 * 所以不该按方法设限——这条就是钉住这一点。
 */
test('路由门：前缀下面的 POST 也要转（界面所有请求都带这个前缀）', async (t) => {
  const hit = []
  const s = await bootServer({ mirror: stubMirror(hit), mirrorEnabled: () => true })
  t.after(s.close)

  const res = await fetch(`${s.base}/mini/mirror/api/session/list?token=TOKEN-123`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    redirect: 'manual',
  })
  assert.equal(res.status, 200, 'POST 不能掉进我们自己的 404')
  assert.deepEqual(hit, ['/api/session/list'],
    '前缀照剥、方法照转——限制成只收 GET 时，界面上就是一片「加载不出来」')
})

test('路由门：我们自己那个 token 参数绝不跟着转发（它会撞坏上游的精确匹配）', async (t) => {
  const hit = []
  const s = await bootServer({ mirror: stubMirror(hit), mirrorEnabled: () => true })
  t.after(s.close)

  // 这是真机上试出来的那一条：界面里插件的脚本走**合并加载**路径，
  // 上游对它是精确匹配，多一个 `&token=` 就 404，脚本一 404 界面就卡在启动画面。
  const combo = '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=09c0a91a00d6'
  const res = await fetch(`${s.base}${combo}&token=TOKEN-123`, { redirect: 'manual' })
  assert.equal(res.status, 200)
  assert.deepEqual(hit, [combo],
    '我们自己的 token 必须摘掉，其余字符（@ / , 这些）一个都不许动')

  // 同名但不是我们那个值的参数**不许摘**——那可能是界面自己在用的。
  // 两个同名参数：第一个是我们的（用来过门），第二个不是（该留着）。
  // （用 ASCII 值：`fetch` 会把中文百分号编码，比对着会看不出在比什么。）
  hit.length = 0
  const other = '/plugins/x.js?token=TOKEN-123&rev=1&token=someone-else'
  await fetch(`${s.base}${other}`, { redirect: 'manual' })
  assert.deepEqual(hit, ['/plugins/x.js?rev=1&token=someone-else'],
    '只摘我们自己那一个，别的一律不许动')
})

test('路由门：拿不到令牌时连 cookie 都不该写（不给一个没验过的会话）', async (t) => {
  const hit = []
  const s = await bootServer({ mirror: stubMirror(hit), mirrorEnabled: () => true })
  t.after(s.close)

  const res = await fetch(`${s.base}/mini/mirror?token=错的`, { redirect: 'manual' })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('set-cookie'), null, '令牌不对就什么都不给')
  assert.deepEqual(hit, [])
})

test('路由门：开关是每请求现读的（开了立刻生效，不用重启）', async (t) => {
  const hit = []
  let on = false
  const s = await bootServer({ mirror: stubMirror(hit), mirrorEnabled: () => on })
  t.after(s.close)

  const before = await fetch(`${s.base}/api/x?token=TOKEN-123`, { redirect: 'manual' })
  assert.equal(before.status, 404, '关着 → 查无此路')

  on = true
  const after = await fetch(`${s.base}/api/x?token=TOKEN-123`, { redirect: 'manual' })
  assert.equal(after.status, 200, '开了 → 立刻可用（这个开关不该需要重启）')

  on = false
  const back = await fetch(`${s.base}/api/x?token=TOKEN-123`, { redirect: 'manual' })
  assert.equal(back.status, 404, '关回去 → 立刻又不通')
})

/**
 * WebSocket 转发（2026-10-06 真机报「一直正在重新连接」之后补的）。
 *
 * 手机和宿主之间那条**常驻连接**就是 WebSocket（官方客户端里写着
 * `url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'`，路径 `/api/remote.mux`）。
 * 它建不起来，界面上会冒出一堆**看起来不相干的显示毛病**：插件那一列只剩图标没有文字、
 * 权限那栏写「permission catalog has no active Host connection」。
 *
 * 这里不用真的 WebSocket 库——握手就是一段 HTTP 文本，握手之后是裸字节，
 * **用裸 TCP 两头夹着测，反而把「我们到底原样转了什么」看得更清楚。**
 */
async function fakeWsUpstream() {
  return fakeApp()
}
/** 拿裸 TCP 当客户端：发一段握手，等回应，再试一次往返。 */
async function wsProbe(port, pathAndQuery) {
  const { connect } = await import('node:net')
  const sock = connect(port, '127.0.0.1')
  await once(sock, 'connect')
  sock.write(`GET ${pathAndQuery} HTTP/1.1\r\nHost: phone\r\nUpgrade: websocket\r\n`
    + 'Connection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n')
  let buf = ''
  sock.on('data', (c) => { buf += c.toString('utf8') })
  // 等握手回来
  for (let i = 0; i < 60 && !buf.includes('\r\n\r\n'); i += 1) await new Promise((r) => setTimeout(r, 25))
  const handshake = buf
  // 握手之后是裸字节，验一次往返
  sock.write('PING-PAYLOAD')
  for (let i = 0; i < 60 && !buf.includes('PING-PAYLOAD'); i += 1) await new Promise((r) => setTimeout(r, 25))
  const echoed = buf.includes('PING-PAYLOAD')
  sock.destroy()
  return { handshake, echoed }
}

test('镜像：WebSocket 也要转（不然界面一直「正在重新连接」）', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const r = await wsProbe(f.port, '/remote/api/remote.mux?x=1')
  assert.match(r.handshake, /101 Switching Protocols/, '握手要真的通（101）')
  assert.ok(r.echoed, '握手之后要能双向裸转字节——只转握手不算转')

  const hit = app.seen.filter((s) => s.upgrade).pop()
  assert.ok(hit, '上游应当收到这次握手')
  assert.equal(hit.url, '/api/remote.mux?x=1',
    '`/remote/api/remote.mux` → `/api/remote.mux`：那条门控通道的前缀同样要剥掉')
  assert.equal(hit.host, `127.0.0.1:${app.port}`,
    'Host 照样固定成上游自己（官方 cookie 按 Host 签）')
  assert.equal(hit.upgrade, 'websocket',
    '**`Upgrade` 头必须原样留着**——它是握手本身，不是「逐跳杂音」；'
    + '按普通转发那样摘掉，握手就废了')
  assert.equal(hit.origin, `http://127.0.0.1:${app.port}`,
    '**`Origin` 必须换成上游自己**——这是 WebSocket 独有的坑：浏览器的普通同源请求不带 Origin，'
    + '但握手一定带。实测过：不带 Origin → 101；带手机那个 Origin → 403；'
    + '带上游自己的 → 101。不换的话手机上就是「重新连接中…」一直转。')
  assert.match(String(hit.cookie), /dsh-auth-/,
    '握手时也要替手机带上官方 cookie；不带的话上游会拒掉这条连接')
})

test('镜像：我们自己的地盘不转 WebSocket（`/mini/...` 不是上游的）', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const r = await wsProbe(f.port, '/mini/something')
  assert.ok(!/101/.test(r.handshake), '我们自己的路径不该被转给上游')
  assert.equal(app.seen.filter((s) => s.upgrade).length, 0, '上游不该收到它')
})

// ---------------------------------------------------------------------------
// 诊断模式（`?diag=1`）：只在开关打开时注入，样本落盘
// ---------------------------------------------------------------------------
//
// ## 为什么要有这一套（2026-10-06）
//
// 「进设置后导航栏只有图标、随便点一下文字才出来」这件事，之前所有结论都是
// **用一个假面板在本地量出来的**，量不到真机上的运行时状态（运行时挂的行内样式、
// 颜色/透明度/可见性、字体到没到、有没有透明层盖着字）；本地又复现不了
// （无头浏览器里那个「设置」按钮在折叠侧栏内、尺寸 0×0，点不开）。
// **那就让真机自己把数据报回来**——一次打开就能拿到「点击前 / 点击后」两份对照。
//
// 这一组要钉住两件事：
//   ① **不带 `diag=1` 时行为完全不变**（一个字节都不多）——正常路径不许被诊断污染；
//   ② 带上之后，脚本真的注入、开关真的传到镜像那边、样本真的落到 `scratch/diag.log`。
//      **最后这条最要紧**：真机跑一次成本很高，链路不通就白跑。

/** 把查询串里的 `diag=1` 翻成 `handle` 的第三个参数（lib/server.js 就是这么做的）。 */
async function frontWithDiag(mirror) {
  return listen((req, res) => {
    const diag = /[?&]diag=1(?:&|$)/.test(String(req.url ?? ''))
    mirror.handle(req, res, { diag })
  })
}

test('镜像：诊断脚本只在 ?diag=1 时注入，正常路径一个字节都不多', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await frontWithDiag(mirror)
  t.after(async () => { await f.close(); await app.close() })

  // ① 正常路径：**不许出现诊断脚本**（用户平时打开的每一页都不该因此重一点、
  //    也不该在页面上多出一条提示条）。
  const plain = await (await fetch(`http://127.0.0.1:${f.port}/blocked`)).text()
  assert.ok(!plain.includes('mini-mirror-diag'),
    '不带 diag 时**一个字节都不许多**——正常路径的行为必须完全不变')
  assert.match(plain, /ownsHost/, '该有的注入一样不少')

  // ② 诊断路径：脚本要在场，而且**必须语法正确**——真机上它一报错就是白跑一次。
  const diag = await (await fetch(`http://127.0.0.1:${f.port}/blocked?diag=1`)).text()
  const scripts = [...diag.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const probe = scripts.find((s) => s.includes('mini-mirror-diag'))
  assert.ok(probe, '带上 diag=1 要注入那段采样脚本')
  assert.doesNotThrow(() => new Function(probe),
    '那段脚本必须能通过语法解析（真机上它报错的话，用户跑一次就白跑了）')

  // 顾问群给的判别树，四条路各要有一个探针——少一条就得多跑一次真机。
  assert.match(probe, /elementsFromPoint/, '要能发现「有透明层盖在字上面」（第一条）')
  assert.match(probe, /-webkit-text-fill-color|webkitTextFillColor/,
    '颜色这一路要连着 -webkit-text-fill-color 一起看：Chromium 系它优先于 color')
  assert.match(probe, /document\.fonts/, '字体晚到不重绘也要看得出来')
  assert.match(probe, /pointerdown/, '「点一下字才出」要靠点击那一刻的样本对照')
  assert.match(probe, /getAttribute\('style'\)/, '运行时挂上去的行内样式也要采')
  assert.match(probe, /_navLabel/, '只采第一个 _navLabel')
  assert.match(probe, /querySelector\('svg'\)/, '要有同一个格子里那个图标的对照组')
  assert.match(probe, /closest\(/, '要沿祖先链逐层量，看宽度塌在哪一层')
  assert.match(probe, /clientRects/, '首帧被压到零宽的话，clientRects 会是空的')
  assert.match(probe, /devicePixelRatio/, '真机的视口信息也要带上')

  // 脚本本身不许把注入顺序搞反：必须排在**我们那套适配之后**，
  // 否则量到的是「适配生效前」的样子，不是用户看到的样子。
  assert.ok(diag.indexOf('mini-mirror-adapt') < diag.indexOf('mini-mirror-diag'),
    '采样脚本要排在我们的适配样式后面')
})

test('路由门：?diag=1 要原样传到镜像那边（入口会把查询串丢掉，只能这么传）', async (t) => {
  const hit = []
  const opts = []
  const s = await bootServer({ mirror: stubMirror(hit, opts), mirrorEnabled: () => true })
  t.after(s.close)

  // 带斜杠的入口：这就是上游首页，查询串整个丢掉——但诊断开关必须留下。
  await fetch(`${s.base}/mini/mirror/?token=TOKEN-123&diag=1`, { redirect: 'manual' })
  assert.deepEqual(hit, ['/'], '入口照旧映射到上游首页')
  assert.equal(opts[0]?.diag, true, '诊断开关要跟着进到镜像里')

  // 不带就一定是关的——正常路径不许被诊断污染。
  hit.length = 0; opts.length = 0
  await fetch(`${s.base}/mini/mirror/?token=TOKEN-123`, { redirect: 'manual' })
  assert.ok(!opts[0]?.diag, '不带 diag=1 时缺省是关的')

  // 不带尾斜杠的入口会 302 一次：**诊断开关要跟着跳过去**，
  // 否则用户拿到的链接少一个斜杠，真机跑一次就白跑了。
  const bare = await fetch(`${s.base}/mini/mirror?token=TOKEN-123&diag=1`, { redirect: 'manual' })
  assert.equal(bare.status, 302)
  assert.equal(bare.headers.get('location'), '/mini/mirror/?diag=1',
    '补斜杠时要把诊断开关带上')

  const barePlain = await fetch(`${s.base}/mini/mirror?token=TOKEN-123`, { redirect: 'manual' })
  assert.equal(barePlain.headers.get('location'), '/mini/mirror/',
    '不开诊断时那条 302 还是老样子（不许为了带上开关而多写参数）')
})

test('路由门：我们自己的 diag 参数绝不跟着转发（上游不认它，多一个就 404）', async (t) => {
  const hit = []
  const s = await bootServer({ mirror: stubMirror(hit), mirrorEnabled: () => true })
  t.after(s.close)

  const res = await fetch(`${s.base}/mini/mirror/assets/index-abc.js?rev=1&diag=1&token=TOKEN-123`,
    { redirect: 'manual' })
  assert.equal(res.status, 200)
  assert.deepEqual(hit, ['/assets/index-abc.js?rev=1'],
    '挂在前缀下面的地址要摘掉 diag=1，其余查询串一个字符都不许动')
})

test('诊断端点：样本会追加落到 scratch/diag.log（真机上唯一能看到的东西）', async (t) => {
  const { mkdtemp, readFile } = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')

  // 写到临时文件里：真机报上来的那一份不能被测试的样本搅浑
  // （读日志的人分不清哪条是真机的，这一趟就白跑了）。
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mini-diag-'))
  const file = path.join(dir, 'diag.log')
  process.env.DSH_MINI_DIAG_LOG = file
  t.after(() => { delete process.env.DSH_MINI_DIAG_LOG })

  const s = await bootServer({ mirror: stubMirror([]), mirrorEnabled: () => true })
  t.after(s.close)

  const post = (body, suffix = '?token=TOKEN-123') => fetch(`${s.base}/mini/api/mirror-diag${suffix}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  // 这道日志里写的会是界面上的东西，所以**要过同一道门**。
  const no = await fetch(`${s.base}/mini/api/mirror-diag`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"phase":"x"}',
  })
  assert.equal(no.status, 401, '没令牌不许往上写')

  const yes = await post({ session: 'abc', phase: 'baseline', label: { textLen: 2, rect: { w: 0 } } })
  assert.equal(yes.status, 200)
  assert.deepEqual(await yes.json(), { ok: true })

  const text = await readFile(file, 'utf8')
  assert.match(text, /baseline/, '样本要真的落到文件里')
  assert.match(text, /textLen/, '内容要整份留着——诊断就是靠这些字段')

  // **追加**，不是覆盖：一次打开要对照好几批（点击前 / 点击后），
  // 只留最后一批等于把对照数据丢了一半。
  await post({ session: 'abc', phase: 'after-click-3000' })
  const both = await readFile(file, 'utf8')
  assert.match(both, /baseline/, '前一批还在')
  assert.match(both, /after-click-3000/, '后一批也写进去了')

  // 默认落在插件根目录的 `scratch/diag.log`：**scratch/ 是 gitignore 的**，
  // 日志不会入库，也不会混进发布件。
  const src = await readFile(new URL('../lib/server.js', import.meta.url), 'utf8')
  assert.match(src, /'\.\.\/scratch\/diag\.log'/, '默认路径要从 lib/ 往上一层到 scratch/diag.log')
})

