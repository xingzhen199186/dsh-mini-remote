/**
 * 跨机第二步 · A 侧：**跨机取票接口 `POST /mini-remote/remote/window`**，
 * 以及它和「配对」共用的那一个总开关（`allowRemoteComputers`，默认关）。
 *
 * 这一步的语义是一句话：**另一台电脑拿自己的设备凭据，来 A 换一张带票的地址**。
 * 下面每一条都盯着"悄悄坏掉也不会有人发现"的那一类：
 *
 *   ① **地址里的 host 必须跟着请求到达的 Host 走**（这一步最容易做错、错了最难查的
 *      一处）：写死 `127.0.0.1` 的话，那条地址在**对面**那台电脑的浏览器里指的是
 *      **它自己**——框会去连对面的本机端口，表现是白屏或者一个莫名其妙的 404，
 *      而 A 这边日志干干净净。这里用**伪造的 Host 请求头**钉住它，并且两个不同的
 *      Host 各来一次（只有一次的话，"回了个常量"也能蒙混过去）。
 *   ② **它必须"外面"也能调**：整族 `/mini-remote/*` 都走 `localOnly`，这一条不能走。
 *      拿**同一个非本机来源**分别打名册那条（403）和这一条（照常受理）做对照——
 *      哪天有人顺手补上一行 `localOnly`，没有对照就看不出来。
 *   ③ **没凭据 → 401**；凭据的三处带法（`X-Mini-Device` 头 / `?device=` / cookie）
 *      都要认，而且都要**真的认得出是哪一台**（认人走 isAuthorized 那一路）。
 *   ④ **名册里删掉那条记录 → 同一枚凭据当场失效**（撤销即失效）。
 *   ⑤ **票的价值只够一次**：拿回地址里的那张票去兑，第一次成、**第二次必定失败**
 *      ——这正是"一次性票"这句话的全部内容。
 *   ⑥ **开关关着：两条跨机路由一条都不接**（配对和取票），而且**配对那条一条记录
 *      都不许留下**。开着之后两条都照常——这一对前后对照就是"开关真的管用"。
 *   ⑦ **限速挂的是手机服务那同一张表**：在手机页上猜错 5 次，这条也一起被挡。
 *   ⑧ **卸载要把这两条一起摘掉**（十二条注册，十二条注销）。
 *
 * 全程用**真的插件**（`lib/index.js` 的 apply）+ 真 HTTP 端口 + 真镜像 + 真名册，
 * 照 test/pair.test.mjs 那份夹具：那几条路由注册在宿主那一半，所以把
 * `webServer.register` 收下来的 handler 挂在一个真的 http 服务上发出去；
 * "非本机来源"用伪造的来源地址（真实的 TCP 连接只能来自本机）。
 *
 * **"另一台电脑"的浏览器怎么进那扇门**：这一步只做 A 侧（B 侧还没有），所以兑票那
 * 一下照 test/window-device.test.mjs 的 `openWindow`：把设备凭据放在 `X-Mini-Device`
 * 请求头上（票地址里不会有凭据）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import { createServer } from 'node:http'

const ROOT_URL = new URL('..', import.meta.url)
const DEVICE_COOKIE = 'dsh_mini_device'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 先占一个端口拿到号再放掉，给被测插件一个确定的监听地址（照 test/pair.test.mjs）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** 一个「像真 cordis 一样挑剔」的假 ctx（照 test/pair.test.mjs 那一份）。 */
function makeCtx(services, directNames, collected = []) {
  return new Proxy(services, {
    get: (target, prop, receiver) => {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      if (prop === 'get') return (name) => target[name]
      if (prop === 'inject') {
        return (names, callback) => {
          const off = callback(makeCtx(target, [...directNames, ...names], collected))
          if (typeof off === 'function') collected.push(off)
        }
      }
      if (directNames.includes(prop)) return Reflect.get(target, prop, receiver)
      if (prop in target) throw new Error(`cannot get property "${prop}" without inject`)
      return Reflect.get(target, prop, receiver)
    },
  })
}

/**
 * 一个「像电脑端界面」的替身：**镜像要指着一个活的上游**。
 *
 * 为什么非要它：兑票那一下成功之后，镜像会把请求转给上游（上游死了就是 502）。
 * 我们要看的是"票兑现成了没有"（拿到了窗口会话 cookie），所以用一个真上游把这条
 * 路走得完整——免得 200 和 502 混在一起、测试说不清自己在断言什么。
 *
 * 形状照 test/window-device.test.mjs：镜像转发前要先拿官方那枚会话 cookie
 * （`?token=…` → 303 + `set-cookie: dsh-auth-…`），之后每个请求都带着它。
 */
async function fakeUpstream() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
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
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><body>电脑端界面</body></html>')
  })
  server.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

/**
 * 起一个真的插件实例 + 真的手机服务，并把宿主那半边（`/mini-remote/*`）挂在
 * 一个真的 http 服务上。真机上外面那层壳是 DSH 的 webServer。
 *
 * `config` 可以预置配置（比如把那个开关先打开）——真机上它就是 settings.json。
 */
async function bootHost(config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mini-remote-window-'))
  process.env.DSH_HOME = home

  const app = await fakeUpstream()
  const port = await freePort()
  const routes = new Map()
  const disposers = []
  const ctx = makeCtx({
    agents: { get: () => undefined, list: () => [] },
    // 镜像转发前要拿官方那枚会话 cookie，靠的就是这个能力（真机上它是 DSH 的
    // connection 服务给的带令牌地址）。少了它，兑票那一下会以 502 收场。
    connection: {
      authenticatedUrl: (base) => `${String(base).replace(/\/+$/, '')}/?token=LAUNCH-TOKEN`,
    },
    webServer: {
      // 镜像的上游就是这块界面（真机上它是 19387 / 3080）。指到替身上，
      // 兑票那一下才能真的走完（见上面 fakeUpstream）。
      port: app.port,
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    on: () => () => {},
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => dispose?.()
    },
    logger: { info: () => {}, warn: () => {} },
  }, ['agents', 'logger', 'on', 'effect'], disposers)

  const mod = await import(new URL(`lib/index.js?t=${Date.now()}`, ROOT_URL).href)
  // `bindAddress: 'auto'`（真机上的默认值，照 test/plugin.test.mjs）：配对信息那条路
  // 在"只绑了本机"时会回 `ok:false`（那是在说"手机没有能连上的地址"），而我们这一条
  // 要的是它正常那份。
  mod.apply(ctx, { port, bindAddress: 'auto', ...config })

  const base = `http://127.0.0.1:${port}`
  const token = readFileSync(join(home, 'dsh-mini-remote', 'token'), 'utf8').trim()
  for (let i = 0; i < 100; i += 1) {
    try {
      await fetch(`${base}/mini/api/state?token=${token}`)
      break
    } catch {
      await sleep(50)
    }
  }

  // 真的 http 服务，只认精确路径——和真机（DSH 的 webServer）同一套口径。
  const hostServer = createServer((req, res) => {
    const path = String(req.url ?? '/').split('?')[0]
    const route = routes.get(path)
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
      return
    }
    Promise.resolve(route.handler(req, res)).catch(() => {
      try { res.writeHead(500); res.end('{}') } catch { /* 已经回过话了 */ }
    })
  })
  hostServer.listen(0, '127.0.0.1')
  await new Promise((resolve) => hostServer.once('listening', resolve))
  const host = `http://127.0.0.1:${hostServer.address().port}`

  return {
    home, base, host, token, routes,
    /** 只跑注销器（"卸载之后路由还挂着吗"这一条要它）。 */
    dispose: () => {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* 清理失败不该盖住真正的测试结果 */ }
      }
    },
    stop: async () => {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* 清理失败不该盖住真正的测试结果 */ }
      }
      await new Promise((resolve) => {
        hostServer.closeAllConnections?.()
        hostServer.close(() => resolve())
      })
      await app.close()
    },
  }
}

/**
 * 名册落盘那几条记录（文件还没生成时算空名册，照 test/pair.test.mjs）。
 */
function records(p) {
  try {
    return JSON.parse(readFileSync(join(p.home, 'dsh-mini-remote', 'devices.json'), 'utf8')).devices
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

/**
 * 一个来源地址是**外面**的请求（照 test/pair.test.mjs 的 fakeReq）。
 *
 * `headers` 可以整个换掉——伪造 Host 就在那里（这一条要用两个不同的 Host 各打一次，
 * 只有一次的话"回了个常量"也能蒙混过去）。
 */
function fakeReq(remoteAddress, {
  method = 'POST',
  url = '/mini-remote/remote/window',
  body = null,
  headers = null,
} = {}) {
  const listeners = new Map()
  const req = {
    method,
    url,
    headers: headers ?? { host: '192.168.1.9:19387', 'content-type': 'application/json' },
    socket: { remoteAddress },
    on(name, fn) {
      listeners.set(name, fn)
      return req
    },
    destroy() {},
  }
  if (body !== null) {
    // 异步喂进去，模拟真实的请求体是分块到达的
    queueMicrotask(() => {
      listeners.get('data')?.(Buffer.from(body, 'utf8'))
      listeners.get('end')?.()
    })
  }
  return req
}

function fakeRes() {
  const out = { status: 0, headers: null, body: '' }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(body) { out.body = body ?? '' },
  }
}

/** 以某个来源地址调一条宿主路由，返回 { status, body, text }。 */
async function callHost(p, path, opts = {}) {
  const route = p.routes.get(path)
  assert.ok(route, `${path} 没注册到宿主上`)
  const res = fakeRes()
  await route.handler(fakeReq(opts.remoteAddress ?? '192.168.1.50', { url: path, ...opts }), res)
  let parsed = null
  try { parsed = JSON.parse(res.out.body) } catch { /* 不是 JSON 就留着 null，由断言去说 */ }
  return { status: res.out.status, body: parsed, text: res.out.body }
}

/** 把那个开关翻转（真机上就是设置页上点一下）。来源地址默认是"本机"。 */
async function setSwitch(p, enabled, remoteAddress = '127.0.0.1') {
  return callHost(p, '/mini-remote/remote-access', {
    remoteAddress, body: JSON.stringify({ enabled }),
  })
}

/** 开开关 + 配一台电脑，返回那枚设备凭据（这是跨机一切的前提）。 */
async function pairOnce(p) {
  const opened = await setSwitch(p, true)
  assert.equal(opened.status, 200, `开关要能在本机打开（回的是 ${opened.status}：${opened.text.slice(0, 300)}）`)
  const r = await callHost(p, '/mini-remote/pair', { body: JSON.stringify({ token: p.token }) })
  assert.equal(r.status, 200, `开关打开之后配对要能用（回的是 ${r.status}：${r.text.slice(0, 300)}）`)
  return r.body.credential
}

/** 以某枚凭据、某个 Host 打一次跨机取票。 */
function askWindow(p, credential, opts = {}) {
  const headers = opts.headers ?? {
    host: (opts.host ?? '192.168.1.9:3090'),
    'content-type': 'application/json',
    ...(credential ? { 'x-mini-device': credential } : {}),
  }
  return callHost(p, '/mini-remote/remote/window', {
    remoteAddress: opts.remoteAddress ?? '192.168.1.50',
    headers,
    body: '{}',
    method: opts.method ?? 'POST',
  })
}

/** 那张带票的地址里，票是哪一串。 */
function ticketOf(url) {
  return new URL(url).searchParams.get('ticket') ?? ''
}

/**
 * 兑票（"另一台电脑的浏览器"进门那一下）。
 *
 * `credential` 给了就走请求头（票地址里不会有凭据，进门这一下由对面那台电脑带着）；
 * 没给就是"只有一张票、什么凭据都没有"的那一下——那正是要验"票是不是一次性"时
 * 该摆出来的样子。
 * `cookie` 给了就带上（iframe 重新加载时浏览器会自动带）。
 * @returns {{status:number, session:string, ticket:string}}
 */
async function redeem(p, url, credential, opts = {}) {
  const headers = { ...(opts.headers ?? {}) }
  if (credential) headers['X-Mini-Device'] = credential
  if (opts.cookie) headers.cookie = opts.cookie
  const res = await fetch(url, { headers, redirect: 'manual' })
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const raw = setCookies.find((one) => one.startsWith('dsh_mini_window=')) ?? ''
  const body = await res.text()
  return {
    status: res.status,
    body,
    ticket: ticketOf(url),
    session: raw ? decodeURIComponent(raw.slice('dsh_mini_window='.length).split(';')[0]) : '',
  }
}

// ---------------------------------------------------------------------------
// ① 这一步最容易做错的地方：地址里的 host 跟着请求到达的 Host 走
// ---------------------------------------------------------------------------

test('⚠️ 回的那个地址：host 就是**请求到达时的 Host**，不是写死的 127.0.0.1', async (t) => {
  const p = await bootHost()
  t.after(p.stop)
  const cred = await pairOnce(p)

  // 两个不同的 Host 各来一次。**只测一次是不够的**：回一个常量也能让那一次过。
  const first = await askWindow(p, cred, { host: '192.168.1.5:3090' })
  assert.equal(first.status, 200, '带对凭据就该给地址')
  assert.equal(first.body.ok, true)
  assert.ok(first.body.url, '要回一条地址')
  assert.equal(new URL(first.body.url).origin, 'http://192.168.1.5:3090',
    '地址里的 host:port 必须就是请求里那个 Host')
  assert.equal(new URL(first.body.url).pathname, '/mini/mirror/', '还是镜像那扇门')
  assert.ok(ticketOf(first.body.url), '地址里要带一张票')

  const second = await askWindow(p, cred, { host: 'a.example.ts.net' })
  assert.equal(second.status, 200)
  assert.equal(new URL(second.body.url).origin, 'http://a.example.ts.net',
    '换一个 Host 来，回的就该跟着换')

  // ★ 这一条是全部意义所在：**任何一次都不许出现 127.0.0.1**
  for (const one of [first, second]) {
    assert.doesNotMatch(one.body.url, /127\.0\.0\.1/,
      '这个地址会交给对面那台电脑的浏览器，127.0.0.1 在那里指的是它自己')
  }

  // Tailscale 那条 https 路上，Host 是域名、协议由转发头告诉我们的。
  const viaHttps = await askWindow(p, cred, {
    headers: { host: 'a.example.ts.net', 'x-forwarded-proto': 'https', 'x-mini-device': cred },
  })
  assert.equal(new URL(viaHttps.body.url).origin, 'https://a.example.ts.net',
    '藏在 https 后面时，协议要跟着 X-Forwarded-Proto 走')
})

test('没带 Host 的请求：明说"说不清地址"，**绝不退回一个写死的本机地址**', async (t) => {
  const p = await bootHost()
  t.after(p.stop)
  const cred = await pairOnce(p)
  const r = await askWindow(p, cred, { headers: { 'content-type': 'application/json', 'x-mini-device': cred } })
  assert.equal(r.status, 400)
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /Host/)
  assert.doesNotMatch(r.text, /127\.0\.0\.1/)
})

// ---------------------------------------------------------------------------
// ② 它必须"外面"也能调（和名册那条做对照）
// ---------------------------------------------------------------------------

test('跨机取票：同一个"外面"的来源，名册那条 403，取票这条照常受理', async (t) => {
  const p = await bootHost()
  t.after(p.stop)
  const cred = await pairOnce(p)

  // 对照：同样是外面那台电脑，名册那条走 localOnly，必须被挡
  const denied = await callHost(p, '/mini-remote/devices', { method: 'GET' })
  assert.equal(denied.status, 403, '名册那几条只允许本机，外面来的必须 403')

  // 取票这条：**不调 localOnly**——外面那台电脑正是它要服务的人
  const ok = await askWindow(p, cred, { host: '192.168.1.5:3090' })
  assert.equal(ok.status, 200, '这一条必须能从外面调，否则跨机根本走不动')
})

// ---------------------------------------------------------------------------
// ③ 凭据：三处带法都认；没有就 401
// ---------------------------------------------------------------------------

test('凭据的三处带法都认：X-Mini-Device 头 / ?device= / cookie', async (t) => {
  const p = await bootHost()
  t.after(p.stop)
  const cred = await pairOnce(p)

  const byHeader = await askWindow(p, cred)
  assert.equal(byHeader.status, 200, '请求头那一路（跨机的主路）')
  assert.ok(byHeader.body.url)

  // 地址里的 ?device=（route.handler 收到的是完整 url，所以这里连查询串一起给）
  const byQuery = await callHost(p, '/mini-remote/remote/window', {
    url: `/mini-remote/remote/window?device=${encodeURIComponent(cred)}`,
    headers: { host: '192.168.1.5:3090', 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(byQuery.status, 200, '?device= 那一路（和手机页同一道门）')

  const byCookie = await callHost(p, '/mini-remote/remote/window', {
    headers: {
      host: '192.168.1.5:3090',
      'content-type': 'application/json',
      cookie: `${DEVICE_COOKIE}=${cred}`,
    },
    body: '{}',
  })
  assert.equal(byCookie.status, 200, 'cookie 那一路')
})

test('没凭据 → 401；凭据是垃圾 → 401；名册里删掉那条记录 → 同一枚凭据当场失效', async (t) => {
  const p = await bootHost()
  t.after(p.stop)
  const cred = await pairOnce(p)

  const none = await askWindow(p, null)
  assert.equal(none.status, 401, '没带凭据就该拒')
  assert.equal(none.body.ok, false)
  assert.doesNotMatch(none.text, /mini\/mirror/, '被拒的时候一个地址都不许漏出去')

  const junk = await askWindow(p, 'f'.repeat(32) + '.' + 'e'.repeat(32))
  assert.equal(junk.status, 401, '形状对但名册里没有的那一枚也不认')

  // ★ 撤销 = 名册里删掉那条记录（真机上 `/mini-remote/devices/revoke` 做的就是这一下）
  const revoked = await callHost(p, '/mini-remote/devices/revoke', {
    remoteAddress: '127.0.0.1', body: JSON.stringify({ id: cred.split('.')[0] }),
  })
  assert.equal(revoked.status, 200)
  assert.deepEqual(records(p), [], '名册落盘那份也删掉了')

  const after = await askWindow(p, cred)
  assert.equal(after.status, 401, '撤销之后同一枚凭据当场失效——不必重启，也没有缓存窗口')
})

// ---------------------------------------------------------------------------
// ④ 票是一次性的：第二次兑必定失败
// ---------------------------------------------------------------------------

test('⚠️ 拿回来的那张票：兑现一次之后**不再认**——第二次兑不出第二枚窗口会话（一次性）', async (t) => {
  const p = await bootHost()
  t.after(p.stop)
  const cred = await pairOnce(p)

  const r = await askWindow(p, cred, { host: `127.0.0.1:${new URL(p.base).port}` })
  assert.equal(r.status, 200)

  // 第一次：票兑现成窗口会话（那枚 cookie 就是后面框里那些请求的凭据）
  const first = await redeem(p, r.body.url, cred)
  assert.equal(first.status, 200, '第一次兑票要成（窗口会话就是这么来的）')
  assert.match(first.session, /^v1\./, '那一下要发下窗口会话 cookie')

  // 第二次：同一张票，**什么都不带**（一个没有窗口会话的浏览器再敲一次这条地址）。
  // 票已经烧掉了，只剩"这一页是我嵌出来的"那个取景标记——所以过不去。
  const second = await redeem(p, r.body.url, null)
  assert.equal(second.status, 401, '同一张票兑第二次必须失败——"一次性"就是这一条')
  assert.equal(second.session, '', '失败的那一下不许再发窗口会话')

  // 第三次：带上第一次拿到的那枚会话（iframe 重新加载就是这样的）。这一下**能开**，
  // 但靠的是那枚会话，不是票——所以**不许再发一枚新的会话**（票没有第二次价值）。
  const third = await redeem(p, r.body.url, null, { cookie: `dsh_mini_window=${first.session}` })
  assert.equal(third.status, 200, '带着上一次的窗口会话进来，页面照旧能开（iframe 重载那条路）')
  assert.equal(third.session, '', '⚠️ 票只值一次：第三次那一下不许再发第二枚窗口会话')
})

// ---------------------------------------------------------------------------
// ⑤ 那个总开关（默认关）：两条跨机路由一条都不接
// ---------------------------------------------------------------------------

test('⚠️ 开关**默认关**：什么都不做的时候，配对和取票两条都不接', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  // 开关就是默认值，谁都没碰过
  const paying = await callHost(p, '/mini-remote/pairing', { method: 'GET', remoteAddress: '127.0.0.1' })
  assert.equal(paying.status, 200)
  assert.equal(paying.body.remote.allowed, false, '新装好就该是关着的，不许自动打开')

  const pair = await callHost(p, '/mini-remote/pair', { body: JSON.stringify({ token: p.token }) })
  assert.equal(pair.status, 403, '关着时配对也不受理——"关"是一个整体状态')
  assert.equal(pair.body.ok, false)
  assert.match(pair.body.error, /允许别的电脑连接/)
  assert.deepEqual(records(p), [], '被开关挡住的那一次，名册上一条都不许留下')

  const win = await askWindow(p, 'a'.repeat(32) + '.' + 'b'.repeat(32))
  assert.equal(win.status, 403, '关着时取票这条同样一条都不接')
  assert.equal(win.body.ok, false)
  assert.doesNotMatch(win.text, /mini\/mirror/)
})

test('开关打开之后：两条都照常（**前后对照**，证明被拒的原因就是它）', async (t) => {
  const p = await bootHost()
  t.after(p.stop)
  const cred = await pairOnce(p)
  assert.equal(records(p).length, 1, '配对成功该留下一条 desktop')

  const win = await askWindow(p, cred, { host: '192.168.1.5:3090' })
  assert.equal(win.status, 200, '同一台电脑、同一枚凭据，开关一开就通')
  assert.ok(win.body.url)

  // 再关回去：立刻又不接了（而且是**已经配好的那台电脑，也一起不接**）
  const closed = await setSwitch(p, false)
  assert.equal(closed.status, 200)
  assert.equal(closed.body.remote.allowed, false)
  const again = await askWindow(p, cred)
  assert.equal(again.status, 403, '关掉之后，已经配对过的电脑也进不来')
})

test('开关那条路由只允许本机（和公网开关同一条规矩）', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  // 同一个 Wi-Fi 下的别人来点这个开关：必须挡住——许不许别的电脑连过来，
  // 不能让"别人"替你做主。
  const denied = await setSwitch(p, true, '192.168.1.50')
  assert.equal(denied.status, 403)
  assert.match(denied.body.error, /只能在这台电脑上看/)

  // 挡下了就是真没改成：本机这一读还是关着
  const paying = await callHost(p, '/mini-remote/pairing', { method: 'GET', remoteAddress: '127.0.0.1' })
  assert.equal(paying.body.remote.allowed, false)
})

test('开关打开/关闭都会落到 settings.json（重启之后还是用户选的那一个）', async (t) => {
  const p = await bootHost()
  t.after(p.stop)
  await setSwitch(p, true)
  const saved = JSON.parse(readFileSync(join(p.home, 'dsh-mini-remote', 'settings.json'), 'utf8'))
  assert.equal(saved.allowRemoteComputers, true)
  await setSwitch(p, false)
  const back = JSON.parse(readFileSync(join(p.home, 'dsh-mini-remote', 'settings.json'), 'utf8'))
  assert.equal(back.allowRemoteComputers, false)
})

test('方法不对：GET 一律 405，不发票', async (t) => {
  const p = await bootHost()
  t.after(p.stop)
  const cred = await pairOnce(p)
  const r = await askWindow(p, cred, { method: 'GET' })
  assert.equal(r.status, 405)
  assert.doesNotMatch(r.text, /mini\/mirror/)
})

// ---------------------------------------------------------------------------
// ⑥ 限速：挂的是手机服务那同一张表
// ---------------------------------------------------------------------------

test('限速：和手机服务共用同一张表——在手机页上猜错，取票这条路也一起被挡', async (t) => {
  const p = await bootHost()
  t.after(p.stop)
  const cred = await pairOnce(p)

  // 从"本机这个来源"往手机页上猜错 5 次口令（真 HTTP，来源就是 127.0.0.1）
  for (let i = 1; i <= 5; i += 1) {
    const bad = await fetch(`${p.base}/mini?token=${'bad'.repeat(8)}`)
    assert.equal(bad.status, 200, '门禁页本身是 200（页面上说口令不对）')
    await bad.text()
  }
  const blocked = await callHost(p, '/mini-remote/remote/window', {
    remoteAddress: '127.0.0.1',
    headers: { host: '192.168.1.5:3090', 'content-type': 'application/json', 'x-mini-device': cred },
    body: '{}',
  })
  assert.equal(blocked.status, 429,
    '同一个来源刚在手机页上猜错 5 次，取票这条路必须一起挡——两套各数各的等于给两份额度')
})

// ---------------------------------------------------------------------------
// ⑦ 卸载要把这两条一起摘掉
// ---------------------------------------------------------------------------

test('卸载之后跨机这两条路由都摘干净（十二条注册，十二条注销）', async (t) => {
  const p = await bootHost()
  t.after(p.stop)
  assert.ok(p.routes.get('/mini-remote/remote/window'), '得先挂着')
  assert.ok(p.routes.get('/mini-remote/remote-access'), '开关那条也得挂着')
  p.dispose()
  assert.equal(p.routes.size, 0, '卸载之后一条都不该还挂在服务器上')
})
