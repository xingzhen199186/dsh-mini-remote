/**
 * 网卡识别测试。用的是本机实测到的那组真实地址——八个地址里只有两个能用，
 * 如果分类写错，用户会在启动日志里看到一堆废地址。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, reachableAddresses, resolveBindAddresses } from '../lib/net.js'

test('内网地址认得出来', () => {
  assert.equal(classify('以太网', '192.168.1.2'), 'lan')
  assert.equal(classify('Ethernet', '10.0.0.5'), 'lan')
  assert.equal(classify('Ethernet', '172.16.0.9'), 'lan')
  assert.equal(classify('Ethernet', '172.31.255.1'), 'lan')
})

test('172.32 已经不是内网了', () => {
  // 172.16~172.31 才是私有段，172.32 属于公网
  assert.equal(classify('Ethernet', '172.32.0.1'), null)
  assert.equal(classify('Ethernet', '172.15.0.1'), null)
})

test('Tailscale 的地址单独算一类', () => {
  assert.equal(classify('Tailscale', '100.92.105.99'), 'tailscale')
  assert.equal(classify('Tailscale', '100.64.0.1'), 'tailscale')
  assert.equal(classify('Tailscale', '100.127.255.254'), 'tailscale')
  // 100.128 出了 CGNAT 网段
  assert.equal(classify('Tailscale', '100.128.0.1'), null)
  assert.equal(classify('Tailscale', '100.63.0.1'), null)
})

test('没拿到 IP 的空网卡要丢掉', () => {
  assert.equal(classify('WLAN', '169.254.153.20'), null)
  assert.equal(classify('以太网 2', '169.254.12.23'), null)
  assert.equal(classify('蓝牙网络连接', '169.254.44.240'), null)
})

test('虚拟网卡要丢掉，哪怕它用的是内网地址段', () => {
  // 本机真实存在：WSL 的虚拟网卡自报 172.19.224.1，手机根本连不上
  assert.equal(classify('vEthernet (WSL (Hyper-V firewall))', '172.19.224.1'), null)
  assert.equal(classify('VMware Network Adapter VMnet1', '192.168.237.1'), null)
  assert.equal(classify('Docker Bridge', '172.17.0.1'), null)
})

test('公网地址不主动暴露', () => {
  assert.equal(classify('Ethernet', '8.8.8.8'), null)
  assert.equal(classify('Ethernet', '203.0.113.7'), null)
})

test('本机地址归为 loopback', () => {
  assert.equal(classify('Loopback', '127.0.0.1'), 'loopback')
  assert.equal(classify('lo', '127.0.0.53'), 'loopback')
})

test('真机扫描：只挑出能用的，内网排在 Tailscale 前面', () => {
  const addrs = reachableAddresses()

  for (const a of addrs) {
    assert.notEqual(a.kind, undefined)
    assert.ok(!a.address.startsWith('169.254.'), `不该出现空网卡地址 ${a.address}`)
    assert.ok(!a.address.startsWith('172.19.'), `不该出现 WSL 地址 ${a.address}`)
    assert.ok(a.address !== '127.0.0.1', '本机地址不列给手机')
  }

  // 本机确实有内网和 Tailscale，排序断言才有意义
  const kinds = addrs.map((a) => a.kind)
  if (kinds.includes('lan') && kinds.includes('tailscale')) {
    assert.ok(kinds.indexOf('lan') < kinds.indexOf('tailscale'), '内网应排在 Tailscale 前面')
  }
})

test('默认绑定：本机 + 能用的地址，绝不含废地址', () => {
  const binds = resolveBindAddresses('auto')
  assert.ok(binds.includes('127.0.0.1'), '本机必须在，配对页要打得开')
  assert.equal(new Set(binds).size, binds.length, '不该有重复')
  for (const b of binds) {
    assert.ok(!b.startsWith('169.254.'), `不该绑空网卡 ${b}`)
    assert.ok(!b.startsWith('172.19.'), `不该绑 WSL ${b}`)
  }
})

test('显式指定地址时照办，不做自动探测', () => {
  assert.deepEqual(resolveBindAddresses('0.0.0.0'), ['0.0.0.0'])
  assert.deepEqual(resolveBindAddresses('127.0.0.1'), ['127.0.0.1'])
  assert.deepEqual(resolveBindAddresses('192.168.1.50'), ['192.168.1.50'])
})
