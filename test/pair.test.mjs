/**
 * 跨机第一步 · A 侧：**名册认 `desktop` + 配对接口 `POST /mini-remote/pair`**。
 *
 * 这一步的全部意义是一句话：**另一台电脑拿 A 的口令，给自己换一枚设备凭据**。所以这里
 * 每一条都盯着"悄悄坏掉也不会有人发现"的那一类：
 *
 *   ① **它必须"外面"也能调**（这一步最容易做错的地方）：整族 `/mini-remote/*` 都走
 *      `localOnly`，而配对不能走。所以拿**同一个非本机来源**分别打两条路做对照：
 *      名册那条 403、配对这条照常受理。只测配对能通、不测对照，等于没测——
 *      哪天有人顺手给新 handler 补上一行 `localOnly`，没有对照就看不出来。
 *   ② **口令对 → 真的发一枚凭据**：形状 `<32hex>.<32hex>`，名册多一条 `kind:'desktop'`，
 *      而且这枚凭据**真的进得了手机服务的门**（形状对但进不去，等于发了张废纸）。
 *   ③ **口令错 → 401，名册一条都不长**。
 *   ④ **限速真的生效**：同一来源错 5 次，第 6 次当场 429；**封禁期间连对的口令也是 429**
 *      （否则限速形同虚设）。挂的是手机服务那同一套（见 lib/server.js 的 rateLimit）。
 *   ⑤ **口令不是一次性的**：连配两台都能成——用户可以配多台电脑。
 *   ⑥ **回给对面的只有凭据**：响应的字段集合钉死，keyHash 一个字节都不出去。
 *   ⑦ **口令只从请求体收**：地址里带 `?token=` 不算数（跨机的路上不止一台机器）。
 *
 * 全程用**真的插件**（`lib/index.js` 的 apply）+ 真 HTTP 端口，照 test/device-manage.test.mjs
 * 那份夹具：那几条路由注册在宿主那一半，所以把 `webServer.register` 收下来的 handler
 * 挂在一个真的 http 服务上发出去；"非本机来源"用 test/plugin.test.mjs 那套 fakeReq 伪造
 * （真实的 TCP 连接只能来自本机，伪造来源地址是唯一能验到这道门的方法）。
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

/** 先占一个端口拿到号再放掉，给被测插件一个确定的监听地址（照 test/device-manage.test.mjs）。 */
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

/** 一个「像真 cordis 一样挑剔」的假 ctx（照 test/device-manage.test.mjs 那一份）。 */
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
 * 起一个真的插件实例 + 真的手机服务，并把宿主那半边（`/mini-remote/*`）挂在
 * 一个真的 http 服务上。真机上外面那层壳是 DSH 的 webServer。
 */
async function bootHost() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mini-pair-'))
  process.env.DSH_HOME = home

  const port = await freePort()
  const routes = new Map()
  const disposers = []
  const ctx = makeCtx({
    agents: { get: () => undefined, list: () => [] },
    webServer: {
      port: 19387,
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
  // **先把这个开关打开**（2026-10-16 第二步起，配对归它管）：关着的时候配对也一律
  // 不接——那是一个用户能读懂的整体状态（"这台电脑不接受别的电脑连过来"）。
  // 这个文件的每一条讲的都是"开关开着时配对自己那套规矩"，所以夹具里先打开；
  // **"默认关 + 关着时两条都不接"由 test/remote-window.test.mjs 钉着**。
  mod.apply(ctx, { port, bindAddress: '127.0.0.1', allowRemoteComputers: true })

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
    },
  }
}

/**
 * 名册落盘那几条记录。
 *
 * **一条都没登记过时这个文件根本不在**（devices.js 只在第一次 save 时建它）——那不是失败，
 * 是"名册空着"。文件在、但读不出来，才是真出事了，照抛。
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
 * 一个来源地址是**外面**的请求（照 test/plugin.test.mjs 的 fakeReq/fakeRes）。
 *
 * 真实的 TCP 连接只能来自本机，而"配对要能从外面调"正是这一步的验收点，所以来源地址
 * 只能伪造——这也让"同一个来源打名册那条会被挡"这个对照变得可以逐字对齐。
 */
function fakeReq(remoteAddress, { method = 'POST', url = '/mini-remote/pair', body = null } = {}) {
  const listeners = new Map()
  const req = {
    method,
    url,
    headers: { host: '192.168.1.9:19387', 'content-type': 'application/json' },
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
async function callHost(p, path, { method = 'POST', body = null, remoteAddress = '192.168.1.50' } = {}) {
  const route = p.routes.get(path)
  assert.ok(route, `${path} 没注册到宿主上`)
  const res = fakeRes()
  await route.handler(fakeReq(remoteAddress, { method, url: path, body }), res)
  let parsed = null
  try { parsed = JSON.parse(res.out.body) } catch { /* 不是 JSON 就留着 null，由断言去说 */ }
  return { status: res.out.status, body: parsed, text: res.out.body }
}

/** 打一次配对（口令走请求体）。 */
function pairWith(p, token, remoteAddress = '192.168.1.50') {
  return callHost(p, '/mini-remote/pair', {
    body: JSON.stringify({ token }), remoteAddress,
  })
}

// ---------------------------------------------------------------------------
// ① 这一步最容易做错的地方：它必须**外面也能调**，而名册那几条照旧只允许本机
// ---------------------------------------------------------------------------

test('配对：同一个"外面"的来源，名册那条 403，配对这条照常受理', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  // 对照：同样是外面那台电脑，名册那条走 localOnly，必须被挡（不然这个"绕开"就没意义）
  const denied = await callHost(p, '/mini-remote/devices', { method: 'GET' })
  assert.equal(denied.status, 403, '名册那几条只允许本机，外面来的必须 403')
  assert.match(denied.body.error, /只能在这台电脑上看/)

  // 配对这条：**不调 localOnly**——外面那台电脑正是它要服务的人
  const ok = await pairWith(p, p.token)
  assert.equal(ok.status, 200, '配对必须能从外面调，否则跨机第一步根本走不动')
  assert.equal(ok.body.ok, true)
})

test('配对：本机来源照旧能用（不调 localOnly 不等于只认外面）', async (t) => {
  const p = await bootHost()
  t.after(p.stop)
  const ok = await callHost(p, '/mini-remote/pair', {
    body: JSON.stringify({ token: p.token }), remoteAddress: '127.0.0.1',
  })
  assert.equal(ok.status, 200)
})

// ---------------------------------------------------------------------------
// ② 口令对：一枚真凭据 + 名册多一条 desktop
// ---------------------------------------------------------------------------

test('口令对：回一枚真凭据、名册多一条 kind:"desktop"，且这枚凭据真的进得了门', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  const r = await pairWith(p, p.token)
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  const cred = r.body.credential
  assert.match(cred, /^[0-9a-f]{32}\.[0-9a-f]{32}$/, '凭据的形状要和现有的一样：id.密钥')

  // 名册：多了一条，而且是 desktop
  const list = records(p)
  assert.equal(list.length, 1, '配对成功该在名册上留下一条')
  assert.equal(list[0].kind, 'desktop', '来配对的是另一台电脑')
  assert.equal(list[0].id, cred.split('.')[0], '凭据里那个 id 就是名册上这条')

  // **凭据要真能用**：拿它进手机服务的门（不是只有形状对）
  const used = await fetch(`${p.base}/mini/api/state`, {
    headers: { cookie: `${DEVICE_COOKIE}=${cred}` },
  })
  assert.equal(used.status, 200, '换回来的凭据必须真的能进门，否则等于发了张废纸')
  await used.text()

  // **回给对面的只有凭据**：keyHash 一个字节都不许出去
  assert.ok(!r.text.includes(list[0].keyHash), 'keyHash 绝不能出去')
  assert.deepEqual(Object.keys(r.body).sort(), ['credential', 'ok'],
    '回给调用方的字段就这两个——多一个就多一处泄漏面')
})

// ---------------------------------------------------------------------------
// ③ 口令错：401，名册一条都不长
// ---------------------------------------------------------------------------

test('口令错：401、一句人话，名册一条都不长', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  const bad = await pairWith(p, 'x'.repeat(24))
  assert.equal(bad.status, 401, '口令不对就该拒')
  assert.equal(bad.body.ok, false)
  assert.match(bad.body.error, /口令不对/)
  assert.equal(records(p).length, 0, '没配成就不该在名册上留下任何东西')

  // 空口令、压根不带 token、token 不是字符串：一律当错，不许有"漏一条就能进"的形状
  for (const body of ['{}', '{"token":""}', '{"token":123}', 'null']) {
    const r = await callHost(p, '/mini-remote/pair', { body, remoteAddress: '10.0.0.7' })
    assert.equal(r.status, 401, `${body} 也该被拒`)
  }
  assert.equal(records(p).length, 0)
})

// ---------------------------------------------------------------------------
// ④ 限速：挂的是手机服务那同一套
// ---------------------------------------------------------------------------

test('限速：同一来源错 5 次就挡住，**封禁期间对的口令也是 429**', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  for (let i = 1; i <= 5; i += 1) {
    const bad = await pairWith(p, 'bad'.repeat(8))
    assert.equal(bad.status, 401, `第 ${i} 次错口令是 401（还没有到封顶那一下）`)
  }
  const blocked = await pairWith(p, p.token)
  assert.equal(blocked.status, 429, '第 6 次必须被挡住——限速要真的生效')
  assert.equal(records(p).length, 0, '被封的来源一次都没配成')

  // 另一个来源不受影响：挡的是"猜的那个人"，不是把门整个关上
  const other = await pairWith(p, p.token, '192.168.1.77')
  assert.equal(other.status, 200, '别的电脑不该被连坐')
  assert.equal(records(p).length, 1)
})

test('限速：和手机服务共用同一张表——在手机页上猜错，配对这条路也一起被挡', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  // 从"本机这个来源"往手机页上猜错 5 次口令（真 HTTP，来源就是 127.0.0.1）
  for (let i = 1; i <= 5; i += 1) {
    const bad = await fetch(`${p.base}/mini?token=${'bad'.repeat(8)}`)
    assert.equal(bad.status, 200, '门禁页本身是 200（页面上说口令不对）')
    await bad.text()
  }
  const blocked = await callHost(p, '/mini-remote/pair', {
    body: JSON.stringify({ token: p.token }), remoteAddress: '127.0.0.1',
  })
  assert.equal(blocked.status, 429,
    '同一个来源刚在手机页上猜错 5 次，配对这条路必须一起挡——两套各数各的等于给两份额度')
})

// ---------------------------------------------------------------------------
// ⑤ 口令不是一次性的
// ---------------------------------------------------------------------------

test('口令**不是一次性的**：连配两台都能成（用户可以配多台电脑）', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  const first = await pairWith(p, p.token)
  const second = await pairWith(p, p.token, '192.168.1.66')
  assert.equal(first.status, 200)
  assert.equal(second.status, 200, '同一枚口令要能配第二台——一次性的东西是"票"，不是口令')
  assert.notEqual(first.body.credential, second.body.credential, '每台电脑各拿一枚自己的凭据')

  const list = records(p)
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((d) => d.kind), ['desktop', 'desktop'])
  // 两枚都要真能用
  for (const cred of [first.body.credential, second.body.credential]) {
    const used = await fetch(`${p.base}/mini/api/state`, {
      headers: { cookie: `${DEVICE_COOKIE}=${cred}` },
    })
    assert.equal(used.status, 200)
    await used.text()
  }
})

// ---------------------------------------------------------------------------
// ⑥ 口令只从请求体收；方法不对就 405
// ---------------------------------------------------------------------------

test('口令只从请求体收：地址里带 ?token= 不算数（跨机的路上不止一台机器）', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  const inUrl = await callHost(p, '/mini-remote/pair', {
    body: '{}', remoteAddress: '192.168.1.88',
  })
  assert.equal(inUrl.status, 401, '空请求体就是没给口令')
  assert.equal(records(p).length, 0)

  // 真机口径：真发一次带 ?token= 的 POST（这一条只能从本机发，来源不影响结论）
  const res = await fetch(`${p.host}/mini-remote/pair?token=${encodeURIComponent(p.token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(res.status, 401, '口令写在地址里不算数——它是给日志和历史看的')
  await res.text()
  assert.equal(records(p).length, 0)
})

test('方法不对：GET 一律 405，不碰名册', async (t) => {
  const p = await bootHost()
  t.after(p.stop)
  const r = await callHost(p, '/mini-remote/pair', { method: 'GET' })
  assert.equal(r.status, 405)
  assert.equal(records(p).length, 0)
})

// ---------------------------------------------------------------------------
// ⑦ 卸载要把这条也注销掉（漏一笔 = 卸载后还挂着一条指向死闭包的路）
// ---------------------------------------------------------------------------

test('卸载之后配对这条路由也摘干净（十条注册，十条注销）', async (t) => {
  const p = await bootHost()
  t.after(p.stop)
  assert.ok(p.routes.get('/mini-remote/pair'), '得先挂着')
  p.dispose()
  assert.equal(p.routes.size, 0, '卸载之后一条都不该还挂在服务器上')
})
