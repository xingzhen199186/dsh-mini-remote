import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  normalizeRelayConfig,
  buildFrpcConfig,
  publicUrlOf,
  createSelfRelay,
} from '../lib/self-relay.js'

const valid = {
  serverAddr: 'relay.example.com',
  serverPort: 443,
  token: 'secret-token',
  publicHost: 'remote.example.com',
  transport: 'wss',
}

test('自建中继：wss/443 的配置写成 frpc 能读的 TOML', () => {
  const { errors, config } = normalizeRelayConfig(valid)
  assert.deepEqual(errors, [])
  const text = buildFrpcConfig(config, 3090)
  assert.match(text, /serverAddr = "relay\.example\.com"/)
  assert.match(text, /serverPort = 443/)
  assert.match(text, /transport\.protocol = "wss"/)
  assert.doesNotMatch(text, /transport\.websocket\.path/)
  assert.match(text, /customDomains = \["remote\.example\.com"\]/)
  assert.match(text, /localPort = 3090/)
  assert.match(text, /auth\.token = "secret-token"/)
  assert.equal(publicUrlOf(config), 'https://remote.example.com')
})

test('自建中继：tcp/7000 不写 websocket 路径', () => {
  const { errors, config } = normalizeRelayConfig({
    ...valid, serverPort: 7000, transport: 'tcp',
  })
  assert.deepEqual(errors, [])
  const text = buildFrpcConfig(config, 3090)
  assert.match(text, /transport\.protocol = "tcp"/)
  assert.doesNotMatch(text, /transport\.websocket\.path/)
})

test('自建中继：地址带协议/路径会归一化，坏输入会报清楚', () => {
  const ok = normalizeRelayConfig({
    ...valid,
    serverAddr: 'https://relay.example.com/abc',
    publicHost: 'https://remote.example.com/',
  })
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.config.serverAddr, 'relay.example.com')
  assert.equal(ok.config.publicHost, 'remote.example.com')

  const bad = normalizeRelayConfig({
    serverAddr: 'https://relay.example.com/path',
    serverPort: 443,
    token: '',
    publicHost: 'not a host',
    transport: 'tcp',
  })
  assert.ok(bad.errors.some((line) => line.includes('token')))
  assert.ok(bad.errors.some((line) => line.includes('公网地址')))
  assert.ok(bad.errors.some((line) => line.includes('443')))
})

test('自建中继：状态里不出现 token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-self-relay-'))
  const relay = createSelfRelay({ dataDir: dir, localPort: 3090, log: { info() {}, warn() {} } })
  relay.setConfig(normalizeRelayConfig(valid).config)
  const text = JSON.stringify(relay.status())
  assert.doesNotMatch(text, /secret-token/)
  assert.equal(relay.status().url, 'https://remote.example.com')
  relay.dispose()
})
