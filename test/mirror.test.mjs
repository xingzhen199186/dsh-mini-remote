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
test('镜像：手机布局适配（把设置面板抬到侧栏上面 + 底部安全区）', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const body = await (await fetch(`http://127.0.0.1:${f.port}/blocked`)).text()
  assert.match(body, /\[class\*="_overlay"\]\{z-index:1200/,
    '要把设置面板那层浮层抬到侧栏（1100）上面')
  assert.ok(!/_sidebarCol"\]\{z-index/.test(body),
    '**不许把侧栏压下去**——第一版就是这么写的：遮罩反过来盖住侧栏、点击落在遮罩上，'
    + '真机上「一点侧栏就消失、还进不去设置」')
  assert.match(body, /safe-area-inset-bottom/, '底部要让开手势条（顶部那条由我们自己的横条管）')
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
  assert.match(body, /attributeFilter:\s*\["class"\]/, '观察范围要收窄（只看 body 的 class），别盯着整棵树')

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
 * **首帧没字的真根因：官方那个名字的 flex 是为竖列设计的，被我们改成横排后首帧被压到零宽**
 * （2026-10-06 顾问群会诊给出的判断，能对上全部证据）。
 *
 * 官方 `_navLabel{white-space:nowrap;text-overflow:ellipsis;flex:1;min-width:0}` 是给
 * 「左边一竖列 188px 宽」用的：占满剩余宽度、太长就截断。我们把它改成了一行横排之后，
 * **首帧里它被分到接近零的宽度**（或被省略号截空）→ 只剩图标；
 * **点一下触发重排、宽度重新分配，字才出来**——正是用户反复确认的现象。
 * 图标是矢量图、有固有尺寸，所以不受影响，这也对得上。
 *
 * 根治：让它**按内容取宽、彻底不参与收缩**。`min-width` 必须一起覆盖——
 * 只改 `flex` 而留着官方的 `min-width:0`，收缩那条路还是开着的。
 */
test('镜像：导航名字要按内容取宽、不参与收缩（首帧没字的根因）', async (t) => {
  const app = await fakeApp()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
  })
  const f = await front(mirror)
  t.after(async () => { await f.close(); await app.close() })

  const body = await (await fetch(`http://127.0.0.1:${f.port}/blocked`)).text()
  assert.match(body, /\[class\*="_navLabel"\]\{[^}]*flex:0 0 auto !important/,
    '名字要按内容取宽——不伸不缩，否则首帧会被压到零宽')
  assert.match(body, /\[class\*="_navLabel"\]\{[^}]*min-width:max-content !important/,
    '**min-width 必须一起覆盖**——只改 flex 而留着官方的 min-width:0，收缩那条路还开着')
  assert.match(body, /\[class\*="_navLabel"\]\{[^}]*width:max-content !important/,
    '宽度也钉成按内容')
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
function stubMirror(log) {
  return {
    handle: async (req, res) => {
      log.push(req.url)
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
