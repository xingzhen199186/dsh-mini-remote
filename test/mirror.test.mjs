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
      res.end('<html>hi</html>')
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
  assert.equal(await res.text(), '<html>hi</html>', '正文不该被改动')
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
  // `req.url` 是**带查询串**的原文，所以这里连 `?token=` 一起比。
  // （那串我们的令牌跟着转发过去是无害的：上游就是同一台机器上的 DSH 自己。）
  assert.deepEqual(hit, ['/api/whatever?token=TOKEN-123'],
    '认出来了就原样转发（路径不带我们的前缀、也不改写）')
})

test('路由门：入口那一下写成 cookie，界面后面自己发的请求才认得出', async (t) => {
  const hit = []
  const s = await bootServer({ mirror: stubMirror(hit), mirrorEnabled: () => true })
  t.after(s.close)

  const res = await fetch(`${s.base}/mini/mirror?token=TOKEN-123`, { redirect: 'manual' })
  assert.equal(res.status, 200)
  const cookie = res.headers.get('set-cookie')
  assert.ok(cookie, '入口必须顺手把 cookie 写上——否则界面里那些 /api/... 全是 401')
  assert.match(cookie, /Path=\//, 'cookie 要覆盖整个站，不然 /api/... 带不上')

  assert.deepEqual(hit, ['/'], '入口那条路径映射到上游的首页')
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
