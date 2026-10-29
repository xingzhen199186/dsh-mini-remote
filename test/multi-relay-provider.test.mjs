import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPairing } from '../lib/pairing.js'
import {
  createMultiRelayIdentity,
  loadMultiRelayIdentity,
  multiRelayIdentityPath,
  saveMultiRelayIdentity,
} from '../lib/multi-relay-identity.js'
import {
  MultiRelayProvider,
  startMultiRelayFrpc,
} from '../lib/multi-relay-provider.js'

const CONTROL = 'https://admin.relay.example.com'
const TENANT_ID = 'abcdefghijklmnopqrstuvwxyz'
const PUBLIC_HOST = `${TENANT_ID}.relay.example.com`
const CONTROL_HOST = `frp-${TENANT_ID}.relay.example.com`
const FRP_TOKEN = 'frp-token-test-value-1234567890'
const CLIENT_SECRET = 'a'.repeat(43)

function claimedIdentity(overrides = {}) {
  const identity = createMultiRelayIdentity(CONTROL)
  Object.assign(identity, {
    id: TENANT_ID,
    publicHost: PUBLIC_HOST,
    controlHost: CONTROL_HOST,
    frpsPort: 443,
    transport: 'wss',
    frpToken: FRP_TOKEN,
    clientSecret: CLIENT_SECRET,
  }, overrides)
  return identity
}

function fakeClient({ claimResult, releaseResult } = {}) {
  return {
    claimCalls: 0,
    releaseCalls: 0,
    async claim() {
      this.claimCalls += 1
      return claimResult ?? {
        ok: true,
        id: TENANT_ID,
        publicHost: PUBLIC_HOST,
        controlHost: CONTROL_HOST,
        frpsPort: 443,
        transport: 'wss',
        frpToken: FRP_TOKEN,
        tokenIssued: true,
      }
    },
    async status() {
      return { ok: true, tenant: { id: TENANT_ID, state: 'active' } }
    },
    async release() {
      this.releaseCalls += 1
      return releaseResult ?? { ok: true, tenant: { id: TENANT_ID, state: 'released' } }
    },
  }
}

function fakeProcesses() {
  const handles = []
  const calls = []
  const startProcess = async (input) => {
    calls.push(input)
    const handle = {
      input,
      stopped: false,
      exit: null,
      stop() { this.stopped = true },
      onExit(cb) { this.exit = cb },
    }
    handles.push(handle)
    return handle
  }
  return { handles, calls, startProcess }
}

function fakeTimers() {
  const jobs = []
  let nextId = 0
  return {
    setTimeout(fn, ms) {
      nextId += 1
      jobs.push({ id: nextId, fn, ms, cancelled: false })
      return nextId
    },
    clearTimeout(id) {
      const job = jobs.find((one) => one.id === id)
      if (job) job.cancelled = true
    },
    async runNext() {
      const job = jobs.find((one) => !one.cancelled)
      assert.ok(job, '应该有一个待执行的重连计时器')
      job.cancelled = true
      job.fn()
      await new Promise((resolve) => setImmediate(resolve))
      return job
    },
  }
}

test('首次 claim 成功：保存身份、只启动一次 frpc，snapshot/日志不含 token', async () => {
  const client = fakeClient()
  const process = fakeProcesses()
  const logs = []
  const saved = []
  const timer = fakeTimers()
  const provider = new MultiRelayProvider({
    client,
    identity: null,
    saveIdentity: async (identity) => saved.push(JSON.parse(JSON.stringify(identity))),
    startProcess: process.startProcess,
    onChange: () => {},
    log: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
    timer,
  })

  const snapshot = await provider.start({
    controlUrl: CONTROL,
    inviteCode: 'invite-code',
    originPort: 3090,
  })
  assert.equal(snapshot.state, 'running')
  assert.equal(snapshot.publicHost, PUBLIC_HOST)
  assert.equal(snapshot.url, `https://${PUBLIC_HOST}`)
  assert.equal(snapshot.reconnectable, true)
  assert.equal(snapshot.busy, false)
  assert.equal(client.claimCalls, 1)
  assert.equal(process.calls.length, 1)
  assert.equal(process.calls[0].token, FRP_TOKEN)
  assert.equal(process.calls[0].originPort, 3090)
  assert.equal(provider.identity.frpToken, FRP_TOKEN)
  assert.equal(saved.at(-1).publicHost, PUBLIC_HOST)
  assert.equal(saved.at(-1).frpToken, FRP_TOKEN)
  assert.equal(JSON.stringify(snapshot).includes(FRP_TOKEN), false)
  assert.equal(JSON.stringify(logs).includes(FRP_TOKEN), false)
  assert.equal(JSON.stringify(logs).includes('invite-code'), false)
})

test('已有身份和 token 时直接连，不重复 claim', async () => {
  const identity = claimedIdentity()
  const client = fakeClient()
  const process = fakeProcesses()
  const provider = new MultiRelayProvider({
    client,
    identity,
    saveIdentity: async () => {},
    startProcess: process.startProcess,
  })
  const snapshot = await provider.start({ controlUrl: CONTROL, originPort: 3090 })
  assert.equal(snapshot.state, 'running')
  assert.equal(client.claimCalls, 0)
  assert.equal(process.calls.length, 1)
})

test('reconnect 只重启本地 frpc，不 claim；退出后按退避自动重启', async () => {
  const identity = claimedIdentity()
  const client = fakeClient()
  const process = fakeProcesses()
  const timer = fakeTimers()
  const provider = new MultiRelayProvider({
    client,
    identity,
    saveIdentity: async () => {},
    startProcess: process.startProcess,
    timer,
    now: () => 1000,
    random: () => 0.5,
    maxRestarts: 3,
    baseDelayMs: 100,
  })
  await provider.start({ controlUrl: CONTROL, originPort: 3090 })
  const first = process.handles[0]
  await provider.reconnect({ originPort: 3091 })
  assert.equal(client.claimCalls, 0)
  assert.equal(process.calls.length, 2)
  assert.equal(first.stopped, true)

  process.handles[1].exit(1)
  assert.equal(provider.snapshot().state, 'error')
  assert.equal(provider.snapshot().restarting, true)
  await timer.runNext()
  assert.equal(provider.snapshot().state, 'running')
  assert.equal(process.calls.length, 3)
  assert.equal(client.claimCalls, 0)
})

test('claim 失败写 error 状态并保留身份种子，不启动 frpc', async () => {
  const client = fakeClient({
    claimResult: { ok: false, status: 403, code: 'invite_invalid', retryable: false },
  })
  const process = fakeProcesses()
  const saved = []
  const provider = new MultiRelayProvider({
    client,
    identity: null,
    saveIdentity: async (identity) => saved.push(JSON.parse(JSON.stringify(identity))),
    startProcess: process.startProcess,
  })
  const snapshot = await provider.start({
    controlUrl: CONTROL,
    inviteCode: 'used-code',
    originPort: 3090,
  })
  assert.equal(snapshot.state, 'error')
  assert.equal(snapshot.errorCode, 'invite_invalid')
  assert.match(snapshot.lastError, /邀请码无效/)
  assert.equal(snapshot.reconnectable, false)
  assert.equal(process.calls.length, 0)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].frpToken, null)
  assert.equal(JSON.stringify(snapshot).includes('used-code'), false)
})

test('frpc 起不来时进入 error 状态，身份保留可重连，错误里没有 token', async () => {
  const identity = claimedIdentity()
  const client = fakeClient()
  const provider = new MultiRelayProvider({
    client,
    identity,
    saveIdentity: async () => {},
    startProcess: async () => {
      throw Object.assign(new Error(`启动失败 ${FRP_TOKEN}`), { code: 'frpc_not_found' })
    },
  })
  const snapshot = await provider.start({ controlUrl: CONTROL, originPort: 3090 })
  assert.equal(snapshot.state, 'error')
  assert.equal(snapshot.errorCode, 'frpc_not_found')
  assert.equal(snapshot.reconnectable, true)
  assert.equal(JSON.stringify(snapshot).includes(FRP_TOKEN), false)
  assert.equal(client.claimCalls, 0)
})

test('stop 只停本地 frpc，不调用 release；显式 release 才调用并清 token', async () => {
  const identity = claimedIdentity()
  const client = fakeClient()
  const process = fakeProcesses()
  const saved = []
  const provider = new MultiRelayProvider({
    client,
    identity,
    saveIdentity: async (value) => saved.push(JSON.parse(JSON.stringify(value))),
    startProcess: process.startProcess,
  })
  await provider.start({ controlUrl: CONTROL, originPort: 3090 })
  const stopped = await provider.stop()
  assert.equal(stopped.state, 'idle')
  assert.equal(stopped.reconnectable, true)
  assert.equal(client.releaseCalls, 0)
  assert.equal(process.handles[0].stopped, true)

  const released = await provider.release()
  assert.equal(released.state, 'released')
  assert.equal(released.reconnectable, false)
  assert.equal(client.releaseCalls, 1)
  assert.equal(saved.at(-1).frpToken, null)
})

test('frpc 必须看到 start proxy success 才返回，参数不含 token', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => { child.killed = true }
  let spawned = null
  const pending = startMultiRelayFrpc({
    binPath: 'frpc-test',
    configFile: '/tmp/frpc.toml',
    publicUrl: `https://${PUBLIC_HOST}`,
    spawnFn: (bin, argv, options) => {
      spawned = { bin, argv, options }
      return child
    },
    readyTimeoutMs: 1000,
  })
  child.stderr.emit('data', 'login to server success')
  queueMicrotask(() => child.stderr.emit('data', 'start proxy success'))
  const handle = await pending
  assert.equal(spawned.bin, 'frpc-test')
  assert.deepEqual(spawned.argv, ['-c', '/tmp/frpc.toml'])
  assert.equal(spawned.argv.join(' ').includes(FRP_TOKEN), false)
  assert.equal(handle.url, `https://${PUBLIC_HOST}`)
  handle.stop()
  assert.equal(child.killed, true)
})

test('身份文件 0600 保存；损坏时读取返回错误而不抛异常', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-multi-relay-'))
  const identity = claimedIdentity()
  saveMultiRelayIdentity(dir, identity)
  const path = multiRelayIdentityPath(dir)
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600)
  }
  // 第二次保存要覆盖同一个文件（claim 成功前后各写一次）。
  saveMultiRelayIdentity(dir, { ...identity, frpToken: FRP_TOKEN + '-rotated' })
  assert.equal(loadMultiRelayIdentity(dir).identity.frpToken, FRP_TOKEN + '-rotated')
  saveMultiRelayIdentity(dir, identity)
  assert.equal(loadMultiRelayIdentity(dir).identity.publicHost, PUBLIC_HOST)

  writeFileSync(path, '{broken', 'utf8')
  const before = readFileSync(path, 'utf8')
  const broken = loadMultiRelayIdentity(dir)
  assert.equal(broken.identity, null)
  assert.match(broken.error, /读不出来|格式不对/)
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('配对面板只在 running 时增加 multi-relay 固定地址条目', async () => {
  const running = await buildPairing({
    port: 3090,
    token: 'abc123',
    bound: [],
    multiRelay: { state: 'running', publicHost: PUBLIC_HOST },
  })
  assert.equal(running.ok, true)
  const entry = running.entries.find((one) => one.kind === 'multi-relay')
  assert.ok(entry)
  assert.equal(entry.label, '公网（自建多用户）')
  assert.equal(entry.url, `https://${PUBLIC_HOST}/mini?token=abc123`)
  assert.match(entry.qr, /^data:image\/png;base64,/)

  const idle = await buildPairing({
    port: 3090,
    token: 'abc123',
    bound: [],
    multiRelay: { state: 'idle', publicHost: PUBLIC_HOST },
  })
  assert.equal((idle.entries ?? []).some((one) => one.kind === 'multi-relay'), false)
})
