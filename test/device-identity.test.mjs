/**
 * 「设备身份」第一步：名册、登记时机，以及**凭据绝不跟着请求进上游**。
 *
 * 四件事，每一件都是「悄悄坏掉也不会有人发现」的那一类：
 *
 *   ① **凭据不转发**（这一步的验收核心）。设备凭据一旦跟着地址或请求头转到上游，
 *      就等于**把一台设备的长期身份写进上游的日志和链路**；而且上游对一部分地址是
 *      精确匹配，多带一个参数会当场 404——在手机上的表现是镜像白屏。所以用一个
 *      假上游实测：它收到的东西里，**一个字节的凭据都不许有**。
 *   ② **登记只发生在「打开手机页」那一下**。普通接口请求一次都不登记——否则页面
 *      每抖一次、每刷新一次就多一台「新设备」，「谁是谁」当场失真。
 *   ③ **老设备升级不许踢人**：只有令牌的老设备打开手机页时自动补上设备身份，
 *      而它原来那份令牌照旧能用（设计里的硬要求：不能「升级即全踢」）。
 *   ④ **删掉记录 = 那台设备当场失效**（不必重启），而且文件里只有密钥的哈希。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMiniServer } from '../lib/server.js'
import { createMirror } from '../lib/mirror.js'
import { createDevices } from '../lib/devices.js'

const TOKEN = 'testtoken0123456789abcdef012345'
const DEVICE_COOKIE = 'dsh_mini_device'

// ---------------------------------------------------------------- 夹具

/** 起一个服务器并等它真的在听（照 test/mirror.test.mjs 那份）。 */
async function listen(handler) {
  const server = createServer(handler)
  const upgraded = new Set()
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    close: () => new Promise((r) => {
      for (const s of upgraded) s.destroy()
      server.closeAllConnections?.()
      server.close(r)
    }),
  }
}

/**
 * 一个「像电脑端界面」的假上游：**它会如实记下自己收到的每一个字节**——
 * 这一组测试要的正是这个（凭据有没有漏过去，由它说了算，不由我们的代码说了算）。
 */
async function fakeUpstream() {
  const seen = []
  const app = await listen((req, res) => {
    // 整个头一起留：断言才能落在「上游到底收到了什么」上，而不是我们猜它会收到什么。
    seen.push({ url: req.url, method: req.method, headers: { ...req.headers } })
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
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('上游内容 ' + url.pathname)
  })
  return { port: app.port, seen, close: app.close }
}

/** 一个只够跑这条路的最小服务外壳。 */
async function boot({ devices, mirror = null, mirrorEnabled = () => true } = {}) {
  const instance = await createMiniServer({
    store: { snapshot: () => ({}), state: {} },
    config: { port: 0, defaultMode: 'minimal' },
    token: TOKEN,
    bindAddresses: ['127.0.0.1'],
    devices,
    mirror,
    mirrorEnabled,
    log: { info: () => {}, warn: () => {} },
    build: 'test',
  })
  return { base: `http://127.0.0.1:${instance.port}`, close: () => instance.close() }
}

/** 一个干净的数据目录：名册文件和真机上是同一个名字。 */
function tempDevices() {
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-mini-devices-')), 'devices.json')
  return { file, devices: createDevices({ file }) }
}

/** 名册落盘那几条记录；文件还没生成时算空名册。 */
function records(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).devices ?? []
  } catch {
    return []
  }
}

/** 从响应里把设备凭据取出来（没发就是空串）。 */
function credentialFrom(res) {
  const all = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : String(res.headers.get('set-cookie') ?? '').split(', ')
  const head = `${DEVICE_COOKIE}=`
  for (const one of all) {
    if (!one.startsWith(head)) continue
    return decodeURIComponent(one.slice(head.length).split(';')[0])
  }
  return ''
}

// ---------------------------------------------------------------- ① 同一道门

test('设备凭据和令牌走同一道门：cookie / 请求头 / 地址三种带法都认', async (t) => {
  const { devices } = tempDevices()
  const s = await boot({ devices })
  t.after(s.close)

  // 登记就发生在这一下：第一次带配对码打开手机页（二维码扫的就是这个地址）。
  const page = await fetch(`${s.base}/mini?token=${TOKEN}`)
  assert.equal(page.status, 200)
  const cred = credentialFrom(page)
  assert.match(cred, /^[0-9a-f]{32}\.[0-9a-f]{32}$/, '打开手机页那一下该发下一枚设备凭据')

  // 三种带法各来一次，都该过门——**这就是「和令牌同一道门」**。
  const viaCookie = await fetch(`${s.base}/mini/api/state`, {
    headers: { Cookie: `${DEVICE_COOKIE}=${cred}` },
  })
  assert.equal(viaCookie.status, 200, '凭据走 cookie 该进得来（真机上的主路）')

  const viaHeader = await fetch(`${s.base}/mini/api/state`, {
    headers: { 'X-Mini-Device': cred },
  })
  assert.equal(viaHeader.status, 200, '凭据走请求头该进得来')

  const viaQuery = await fetch(`${s.base}/mini/api/state?device=${cred}`)
  assert.equal(viaQuery.status, 200, '凭据走地址该进得来')

  // 认人靠的是名册：编出来的一枚一律不算。
  const madeUp = `${'a'.repeat(32)}.${'b'.repeat(32)}`
  const fake = await fetch(`${s.base}/mini/api/state?device=${madeUp}`)
  assert.equal(fake.status, 401, '名册里没有的凭据不是凭据')
  const none = await fetch(`${s.base}/mini/api/state`)
  assert.equal(none.status, 401, '什么都不带当然进不来')
})

// ---------------------------------------------------------------- ② 验收核心

test('⚠️ 验收核心：带设备凭据的请求转发到上游时，凭据必须不在（假上游实测）', async (t) => {
  const { devices } = tempDevices()
  const app = await fakeUpstream()
  const mirror = createMirror({
    upstream: `http://127.0.0.1:${app.port}`,
    tokenUrl: () => `http://127.0.0.1:${app.port}/?token=LAUNCH-TOKEN`,
    log: () => {},
  })
  const s = await boot({ devices, mirror })
  t.after(async () => { await s.close(); await app.close() })

  const page = await fetch(`${s.base}/mini?token=${TOKEN}`)
  const cred = credentialFrom(page)
  assert.ok(cred, '先得有一枚真的设备凭据')

  /**
   * 把一条镜像里的东西要走一遍，回上游**实际**收到了什么。
   * 判据一律落在 `whole`（上游收到的地址 + 全部请求头）上，不落在我们的预期上。
   */
  async function forward(path, headers) {
    app.seen.length = 0
    const res = await fetch(`${s.base}${path}`, { headers })
    assert.equal(res.status, 200, `这条路该通：${path}`)
    const got = app.seen.at(-1)
    assert.ok(got, '上游应当收到这次转发')
    return { got, whole: JSON.stringify(got) }
  }

  // ① 凭据跟着**地址**过去（`device=` 是我们认的名字）。这条请求不带令牌——它全靠设备凭据过门。
  {
    const { got, whole } = await forward(`/mini/mirror/assets/app.js?rev=1&device=${cred}`, {})
    assert.ok(!whole.includes(cred), `设备凭据跟着地址进了上游：${got.url}`)
    assert.equal(got.url, '/assets/app.js?rev=1', '摘掉凭据之外，其余查询串一个字符都不许动')
  }

  // ② 凭据换一个**参数名**（`dk=`，我们压根不认的名字），过门靠 cookie。
  //    这一条钉的就是那句「不管新凭据走哪个参数名，都要被摘干净」——
  //    摘的判据必须是**值/形状**，不能是参数名。
  {
    const { whole } = await forward(`/mini/mirror/assets/app.js?rev=1&dk=${cred}`, {
      Cookie: `${DEVICE_COOKIE}=${cred}`,
    })
    assert.ok(!whole.includes(cred), '换了参数名就漏摘——这正是这一步要堵死的那个洞')
  }

  // ③ 凭据走**请求头**（顺带把令牌也塞上，真机上打开镜像框时就是这个样子）。
  {
    const { whole } = await forward('/mini/mirror/api/session/list?rev=2', {
      'X-Mini-Device': cred,
      'X-Mini-Token': TOKEN,
      Cookie: `${DEVICE_COOKIE}=${cred}; dsh_mini_token=${TOKEN}`,
    })
    assert.ok(!whole.includes(cred), '设备凭据跟着请求头进了上游')
    assert.ok(!whole.includes(TOKEN), '令牌也跟着请求头进了上游——同一个洞')
  }

  // ④ 两条凭据挤在地址里（令牌 + 设备凭据），一个都不许过去。
  {
    const { got, whole } = await forward(
      `/mini/mirror/assets/app.js?rev=3&token=${TOKEN}&device=${cred}`, {},
    )
    assert.equal(got.url, '/assets/app.js?rev=3')
    assert.ok(!whole.includes(cred), '地址里的设备凭据漏了')
    assert.ok(!whole.includes(TOKEN), '地址里的令牌漏了')
  }
})

// ---------------------------------------------------------------- ③ 登记时机

test('登记只发生在「打开手机页」那一下：普通接口请求一次都不登记', async (t) => {
  const { file, devices } = tempDevices()
  const s = await boot({ devices })
  t.after(s.close)

  // 还没打开过页面：普通接口请求来回三趟，名册必须还是空的。
  // （登记要是跟着普通请求走，页面一抖就多一台设备——「一请求就复活」。）
  for (let i = 0; i < 3; i += 1) {
    const res = await fetch(`${s.base}/mini/api/state?token=${TOKEN}`)
    assert.equal(res.status, 200)
  }
  assert.deepEqual(records(file), [], '普通请求把设备登记出来了')

  // 只有「打开手机页」这一下登记。
  const page = await fetch(`${s.base}/mini?token=${TOKEN}`)
  const cred = credentialFrom(page)
  assert.equal(records(file).length, 1, '打开手机页那一下该登记一台')

  // 之后照旧怎么请求都不添新的。
  for (let i = 0; i < 3; i += 1) await fetch(`${s.base}/mini/api/state?token=${TOKEN}`)
  assert.equal(records(file).length, 1, '登记过了就不该再添')

  // 同一台手机再打开一次页面（这回带的是设备凭据）：不重发、不新建。
  const again = await fetch(`${s.base}/mini`, { headers: { Cookie: `${DEVICE_COOKIE}=${cred}` } })
  assert.equal(again.status, 200)
  assert.equal(again.headers.get('set-cookie'), null, '已经有有效凭据了就别再发一枚')
  assert.equal(records(file).length, 1)
})

// ---------------------------------------------------------------- ④ 老设备升级

test('老设备（只有令牌）打开手机页时自动登记，令牌照旧能用——不踢人', async (t) => {
  const { file, devices } = tempDevices()
  const s = await boot({ devices })
  t.after(s.close)

  // 老设备的样子：浏览器里只有 `dsh_mini_token` 那枚 cookie，没有设备凭据，地址里也没有 ?token=。
  const page = await fetch(`${s.base}/mini`, { headers: { Cookie: `dsh_mini_token=${TOKEN}` } })
  assert.equal(page.status, 200, '老设备照旧进得来——不能「升级即全踢」')
  assert.ok((await page.text()).includes('var NEEDS_TOKEN = false;'),
    '老设备看到的是正常页面，不是门禁页')
  const cred = credentialFrom(page)
  assert.ok(cred, '顺手补一枚设备凭据——这就是自动升级，用户零动作')
  assert.equal(records(file).length, 1)

  // 升级**不动老路**：原来那枚令牌照样过门。
  const byToken = await fetch(`${s.base}/mini/api/state`, {
    headers: { Cookie: `dsh_mini_token=${TOKEN}` },
  })
  assert.equal(byToken.status, 200, '令牌这条路一个字没动：老设备不该因为升级而失效')

  // 新补的那枚也认。
  const byDevice = await fetch(`${s.base}/mini/api/state`, {
    headers: { Cookie: `${DEVICE_COOKIE}=${cred}` },
  })
  assert.equal(byDevice.status, 200)
})

// ---------------------------------------------------------------- ⑤ 撤销与落盘

test('文件里只有密钥的哈希；删掉记录 → 那台设备的凭据当场失效', async (t) => {
  const { file, devices } = tempDevices()
  const s = await boot({ devices })
  t.after(s.close)

  // 这次故意报一个 iPhone 的 UA：默认名字从设备类型推，认人却从不看它（名字只是标签）。
  const page = await fetch(`${s.base}/mini?token=${TOKEN}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
  })
  const cred = credentialFrom(page)
  const secret = cred.slice(33)
  const [record] = records(file)
  assert.equal(record.kind, 'phone', "kind 恒为 'phone'（跨机落地时省一次文件迁移）")
  assert.equal(record.name, 'iOS', '默认名字从设备类型推——名字只是标签')
  assert.equal(record.keyHash, createHash('sha256').update(secret).digest('hex'),
    '落盘的必须是密钥的 SHA-256')

  // 读了这份文件也不能冒充已有设备：密钥那 32 个字符在文件里一个都找不到。
  const raw = readFileSync(file, 'utf8')
  assert.ok(!raw.includes(secret), '密钥明文落盘了——读了文件就能冒充')
  assert.ok(!raw.includes(cred), '整枚凭据落盘了')

  const before = await fetch(`${s.base}/mini/api/state`, {
    headers: { Cookie: `${DEVICE_COOKIE}=${cred}` },
  })
  assert.equal(before.status, 200, '删之前它是认的')

  // 撤销 = 把那条记录删掉。**不重启、也没有缓存窗口**，下一次请求就该失效。
  writeFileSync(file, `${JSON.stringify({ version: 1, devices: [] }, null, 2)}\n`)
  const after = await fetch(`${s.base}/mini/api/state`, {
    headers: { Cookie: `${DEVICE_COOKIE}=${cred}` },
  })
  assert.equal(after.status, 401, '记录删了，这枚凭据当场失效——这就是撤销的语义')
})
