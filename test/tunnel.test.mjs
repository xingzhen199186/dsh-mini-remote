/**
 * 公网隧道相关的单元测试。
 *
 * 真起一条隧道需要联网、还要等几十秒，不能放进常规测试里（我已经单独做过一次
 * 真机验证）。这里钉住的是那些**容易悄悄坏掉**的地方：正则的坑、限速分桶的
 * 归属、二进制找不到时的报错、以及配对面板多出来的那一条。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseTunnelUrl, startTunnel, TUNNEL_HINT } from '../lib/tunnel.js'
import { ensureCloudflared } from '../lib/cloudflared.js'
import { clientKey } from '../lib/server.js'

// ---------------------------------------------------------------------------
// 隧道失败时给用户的那句话
// 2026-09-22 实测：本机代理的 TUN 模式会掐断 cloudflared 到 Cloudflare 边缘的连接——
// cloudflared 好好活着，却一条 ESTABLISHED 都没有。用户看到「连不上」的第一反应是重试，
// 而正确的动作往往是关代理。少写这一句，他就会一直重试下去。
// ---------------------------------------------------------------------------

test('隧道失败的提示要点名代理/VPN 和 TUN 模式', () => {
  assert.match(TUNNEL_HINT, /代理或 VPN/, '不点名代理，用户不会想到去关它')
  assert.match(TUNNEL_HINT, /TUN 模式/, 'TUN 模式才是掐断连接的那个开关，得说具体')
})

test('隧道失败的提示要给一条走得通的路', () => {
  // 只说「关掉代理」是不够的：有些人关不了（工作网络），得告诉他还有别的路
  assert.match(TUNNEL_HINT, /Tailscale/)
})

test('隧道失败的提示不许说「关掉再打开一次」', () => {
  // 上一版的文案就是这句，而在代理掐断连接的场景下，重开多少次都一样——
  // 那是**误导**，比不说还糟。反向钉住，别再写回来。
  assert.doesNotMatch(TUNNEL_HINT, /关掉再打开/)
  assert.doesNotMatch(TUNNEL_HINT, /重试一次就/)
})
import { buildPairing, tailscaleNotice, tunnelUrlFor, tunnelProbeVerdict } from '../lib/pairing.js'

// ---------------------------------------------------------------------------
// 自测失败时：是隧道坏了，还是本机 DNS 坏了
// 2026-09-22 实测：隧道好好的（cloudflared 连着 3 条边缘连接、公共 DNS 都解析得出、
// 强制指到真实 IP 打过去是 200），只有本机路由器解析不了 *.trycloudflare.com。
// 这两种必须分开：判成「隧道坏了」会把一条能用的网址收走。
// ---------------------------------------------------------------------------

test('DNS 解析不了：判成 dns，不许判死', () => {
  assert.equal(tunnelProbeVerdict('ENOTFOUND'), 'dns')
  assert.equal(tunnelProbeVerdict('EAI_AGAIN'), 'dns')
})

test('真连不上：判成 dead，该收回网址', () => {
  assert.equal(tunnelProbeVerdict('UND_ERR_CONNECT_TIMEOUT'), 'dead')
  assert.equal(tunnelProbeVerdict('ECONNRESET'), 'dead')
  assert.equal(tunnelProbeVerdict('ECONNREFUSED'), 'dead')
})

test('拿不到错误码时：宁可当它坏了，也不要假装没事', () => {
  // 反过来（把坏隧道当成 DNS 问题）会让用户一直扫一条扫不开的码，
  // 那正是 1033 那次踩的坑。
  assert.equal(tunnelProbeVerdict(''), 'dead')
  assert.equal(tunnelProbeVerdict(undefined), 'dead')
})

// ---------------------------------------------------------------------------
// 隧道判死之后，网址要收回来
// 2026-09-22：用户照着一个写着「已开启」的面板去扫码，扫出来是 Cloudflare 的
// Error 1033——cloudflared 进程活着，但它到边缘的连接早断了。插件只认「网址打印
// 出来了」，所以一直显示「已开启」。
// ---------------------------------------------------------------------------

test('隧道通着：网址照给', () => {
  assert.equal(tunnelUrlFor(true, 'https://a-b-c.trycloudflare.com'), 'https://a-b-c.trycloudflare.com')
})

test('还不知道通不通（刚起来）：网址先给，别误伤', () => {
  // 刚拿到网址那几秒本来就可能还没公布出去，这时候收回来会让用户白等一轮
  assert.equal(tunnelUrlFor(null, 'https://a-b-c.trycloudflare.com'), 'https://a-b-c.trycloudflare.com')
})

test('判死了：网址必须收回来，不许再画二维码', () => {
  // 收不回来的话，面板上会留一条扫不开的码——那正是用户踩的那个坑
  assert.equal(tunnelUrlFor(false, 'https://a-b-c.trycloudflare.com'), null)
})

test('没有网址就是没有，别把 undefined 漏给界面', () => {
  assert.equal(tunnelUrlFor(null, undefined), null)
  assert.equal(tunnelUrlFor(true, undefined), null)
})

// ---------------------------------------------------------------------------
// 从 cloudflared 的输出里挑网址
// ---------------------------------------------------------------------------

test('能从 cloudflared 的输出里挑出公网网址', () => {
  const out = 'INF Requesting new quick Tunnel on trycloudflare.com...\n'
    + 'INF +--------------------------------------------------------------------------------------------+\n'
    + 'INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\n'
    + 'INF |  https://tidy-lamp-brave-honest.trycloudflare.com                                          |\n'
    + 'INF +--------------------------------------------------------------------------------------------+\n'
  assert.equal(parseTunnelUrl(out), 'https://tidy-lamp-brave-honest.trycloudflare.com')
})

test('不会把 api.trycloudflare.com 当成用户该访问的网址', () => {
  // 这是真踩过的坑：输出里会先出现接口地址，它打不开。
  const out = 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded'
  assert.equal(parseTunnelUrl(out), null)
})

test('api. 先出现、真网址后出现时，要挑后面那个', () => {
  const out = 'Post "https://api.trycloudflare.com/tunnel" ok\n'
    + 'INF |  https://calm-river-slow-window.trycloudflare.com  |'
  assert.equal(parseTunnelUrl(out), 'https://calm-river-slow-window.trycloudflare.com')
})

test('网址被拆成两段写出来也认得出来', () => {
  // 抓取是在累积缓冲区里做的，所以拼接之后必须能匹配上
  const first = 'INF |  https://split-across-chunks-'
  const second = 'here.trycloudflare.com  |'
  assert.equal(parseTunnelUrl(first), null, '前半段本来就不完整，不该误报')
  assert.equal(parseTunnelUrl(first + second), 'https://split-across-chunks-here.trycloudflare.com')
})

test('没有网址时返回 null，而不是抛错或瞎猜', () => {
  assert.equal(parseTunnelUrl(''), null)
  assert.equal(parseTunnelUrl(null), null)
  assert.equal(parseTunnelUrl('ERR Failed to connect to the edge'), null)
})

// ---------------------------------------------------------------------------
// 限速分桶：隧道流量不能和本机共用同一个桶
// ---------------------------------------------------------------------------

function req(headers, remoteAddress = '127.0.0.1') {
  return { headers, socket: { remoteAddress } }
}

test('本机/局域网的请求按源地址分桶', () => {
  assert.equal(clientKey(req({}, '192.168.1.50'), null), 'src:192.168.1.50')
  assert.equal(clientKey(req({}, '127.0.0.1'), null), 'src:127.0.0.1')
})

test('隧道流量按真实客户端分桶，不按 127.0.0.1', () => {
  // 这条是核心：隧道进来的请求源地址全是 127.0.0.1，要是共用桶，
  // 公网上随便一个人错 5 次密码就能把机主自己的手机一起锁掉。
  const host = 'tidy-lamp-brave-honest.trycloudflare.com'
  const a = req({ host, 'cf-connecting-ip': '1.1.1.1' })
  const b = req({ host, 'cf-connecting-ip': '2.2.2.2' })
  assert.equal(clientKey(a, host), 'fwd:1.1.1.1')
  assert.equal(clientKey(b, host), 'fwd:2.2.2.2')
  assert.notEqual(clientKey(a, host), clientKey(b, host), '两个不同的公网客户端不能共用一个桶')
})

test('带端口的 Host 也认得出是隧道', () => {
  const host = 'tidy-lamp-brave-honest.trycloudflare.com'
  assert.equal(clientKey(req({ host: `${host}:443`, 'cf-connecting-ip': '1.1.1.1' }), host), 'fwd:1.1.1.1')
})

test('没有 cf-connecting-ip 时退回 x-forwarded-for 的第一段', () => {
  const host = 'a-b-c-d.trycloudflare.com'
  assert.equal(clientKey(req({ host, 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }), host), 'fwd:9.9.9.9')
})

test('Host 对不上隧道域名时，还是按源地址分桶', () => {
  const host = 'a-b-c-d.trycloudflare.com'
  // 有人从局域网伪造一个别的 Host：不能因此就按可伪造的头去分桶
  assert.equal(clientKey(req({ host: 'evil.example.com', 'cf-connecting-ip': '1.1.1.1' }), host), 'src:127.0.0.1')
  assert.equal(clientKey(req({ host, 'cf-connecting-ip': '1.1.1.1' }), null), 'src:127.0.0.1', '没开隧道时不做特殊处理')
})

test('隧道流量没带转发头时，退回源地址而不是崩掉', () => {
  const host = 'a-b-c-d.trycloudflare.com'
  assert.equal(clientKey(req({ host }), host), 'src:127.0.0.1')
})

// ---------------------------------------------------------------------------
// 找 cloudflared
// ---------------------------------------------------------------------------

test('配置里指的 cloudflared 不存在时，报错要说清是哪个路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mini-cf-'))
  const missing = join(dir, 'nope', 'cloudflared.exe')
  const found = await ensureCloudflared({ configuredPath: missing, dataDir: dir })
  assert.equal(found.path, null)
  assert.match(found.error, /cloudflaredPath/)
  assert.ok(found.error.includes(missing), '要把具体路径写出来，用户才知道去哪儿找')
})

test('配置里指的 cloudflared 存在就直接用，不去联网下载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mini-cf-'))
  const fake = join(dir, 'cloudflared.exe')
  writeFileSync(fake, 'not really an exe')
  const found = await ensureCloudflared({ configuredPath: fake, dataDir: dir })
  assert.equal(found.path, fake)
  assert.equal(found.source, 'configured')
})

// ---------------------------------------------------------------------------
// 起隧道失败时的表现
// ---------------------------------------------------------------------------

test('cloudflared 文件不存在时，startTunnel 要拒绝而不是挂住', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mini-cf-'))
  await assert.rejects(
    startTunnel({ binPath: join(dir, 'nope.exe'), port: 1 }),
    /cloudflared 起不来/,
  )
})

test('cloudflared 起手就退出时，报错要带上它最后说的话', async () => {
  // 拿 node 冒充 cloudflared：它会因为不认识 --no-autoupdate 立刻退出
  await assert.rejects(
    startTunnel({ binPath: process.execPath, port: 1 }),
    (err) => {
      assert.match(err.message, /提前退出/)
      assert.ok(err.message.length > 20, '要把 cloudflared 的输出带出来，否则用户没法排查')
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// 配对面板里的公网那条
// ---------------------------------------------------------------------------

test('隧道起来之后，配对面板多出一条公网地址，排在最后', async () => {
  const payload = await buildPairing({
    port: 3090,
    token: 'abc123',
    bound: [], // 故意不给内网地址，只看公网这条
    tunnel: { enabled: true, url: 'https://tidy-lamp-brave-honest.trycloudflare.com' },
  })
  assert.equal(payload.ok, true)
  assert.equal(payload.entries.length, 1)
  const [entry] = payload.entries
  assert.equal(entry.kind, 'public')
  assert.equal(entry.url, 'https://tidy-lamp-brave-honest.trycloudflare.com/mini?token=abc123')
  assert.match(entry.url, /^https:\/\//, '公网那条必须是 https')
  assert.match(entry.qr, /^data:image\/png;base64,/)
  assert.match(entry.hint, /每次重启/)
  assert.deepEqual(payload.tunnel, { enabled: true, up: true, starting: false, error: null })
})

test('隧道没开时，面板里不出现公网那条', async () => {
  const payload = await buildPairing({
    port: 3090,
    token: 'abc123',
    bound: [],
    tunnel: { enabled: false },
  })
  assert.equal(payload.ok, false)
  assert.match(payload.error, /bindAddress/, '这时候该说的是内网绑定的配置问题')
  assert.equal(payload.tunnel.enabled, false)
})

test('隧道开了但没起来，报错要指向隧道而不是网络', async () => {
  const payload = await buildPairing({
    port: 3090,
    token: 'abc123',
    bound: [],
    tunnel: { enabled: true, url: null, error: '所有下载源都没成功' },
  })
  assert.equal(payload.ok, false)
  assert.match(payload.error, /公网访问没起来/)
  assert.match(payload.error, /所有下载源都没成功/, '要把底层原因透出来')
})

// ---------------------------------------------------------------------------
// Tailscale 没装的时候，那一行不能「直接消失」
// ---------------------------------------------------------------------------

test('探到 Tailscale 时，不出现那行提示', () => {
  const notice = tailscaleNotice([{ kind: 'lan' }, { kind: 'tailscale' }], false)
  assert.equal(notice, null, '已经有了就别再劝人装')
})

test('没探到 Tailscale：那行要出现，并且带下载地址', () => {
  // 用户 2026-09-21 的原话是「如果用户没装，在手机遥控页面显示请先安装 tailscale，
  // 并且附上下载地址」。关键在于**它得出现**——原来那一行是直接不显示的，
  // 用户看到的不是「你没有 Tailscale」，而是「这里什么都没有」。
  const notice = tailscaleNotice([{ kind: 'lan' }], false)
  assert.ok(notice, '没探到就得给一句话，不能静默')
  assert.equal(notice.installed, false)
  assert.match(notice.download, /^https:\/\//, '下载地址要是 https')
  assert.match(notice.download, /tailscale\.com/, '指向官方站')
})

test('装了但没登录：说的是「没登录」，不是叫人家再装一遍', () => {
  // 这两种情况的下一步动作完全不同。合成一句「请安装 Tailscale」会让一个
  // 已经装了的人去重装——对非技术用户来说这就是白折腾一轮。
  const notice = tailscaleNotice([{ kind: 'lan' }], true)
  assert.equal(notice.installed, true)
})

// ---------------------------------------------------------------------------
// Tailscale 那条路上的 HTTPS 地址（2026-09-24）
// ---------------------------------------------------------------------------

test('serve 开着时，配对面板多出一条加密的 Tailscale 地址', async () => {
  const payload = await buildPairing({
    port: 3090,
    token: 'abc123',
    bound: [],
    serve: { installed: true, url: 'https://desktop-gbsdc68.tail0429e3.ts.net/' },
  })
  assert.equal(payload.ok, true)
  assert.equal(payload.entries.length, 1)
  const [entry] = payload.entries
  assert.equal(entry.kind, 'tailscale-https')
  // 尾斜杠不能拼成 `//mini`——serve 报出来的网址是带尾斜杠的。
  assert.equal(entry.url, 'https://desktop-gbsdc68.tail0429e3.ts.net/mini?token=abc123')
  assert.match(entry.qr, /^data:image\/png;base64,/)
  assert.match(entry.hint, /加密/, '要说清楚它和明文那条的区别在哪儿')
  assert.match(
    entry.hint,
    /通知|麦克风/,
    '还要说清楚加密能换来什么——否则用户看不出两条码为什么要并存',
  )
})

test('serve 没开时，不出现那条加密地址', async () => {
  const payload = await buildPairing({
    port: 3090,
    token: 'abc123',
    bound: [],
    serve: { installed: true, url: null, urlOfOtherPort: null },
  })
  assert.equal(payload.ok, false, 'bound 是空的，所以一条地址都没有')
  assert.ok(!payload.entries, '不该凭空冒出一条')
  assert.equal(payload.serve.on, false)
})

test('serve 配着、但指的是别的端口：不能当成本插件的地址', async () => {
  // serve 完全可能被用户拿去转发别的东西。指向别人的时候把地址摆到手机上，
  // 用户扫出来是另一个服务——比不给更糟。
  const payload = await buildPairing({
    port: 3090,
    token: 'abc123',
    bound: [],
    serve: { installed: true, url: null, urlOfOtherPort: 'https://x.ts.net/' },
  })
  assert.equal(payload.serve.on, false)
  assert.equal(
    payload.serve.urlOfOtherPort,
    'https://x.ts.net/',
    '要留着它，界面才说得出「配着，但指的是别的端口」而不是含糊的「没开」',
  )
})

test('serve 那个字段在**每一条**返回路径上都要有', async () => {
  // 第 26 轮吃过一次亏：tailscale 那个字段只在成功路径上带，失败的时候那一行
  // 又会整个消失，用户看到的是「这里什么都没有」，不知道自己缺了什么。
  //
  // 四种返回路径里能造出三种（「一条地址都没有」那种要求本机网卡全空，造不出来）。
  const cases = [
    ['成功', { port: 3090, token: 'a', bound: [], serve: { url: 'https://x.ts.net/' } }],
    ['隧道报错', { port: 3090, token: 'a', bound: [], tunnel: { enabled: true, error: '炸了' } }],
    ['绑定配置问题', { port: 3090, token: 'a', bound: [], tunnel: { enabled: false } }],
  ]
  for (const [name, opts] of cases) {
    const payload = await buildPairing(opts)
    assert.ok('serve' in payload, `${name} 那条返回路径上缺了 serve 字段`)
    assert.equal(typeof payload.serve.installed, 'boolean', `${name}：installed 该是布尔`)
  }
})

test('配对面板里始终带着 tailscale 这个字段，界面才有得判断', async () => {
  const payload = await buildPairing({
    port: 3090,
    token: 'abc123',
    bound: [],
    tunnel: { enabled: false },
  })
  assert.ok('tailscale' in payload, '字段必须在，null 也要在——界面靠它决定那一行显不显示')
})
