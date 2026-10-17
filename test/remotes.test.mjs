/**
 * 跨机第三步 · **B 侧**：`lib/remotes.js`（「我能连的电脑」名册）与那四条宿主路由
 * （列出 / 添加 / 取票 / 断开）。
 *
 * 这一步的语义是一句话：**B 记着"我连得上哪几台电脑"，并且替自己的界面去换票**。
 * 下面每一条都盯着"悄悄坏掉也不会有人发现"的那一类：
 *
 *   ① **凭据有没有可能进 B 的浏览器**（这一步最要命的一条）：把那条回复的**全文**、
 *      以及列表接口的**全文**，拿**真正存在磁盘上的那枚凭据**（连同密钥那一半）去扫。
 *      光断言"响应里没有 credential 字段"是不够的——换个人把它塞进别的字段照样漏。
 *   ② **添加失败不留脏记录**：口令错、对面开关关着、地址根本不通——名册里一条都不许留，
 *      而且要是一句**人能照着做**的话（不是 `fetch failed`）。
 *   ③ **凭据走的是请求头、不是地址**：拿一个记账用的假 A 把请求原样收下来看
 *      （`x-mini-device` 有没有、地址里有没有查询串）——真 A 三种带法都认，
 *      光看"成功了"证明不了 B 用的是哪一种。
 *   ④ **断开只动 B 本地**（用户拍板的那一条）：断开之后 B 的列表空了，**而 A 名册里
 *      那条记录还在、那枚凭据在 A 那边照旧好使**——这就是"没替用户去撤销"的证据。
 *   ⑤ **重连 = 再取一次票**：同一个 id 连着取两次，拿到的是两张不同的票（票是一次性的）。
 *   ⑥ **对面撤销之后取票失败**：给人话，而且**一个地址都不许漏出去**。
 *   ⑦ **这一族只允许本机调**（和 `/mini-remote/devices` 那几条同一条规矩）：
 *      同一个"外面"的来源打过来必须 403。界面在**这台电脑**上，所以它是回环。
 *   ⑧ **卸载要把这四条一起摘掉**（十六条注册，十六条注销）。
 *
 * 全程 **两个真插件实例**：A 用 `lib/index.js` 的 apply 起一个真宿主 + 真手机服务，
 * B 同样起一个。两个实例各有自己的临时 `DSH_HOME`（A 和 B 的 token、名册、名册文件
 * 互不相干——`dataDir()` 只在 apply 那一刻读一次环境变量，所以同一个进程里能并存），
 * 各自把 `webServer.register` 收下来的 handler 挂在**真的 http 服务**上。
 * 这样跑的是一条真链路：B 的宿主 → HTTP → A 的宿主。
 *
 * ⚠️ 这一切证明的是**逻辑通**：B 能按规矩向 A 要票。它**不**证明"现在就能从另一台
 * 机器连通"——地址可达、以及 A 那个总开关打开，属于后面的"网络形态"那一步。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import { createServer } from 'node:http'

import { createRemotes, normalizeBaseUrl } from '../lib/remotes.js'

const ROOT_URL = new URL('..', import.meta.url)
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
 * 一个「像电脑端界面」的替身（照 test/remote-window.test.mjs）。
 *
 * 为什么非要它：A 那边取票成功之后，B 拿回来的地址要**在 A 上兑现**才能证明"这是一张
 * 真票"。兑票那一下镜像会转发给上游，上游死了就是 502——用一个真上游把这条走完整。
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
 * 起**一台电脑**：真插件实例 + 真手机服务 + 一个真的宿主 http 服务。
 *
 * `home` 是这台电脑的临时数据目录——A 和 B 各一个，互不打扰。⚠️ `DSH_HOME` 是进程级
 * 的环境变量，所以这里**在 apply 之前**把它指好（`dataDir()` 只在那一刻读一次）。
 *
 * `bindAddress: '127.0.0.1'`：这一步只验逻辑，所有连接都走本机回环，不往局域网上开门。
 *
 * ## 两个地址，分别是什么
 *
 *   · `host` = **宿主那一半**（真机上就是 DSH 的 webServer）：`/mini-remote/*` 长在这里，
 *     所以 B 要去够的"那台电脑的地址"是**这一条**；
 *   · `base` = **手机服务那一半**（真机上是 3090）：`/mini/mirror/` 长在这里，
 *     所以 A 取票时回来的那条地址，兑现时要打这一头。
 *
 * 真机上"B 到底该填哪条地址"（以及它可不可达）属于**后面的「网络形态」那一步**——
 * 这一步只验逻辑：B 按规矩向 A 要票、把票交给界面。
 */
async function bootSide(home, upstreamPort) {
  mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home

  const port = await freePort()
  const routes = new Map()
  const disposers = []
  const ctx = makeCtx({
    agents: { get: () => undefined, list: () => [] },
    // 镜像转发前要拿官方那枚会话 cookie（真机上它是 DSH 的 connection 服务给的）。
    connection: {
      authenticatedUrl: (base) => `${String(base).replace(/\/+$/, '')}/?token=LAUNCH-TOKEN`,
    },
    webServer: {
      port: upstreamPort,
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

  return {
    base,
    host: `http://127.0.0.1:${hostServer.address().port}`,
    home, token, routes,
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
 * 起一对：**A（被连的那台）+ B（要连的那台）**，共用一个"电脑端界面"替身。
 * 返回的 `a` / `b` 就是上面 bootSide 那一份；`stop()` 两台一起收摊。
 */
async function bootPair(t) {
  const upstream = await fakeUpstream()
  const a = await bootSide(mkdtempSync(join(tmpdir(), 'dsh-mini-remote-step3-a-')), upstream.port)
  const b = await bootSide(mkdtempSync(join(tmpdir(), 'dsh-mini-remote-step3-b-')), upstream.port)
  const stop = async () => {
    await a.stop()
    await b.stop()
    await upstream.close()
  }
  t.after(stop)
  return { a, b }
}

/** 一个来源地址、请求头都可控的假请求（照 test/remote-window.test.mjs）。 */
function fakeReq(remoteAddress, { method = 'POST', url = '/', body = null, headers = null } = {}) {
  const listeners = new Map()
  const req = {
    method,
    url,
    headers: headers ?? { host: '127.0.0.1', 'content-type': 'application/json' },
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
  assert.ok(route, `${path} 没注册到这台电脑的宿主上`)
  const res = fakeRes()
  await route.handler(fakeReq(opts.remoteAddress ?? '127.0.0.1', { url: path, ...opts }), res)
  let parsed = null
  try { parsed = JSON.parse(res.out.body) } catch { /* 不是 JSON 就留着 null，由断言去说 */ }
  return { status: res.out.status, body: parsed, text: res.out.body }
}

/** A 那边那个总开关（真机上就是设置页上点一下）。 */
function setSwitch(p, enabled, remoteAddress = '127.0.0.1') {
  return callHost(p, '/mini-remote/remote-access', { remoteAddress, body: JSON.stringify({ enabled }) })
}

/**
 * 在 A 上打开「允许别的电脑连接」。
 *
 * ⚠️ 这条路由存完设置之后会顺带回一整份配对信息（"手机怎么连上来"）。这一步里两台电脑
 * 都只绑了回环（**为了让测试不往局域网上开门**），那种情况下配对信息自己会回
 * `ok:false`——**那不是开关没开**：路由是先 `persistSettings` 再算配对信息的。
 * 所以这里只认"设置落盘了没有"这个效果。
 */
async function openSwitch(p) {
  const res = await setSwitch(p, true)
  const saved = JSON.parse(readFileSync(join(p.home, 'dsh-mini-remote', 'settings.json'), 'utf8'))
  assert.equal(saved.allowRemoteComputers, true,
    `开关要落盘（那条路由回了 ${res.status}：${res.text.slice(0, 200)}）`)
  return res
}

/** B 的界面（回到这台电脑自己）调一条 B 侧路由。 */
function callB(p, path, body, opts = {}) {
  return callHost(p, path, {
    method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
    body: body === undefined ? null : JSON.stringify(body),
  })
}

/** 往 B 的名册上添加一台电脑（`extra` 可以覆盖 name / baseUrl / token）。 */
function addRemote(b, a, extra = {}) {
  return callB(b, '/mini-remote/remotes/add', { baseUrl: a.host, token: a.token, ...extra })
}

/** B 让宿主去 A 换一张票。 */
function askWindow(b, id) {
  return callB(b, '/mini-remote/remotes/window', { id })
}

function fileRecords(p, name) {
  try {
    return JSON.parse(readFileSync(join(p.home, 'dsh-mini-remote', name), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/** B 的 remotes.json 里那几条（文件还没生成算空）。 */
function savedRemotes(p) {
  return fileRecords(p, 'remotes.json')?.remotes ?? []
}

/** A 的 devices.json 里那几条。 */
function savedDevices(p) {
  return fileRecords(p, 'devices.json')?.devices ?? []
}

/** B 存着的那枚凭据（**测试自己要看它**，好拿它去扫回复里有没有漏出来）。 */
function storedCredential(b, id = null) {
  const hit = id ? savedRemotes(b).find((r) => r.id === id) : savedRemotes(b)[0]
  return hit?.credential ?? ''
}

/**
 * ★ 「凭据有没有可能进浏览器」这一条的正面检查。
 *
 * 拿**磁盘上真实存在的那枚凭据**去扫一整段回给界面的东西——**连着密钥那一半一起扫**
 * （光比整体，有人只漏了后半截照样漏）。`credential` 字段名在不在无所谓，值在不在才作数。
 */
function assertNoCredential(text, credential, what) {
  const key = credential.split('.')[1] ?? ''
  assert.ok(credential.length > 20 && key.length === 32, `测试自己得先拿到一枚真凭据（拿到的是 ${JSON.stringify(credential)}）`)
  assert.ok(!String(text).includes(credential), `${what}里出现了整枚凭据`)
  assert.ok(!String(text).includes(key), `${what}里出现了凭据的密钥那一半`)
  assert.ok(!String(text).includes(credential.split('.')[0]), `${what}里出现了 A 那边那份设备 id`)
}

/** 兑票（"另一台电脑的浏览器"进门那一下）——它手上**没有**凭据，只有地址里那张票。 */
async function redeem(url) {
  const res = await fetch(url, { redirect: 'manual' })
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const raw = setCookies.find((one) => one.startsWith('dsh_mini_window=')) ?? ''
  return {
    status: res.status,
    body: await res.text(),
    session: raw ? decodeURIComponent(raw.slice('dsh_mini_window='.length).split(';')[0]) : '',
  }
}

/**
 * 把 A 给的那条地址**在 A 上兑现**（真机上那条地址的 host 就是 A 这台电脑）。
 *
 * 测试里要换一下前缀：A 的 `/mini/mirror/` 长在**手机服务那一半**（`a.base`），
 * 而 B 请求时那个 Host 是宿主那一半——真机上这两件事怎么对上，属于后面的
 * 「网络形态」那一步（见报告里那条发现）。这里要验的是**票本身是真的**。
 */
function redeemAt(a, url) {
  const ticket = new URL(url).searchParams.get('ticket') ?? ''
  return redeem(`${a.base}/mini/mirror/?ticket=${encodeURIComponent(ticket)}`)
}

/**
 * 一个**记账用的假 A**：把收到的每一条请求原样收下来（地址、头、体），好让测试看
 * **B 到底把凭据放在哪儿、口令放在哪儿**。真 A 三种带法都认，"成功了"证明不了 B 用的
 * 是哪一种；这一条才看得见。
 */
async function fakeRemote(plan = {}) {
  const seen = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: raw }
      seen.push(record)
      const route = String(req.url).startsWith('/mini-remote/pair') ? plan.pair : plan.window
      const answer = typeof route === 'function' ? route(record) : route
      const status = answer?.status ?? 200
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(answer?.body ?? {}))
    })
  })
  server.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    // 和真机上那两台一半对齐：假 A 把两条路由都答在自己的同一个端口上（它只负责记账）
    host: base,
    seen,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

const HEX32 = 'abcdef0123456789'.repeat(2) // 正好 32 位 hex
const GOOD_CREDENTIAL = `${HEX32}.${HEX32}`

// ---------------------------------------------------------------------------
// ① 存储：形状、原子写、坏了怎么办（不起插件，直接盯着那个模块）
// ---------------------------------------------------------------------------

test('落盘：形状就是 `{version, remotes[]}`，一条六个字段、凭据在里面', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mini-remotes-store-'))
  const file = join(home, 'remotes.json')
  const remotes = createRemotes({ file })

  assert.deepEqual(remotes.list(), [], '新装的这份名册是空的')
  const added = remotes.add({ name: '书房那台', baseUrl: 'http://192.168.1.5:3090', credential: GOOD_CREDENTIAL })
  assert.equal(added.ok, true, added.error)
  assert.deepEqual(Object.keys(added.remote).sort(), ['addedAt', 'baseUrl', 'id', 'lastOk', 'name'])
  assert.equal(added.remote.lastOk, 0, '还没换过票就该是 0，不许拿添加时间顶替')

  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.remotes.length, 1)
  assert.deepEqual(Object.keys(onDisk.remotes[0]).sort(),
    ['addedAt', 'baseUrl', 'credential', 'id', 'lastOk', 'name'])
  assert.equal(onDisk.remotes[0].credential, GOOD_CREDENTIAL, '凭据必须原样留着——B 每次换票都要发回给 A')
  assert.equal(onDisk.remotes[0].baseUrl, 'http://192.168.1.5:3090')

  // 名字没给：取地址里的 host（列表上要能一眼分出是哪一台）
  const unnamed = createRemotes({ file: join(home, 'another.json') })
  unnamed.add({ baseUrl: 'http://192.168.1.9:3090', credential: GOOD_CREDENTIAL })
  assert.equal(unnamed.list()[0].name, '192.168.1.9:3090')

  // ⚠️ 平台说明：Windows 上 Node 只把 mode 映射成"只读位"，0o600 看不出差别
  //（lib/devices.js 的注释也是这么写的）。POSIX 上这一条才是真的，所以在这儿验。
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600, '同目录的 token 也是这个口径：只有本人能读')
  }
})

test('落盘走的是「先写 .tmp 再改名」（原子写）：目标路径被占住时，临时文件留在原地', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mini-remotes-atomic-'))
  const file = join(home, 'remotes.json')
  // 拿一个**目录**占住目标路径：写临时文件照旧成功，改名那一步必然失败。
  mkdirSync(file)

  const remotes = createRemotes({ file })
  const added = remotes.add({ name: 'x', baseUrl: 'http://192.168.1.5:3090', credential: GOOD_CREDENTIAL })
  assert.equal(added.ok, true, '落盘失败不该让这一次添加失败——内存里那一份照常用')

  const tmp = JSON.parse(readFileSync(`${file}.tmp`, 'utf8'))
  assert.equal(tmp.remotes.length, 1, '整份 JSON 是先写进 .tmp 的：这就是"先临时文件、再改名"这条路的证据')
  assert.equal(tmp.remotes[0].credential, GOOD_CREDENTIAL)
  assert.equal(statSync(file).isDirectory(), true, '目标那一步没成（它还是个目录）')

  // 落盘失败也不会把内存里那份弄丢
  assert.equal(remotes.list().length, 1)
})

test('手改坏 / 被别的进程删掉：坏文件当空名册（不崩），删掉的那条当场不再认', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mini-remotes-corrupt-'))
  const file = join(home, 'remotes.json')

  writeFileSync(file, '{"version":1,"remotes":[{"id":"a"') // 半截 JSON（原子写要防的就是它）
  const remotes = createRemotes({ file })
  assert.deepEqual(remotes.list(), [], '半截 JSON 当空名册，绝不让插件起不来')

  remotes.add({ name: 'x', baseUrl: 'http://192.168.1.5:3090', credential: GOOD_CREDENTIAL })
  const id = remotes.list()[0].id
  // 用户自己在文件里删了那一行（明文 JSON，完全可能）
  writeFileSync(file, '{"version":1,"remotes":[]}\n')
  assert.equal(remotes.secret(id), null, '删掉的那条当场不再认——不必重启，也没有缓存窗口')
  assert.deepEqual(remotes.list(), [])

  // 形状不对的地址 / 凭据一律不收（脏记录比没有记录难查得多）
  assert.equal(remotes.add({ baseUrl: '192.168.1.5:3090', credential: GOOD_CREDENTIAL }).ok, false)
  assert.equal(remotes.add({ baseUrl: 'http://192.168.1.5:3090', credential: '不是凭据' }).ok, false)
  assert.deepEqual(remotes.list(), [], '两次失败都不许留下东西')
})

test('地址的规整：去尾斜杠、必须带 scheme、不带查询串', () => {
  assert.equal(normalizeBaseUrl(' http://192.168.1.5:3090/ '), 'http://192.168.1.5:3090')
  assert.equal(normalizeBaseUrl('https://a.example.ts.net//'), 'https://a.example.ts.net')
  assert.equal(normalizeBaseUrl('192.168.1.5:3090'), '', '少了 scheme 不收——补错了 http/https 是我们猜的')
  assert.equal(normalizeBaseUrl('ftp://192.168.1.5'), '', '不是网页地址')
  assert.equal(normalizeBaseUrl('http://192.168.1.5:3090/?x=1'), '', '带查询串的拼上去就拼坏了')
  assert.equal(normalizeBaseUrl(undefined), '')
})

// ---------------------------------------------------------------------------
// ② 添加一台电脑：成功那份，以及"失败不留脏记录"那一半
// ---------------------------------------------------------------------------

test('⚠️ 添加成功：列表里有一条、**凭据一个字节都没回给界面**，而登录凭据确实进了 B 的宿主', async (t) => {
  const { a, b } = await bootPair(t)
  await openSwitch(a) // 先在 A 上打开「允许别的电脑连接」

  const added = await addRemote(b, a, { name: '书房那台' })
  assert.equal(added.status, 200, `添加要成功（回的是 ${added.status}：${added.text.slice(0, 300)}）`)
  assert.equal(added.body.ok, true)
  assert.equal(added.body.remote.name, '书房那台')
  assert.equal(added.body.remote.baseUrl, a.host)
  assert.equal(added.body.remote.lastOk, 0, '还没换过票')

  // ★ 正面回答"凭据进没进浏览器"：拿磁盘上那枚真凭据扫**这一条回复的全文**
  const credential = storedCredential(b)
  assert.ok(credential, 'B 的宿主该把凭据存下来了')
  assertNoCredential(added.text, credential, '「添加成功」那条回复')
  assert.equal(Object.hasOwn(added.body.remote, 'credential'), false, '记录里连字段都不该有')

  // 列表：同样是 publicRecord（照 devices.js 的先例）
  const listed = await callB(b, '/mini-remote/remotes')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.remotes.length, 1)
  assert.deepEqual(Object.keys(listed.body.remotes[0]).sort(), ['addedAt', 'baseUrl', 'id', 'lastOk', 'name'])
  assertNoCredential(listed.text, credential, '「列出」那条回复')

  // 凭据在 B 的宿主这边：落的是 remotes.json（和 devices.json 并排）
  assert.equal(savedRemotes(b).length, 1)
  assert.equal(savedRemotes(b)[0].credential, credential)
  // ⚠️ 而且**没有混进 settings.json**（那是给用户手改的文件）
  const settings = JSON.parse(readFileSync(join(b.home, 'dsh-mini-remote', 'settings.json'), 'utf8'))
  assert.ok(!JSON.stringify(settings).includes(credential), '长期凭据不许进 settings.json')

  // A 那边：名册里多了一条 desktop（配对那一步的落点）
  const roster = savedDevices(a)
  assert.equal(roster.length, 1)
  assert.equal(roster[0].kind, 'desktop')
  assert.equal(roster[0].id, credential.split('.')[0], 'B 手上那枚凭据的 id 就是 A 名册里这一条')
})

test('⚠️ 添加失败（口令错）→ 一句人话，**本地一条脏记录都不留**', async (t) => {
  const { a, b } = await bootPair(t)
  await openSwitch(a)

  const wrong = await addRemote(b, a, { token: '这不是口令' })
  assert.equal(wrong.status, 502, '出错的是对面那一头，不是本机这次调用不合规矩')
  assert.equal(wrong.body.ok, false)
  assert.match(wrong.body.error, /口令不对/, 'A 那句原因要原样带回来（加一句"那台电脑说："）')
  assert.match(wrong.body.error, /那台电脑说/)

  assert.deepEqual(savedRemotes(b), [], '失败了就不许落盘')
  assert.equal((await callB(b, '/mini-remote/remotes')).body.remotes.length, 0)
  assert.deepEqual(savedDevices(a), [], 'A 那边也不该留下半条记录')
})

test('⚠️ 添加失败（A 拒绝：开关关着）→ 人话点明去 A 上开那个开关，不留脏记录', async (t) => {
  const { a, b } = await bootPair(t)
  // 开关就是默认值，谁都没碰过（默认关）
  const refused = await addRemote(b, a)
  assert.equal(refused.status, 502)
  assert.match(refused.body.error, /允许别的电脑连接/, '要告诉用户"去哪儿把它打开"，不是一句"失败了"')
  assert.deepEqual(savedRemotes(b), [])
  assert.deepEqual(savedDevices(a), [])

  // 前后对照：开关一开，同一台电脑、同一枚口令就通了（证明被拒的原因就是它）
  await openSwitch(a)
  const ok = await addRemote(b, a)
  assert.equal(ok.status, 200, `开关打开之后要能加上（回的是 ${ok.status}：${ok.text.slice(0, 300)}）`)
})

test('添加失败（地址不通 / 地址写得不对）→ 人话；参数不对是 400', async (t) => {
  const { a, b } = await bootPair(t)
  await openSwitch(a)

  const dead = `http://127.0.0.1:${await freePort()}` // 没人监听
  const unreachable = await addRemote(b, a, { baseUrl: dead })
  assert.equal(unreachable.status, 502)
  assert.match(unreachable.body.error, /连不上那台电脑/)
  assert.ok(unreachable.body.error.includes(dead), '要把那条地址摆出来，用户才知道自己去连了什么')

  const noScheme = await addRemote(b, a, { baseUrl: '192.168.1.5:3090' })
  assert.equal(noScheme.status, 400)
  assert.match(noScheme.body.error, /http:\/\//)

  const noToken = await callB(b, '/mini-remote/remotes/add', { baseUrl: a.base })
  assert.equal(noToken.status, 400)
  assert.match(noToken.body.error, /口令/)

  assert.deepEqual(savedRemotes(b), [], '三次失败一个字节都不许落盘')
})

// ---------------------------------------------------------------------------
// ③ 取票：走请求头、拿到真票；对面撤销之后给人话
// ---------------------------------------------------------------------------

test('⚠️ 取票成功：拿到一张**真票**（能在 A 上兑现），而且凭据没进地址、也没进回给界面的东西', async (t) => {
  const { a, b } = await bootPair(t)
  await openSwitch(a)
  const added = await addRemote(b, a)
  assert.equal(added.status, 200, added.text)
  const credential = storedCredential(b)

  const asked = await askWindow(b, added.body.remote.id)
  assert.equal(asked.status, 200, `取票要成功（回的是 ${asked.status}：${asked.text.slice(0, 300)}）`)
  assert.equal(asked.body.ok, true)
  assert.ok(asked.body.url, '要回一条地址')
  assert.equal(new URL(asked.body.url).pathname, '/mini/mirror/', '还是镜像那扇门')
  assert.ok(new URL(asked.body.url).searchParams.get('ticket'), '地址里要带一张票')
  assert.ok(asked.body.expiresIn > 0, '界面要靠它决定多久重取一次')

  // ★ 票是真的：**不带任何凭据**去兑现也能开（票上写着 B 这台电脑的身份）
  const opened = await redeemAt(a, asked.body.url)
  assert.equal(opened.status, 200, '票兑不出来就说明这条链没通')
  assert.match(opened.session, /^v1\./, '那一下要发下窗口会话 cookie')

  // ★ 凭据没进地址、也没进回给界面的东西
  assert.ok(!asked.body.url.includes(credential), '凭据进了地址就会留在历史、代理和对面日志里')
  assertNoCredential(asked.text, credential, '「取票」那条回复')

  // lastOk 记上了（列表上"最近成功连接"那句话就是它）
  assert.ok(savedRemotes(b)[0].lastOk > 0, '成功换到票就该记一次')
  assert.ok((await callB(b, '/mini-remote/remotes')).body.remotes[0].lastOk > 0)

  // 重连 = 再取一次票：两次拿到的是**两张不同的票**（票是一次性的，30 秒）
  const again = await askWindow(b, added.body.remote.id)
  assert.equal(again.status, 200)
  assert.notEqual(again.body.url, asked.body.url, '同一条地址不许发两次——票是一次性的')
  assert.equal((await redeemAt(a, again.body.url)).status, 200, '重取的那一张也是真票')
})

test('取票失败（A 那边把这条记录撤销了）→ 人话，而且一个地址都不许漏出去', async (t) => {
  const { a, b } = await bootPair(t)
  await openSwitch(a)
  const added = await addRemote(b, a)
  const id = added.body.remote.id
  const deviceId = storedCredential(b).split('.')[0]

  // A 那边撤销（真机上就是设置页上点的那一下）
  const revoked = await callHost(a, '/mini-remote/devices/revoke', { body: JSON.stringify({ id: deviceId }) })
  assert.equal(revoked.status, 200)
  assert.deepEqual(savedDevices(a), [])

  const after = await askWindow(b, id)
  assert.equal(after.status, 502)
  assert.equal(after.body.ok, false)
  assert.match(after.body.error, /已经不认这枚凭据/, '要说清"它那边撤销了"')
  assert.match(after.body.error, /重新添加/, '还要告诉用户接下来能做什么')
  assert.doesNotMatch(after.text, /mini\/mirror/, '被拒的时候一个地址都不许漏出去')
})

test('取票失败（A 把总开关关掉 / id 不在列表里）→ 各有各的人话', async (t) => {
  const { a, b } = await bootPair(t)
  await openSwitch(a)
  const added = await addRemote(b, a)
  const id = added.body.remote.id

  await setSwitch(a, false)
  const off = JSON.parse(readFileSync(join(a.home, 'dsh-mini-remote', 'settings.json'), 'utf8'))
  assert.equal(off.allowRemoteComputers, false, '关要真的关上（这一条要被挡住的原因就是它）')
  const closed = await askWindow(b, id)
  assert.equal(closed.status, 502)
  assert.match(closed.body.error, /允许别的电脑连接/)
  assert.doesNotMatch(closed.text, /mini\/mirror/)

  const missing = await askWindow(b, 'not-there')
  assert.equal(missing.status, 404)
  assert.match(missing.body.error, /不在列表里/)

  const noId = await askWindow(b, undefined)
  assert.equal(noId.status, 400, 'body 里没有 id')
})

// ---------------------------------------------------------------------------
// ④ 断开：只动 B 本地，**绝不替用户去 A 撤销**
// ---------------------------------------------------------------------------

test('⚠️ 断开（forget）：B 的列表空了，**而 A 名册里那条还在、那枚凭据照旧好使**', async (t) => {
  const { a, b } = await bootPair(t)
  await openSwitch(a)
  const added = await addRemote(b, a)
  const id = added.body.remote.id
  const credential = storedCredential(b)

  const gone = await callB(b, '/mini-remote/remotes/forget', { id })
  assert.equal(gone.status, 200, gone.text)
  assert.equal(gone.body.ok, true)
  assert.equal(gone.body.id, id)
  // 给用户看的文案必须说清"那边还留着"
  assert.match(gone.body.note, /那台电脑上还留着/)
  assert.match(gone.body.note, /撤销/)

  // B 这边：列表空了，文件里那条也没了（连凭据一起走）
  assert.deepEqual((await callB(b, '/mini-remote/remotes')).body.remotes, [])
  assert.deepEqual(savedRemotes(b), [])

  // ★ 关键：**A 名册里那条记录还在**——我们没有替用户去撤销
  const roster = savedDevices(a)
  assert.equal(roster.length, 1, '断开只该动 B 本地；A 名册里那条必须原样还在')
  assert.equal(roster[0].kind, 'desktop')

  // ★ 而且那枚凭据在 A 那边**照旧好使**（直接问 A 要一张票，绕开 B）
  const direct = await callHost(a, '/mini-remote/remote/window', {
    remoteAddress: '192.168.1.50',
    headers: { host: '192.168.1.5:3090', 'content-type': 'application/json', 'x-mini-device': credential },
    body: '{}',
  })
  assert.equal(direct.status, 200, 'A 那边根本没被通知过——这正是"断开 ≠ 撤销"的证据')
  assert.ok(direct.body.url)

  // 已经断开过的再断一次：如实说"不在列表里了"，别假装成功
  const twice = await callB(b, '/mini-remote/remotes/forget', { id })
  assert.equal(twice.status, 404)
})

test('断开之后要回来 = 重新添加一次（A 的口令还在场时）', async (t) => {
  const { a, b } = await bootPair(t)
  await openSwitch(a)
  const first = await addRemote(b, a, { name: '书房那台' })
  await callB(b, '/mini-remote/remotes/forget', { id: first.body.remote.id })
  assert.deepEqual(savedRemotes(b), [])

  const again = await addRemote(b, a, { name: '书房那台' })
  assert.equal(again.status, 200, `重新添加要能成（回的是 ${again.status}：${again.text.slice(0, 300)}）`)
  assert.notEqual(again.body.remote.id, first.body.remote.id, '这是一条新记录（B 这边的 id 是自己起的）')
  // A 那边会多出一条记录：**B 断开时没有替用户撤销，所以这里必然是两条**
  assert.equal(savedDevices(a).length, 2, '断开不撤销 → 重新配对就是在 A 上又登记了一台')

  const asked = await askWindow(b, again.body.remote.id)
  assert.equal(asked.status, 200, '重连之后要能拿到票')
  assert.equal((await redeemAt(a, asked.body.url)).status, 200)
})

// ---------------------------------------------------------------------------
// ⑤ 凭据到底放在哪儿（拿记账用的假 A 看线上那一条请求）
// ---------------------------------------------------------------------------

test('⚠️ 线上那一条请求：口令在**请求体**里、凭据在**请求头**里，地址里干干净净', async (t) => {
  const fakeA = await fakeRemote({
    pair: { body: { ok: true, credential: GOOD_CREDENTIAL } },
    window: { body: { ok: true, url: 'http://192.168.1.5:3090/mini/mirror/?ticket=t-1', expiresIn: 30 } },
  })
  t.after(fakeA.close)

  // 假 A 当"另一台电脑"：B 的 baseUrl 指过去就行（它不校验口令，只负责记账）
  const upstream = await fakeUpstream()
  const b = await bootSide(mkdtempSync(join(tmpdir(), 'dsh-mini-remote-step3-b-')), upstream.port)
  t.after(async () => { await b.stop(); await upstream.close() })

  const added = await addRemote(b, fakeA, { token: 'A-的口令' })
  assert.equal(added.status, 200, added.text)

  const pairCall = fakeA.seen[0]
  assert.equal(pairCall.method, 'POST')
  assert.equal(pairCall.url, '/mini-remote/pair', '口令**不许**进地址（进了就会被写进日志和历史）')
  assert.equal(JSON.parse(pairCall.body).token, 'A-的口令')

  const asked = await askWindow(b, added.body.remote.id)
  assert.equal(asked.status, 200, asked.text)
  assert.equal(asked.body.url, 'http://192.168.1.5:3090/mini/mirror/?ticket=t-1', 'A 给的地址原样交给界面')
  assert.equal(asked.body.expiresIn, 30)

  const winCall = fakeA.seen[1]
  assert.equal(winCall.url, '/mini-remote/remote/window', '凭据**不许**进地址')
  assert.equal(winCall.headers['x-mini-device'], GOOD_CREDENTIAL, '凭据走的是请求头')

  // 回给界面的东西里，凭据那两半一个字节都不许有
  assertNoCredential(added.text, GOOD_CREDENTIAL, '「添加」那条回复')
  assertNoCredential(asked.text, GOOD_CREDENTIAL, '「取票」那条回复')
})

test('⚠️ 对面回了 ok、却没有一枚像样的凭据 → 照样不落盘', async (t) => {
  const fakeA = await fakeRemote({
    pair: { body: { ok: true, credential: '我说这是凭据就是了' } },
  })
  t.after(fakeA.close)

  const upstream = await fakeUpstream()
  const b = await bootSide(mkdtempSync(join(tmpdir(), 'dsh-mini-remote-step3-b-')), upstream.port)
  t.after(async () => { await b.stop(); await upstream.close() })

  const added = await addRemote(b, fakeA, { token: 'A-的口令' })
  assert.equal(added.status, 502)
  assert.match(added.body.error, /凭据/)
  assert.deepEqual(savedRemotes(b), [], '形状不对的凭据不许进名册——脏记录比没有记录难查得多')
})

// ---------------------------------------------------------------------------
// ⑥ 这一族的门：只允许本机；卸载要摘干净
// ---------------------------------------------------------------------------

test('这一族只允许本机调：外面来的四条一律 403（和 devices 那几条同一条规矩）', async (t) => {
  const { b } = await bootPair(t)
  const outside = '192.168.1.50'

  for (const [path, body] of [
    ['/mini-remote/remotes', null],
    ['/mini-remote/remotes/add', JSON.stringify({ baseUrl: 'http://192.168.1.5:3090', token: 'x' })],
    ['/mini-remote/remotes/window', JSON.stringify({ id: 'x' })],
    ['/mini-remote/remotes/forget', JSON.stringify({ id: 'x' })],
  ]) {
    const denied = await callHost(b, path, { remoteAddress: outside, body })
    assert.equal(denied.status, 403, `${path} 只允许这台电脑自己调`)
    assert.match(denied.body.error, /只能在这台电脑上看/)
  }
})

test('方法不对：这几条各自只认自己那个方法', async (t) => {
  const { b } = await bootPair(t)
  assert.equal((await callB(b, '/mini-remote/remotes', undefined, { method: 'POST' })).status, 405)
  for (const path of ['/mini-remote/remotes/add', '/mini-remote/remotes/window', '/mini-remote/remotes/forget']) {
    assert.equal((await callB(b, path, undefined, { method: 'GET' })).status, 405, path)
  }
})

test('卸载之后 B 侧这四条一起摘干净（十六条注册，十六条注销）', async (t) => {
  const { b } = await bootPair(t)
  for (const path of ['/mini-remote/remotes', '/mini-remote/remotes/add', '/mini-remote/remotes/window', '/mini-remote/remotes/forget']) {
    assert.ok(b.routes.get(path), `${path} 得先挂着`)
  }
  b.dispose()
  assert.equal(b.routes.size, 0, '卸载之后一条都不该还挂在这台电脑上')
})

// ---------------------------------------------------------------------------
// ⑦ 「B 到底该填哪条地址」（2026-10-17 第七步）
//
// 这一步回答的就是上一个子代理留下的那个洞：**B 手上只有一条地址**，而 A 这边两条路
// 本来分在两个端口上（配对/取票在宿主那一半，`/mini/mirror/` 在手机服务那一半）。
// 取票回的地址用的是**请求到达时的 Host**，所以填哪一边都有一半对不上：填宿主那一半，
// 框里那条 `/mini/mirror/` 是 404；填手机服务那一半，配对那一下先被门拦住（401/404）。
//
// 下面这一条把"填手机服务那条"整条链走完，用的全是**真 http**：
// 配对 → 取票 → 兑票 → 框里那些请求（绝对路径 + 前缀下面的静态资源）。
// ---------------------------------------------------------------------------

test('⚠️ B 只填一条地址（手机服务那一半）：配对 → 取票 → 兑票 → 框里那些请求，全在同一个源上', async (t) => {
  const { a, b } = await bootPair(t)
  await openSwitch(a) // 先在 A 上打开「允许别的电脑连接」

  // ① 配对：B 填的是**手机服务**那条地址（真机上就是 3090——跨机时它是唯一一条
  //    能到达 A 的地址；宿主那一半只绑在本机回环上）。
  const added = await addRemote(b, a, { baseUrl: a.base, name: '书房那台' })
  assert.equal(added.status, 200,
    `配对得能在手机服务上打通（回的是 ${added.status}：${added.text.slice(0, 300)}）`)
  assert.equal(added.body.remote.baseUrl, a.base)

  // ② 取票：同一条地址。回给界面的那条地址**必须还是这个源**——
  //    否则就是"票开在 A 上、框去 B 的本机端口找"那类错。
  const asked = await askWindow(b, added.body.remote.id)
  assert.equal(asked.status, 200,
    `取票要走同一条地址（回的是 ${asked.status}：${asked.text.slice(0, 300)}）`)
  const url = new URL(asked.body.url)
  assert.equal(url.origin, a.base, '回来的地址必须和 B 填的是同一个源：不同源就是"填哪边都有一半对不上"')
  assert.equal(url.pathname, '/mini/mirror/', '还是镜像那扇门')

  // ③ 兑票：**拿 A 给的那条地址原样兑现**（不再像从前那样把前缀换成 a.base）。
  const opened = await redeem(asked.body.url)
  assert.equal(opened.status, 200, `那条地址得在它自己的源上兑现得了（回的是 ${opened.status}）`)
  assert.match(opened.session, /^v1\./, '兑票那一下要发下窗口会话 cookie')
  assert.match(opened.body, /电脑端界面/, '入口那一下要真的是电脑端界面，不是一句 404/401')

  // ④ 框里那些请求：内置界面的写法有两种，两种都要认得这枚会话。
  //    绝对路径（`/api/...`）和挂在 `/mini/mirror/` 下面的静态资源。
  const cookie = `dsh_mini_window=${opened.session}`
  const abs = await fetch(`${a.base}/api/session/list`, { headers: { cookie } })
  assert.equal(abs.status, 200, `框里的绝对路径要能过（回的是 ${abs.status}）`)
  const rel = await fetch(`${a.base}/mini/mirror/assets/index-abc.js`, { headers: { cookie } })
  assert.equal(rel.status, 200, `框里前缀下面的静态资源要能过（回的是 ${rel.status}）`)

  // 反面：不带这枚会话就进不去——说明上面那两个 200 是会话换来的，不是路口开着。
  // （回 404 不是 401：这台电脑上「进阶设置」那个开关还没开，整块镜像路由照旧当
  //  不存在——那是它本来的规矩。要紧的是**没有 200**。）
  const bare = await fetch(`${a.base}/mini/mirror/assets/index-abc.js`)
  assert.notEqual(bare.status, 200, `没带会话就不该拿到东西（回的是 ${bare.status}）`)

  // ⑤ 宿主那一半那条老路**一个字都没动**（本机的面板还在用它）。
  const viaHost = await addRemote(b, a, { baseUrl: a.host })
  assert.equal(viaHost.status, 200, '宿主那一半的配对照旧能走（这一条是回归保护）')
})
