/**
 * 「设备身份」第四步 + 第五步：**把「这一扇窗是谁的」记下来，让撤销对已经开着的窗口也生效，
 * 也让跨机那条路兑得成票**。
 *
 * 语义是一句话：**宁可窗开不了，也不开一扇撤不掉的窗**（fail closed）。
 * 下面每一条都是「悄悄坏掉也不会有人发现」的那一类：
 *
 *   ① **验收核心**：名册里那台设备开出来的那扇窗，记录一删，**下一次请求当场 401**
 *      （不重启、也没有缓存窗口）。撤销之前它明明是 200——这一对前后对照就是全部意义。
 *   ② **本机那一半（`local`）**：桌面端面板走的就是它，它**不查名册**。所以名册空着、
 *      或者把设备全撤光，它照旧能用。这一条同样重要——本机面板要是跟着一起坏，
 *      用户看到的是"撤销了别人，我自己的窗口也黑了"。
 *   ③ **票上没写主人 / 本机票走了隧道**：一律不兑现（fail closed），而且**票不烧掉**
 *      （留着自然过期）。隧道流量在回环上长得像本机（cloudflared 就是回连我们），
 *      所以本机那一半必须再验"这一下是这台电脑自己发的"。
 *   ⑦ **跨机取票（第五步补的那条路）**：对面那台电脑的浏览器**没有设备凭据**
 *      （凭据只活在对面那个宿主进程里），也**不是本机回环**。所以身份只能在**发票那
 *      一刻**定下来、跟着票走（见 lib/index.js 的两条取票路由），兑票时读票上那个
 *      主人（见 lib/server.js 的 ticketWindowOwner）。**票仍然 30 秒、一次性**，
 *      撤销仍然两头都管：手上那张没用掉的票当场兑不出来，已经换出来的会话下一次
 *      请求 401。
 *   ④ **换一个宿主进程，旧会话全失效**：签名仍然只有进程密钥，这一条一个字都没变。
 *   ⑤ **撤销时那条已经握手的 WebSocket 也要断**：它不是 HTTP，401 管不到它。
 *      窗口里那条常驻连接是靠**会话里签着的设备身份**才认得出来的（第二路）。
 *   ⑥ **身份改不了**：拿到会话的人没法把自己说成另一台设备（签名罩着身份那一段）。
 *
 * 全程用**真服务 + 真镜像 + 真名册**（`createMiniServer` / `createMirror` / `createDevices`），
 * 只有"电脑端界面"是个替身。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMiniServer } from '../lib/server.js'
import { createMirror } from '../lib/mirror.js'
import { createDevices } from '../lib/devices.js'
import { reachableAddresses } from '../lib/net.js'

const TOKEN = 'testtoken0123456789abcdef012345'
const DEVICE_COOKIE = 'dsh_mini_device'
const WINDOW_COOKIE = 'dsh_mini_window'
/** 「本机那一半」在票上和会话里的身份标记（真身就是 lib/server.js 那个常量）。 */
const LOCAL = 'local'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等一个条件成立（真机上的"下一次请求"在测试里就是这一下）。 */
async function waitFor(ok, ms = 3000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ok()) return true
    await sleep(10)
  }
  return ok()
}

// ---------------------------------------------------------------- 夹具

/** 起一个服务器并等它真的在听（照 test/device-identity.test.mjs 那份）。 */
async function listen(handler, onUpgrade = null) {
  const server = createServer(handler)
  const upgraded = new Set()
  server.on('upgrade', (req, socket, head) => {
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))
    onUpgrade?.(req, socket, head)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    upgraded,
    close: () => new Promise((r) => {
      for (const s of upgraded) s.destroy()
      server.closeAllConnections?.()
      server.close(r)
    }),
  }
}

/**
 * 一个「像电脑端界面」的替身：**HTTP 和 WebSocket 都真的受理**。
 *
 * WS 那条必须真的回 101 并**握手后一直挂着**——否则"撤销把这条连接掐断"就没有可观察的
 * 信号（连接是上游自己关的、还是我们掐的，就分不出来了）。
 */
async function fakeUpstream() {
  const seen = []
  const app = await listen((req, res) => {
    seen.push(req.url)
    const url = new URL(req.url, 'http://x')
    // 镜像铸官方会话 cookie 那一步（官方 BrowserAuth.authorizeIndex 的形状）。
    if (url.pathname === '/' && url.searchParams.get('token') === 'LAUNCH-TOKEN') {
      res.writeHead(303, {
        location: './',
        'set-cookie': 'dsh-auth-abc123=v1.payload.sig; Path=/; HttpOnly',
      })
      res.end()
      return
    }
    if (!/dsh-auth-/.test(String(req.headers.cookie ?? ''))) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh web authentication required')
      return
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body>电脑端界面</body></html>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('上游内容 ' + url.pathname)
  }, (req, socket) => {
    socket.on('error', () => { /* 被掐断是常态 */ })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  return { port: app.port, seen, upgraded: app.upgraded, close: app.close }
}

/** 一份真镜像，指着替身上游。 */
function realMirror(app) {
  return createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
    log: () => {},
  })
}

/** 一个只够跑这条路的最小服务外壳（**真**的 createMiniServer）。 */
async function boot({ devices, mirror, mirrorEnabled = () => true, bindAddresses = ['127.0.0.1'] }) {
  const instance = await createMiniServer({
    store: { snapshot: () => ({}), state: {} },
    config: { port: 0, defaultMode: 'minimal' },
    token: TOKEN,
    bindAddresses,
    devices,
    mirror,
    mirrorEnabled,
    log: { info: () => {}, warn: () => {} },
    build: 'test',
  })
  return {
    port: instance.port,
    addresses: instance.addresses,
    base: `http://127.0.0.1:${instance.port}`,
    instance,
    close: () => instance.close(),
  }
}

/** 一个干净的数据目录：名册文件和真机上是同一个名字。 */
function tempDevices() {
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-mini-windev-')), 'devices.json')
  return { file, devices: createDevices({ file }) }
}

/** 名册落盘那几条记录（文件还没生成时算空名册）。 */
function records(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).devices ?? []
  } catch {
    return []
  }
}

/** 这次响应写下的全部 Set-Cookie 段。 */
function setCookieList(res) {
  const all = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [String(res.headers.get('set-cookie') ?? '')]
  return all.filter(Boolean)
}

/** 从响应的一条 Set-Cookie 里取某个名字的值（没有就空串）。 */
function cookieValue(res, name) {
  const head = `${name}=`
  for (const one of setCookieList(res)) {
    if (!one.startsWith(head)) continue
    return decodeURIComponent(one.slice(head.length).split(';')[0])
  }
  return ''
}

/**
 * 打开一次手机页 = 登记一台新设备（登记点只有这一个，见 lib/server.js）。
 * 这一步纯属"让名册里有一条记录"，和窗口那件事本身无关。
 */
async function registerDevice(p, ua) {
  const res = await fetch(`${p.base}/mini?token=${TOKEN}`, { headers: ua ? { 'user-agent': ua } : {} })
  assert.equal(res.status, 200)
  const cred = cookieValue(res, DEVICE_COOKIE)
  assert.match(cred, /^[0-9a-f]{32}\.[0-9a-f]{32}$/, '打开手机页那一下要发下一枚设备凭据')
  await res.text()
  return cred
}

/**
 * **兑票开窗**——门里的那一下。
 *
 * 真机上「这一扇窗是谁的」是**发票那一刻**定下来的（见 lib/index.js 的两条取票路由：
 * 本机那条给 `local`，跨机那条给刚验过的设备 id），所以这里也照那个口径发票。
 *
 * **兑票这一下不带任何凭据**（`device` 只用来推它是哪台设备，不进请求）：跨机那条路上，
 * 票是在**对面那台电脑的浏览器**里打开的，它手上只有这张票——凭据只活在对面那个宿主
 * 进程里，永远不进浏览器。这正是这一步要修的那条路。
 *
 * @param {string | null} device 名册里那台设备的凭据（`<id>.<secret>`）；给 null 就是本机那一半。
 * @returns {{status:number, session:string, body:string, ticket:string}}
 */
async function openWindow(p, mirror, device) {
  const ticket = mirror.issueTicket(device ? String(device).split('.')[0] : LOCAL)
  const res = await fetch(`${p.base}/mini/mirror/?ticket=${ticket}`, { redirect: 'manual' })
  const body = await res.text()
  return { status: res.status, session: cookieValue(res, WINDOW_COOKIE), body, ticket }
}

/** 框里那些请求的典型一条：绝对路径、带窗口会话、不带别的凭据。 */
function frameCall(p, session, path = '/api/session/list') {
  return fetch(`${p.base}${path}`, {
    method: 'POST',
    headers: { cookie: `${WINDOW_COOKIE}=${session}`, 'content-type': 'application/json' },
    body: '{}',
    redirect: 'manual',
  })
}

/** 窗口入口（iframe 重新加载走的那一条）。 */
function frameEntry(p, session, extra = '') {
  return fetch(`${p.base}/mini/mirror/${extra}`, {
    headers: session ? { cookie: `${WINDOW_COOKIE}=${session}` } : {},
    redirect: 'manual',
  })
}

/**
 * 测试自己开出来的那些"活着的"连接。
 *
 * 为什么要有这一个集合：`server.close()` 只自动关掉**空闲的** keep-alive，
 * 一条已经升级成 WebSocket 的连接会让它一直等下去——**收尾顺序错了就是测试挂死**。
 * 所以凡是我方开的连接，收尾时一律先掐掉。
 */
const liveSockets = new Set()

/**
 * 收尾：先掐自己开的连接，**再关上游、最后关服务**。
 *
 * **顺序不能换**（实测出来的）：镜像那条隧道是"两头互相收尸"——上游那条一断，
 * `call.on('close')` 才会把我们这边的套接字一起收掉。反过来先 `server.close()` 的话，
 * 一条还活着的升级连接会让它一直等下去（实测 ~120 秒，由 Node 那层的一个超时松开）。
 */
async function shutdown(p, app) {
  for (const sock of liveSockets) {
    try { sock.destroy() } catch { /* 已经断了 */ }
  }
  liveSockets.clear()
  await app.close()
  await p.close()
}

/**
 * 打开一条窗口里的常驻连接（`/mini/mirror/api/remote.mux`），**只带窗口会话这一枚**。
 * 这正是"第二路"要认的那一种：凭据不在 cookie 里，只有会话里签着的身份。
 */
function openWindowWs(port, session) {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1')
    liveSockets.add(sock)
    const state = { line: '', closed: false }
    let buf = ''
    const timer = setTimeout(() => reject(new Error('窗口那条 WS 的握手一直没有回应')), 5000)
    sock.on('error', () => { /* 被掐断时本来就会报 */ })
    sock.on('close', () => { state.closed = true; liveSockets.delete(sock) })
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      if (state.line || !buf.includes('\r\n')) return
      state.line = buf.split('\r\n')[0]
      clearTimeout(timer)
      resolve({ state, waitClosed: (ms) => waitFor(() => state.closed, ms) })
    })
    sock.on('connect', () => {
      sock.write([
        'GET /mini/mirror/api/remote.mux HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        `Cookie: ${WINDOW_COOKIE}=${session}`,
        '', '',
      ].join('\r\n'))
    })
  })
}

// ---------------------------------------------------------------------------
// ① 验收核心：撤销之后，那扇已经开着的窗下一次请求就 401
// ---------------------------------------------------------------------------

test('⚠️ 验收核心：票上写着哪台设备，名册里删掉那条记录之后下一次请求当场 401', async (t) => {
  const { file, devices } = tempDevices()
  const app = await fakeUpstream()
  const mirror = realMirror(app)
  const p = await boot({ devices, mirror })
  t.after(() => shutdown(p, app))

  const cred = await registerDevice(p, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
  const id = cred.split('.')[0]
  assert.equal(records(file).length, 1)

  // 兑票开窗：**票上写着这台设备**（真机上由 `/mini-remote/remote/window` 在验完凭据
  // 之后记进去），而兑票这一下**不带凭据**——跨机那条路上，票是在对面那台电脑的浏览器里
  // 打开的，它手上只有这张票。
  const opened = await openWindow(p, mirror, cred)
  assert.equal(opened.status, 200, '票上写着名册里的那台设备，这一张票要能兑现')
  assert.ok(opened.session, '开窗那一下要发下窗口会话 cookie')
  assert.equal(opened.session.split('.').length, 3, '会话仍是三节：版本.随机串.签名')
  assert.match(opened.session.split('.')[1], /~[0-9a-f]{32}$/,
    '身份那一节签在随机串后面（`~` 分隔），不是另开一节')

  // 撤销之前：框里那条请求能用（这一条是"前后对照"的前一半）。
  const before = await frameCall(p, opened.session)
  assert.equal(before.status, 200, '撤销之前，窗口会话该能把框里的请求转上去')
  await before.text()

  // ★ 撤销 = 名册里删掉那条记录。
  //   真机上 `/mini-remote/devices/revoke` 做的就是这一下（外加掐活连接，见第 ⑤ 条）。
  assert.equal(devices.remove(id), true, '这台设备本来在名册里')
  assert.deepEqual(records(file), [], '名册落盘那份也删掉了')

  // ★ 验收：不重启、不换票、什么都不做——**下一次请求就是 401**。
  const after = await frameCall(p, opened.session)
  assert.equal(after.status, 401, '⚠️ 撤销之后，那扇已经开着的窗下一次请求必须 401')
  await after.text()

  // 入口那一条也进不去（iframe 重新加载走的就是它）。
  const entry = await frameEntry(p, opened.session)
  assert.equal(entry.status, 401, '重新加载窗口入口也不行')
  await entry.text()

  // **带票的那条地址**重新加载同样不行：票只证"这一页是我嵌出来的"（取景政策），
  // 它**不是**通行证。少了后一半，撤销就会被"刷新一下"绕过去。
  const reload = await frameEntry(p, opened.session, `?ticket=${opened.ticket}`)
  assert.equal(reload.status, 401, '带票地址重新加载也不行：票不管通行，只管取景')
  await reload.text()

  // 名册里那台设备不在了，凭据本身当然也不认了——两条路一起失效。
  const byCred = await fetch(`${p.base}/mini/api/state`, { headers: { 'X-Mini-Device': cred } })
  assert.equal(byCred.status, 401, '设备凭据本身也当场失效')

  // 撤销之后**一个字节都没有再往上流转**（上游记录里不该有新条目）。
  const forwarded = app.seen.filter((u) => u.startsWith('/api/'))
  assert.deepEqual(forwarded, ['/api/session/list'], '撤销之后不该再有任何请求被转给上游')
})

// ---------------------------------------------------------------------------
// ② 本机那一半：`local`，不查名册
// ---------------------------------------------------------------------------

test('本机那一半（local）：名册空着也能开窗，把设备撤光也不影响它', async (t) => {
  const { file, devices } = tempDevices()
  const app = await fakeUpstream()
  const mirror = realMirror(app)
  const p = await boot({ devices, mirror })
  t.after(() => shutdown(p, app))

  // 名册**一条记录都没有**：本机这条路照样要通——它跟名册不是一回事。
  assert.deepEqual(records(file), [], '先确认名册是空的')
  // 票上写着 `local`（真机上那条 `/mini-remote/window` 就是这么发的），而且这一下
  // 确实是本机（回环、没有转发头）——两条都占才兑现。
  const local = await openWindow(p, mirror, null)
  assert.equal(local.status, 200, '票上写着 `local` + 这一下是本机：这一张票要能兑现')
  assert.ok(local.session)
  assert.match(local.session.split('.')[1], /~local$/, '本机那一半的身份就是 `local`')

  const work = await frameCall(p, local.session)
  assert.equal(work.status, 200, '本机窗口该能正常用')
  await work.text()

  // 现在登记一台设备、又把它撤掉：本机那扇窗**一点不受影响**。
  const cred = await registerDevice(p)
  assert.equal(devices.remove(cred.split('.')[0]), true)
  const still = await frameCall(p, local.session)
  assert.equal(still.status, 200,
    '本机窗口不受"撤销设备"影响：它不是名册里的设备，也没有"撤销这一台"这回事')
  await still.text()
})

// ---------------------------------------------------------------------------
// ③ 票上没写主人 / 本机票走了隧道：不兑现（fail closed），但票不烧掉
//
// 这一步的判据从「看请求带了什么」换成了「看票上写着谁」。**换的是判据的来源，不是松紧**：
//   · 原来 `local` 是**从来源猜出来的**（没凭据、又看着像本机），隧道流量在回环上正好
//     也长得像本机——所以得靠"带转发头就不算本机"这个补丁兜着；
//   · 现在 `local` 只能来自「只对本机开放的那条取票路由」发出来的票（见 lib/index.js
//     的 `/mini-remote/window`），请求**自称不了** `local`；而下面第 ③ 条还留着回环那一关，
//     带转发头的隧道请求**拿着本机票也进不来**。两条加起来只多不少。
// 这一条钉的就是"定不下身份"那一半：给一页人话，而且**票不烧掉**（留着自然过期）。
// ---------------------------------------------------------------------------

test('票上没写主人 / 本机票走了隧道：不兑现、给一页人话，而且票没被烧掉', async (t) => {
  const { devices } = tempDevices()
  const app = await fakeUpstream()
  const mirror = realMirror(app)
  const p = await boot({ devices, mirror })
  t.after(() => shutdown(p, app))

  // ① **票上没写主人**：老形状，或者将来谁加了新的取票口却忘了说明这扇窗是谁的。
  //    定不下身份就不兑现——给一页人话走人。
  const anon = mirror.issueTicket()
  const refused = await fetch(`${p.base}/mini/mirror/?ticket=${anon}`, { redirect: 'manual' })
  assert.equal(refused.status, 403, '票上没主人就不兑现（宁可窗开不了）')
  assert.match(refused.headers.get('content-type') ?? '', /text\/html/, '框会把它当文档渲染，所以要给人话')
  assert.match(await refused.text(), /通行证/, '正文要说清是通行证的问题')
  assert.equal(refused.headers.get('set-cookie'), null, '不兑现就不发窗口会话')
  // **票没被烧掉**：`ticketOwner` 还读得到它（`''`＝还在表里，只是没主人）——
  // 烧掉只让用户白等 30 秒重新点一次，一个字节的安全都换不来。
  assert.equal(mirror.ticketOwner(anon), '', '被拒那一下没把这张票删掉（留着自然过期）')

  // ② **请求里带着名册里的设备凭据也不行**：身份只看票上写的。这一条同时钉住
  //    "老口径"没有留下来当后门——带着凭据来，票上没写主人，照样不兑现。
  const cred = await registerDevice(p)
  const anon2 = mirror.issueTicket()
  const byCred = await fetch(`${p.base}/mini/mirror/?ticket=${anon2}`, {
    headers: { 'X-Mini-Device': cred },
    redirect: 'manual',
  })
  assert.equal(byCred.status, 403, '票上没主人：请求里带设备凭据也不兑现')
  assert.equal(byCred.headers.get('set-cookie'), null, '不兑现就不发窗口会话')
  await byCred.text()

  // ③ **本机票 + 隧道形态**：源地址在回环上（cloudflared 就是回连我们），但带着转发头。
  //    **这一条必须挡住**——不然"另一台机器"会被当成这台电脑自己，拿到一个撤不掉的 `local`。
  const t2 = mirror.issueTicket(LOCAL)
  const blocked = await fetch(`${p.base}/mini/mirror/?ticket=${t2}`, {
    headers: { 'cf-connecting-ip': '198.51.100.7' },
    redirect: 'manual',
  })
  assert.equal(blocked.status, 403, '本机票 + 转发头：不兑现（这一下不是这台电脑自己发的）')
  await blocked.text()

  // 而这张票也**没被烧掉**：同一张票从回环再兑就成——"定不下身份"和"票不对"的分界
  // （后者已经把票删了）。否则在隧道上误开一次，那张票就废了，用户只能重新点一次。
  const ok = await fetch(`${p.base}/mini/mirror/?ticket=${t2}`, { redirect: 'manual' })
  assert.equal(ok.status, 200, '被拒的那一下不该把票烧掉（票留着过期）')
  assert.ok(cookieValue(ok, WINDOW_COOKIE), '同一张票从本机再兑，要能拿到窗口会话')
  await ok.text()
})

// ---------------------------------------------------------------------------
// ③′ 跨机取票（这一轮补的那条路）：对面那台电脑的浏览器**没凭据、只带票**，照样兑现
//
// 真机上的次序：对面那个宿主进程拿**自己的设备凭据**去 `/mini-remote/remote/window`
// 换票（那一步验名册、验完把 id 记进票里），然后把地址交给**它自己的浏览器**。
// 于是兑票这一下的请求：**没有设备凭据**（凭据没进浏览器）、**不是本机回环**
// （它从局域网/隧道进来）。按原来的口径这两条都不占，永远兑不出来——这一轮补的就是它。
// ---------------------------------------------------------------------------

test('⚠️ 跨机取票：对面那台电脑的浏览器没凭据、只带票，也能兑现（票上写着它是谁）', async (t) => {
  const { devices } = tempDevices()
  const app = await fakeUpstream()
  const mirror = realMirror(app)
  const p = await boot({ devices, mirror })
  t.after(() => shutdown(p, app))

  const cred = await registerDevice(p, 'Mozilla/5.0 (Linux; Android 14)')
  const id = cred.split('.')[0]

  const ticket = mirror.issueTicket(id)
  const res = await fetch(`${p.base}/mini/mirror/?ticket=${ticket}`, {
    // 跨机那条路的形状：不带任何凭据，而且带着转发头（隧道/代理进来的都会有）。
    headers: { 'x-forwarded-for': '203.0.113.9' },
    redirect: 'manual',
  })
  assert.equal(res.status, 200, '⚠️ 没凭据、只带票：这一张票必须能兑现')
  const session = cookieValue(res, WINDOW_COOKIE)
  assert.ok(session, '照样要发下窗口会话 cookie')
  assert.match(session.split('.')[1], new RegExp(`~${id}$`),
    '⚠️ 会话里签的是**票上那个设备**，而且**绝不会被升成 `local`**')
  await res.text()

  // 这扇窗真的能用：框里那条请求照旧被转上去。
  const work = await frameCall(p, session)
  assert.equal(work.status, 200, '票换出来的那扇窗能用')
  await work.text()

  // ★ **仍然一次性**：同一张票第二次兑现进不去（票已经删了；`grants` 只留取景标记）。
  //   这一下**不带窗口会话**，否则进门靠的是会话、验不到票这件事。
  const again = await fetch(`${p.base}/mini/mirror/?ticket=${ticket}`, { redirect: 'manual' })
  assert.equal(again.status, 401, '⚠️ 一次性：同一张票第二次兑现必须失败')
  assert.equal(again.headers.get('set-cookie'), null, '也不再发新的窗口会话')
  assert.deepEqual(app.seen.filter((u) => u === '/'), ['/'],
    '那两次失败都没有把请求转给上游（门口就挡下了）')

  // ★ **撤销那一头**：票上那个主人被删掉之后——
  //   ① **手上那张还没用掉的票当场兑不出来**（兑现这一刻也查名册）；
  const ticket2 = mirror.issueTicket(id)
  assert.equal(devices.remove(id), true, '这台设备本来在名册里')
  const revoked = await fetch(`${p.base}/mini/mirror/?ticket=${ticket2}`, { redirect: 'manual' })
  assert.equal(revoked.status, 403, '撤销之后，那张还没用掉的票当场兑不出来')
  assert.equal(revoked.headers.get('set-cookie'), null, '更不会发新的窗口会话')
  await revoked.text()

  //   ② **已经换出来的那扇窗下一次请求也 401**（会话里签着设备身份，每次放行回头查名册）。
  const dead = await frameCall(p, session)
  assert.equal(dead.status, 401, '⚠️ 票上那个主人被撤销之后，票换出来的那扇窗下一次请求就 401')
  await dead.text()
})

test('跨机那条路真打一次：本机票从别的地址进来不兑现；设备票从别的地址进来能兑现', async (t) => {
  const { devices } = tempDevices()
  const app = await fakeUpstream()
  const mirror = realMirror(app)
  // 绑到"内网那个地址"上：从它连进去，源地址就不是回环了——真机上的"另一台机器"。
  const lan = reachableAddresses().find((a) => a.kind === 'lan')?.address ?? null
  const p = await boot({ devices, mirror, bindAddresses: lan ? ['127.0.0.1', lan] : ['127.0.0.1'] })
  t.after(() => shutdown(p, app))

  if (!lan || !p.addresses.includes(lan)) {
    t.diagnostic(`这台机器上没有可用的内网地址（lan=${lan}，实际绑上 ${p.addresses.join('/')}），这一条跳过`)
    return
  }

  // ① 本机那一半的票从"另一台机器"打进来：不兑现——它有可能被当成这台电脑自己。
  const ticket = mirror.issueTicket(LOCAL)
  // 这一下走的是"另一台机器"那条路：**给它一个超时**——真机上连不通就不该把测试挂死。
  const res = await fetch(`http://${lan}:${p.port}/mini/mirror/?ticket=${ticket}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(res.status, 403, `从 ${lan} 打进来的本机票必须不兑现（那不是本机）`)
  await res.text()

  // 对照：同一张票从回环再来 → 能兑（说明上面被拒的原因是"不是本机"，不是别的东西）。
  const local = await fetch(`${p.base}/mini/mirror/?ticket=${ticket}`, { redirect: 'manual' })
  assert.equal(local.status, 200, '对照：回环上同一张票照旧能兑现')
  await local.text()

  // ② **跨机那条路真正的形态**：票上写着名册里那台设备，浏览器在"另一台机器"上、
  //    手上只有这张票——这一条必须能兑现（原来就是它被拒）。
  const cred = await registerDevice(p)
  const id = cred.split('.')[0]
  const remote = await fetch(`http://${lan}:${p.port}/mini/mirror/?ticket=${mirror.issueTicket(id)}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(remote.status, 200, `从 ${lan} 打进来、只带票（不带凭据）：必须能兑现`)
  assert.match(cookieValue(remote, WINDOW_COOKIE).split('.')[1], new RegExp(`~${id}$`),
    '签的还是票上那台设备')
  await remote.text()
})

// ---------------------------------------------------------------------------
// ④ 换一个宿主进程：旧会话全失效（这条不能被这一步碰坏）
// ---------------------------------------------------------------------------

test('换一个宿主进程：上个进程签的会话一律不认（哪怕那台设备还在名册里）', async (t) => {
  const { devices } = tempDevices()
  const app = await fakeUpstream()
  const mirror = realMirror(app)
  const first = await boot({ devices, mirror })
  t.after(() => shutdown(first, app))

  await registerDevice(first)
  const opened = await openWindow(first, mirror, null)
  assert.equal(opened.status, 200)
  assert.equal(mirror.windowValid(opened.session), true, '对照：这个进程里认它')

  // "换一个进程" = 把模块重新装一遍（`?process=…` 把缓存岔开，照 test/mirror.test.mjs）：
  // 新的一份模块会重新生成签名密钥，正是宿主重启时发生的事。
  const fresh = await import(`../lib/mirror.js?process=${Date.now()}`)
  const after = fresh.createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
    log: () => {},
  })
  assert.equal(after.windowValid(opened.session), false, '新进程一眼就不认旧会话')

  // 同一个 HTTP 服务口径上再验一遍：**名册里那台设备还在**，所以这里唯一的原因就是签名。
  const second = await boot({ devices, mirror: after })
  t.after(() => second.close())
  const res = await frameCall(second, opened.session)
  assert.equal(res.status, 401, '换了进程，旧窗口会话全失效（"跟着 DSH 重启失效"没被这一步碰坏）')
  await res.text()
})

// ---------------------------------------------------------------------------
// ⑤ 撤销时把窗口那条 WebSocket 也掐掉
// ---------------------------------------------------------------------------

test('撤销时，窗口那条已经握手的 WebSocket 也要断（它靠会话里签着的身份才认得出来）', async (t) => {
  const { devices } = tempDevices()
  const app = await fakeUpstream()
  const mirror = realMirror(app)
  const p = await boot({ devices, mirror })
  t.after(() => shutdown(p, app))

  const cred = await registerDevice(p)
  const id = cred.split('.')[0]
  const opened = await openWindow(p, mirror, cred)
  assert.equal(opened.status, 200)

  // 窗口里那条常驻连接：**只带窗口会话**（不带设备凭据那一枚）。
  const ws = await openWindowWs(p.port, opened.session)
  assert.match(ws.state.line, /^HTTP\/1\.1 101/, `握手要真的成了（上游接了）：${ws.state.line}`)
  assert.equal(ws.state.closed, false, '刚握手完，它当然还活着')

  // 撤销：删记录 + 掐活连接。**这两下真机上都在 `/mini-remote/devices/revoke` 里。**
  assert.equal(devices.remove(id), true)
  const dropped = p.instance.dropDeviceConnections(id)
  assert.equal(dropped, 1,
    '那条 WS 要记在这台设备头上——记不上（第二路没接）的话这里就是 0，撤销就会漏掉一条活连接')

  assert.equal(await ws.waitClosed(), true, '撤销之后，那条已经握手的 WS 必须断')
})

test('撤销只掐它自己那条：别的设备的长连接一根都不许动', async (t) => {
  const { devices } = tempDevices()
  const app = await fakeUpstream()
  const mirror = realMirror(app)
  const p = await boot({ devices, mirror })
  t.after(() => shutdown(p, app))

  const a = await registerDevice(p, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
  const b = await registerDevice(p, 'Mozilla/5.0 (Linux; Android 14)')
  const winA = await openWindow(p, mirror, a)
  const winB = await openWindow(p, mirror, b)
  const wsA = await openWindowWs(p.port, winA.session)
  const wsB = await openWindowWs(p.port, winB.session)
  assert.match(wsA.state.line, /101/)
  assert.match(wsB.state.line, /101/)

  assert.equal(devices.remove(a.split('.')[0]), true)
  assert.equal(p.instance.dropDeviceConnections(a.split('.')[0]), 1)

  assert.equal(await wsA.waitClosed(), true, '被撤销那台的那条要断')
  await sleep(120)
  assert.equal(wsB.state.closed, false, '另一台设备的连接一点不受影响')
  const other = await frameCall(p, winB.session)
  assert.equal(other.status, 200, '另一台设备的窗口照旧能用')
  await other.text()
})

// ---------------------------------------------------------------------------
// ⑥ 不合规的会话一律不认（fail closed 的那几面）
// ---------------------------------------------------------------------------

test('没有身份的会话、身份被改过的会话——一律不认', async (t) => {
  const { devices } = tempDevices()
  const app = await fakeUpstream()
  const mirror = realMirror(app)
  const p = await boot({ devices, mirror })
  t.after(() => shutdown(p, app))

  const mine = await registerDevice(p, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
  const theirs = await registerDevice(p, 'Mozilla/5.0 (Linux; Android 14)')

  // ① 签了名、但**没带身份**的会话（老形状 / 调用方没把身份传进来）：不认。
  //    兑票那一下现在一定从票上读出主人（见 lib/server.js 的 ticketWindowOwner），
  //    所以这种会话只可能是别人的手笔。
  const anon = mirror.redeemTicket(mirror.issueTicket(LOCAL))
  assert.ok(anon?.session)
  assert.equal(mirror.windowValid(anon.session), true, '签名本身是有效的（它本来就是本进程签的）')
  assert.equal(mirror.windowDevice(anon.session), '', '但它没说自己是谁')
  const anonRes = await frameEntry(p, anon.session)
  assert.equal(anonRes.status, 401, '没有身份的会话一律不认')
  await anonRes.text()

  // ② 拿到会话的人**改不了**自己是谁：身份那一节一动，签名当场对不上。
  const opened = await openWindow(p, mirror, mine)
  assert.equal(opened.status, 200)
  const parts = opened.session.split('.')
  const nonce = parts[1].split('~')[0]
  const forged = `${parts[0]}.${nonce}~${theirs.split('.')[0]}.${parts[2]}`
  assert.notEqual(forged, opened.session)
  const forgedRes = await frameEntry(p, forged)
  assert.equal(forgedRes.status, 401, '身份签在签名罩着的那一节里，改了就失效')
  await forgedRes.text()

  // ③ 对照：原样的会话照旧能用（证明上面那两下不是因为别的原因被拒的）。
  const ok = await frameEntry(p, opened.session)
  assert.equal(ok.status, 200)
  await ok.text()
})

// ---------------------------------------------------------------------------
// ⑦ 镜像开关关着时：撤销之后那条路整块不接（仍然是"进不去"）
// ---------------------------------------------------------------------------

test('镜像开关关着时：撤销之后那条路整块不接，照旧进不去（200 之外都不算放行）', async (t) => {
  const { devices } = tempDevices()
  const app = await fakeUpstream()
  const mirror = realMirror(app)
  // 「远程窗口」这条路**不挂那个开关**（票只由本机宿主发得出来），所以关着也能开窗。
  const p = await boot({ devices, mirror, mirrorEnabled: () => false })
  t.after(() => shutdown(p, app))

  const cred = await registerDevice(p)
  const opened = await openWindow(p, mirror, cred)
  assert.equal(opened.status, 200, '开关关着，带票那一下照样开得起来')

  assert.equal(devices.remove(cred.split('.')[0]), true)

  const entry = await frameEntry(p, opened.session)
  assert.equal(entry.status, 404, '开关关着 + 会话已失效 → 那条路此刻根本不存在（一页人话）')
  assert.match(entry.headers.get('content-type') ?? '', /text\/html/)
  assert.match(await entry.text(), /电脑端界面现在打不开/)
  assert.notEqual(entry.status, 200)
})
