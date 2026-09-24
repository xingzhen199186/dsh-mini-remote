/**
 * Tailscale HTTPS 那条路的单测。
 *
 * 只测**纯函数**（抠链接、读状态、给失败分类）。真跑 `tailscale serve` 的那几条
 * （`serveState` / `serveEnable` / `serveDisable`）不在这里测：它们要起子进程、
 * 要求这台电脑装了 Tailscale 并登录、还依赖 tailnet 后台的一个设置——测起来慢，
 * 而且在别人机器上必然红。
 *
 * 这是这个项目用了三次的老办法（`tailscaleNotice`、`tunnelUrlFor`、
 * `tunnelProbeVerdict` 都是这么做的）：把判断从「取数据」里剥出来，判断单独测，
 * 取数据那条主路径被上游「payload 里始终带着这个字段」的断言连着。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  enableLinkFrom,
  readServeStatus,
  classifyEnableFailure,
  readBackendState,
  cliCandidates,
  runTailscale,
} from '../lib/serve.js'

// ---------------------------------------------------------------------------
// 从报错里抠出「开启 Serve」的链接
// ---------------------------------------------------------------------------

/** 2026-09-24 在真机上抓到的原文，一字未改。 */
const REAL_OUTPUT = [
  'Serve is not enabled on your tailnet.',
  'To enable, visit:',
  '',
  '\thttps://login.tailscale.com/f/serve?node=nKZqMyw1VE11CNTRL',
  '',
].join('\n')

test('从真实报错里抠出开启链接', () => {
  // 这是整个功能里门槛最高的一步——要去 tailnet 后台开一个一次性开关。
  // Tailscale 官方已经把它压缩成「点一下这个链接」，我们自己写一句
  // 「请到后台开启 Serve 功能」等于把门槛又加回去，还指错了路。
  assert.equal(
    enableLinkFrom(REAL_OUTPUT),
    'https://login.tailscale.com/f/serve?node=nKZqMyw1VE11CNTRL',
  )
})

test('链接里带的是节点 ID，不同机器的链接不一样', () => {
  // 抠的时候不能把 node 参数写死——那是本机的节点编号。
  const other = 'To enable, visit:\n\thttps://login.tailscale.com/f/serve?node=AAAABBBBCCCCDDDD\n'
  assert.equal(
    enableLinkFrom(other),
    'https://login.tailscale.com/f/serve?node=AAAABBBBCCCCDDDD',
  )
})

test('别的报错抠不出链接时给 null，不瞎编一个', () => {
  assert.equal(enableLinkFrom('connection refused'), null)
  assert.equal(enableLinkFrom(''), null)
  assert.equal(enableLinkFrom(undefined), null)
  // 长得像但不是开启链接的，也不能误认
  assert.equal(enableLinkFrom('https://login.tailscale.com/admin/machines'), null)
})

// ---------------------------------------------------------------------------
// 读 serve status
// ---------------------------------------------------------------------------

/** 2026-09-24 在真机上抓到的 `serve status --json` 原文。 */
const REAL_JSON = JSON.stringify({
  TCP: { 443: { HTTPS: true } },
  Web: {
    'desktop-gbsdc68.tail0429e3.ts.net:443': {
      Handlers: { '/': { Proxy: 'http://127.0.0.1:3090' } },
    },
  },
})

test('serve 指向我们那个端口：算「开着」，并且给出网址', () => {
  const s = readServeStatus(REAL_JSON, 3090)
  assert.equal(s.servingUs, true)
  assert.equal(s.url, 'https://desktop-gbsdc68.tail0429e3.ts.net/')
  assert.equal(s.proxyPort, 3090)
})

test('serve 配着、但指的是别的端口：不算「开着」，但网址要留着', () => {
  // serve 可以被用户拿去转发别的东西。指向别人的时候把地址摆到手机上，
  // 用户扫出来是另一个服务——比不给更糟。
  // 但也不能含糊地说一句「没开」：那会让用户以为是自己这台电脑不支持。
  // 所以网址仍然带回来，界面负责说清楚是「配着，但指的是别的端口」。
  const s = readServeStatus(REAL_JSON, 9999)
  assert.equal(s.servingUs, false)
  assert.equal(s.url, 'https://desktop-gbsdc68.tail0429e3.ts.net/', '网址要留着，交给界面去解释')
  assert.equal(s.proxyPort, 3090)
})

test('没配 serve 的时候是空的（真机上就是这个形状）', () => {
  const s = readServeStatus('{}', 3090)
  assert.deepEqual(s, { url: null, proxyPort: null, servingUs: false })
})

test('JSON 坏掉、或者根本不是对象：一律当成「没配」，不抛', () => {
  // 这条不能抛：它跑在配对面板的请求里，抛了整块面板就变成一条报错，
  // 用户连别的路都看不到了。
  for (const bad of ['', 'not json', 'null', '[]', '{"Web":null}', '{"Web":"x"}']) {
    assert.deepEqual(
      readServeStatus(bad, 3090),
      { url: null, proxyPort: null, servingUs: false },
      `喂 ${JSON.stringify(bad)} 时该安静地当成「没配」`,
    )
  }
})

test('Web 里塞了别人的域名：不认，别把别人的地址交出去', () => {
  // 只认 *.ts.net。格式不对的键直接跳过，不能当成我们的地址。
  const s = readServeStatus(JSON.stringify({
    Web: { 'evil.example.com:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3090' } } } },
  }), 3090)
  assert.equal(s.servingUs, false)
  assert.equal(s.url, null)
})

test('代理目标没写端口：不认，不能靠猜', () => {
  const s = readServeStatus(JSON.stringify({
    Web: { 'a.b.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1' } } } },
  }), 3090)
  assert.equal(s.servingUs, false)
  assert.equal(s.proxyPort, null)
})

// ---------------------------------------------------------------------------
// 开失败时，到底是哪种失败
// ---------------------------------------------------------------------------

test('tailnet 没开 Serve：说清楚，并把开启链接带出来', () => {
  // 这是最要紧的一支：用户点了一下开关，结果发现要去后台开个东西。
  const r = classifyEnableFailure(REAL_OUTPUT, false)
  assert.equal(r.reason, 'tailnet')
  assert.equal(r.enableLink, 'https://login.tailscale.com/f/serve?node=nKZqMyw1VE11CNTRL')
  assert.match(r.error, /一次性/, '要告诉用户这是个一次性的开关，开过就不用再开了')
  assert.match(r.error, /开一下/, '要给出下一步该做什么')
})

test('没装 Tailscale：指的是「去装」，不是「去后台开」', () => {
  const r = classifyEnableFailure('', true)
  assert.equal(r.reason, 'missing')
  assert.equal(r.enableLink, null)
  assert.match(r.error, /没装/)
})

test('别的失败：把原始输出带出来，不吞', () => {
  const r = classifyEnableFailure('some unexpected failure', false)
  assert.equal(r.reason, 'other')
  assert.equal(r.enableLink, null)
  assert.match(r.error, /some unexpected failure/, '原文要照登，否则用户没法排查')
})

test('别的失败但没有任何输出：也要有一句人话', () => {
  const r = classifyEnableFailure('', false)
  assert.equal(r.reason, 'other')
  assert.ok(r.error.length > 10)
  assert.match(r.error, /没有输出/)
})

test('原始输出太长要截断，不能把整篇甩到面板上', () => {
  const r = classifyEnableFailure('x'.repeat(5000), false)
  assert.ok(r.error.length < 400, `截断后还这么长：${r.error.length}`)
})

test('链接优先于「没装」——两个条件都像时，先给能用的那条路', () => {
  // 真出现这种组合的话（比如命令报错顺带提了链接），给出链接比说「去装」
  // 更有用：装了的人被告知去装一遍，是白折腾一轮。
  const r = classifyEnableFailure(REAL_OUTPUT, true)
  assert.equal(r.reason, 'tailnet')
  assert.ok(r.enableLink)
})

// ---------------------------------------------------------------------------
// 「没登录」和「没开 Serve」是两回事
// ---------------------------------------------------------------------------

test('没登录时：读得出状态，并且把登录链接带出来', () => {
  // 这两件事的下一步动作完全不同，而都发生在浏览器里、都得用户自己动手。
  // 笼统说一句「没开」，一个还没登录的人会反复点开关——怎么点都不会有反应，
  // 因为那个地址要登录之后才存在。
  const r = readBackendState(JSON.stringify({
    BackendState: 'NeedsLogin',
    AuthURL: 'https://login.tailscale.com/a/abc123def456',
    HaveNodeKey: false,
  }))
  assert.equal(r.state, 'NeedsLogin')
  assert.equal(r.authUrl, 'https://login.tailscale.com/a/abc123def456')
})

test('登录着的时候没有登录链接，也不会瞎编一个', () => {
  const r = readBackendState(JSON.stringify({
    BackendState: 'Running',
    AuthURL: '',
    HaveNodeKey: true,
  }))
  assert.equal(r.state, 'Running')
  assert.equal(r.authUrl, null, '空串要变成 null，不能原样交给 href')
})

test('不是 https 的地址不要——它会被塞进 href 里', () => {
  const r = readBackendState(JSON.stringify({
    BackendState: 'NeedsLogin',
    AuthURL: 'javascript:alert(1)',
  }))
  assert.equal(r.authUrl, null)
})

test('JSON 坏掉、或者根本不是对象：安静地返回空，不抛', () => {
  // 它跑在配对面板的请求里，抛了整块面板就变成一条报错。
  for (const bad of ['', 'not json', 'null', '[]', '"x"']) {
    assert.deepEqual(
      readBackendState(bad),
      { state: null, authUrl: null },
      `喂 ${JSON.stringify(bad)} 时该安静地返回空`,
    )
  }
})

test('BackendState 不是字符串时也给 null，不把奇怪的东西当状态', () => {
  assert.equal(readBackendState('{"BackendState":123}').state, null)
  assert.equal(readBackendState('{}').state, null)
})

// ---------------------------------------------------------------------------
// 找得到命令，而且别让用户干等
// ---------------------------------------------------------------------------

test('找 tailscale：PATH 之外，还认常见安装位置', () => {
  // 原来写死成 'tailscale'、靠 PATH。这台电脑 PATH 里有，所以一直没出问题——
  // 但别人完全可能装在别处，那对他来说就是「插件说找不到 Tailscale」，而其实装着呢。
  const c = cliCandidates()
  assert.ok(c.includes('tailscale'), 'PATH 那条要在')
  assert.ok(c.length >= 2, '不能只有 PATH 一条')
  if (process.platform === 'win32') {
    assert.ok(c.some((x) => /Tailscale[\\/]tailscale\.exe$/i.test(x)), 'Windows 上要认安装目录')
  }
})

test('环境变量指定的命令排在最前面', () => {
  const before = process.env.DSH_MINI_REMOTE_TAILSCALE
  process.env.DSH_MINI_REMOTE_TAILSCALE = '/somewhere/else/tailscale'
  try {
    assert.equal(cliCandidates()[0], '/somewhere/else/tailscale')
  } finally {
    if (before === undefined) delete process.env.DSH_MINI_REMOTE_TAILSCALE
    else process.env.DSH_MINI_REMOTE_TAILSCALE = before
  }
})

test('命令打印完链接就挂着时：一秒上下收工，不等满超时', async () => {
  // 2026-09-24 实测：tailnet 没开 Serve 时，`tailscale serve --bg 3090` 会把提示
  // 打印出来，然后**一直挂着不退出**（当时挂了 180 秒没退）。只等回调的话，用户
  // 点一下开关要干等 15 秒才看到那条链接——而他明明一秒前就能看到。
  //
  // 让 node 扮演那个「打印完就挂着」的命令，把真实行为复现出来。
  const script = [
    'console.error("Serve is not enabled on your tailnet.")',
    'console.error("To enable, visit:")',
    'console.error("\\thttps://login.tailscale.com/f/serve?node=AAAABBBBCCCCDDDD")',
    'setTimeout(function () {}, 60000)',
  ].join(';')
  const before = process.env.DSH_MINI_REMOTE_TAILSCALE
  process.env.DSH_MINI_REMOTE_TAILSCALE = process.execPath
  try {
    const t0 = Date.now()
    const r = await runTailscale(['-e', script], 15000, {
      stopWhen: (out) => Boolean(enableLinkFrom(out)),
    })
    const ms = Date.now() - t0
    assert.equal(r.stopped, true, '应该是我们叫停的，不是它自己跑完的')
    assert.ok(r.out.includes('login.tailscale.com/f/serve?node=AAAABBBBCCCCDDDD'), '链接要留着')
    assert.ok(ms < 5000, `等太久了：${ms}ms（该是一秒上下，不该接近 15 秒）`)
    // 叫停的必须当失败处理——命令是被我们杀的，serve 并没有开成。
    const f = classifyEnableFailure(r.out, r.missing)
    assert.equal(f.reason, 'tailnet')
    assert.ok(f.enableLink, '用户要的就是这条链接')
  } finally {
    if (before === undefined) delete process.env.DSH_MINI_REMOTE_TAILSCALE
    else process.env.DSH_MINI_REMOTE_TAILSCALE = before
  }
})