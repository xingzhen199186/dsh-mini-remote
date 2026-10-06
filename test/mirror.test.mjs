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

import { createMirror } from '../lib/mirror.js'
import { createMiniServer } from '../lib/server.js'

/** 起一个服务器并等它真的在听，返回 { server, port, close }。 */
async function listen(handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    server,
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
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
    if (url.pathname === '/boom') {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('upstream boom')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'yes' })
    res.end('上游内容 ' + url.pathname)
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
  }
}

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
