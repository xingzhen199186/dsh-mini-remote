/**
 * 「设备身份」第三步：**电脑端那张设备列表 —— 列出 / 改名 / 撤销**。
 *
 * 这一份测的是用户拍板的第二步之后那几件事，每一件都有一条"悄悄坏掉也不会有人发现"
 * 的路：
 *
 *   ① **列出**：名字、类型、创建时间、最近使用时间都在，而**密钥的哈希一个字节都不出去**；
 *   ② **改名**：名字只是标签——改完那台设备照旧进得来，列表上换的是名字；
 *   ③ **撤销**：删掉记录 = 那台设备当场 401，别的设备一点不受影响；
 *   ④ **撤销要主动切断活连接**（这一步的重点）：SSE 是服务端单向推的，只靠"下次请求
 *      被拒"，用户看到的是"撤销了但那台手机照旧在动"——于是以为撤销没生效。
 *      所以这里真的连上一条 SSE，撤销之后**那条流必须当场读完（EOF）**；
 *   ⑤ **撤销之后重开手机页 → 回到门禁页，并且看到那句人话**（"这台设备的授权已被移除"）。
 *      **别人（没进过门的新浏览器）不许看到这句**——他被撤销和他第一次来是两回事；
 *   ⑥ **lastSeen 的节流**：请求照旧更新内存里那个数，但**最多每分钟写一次盘**
 *      （崩溃时丢的就是这一分钟）。
 *
 * 全程用**真的插件**（`lib/index.js` 的 apply）+ 真的 HTTP 端口：那三条路由注册在
 * 宿主那一半，所以这里把 `webServer.register` 收下来的路由**挂在一个真的 http 服务上**
 * 发出去——走的还是那三个 handler 本体，只是外面的壳换成测试自己的（真机上那层壳是
 * DSH 的 web 服务）。
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

/** 先占一个端口拿到号再放掉，给被测插件一个确定的监听地址（照 test/plugin.test.mjs）。 */
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

/**
 * 一个「像真 cordis 一样挑剔」的假 ctx（照抄 test/plugin.test.mjs 那一份）。
 *
 * 真机上只有写进插件 inject 的服务名才能当属性直接读，别的服务名一读就抛。这里照抄
 * 这条纪律：漏 inject 的代码在测试里就先挂掉，而不是安静地拿到 undefined。
 */
function makeCtx(services, directNames, collected = []) {
  return new Proxy(services, {
    get: (target, prop, receiver) => {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      if (prop === 'get') return (name) => target[name]
      if (prop === 'inject') {
        // **回调的返回值要收下**：真机上 `ctx.inject(names, cb)` 把 cb 返回的那个函数
        // 当注销器（插件就是靠它把注册过的路由摘干净的）。不收的话，"卸载之后路由还
        // 挂不挂着"这件事在测试里根本验不到——而那正是漏一笔最要命的地方。
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
 * 起一个真的插件实例，并把宿主那三条 `/mini-remote/devices*` 路由挂在一个真的 http
 * 服务上发出去（真机上这层壳是 DSH 的 webServer）。
 *
 * 返回里有三样：
 *   · `base`    —— 手机服务（`/mini...` 那一族，走真的 createMiniServer）；
 *   · `host`    —— 宿主路由那几条（`/mini-remote/devices*`），走 lib/index.js 里的真 handler；
 *   · `stop()`  —— 关掉所有东西。
 */
async function bootHost() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mini-devmanage-'))
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
  mod.apply(ctx, { port, bindAddress: '127.0.0.1' })

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

  // 宿主那半边：把 register 收下来的 handler 挂出去（只认精确路径，和真机同一套口径）。
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
    home, base, host, token, routes, mod,
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

/** 这次响应写下的设备凭据（没发就是空串）。 */
function credentialFrom(res) {
  const all = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [String(res.headers.get('set-cookie') ?? '')]
  const head = `${DEVICE_COOKIE}=`
  for (const one of all.filter(Boolean)) {
    if (!one.startsWith(head)) continue
    return decodeURIComponent(one.slice(head.length).split(';')[0])
  }
  return ''
}

/**
 * 打开一次手机页 = 登记一台新设备（登记点只有这一个，见 lib/server.js）。
 * 返回它的凭据。
 */
async function openPhonePage(p, ua) {
  const res = await fetch(`${p.base}/mini?token=${encodeURIComponent(p.token)}`, {
    headers: ua ? { 'user-agent': ua } : {},
  })
  assert.equal(res.status, 200)
  const cred = credentialFrom(res)
  assert.ok(cred, '打开手机页那一下要发下设备凭据')
  await res.text()
  return cred
}

/** 名册落盘那几条记录。 */
function records(p) {
  return JSON.parse(readFileSync(join(p.home, 'dsh-mini-remote', 'devices.json'), 'utf8')).devices
}

/** 走宿主那条路由（这几条只允许本机，所以只能从这台机器上打）。 */
async function hostJson(p, path, init) {
  const res = await fetch(`${p.host}${path}`, init)
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 不是 JSON 就留着 null，由断言去说 */ }
  return { status: res.status, body, text }
}

/** 列一次名单（**不经过服务器之外的任何地方**——它就是设置页要的那份数据）。 */
async function listDevices(p) {
  const r = await hostJson(p, '/mini-remote/devices')
  assert.equal(r.status, 200)
  assert.equal(r.body?.ok, true)
  assert.ok(Array.isArray(r.body.devices))
  return r
}

/**
 * 盯着一条已经连上的 SSE：服务端收流时它当场读完（`done: true`）。
 *
 * 这正是「撤销真的掐断了它」看得见的那个信号——不是"下一次请求被拒"。
 */
function watchClose(res) {
  const reader = res.body.getReader()
  const state = { closed: false, chunks: 0 }
  ;(async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) state.chunks += 1
    }
    state.closed = true
  })().catch(() => { state.closed = true })
  return state
}

async function waitClosed(state, ms = 3000) {
  const deadline = Date.now() + ms
  while (!state.closed && Date.now() < deadline) await sleep(10)
  return state.closed
}

/** 用某台设备的凭据连一条 SSE，并等到它真的连上（收到第一帧）。 */
async function openStream(p, cred) {
  const res = await fetch(`${p.base}/mini/api/stream`, {
    headers: { cookie: `${DEVICE_COOKIE}=${cred}` },
  })
  assert.equal(res.status, 200, '设备凭据要能从这道门进来')
  const watched = watchClose(res)
  for (let i = 0; i < 100 && watched.chunks === 0; i += 1) await sleep(10)
  assert.ok(watched.chunks > 0, 'SSE 要先真的连上（收到第一帧）才有资格谈"它被掐断了"')
  return watched
}

// ---------------------------------------------------------------------------
// ① 列出：该有的都在，不该出去的**一个字节都不出去**
// ---------------------------------------------------------------------------

test('设备名单：名字/类型/创建时间/最近使用都在，keyHash 和凭据一个字都不出去', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  const a = await openPhonePage(p, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
  const b = await openPhonePage(p, 'Mozilla/5.0 (Linux; Android 14)')

  const r = await listDevices(p)
  assert.equal(r.body.devices.length, 2)
  for (const one of r.body.devices) {
    assert.match(one.id, /^[0-9a-f]{32}$/, 'id 是那 128 位随机数的十六进制')
    assert.equal(one.kind, 'phone', '这一步只登记手机')
    assert.ok(one.name, '每台设备都有名字（默认名从设备类型推）')
    assert.ok(one.createdAt > 0, '创建时间要在')
    assert.ok(one.lastSeen > 0, '刚扫过码的设备要显示"用过"，而不是"从未使用"')
    assert.equal(one.keyHash, undefined, '密钥的哈希不许出现在接口里')
  }
  // 名字来自设备类型（**只是标签**，认人从不看它）。
  const names = r.body.devices.map((d) => d.name).sort()
  assert.deepEqual(names, ['Android', 'iOS'])

  // 整个响应正文里：既没有 keyHash 这个名字，也没有任何一枚真实凭据（连密钥那半截都不行）。
  assert.ok(!r.text.includes('keyHash'), '响应里不许出现 keyHash')
  for (const cred of [a, b]) {
    assert.ok(!r.text.includes(cred), '凭据本身更不许出去')
    assert.ok(!r.text.includes(cred.split('.')[1]), '密钥明文一个字节都不许出去')
  }

  // 落盘那份里**有**哈希（认人靠它），而且没有密钥明文——和接口那份正好相反。
  const disk = records(p)
  assert.equal(disk.length, 2)
  for (const one of disk) assert.match(one.keyHash, /^[0-9a-f]{64}$/)
  assert.ok(!readFileSync(join(p.home, 'dsh-mini-remote', 'devices.json'), 'utf8').includes(a.split('.')[1]))
})

test('设备名单：只接受 GET，别的动作用 405 说清（这几条只允许本机，和别的 /mini-remote/* 同一条规矩）', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  const bad = await hostJson(p, '/mini-remote/devices', { method: 'POST', body: '{}' })
  assert.equal(bad.status, 405)
  assert.match(bad.body.error, /只接受 GET/)

  // 三条都注册上了、而且**卸载时会注销**（否则插件重载之后挂着的是死闭包）。
  // 只断言"这三条在"，不去数总数：这一族里还有配对/隧道/改密码那几条，
  // 数总数的话每加一条路由都要来改这里一次（那正是最容易改漏的地方）。
  for (const path of ['/mini-remote/devices', '/mini-remote/devices/rename', '/mini-remote/devices/revoke']) {
    assert.ok(p.routes.has(path), `${path} 要注册上`)
  }
  const mod = p.mod
  assert.equal(typeof mod.apply, 'function', 'apply 还在（这个假 ctx 只够验路由那一层）')

  // 卸载：三条都要跟着注销（每加一条 register 就得在 return() 里补一笔，漏掉的那条
  // 会指向一个已经死掉的闭包——再有人打过来就是莫名其妙的报错）。
  await p.stop()
  assert.equal(p.routes.size, 0, '卸载之后这三条不该还挂在服务器上')
})

// ---------------------------------------------------------------------------
// ② 改名：名字只是标签
// ---------------------------------------------------------------------------

test('改名：列表上换名字，而那台设备照旧进得来（名字不影响认人）', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  const cred = await openPhonePage(p, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
  const before = (await listDevices(p)).body.devices[0]
  assert.equal(before.name, 'iOS')

  const renamed = await hostJson(p, '/mini-remote/devices/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: before.id, name: '  妈妈那台  ' }),
  })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body.ok, true)
  assert.equal(renamed.body.device.name, '妈妈那台', '两头的空格要剪掉')

  // **改完再列一次**：屏幕上那份必须来自服务端，而不是我们以为改成了什么。
  const after = (await listDevices(p)).body.devices[0]
  assert.equal(after.name, '妈妈那台')
  assert.equal(after.id, before.id)
  assert.equal(after.createdAt, before.createdAt, '改名不该动别的字段')
  assert.equal(records(p)[0].name, '妈妈那台', '落盘的也是新名字')

  // 改名**不影响认人**：同一枚凭据照旧过门，别的一台都没多出来。
  const still = await fetch(`${p.base}/mini/api/state`, {
    headers: { cookie: `${DEVICE_COOKIE}=${cred}` },
  })
  assert.equal(still.status, 200, '名字只是标签，改了照旧认人')
  await still.text()
  assert.equal((await listDevices(p)).body.devices.length, 1)
})

test('改名：空名字、超长名字、找不到的 id 各自 400，而且都说人话', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  await openPhonePage(p, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
  const id = (await listDevices(p)).body.devices[0].id

  const post = (body) => hostJson(p, '/mini-remote/devices/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  const empty = await post({ id, name: '   ' })
  assert.equal(empty.status, 400)
  assert.match(empty.body.error, /名字不能是空的/)

  const long = await post({ id, name: '很长'.repeat(30) })
  assert.equal(long.status, 400)
  assert.match(long.body.error, /最多 40 个字/)

  const missing = await post({ id: 'f'.repeat(32), name: '有人吗' })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /不在名册里/)

  // 三次失败之后名字一个字都没动（校验失败不许留下半次改动）。
  assert.equal((await listDevices(p)).body.devices[0].name, 'iOS')
})

// ---------------------------------------------------------------------------
// ③④ 撤销：当场失效 + **当场掐线**
// ---------------------------------------------------------------------------

test('撤销：那台设备当场 401、它的 SSE 当场断开；**别的设备一点都不受影响**', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  const doomed = await openPhonePage(p, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
  const keeper = await openPhonePage(p, 'Mozilla/5.0 (Linux; Android 14)')
  const list = (await listDevices(p)).body.devices
  const doomedId = list.find((d) => d.name === 'iOS').id
  const keeperId = list.find((d) => d.name === 'Android').id

  // 两台都先连上活连接（手机页上那条就是它）。
  const doomedStream = await openStream(p, doomed)
  const keeperStream = await openStream(p, keeper)
  assert.equal(doomedStream.closed, false)

  const revoked = await hostJson(p, '/mini-remote/devices/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: doomedId }),
  })
  assert.equal(revoked.status, 200)
  assert.equal(revoked.body.ok, true)
  assert.equal(revoked.body.id, doomedId)
  assert.ok(revoked.body.dropped >= 1, `撤销要真的掐掉点什么，实际掐了 ${revoked.body.dropped} 条`)

  // ①**活连接当场断**（这一步的核心）：不是"下次请求被拒"，是这条流现在就读完了。
  assert.equal(await waitClosed(doomedStream), true, '撤销之后它那条 SSE 必须当场 EOF')
  // ②当场失效：同一枚凭据的下一次请求 401。
  const after = await fetch(`${p.base}/mini/api/state`, {
    headers: { cookie: `${DEVICE_COOKIE}=${doomed}` },
  })
  assert.equal(after.status, 401, '删掉记录 = 那台设备当场什么都做不了')
  await after.text()

  // ③**别的设备一点都不受影响**：它的流还开着，它的请求还是 200。
  assert.equal(keeperStream.closed, false, '撤销一台不该顺手把别人的流也断了')
  const keeperOk = await fetch(`${p.base}/mini/api/state`, {
    headers: { cookie: `${DEVICE_COOKIE}=${keeper}` },
  })
  assert.equal(keeperOk.status, 200)
  await keeperOk.text()

  // ④名册里只剩一台，而且落盘那份也真的少了那条记录。
  const rest = (await listDevices(p)).body.devices
  assert.equal(rest.length, 1)
  assert.equal(rest[0].id, keeperId)
  assert.equal(records(p).length, 1)

  // ⑤撤销一台已经不在名册里的：说清"它已经不在名册里了"，别假装成功。
  const again = await hostJson(p, '/mini-remote/devices/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: doomedId }),
  })
  assert.equal(again.status, 404)
  assert.match(again.body.error, /不在名册里/)
})

// ---------------------------------------------------------------------------
// ⑤ 撤销之后：那台手机看到门禁页，并且看懂发生了什么
// ---------------------------------------------------------------------------

test('撤销之后重开手机页 → 回门禁页，并且看到"授权已被移除"；**没进过门的人不许看到这句**', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  const cred = await openPhonePage(p, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
  const id = (await listDevices(p)).body.devices[0].id

  // 撤销之前：它看到的是正常页面。
  const before = await fetch(`${p.base}/mini`, { headers: { cookie: `${DEVICE_COOKIE}=${cred}` } })
  const beforeHtml = await before.text()
  assert.ok(beforeHtml.includes('var NEEDS_TOKEN = false;'), '撤销之前它进得来')
  assert.ok(beforeHtml.includes('var DEVICE_REVOKED = false;'), '撤销之前不该有那句话')

  await hostJson(p, '/mini-remote/devices/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  })

  // 撤销之后重开：回到门禁页，并且**看懂发生了什么、下一步做什么**。
  const after = await fetch(`${p.base}/mini`, { headers: { cookie: `${DEVICE_COOKIE}=${cred}` } })
  assert.equal(after.status, 200, '门禁页仍然是 200（它是一页人话，不是一个错误码）')
  const html = await after.text()
  assert.ok(html.includes('var NEEDS_TOKEN = true;'), '没凭据了，回门禁页')
  assert.ok(html.includes('var DEVICE_REVOKED = true;'), '要被撤销的那台设备知道自己是哪一个')
  assert.ok(html.includes('这台设备的授权已被移除，请重新扫码。'), '那句人话要在页面上')

  // **别人（从来没进过门的新浏览器）不许看到这句**：他该看到的是"要令牌"，不是"你被撤了"。
  const stranger = await fetch(`${p.base}/mini`)
  const strangerHtml = await stranger.text()
  assert.ok(strangerHtml.includes('var NEEDS_TOKEN = true;'))
  assert.ok(strangerHtml.includes('var DEVICE_REVOKED = false;'),
    '没带凭据的人不该被说成"你的授权被移除"——他压根没进过门')
})

// ---------------------------------------------------------------------------
// ⑦ 撤销之后那台手机**不会把自己这个来源封掉**（否则重新扫码都进不来）
// ---------------------------------------------------------------------------

test('撤销之后那台手机反复重连（一路 401）不会封掉它自己，重新扫码照旧进得来', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  const cred = await openPhonePage(p, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
  const id = (await listDevices(p)).body.devices[0].id
  await hostJson(p, '/mini-remote/devices/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  })

  // 真机上这就是手机页那条 EventSource：被掐断之后**每 3 秒自己重连一次**，
  // 每一次都是 401。打 8 次（`RATE_MAX_FAILURES` 是 5），看来源会不会被封。
  for (let i = 0; i < 8; i += 1) {
    const res = await fetch(`${p.base}/mini/api/stream`, { headers: { cookie: `${DEVICE_COOKIE}=${cred}` } })
    assert.equal(res.status, 401)
    await res.text()
  }

  // 于是用户拿着电脑上那张新二维码重新扫码：**必须进得来**。
  const again = await fetch(`${p.base}/mini?token=${encodeURIComponent(p.token)}`)
  assert.equal(again.status, 200, '被撤销的那台手机重新扫码时不该撞上「密码错误次数太多」')
  assert.ok((await again.text()).includes('var NEEDS_TOKEN = false;'), '重新扫码就该当场进门')
})

test('反面对照：猜令牌的照旧会被封（限速只对设备凭据那一枚放开）', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  // 令牌是**用户自己定的**（最短 12 位），猜得动——这就是限速存在的全部理由。
  for (let i = 0; i < 6; i += 1) {
    const res = await fetch(`${p.base}/mini/api/state?token=wrongwrongwrong`)
    await res.text()
  }
  const blocked = await fetch(`${p.base}/mini/api/state?token=${encodeURIComponent(p.token)}`)
  assert.equal(blocked.status, 429, '猜了 6 次令牌之后这个来源该被封一分钟')
  await blocked.text()
})

// ---------------------------------------------------------------------------
// ⑧ lastSeen 的节流：内存里是新的，磁盘上最多每分钟一次
// ---------------------------------------------------------------------------

test('lastSeen：用一次就更新（内存里立刻就是新的），但**不是每个请求都写盘**', async (t) => {
  const p = await bootHost()
  t.after(p.stop)

  const cred = await openPhonePage(p, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
  const use = async () => {
    const res = await fetch(`${p.base}/mini/api/state`, { headers: { cookie: `${DEVICE_COOKIE}=${cred}` } })
    assert.equal(res.status, 200)
    await res.text()
  }

  // 第一次触达：`seenFlushedAt` 还是 0，所以当场落一次盘——"刚用过"不能等一分钟才看得见。
  await use()
  const onDisk = records(p)[0].lastSeen
  assert.ok(onDisk > 0, '第一次用过就该落盘')

  // 第二次：**内存里更新了，磁盘上还是上一分钟那个数**（节流的全部意义就在这里）。
  await sleep(30)
  await use()
  const inMemory = (await listDevices(p)).body.devices[0].lastSeen
  assert.ok(inMemory > onDisk, '列表要显示刚刚这一次使用，而不是磁盘上那个旧数')
  assert.equal(records(p)[0].lastSeen, onDisk, '一分钟之内不该再写一次盘')
})
