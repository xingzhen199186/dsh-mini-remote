import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROXY_BYPASS_DOMAINS,
  detectProxy,
  ensureSystemProxyBypass,
  restoreSystemProxyBypass,
  pickPhysicalIPv4,
  proxyBypassRulesText,
} from '../lib/proxy-compat.js'

const KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`

function registryOutput({ enabled = '0x1', server = '127.0.0.1:7890', override = '<local>' } = {}) {
  return [
    '',
    `    ProxyEnable    REG_DWORD    ${enabled}`,
    `    ProxyServer    REG_SZ    ${server}`,
    ...(override === null ? [] : [`    ProxyOverride    REG_SZ    ${override}`]),
    '',
  ].join('\r\n')
}

function fakeRegistry(initial = {}) {
  const state = {
    enabled: initial.enabled ?? '0x1',
    server: initial.server ?? '127.0.0.1:7890',
    override: initial.override ?? '<local>',
  }
  const calls = []
  const execFileSync = (file, args) => {
    calls.push({ file, args })
    if (args[0] === 'query') return registryOutput(state)
    if (args[0] === 'add') {
      assert.equal(args[1], KEY)
      assert.equal(args[3], 'ProxyOverride')
      state.override = args[7]
      return ''
    }
    throw new Error('unexpected reg call')
  }
  return { state, calls, execFileSync }
}

test('detectProxy 读取 Windows 系统代理、环境变量和 TUN 名称', () => {
  const registry = fakeRegistry()
  const result = detectProxy({
    platform: 'win32',
    env: {
      HTTPS_PROXY: 'http://user:password@127.0.0.1:7890',
      NO_PROXY: 'localhost',
    },
    execFileSync: registry.execFileSync,
    networkInterfaces: () => ({
      Ethernet: [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
      'Clash TUN': [{ family: 'IPv4', address: '198.18.0.1', internal: false }],
      'WireGuard Tunnel': [],
    }),
  })
  assert.deepEqual(result, {
    systemProxy: true,
    proxyServer: '127.0.0.1:7890',
    envProxy: true,
    tun: true,
    tunNames: ['Clash TUN', 'WireGuard Tunnel'],
    bypassDomains: [...PROXY_BYPASS_DOMAINS],
  })
  assert.equal(JSON.stringify(result).includes('password'), false)
})

test('detectProxy 在非 Windows 不调用 reg，注册表或网卡读取失败也不抛出', () => {
  let called = false
  const nonWindows = detectProxy({
    platform: 'linux',
    execFileSync: () => { called = true; throw new Error('must not run') },
    networkInterfaces: () => ({}),
  })
  assert.equal(nonWindows.systemProxy, false)
  assert.equal(called, false)

  const failed = detectProxy({
    platform: 'win32',
    execFileSync: () => { throw new Error('reg unavailable') },
    networkInterfaces: () => { throw new Error('interfaces unavailable') },
  })
  assert.equal(failed.systemProxy, false)
  assert.equal(failed.tun, false)
  assert.deepEqual(failed.tunNames, [])
})

test('ensureSystemProxyBypass 只追加缺失域名并保留原始顺序', () => {
  const registry = fakeRegistry({ override: '<local>;*.trycloudflare.com' })
  const result = ensureSystemProxyBypass({ platform: 'win32', execFileSync: registry.execFileSync })
  assert.equal(result.changed, true)
  assert.equal(result.original, '<local>;*.trycloudflare.com')
  assert.equal(result.current, registry.state.override)
  assert.ok(result.current.startsWith('<local>;*.trycloudflare.com;'))
  assert.equal(result.domains.includes('*.trycloudflare.com'), false, '已有 *.domain 不应重复追加')
  assert.deepEqual(result.domains, PROXY_BYPASS_DOMAINS.flatMap((domain) => [domain, '*.' + domain]).filter((entry) => entry !== '*.trycloudflare.com'))
  assert.equal(registry.calls.filter((call) => call.args[0] === 'add').length, 1)
  assert.equal(registry.calls.some((call) => call.args.includes('ProxyEnable') || call.args.includes('ProxyServer')), false)
})

test('ensureSystemProxyBypass 已齐全时不写注册表，系统代理关闭时也不写', () => {
  const completeEntries = PROXY_BYPASS_DOMAINS.flatMap((domain) => [domain, '*.' + domain])
  const complete = fakeRegistry({ override: completeEntries.join(';') })
  const unchanged = ensureSystemProxyBypass({ platform: 'win32', execFileSync: complete.execFileSync })
  assert.equal(unchanged.changed, false)
  assert.equal(unchanged.current, completeEntries.join(';'))
  assert.equal(complete.calls.filter((call) => call.args[0] === 'add').length, 0)

  const disabled = fakeRegistry({ enabled: '0x0' })
  const skipped = ensureSystemProxyBypass({ platform: 'win32', execFileSync: disabled.execFileSync })
  assert.equal(skipped.changed, false)
  assert.equal(disabled.calls.filter((call) => call.args[0] === 'add').length, 0)
})

test('ensure/restore 的 reg 失败只返回错误状态', () => {
  const failure = () => { throw new Error('access denied') }
  const ensured = ensureSystemProxyBypass({ platform: 'win32', execFileSync: failure })
  assert.equal(ensured.changed, false)
  assert.match(ensured.error, /access denied/)
  const restored = restoreSystemProxyBypass('<local>', { platform: 'win32', execFileSync: failure })
  assert.deepEqual(restored, { ok: false, error: 'access denied' })
})

test('restoreSystemProxyBypass 恢复原 ProxyOverride，不碰其他值', () => {
  const registry = fakeRegistry({ override: 'changed' })
  const result = restoreSystemProxyBypass('<local>;localhost', {
    platform: 'win32',
    execFileSync: registry.execFileSync,
  })
  assert.deepEqual(result, { ok: true, error: null })
  assert.equal(registry.state.override, '<local>;localhost')
  assert.equal(registry.state.enabled, '0x1')
  assert.equal(registry.state.server, '127.0.0.1:7890')
})

test('pickPhysicalIPv4 排除虚拟网卡并优先常见私网地址', () => {
  const interfaces = {
    'Mihomo TUN': [{ family: 'IPv4', address: '198.18.0.1', internal: false }],
    Ethernet: [{ family: 'IPv4', address: '8.8.8.8', internal: false }],
    WLAN: [
      { family: 'IPv6', address: 'fe80::1', internal: false },
      { family: 'IPv4', address: '192.168.31.2', internal: false },
    ],
    'sing-box': [{ family: 'IPv4', address: '172.19.0.1', internal: false }],
  }
  assert.equal(pickPhysicalIPv4(interfaces), '192.168.31.2')
  assert.equal(pickPhysicalIPv4({ 'Wintun Userspace Tunnel': interfaces['Mihomo TUN'] }), null)
  assert.equal(pickPhysicalIPv4(() => interfaces), '192.168.31.2')
})

test('proxyBypassRulesText 可直接粘贴并包含进程和全部域名', () => {
  const lines = proxyBypassRulesText().split('\n')
  assert.equal(lines[0], 'PROCESS-NAME,cloudflared.exe,DIRECT')
  assert.deepEqual(lines.slice(1), PROXY_BYPASS_DOMAINS.map((domain) => `DOMAIN-SUFFIX,${domain},DIRECT`))
})
