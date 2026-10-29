import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  B_REQUEST_TIMEOUT_MS,
  B_CONTROL_URL,
  createBRelayClient,
} from '../lib/b-relay-client.js'
import {
  loadOrCreateBRelayIdentity,
  saveBRelayIdentity,
  validateBRelayIdentity,
} from '../lib/b-relay-identity.js'
import {
  BRelayProvider,
  bTunnelArgs,
  startBCloudflared,
} from '../lib/b-relay-provider.js'

const HOSTNAME = 'abcdefghijklmnopqrstuvwxyz.dsh-everywhere.com'
const TOKEN = 'tunnel-token-must-stay-private'

function fakeTimers() {
  const jobs = []
  let nextId = 0
  return {
    jobs,
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
      assert.ok(job, '应该有一个待执行的计时器')
      job.cancelled = true
      job.fn()
      await new Promise((resolve) => setImmediate(resolve))
      return job
    },
  }
}

function processImpl() {
  const calls = []
  const handles = []
  const startProcess = async (input) => {
    calls.push(input)
    const handle = {
      stopped: false,
      input,
      exit: null,
      stop() { this.stopped = true },
      onExit(cb) { this.exit = cb },
    }
    handles.push(handle)
    return handle
  }
  return { calls, handles, startProcess }
}

function activeClient(overrides = {}) {
  return {
    claimCalls: 0,
    renewCalls: [],
    releaseCalls: 0,
    retireCalls: 0,
    async claim(input) {
      this.claimCalls += 1
      this.lastClaim = input
      return {
        ok: true,
        id: 'abcdefghijklmnopqrstuvwxyz',
        hostname: HOSTNAME,
        tunnelToken: TOKEN,
        state: 'active',
        ...overrides,
      }
    },
    async renew(input) {
      this.renewCalls.push(input)
      return { ok: true, state: 'active' }
    },
    async release() {
      this.releaseCalls += 1
      return { ok: true, state: 'released', releasedAt: 100, retainUntil: 200 }
    },
    async retire() {
      this.retireCalls += 1
      return { ok: true, state: 'retired' }
    },
  }
}

async function makeIdentity(dir) {
  return loadOrCreateBRelayIdentity(dir)
}

test('client 固定控制面地址、8 秒超时并保留错误 code/retryable/retryAfter', async () => {
  assert.equal(B_CONTROL_URL, 'https://control.dsh-everywhere.com')
  assert.equal(B_REQUEST_TIMEOUT_MS, 8_000)
  const identity = {
    clientSecret: 'a'.repeat(43),
    claimRequestId: 'claim-request-0001',
    id: 'abcdefghijklmnopqrstuvwxyz',
  }
  const seen = []
  const client = createBRelayClient({
    identity,
    fetchFn: async (url, init) => {
      seen.push({ url, init })
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => (name === 'retry-after' ? '12' : null) },
        json: async () => ({ ok: false, code: 'rate_limited', retryable: true, requestId: 'req-1' }),
      }
    },
  })
  const result = await client.status()
  assert.deepEqual(result, {
    ok: false,
    status: 429,
    code: 'rate_limited',
    retryable: true,
    retryAfter: 12,
    retryAfterMs: 12_000,
  })
  assert.equal(seen[0].url, 'https://control.dsh-everywhere.com/api/b/v1/status')
  assert.equal(seen[0].init.method, 'POST')
  assert.equal(JSON.parse(seen[0].init.body).clientSecret, identity.clientSecret)
})

test('client 的五条 API 都走固定控制面，契约路径和方法正确', async () => {
  const identity = {
    clientSecret: 'a'.repeat(43),
    claimRequestId: 'claim-request-0001',
    id: 'abcdefghijklmnopqrstuvwxyz',
  }
  const seen = []
  const client = createBRelayClient({
    identity,
    fetchFn: async (url, init) => {
      seen.push({ url, method: init.method, body: JSON.parse(init.body) })
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true, state: 'active' }),
      }
    },
  })
  await client.claim({ activationCode: 'activation-code', originPort: 3090 })
  await client.status()
  await client.renew({ originPort: 3091 })
  await client.release()
  await client.retire()
  assert.deepEqual(seen.map((one) => one.method + ' ' + new URL(one.url).pathname), [
    'PUT /api/b/v1/claim',
    'POST /api/b/v1/status',
    'POST /api/b/v1/renew',
    'POST /api/b/v1/release',
    'POST /api/b/v1/retire',
  ])
  assert.ok(seen.every((one) => one.url.startsWith('https://control.dsh-everywhere.com/')))
  assert.deepEqual(seen[0].body, {
    activationCode: 'activation-code',
    clientSecret: identity.clientSecret,
    claimRequestId: identity.claimRequestId,
    originPort: 3090,
  })
  assert.equal(seen[1].body.id, identity.id)
  assert.equal(seen[2].body.originPort, 3091)
})

test('本机身份首次生成、可重复读取；损坏时抛错且不覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-b-identity-'))
  const created = await makeIdentity(dir)
  assert.equal(validateBRelayIdentity(created), true)
  assert.match(created.clientSecret, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(created.id, null)
  const again = await makeIdentity(dir)
  assert.equal(again.clientSecret, created.clientSecret)
  assert.equal(again.claimRequestId, created.claimRequestId)

  const path = join(dir, 'b-identity.json')
  writeFileSync(path, '{broken', 'utf8')
  const before = readFileSync(path, 'utf8')
  assert.throws(() => loadOrCreateBRelayIdentity(dir), /B 本地身份文件读不出来/)
  assert.equal(readFileSync(path, 'utf8'), before, '损坏的身份文件不能被悄悄替换')
})

test('claim 成功：返回 running、保存 id/hostname，snapshot 不含 tunnel token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-b-provider-'))
  const identity = await makeIdentity(dir)
  const client = activeClient()
  const process = processImpl()
  const logs = []
  let saved = null
  const provider = new BRelayProvider({
    client,
    identity,
    saveIdentity: async (value) => { saved = JSON.parse(JSON.stringify(value)) },
    startProcess: process.startProcess,
    log: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
    maxRestarts: 3,
  })

  const snapshot = await provider.start({ activationCode: 'code', originPort: 3090 })
  assert.equal(JSON.stringify(logs).includes(TOKEN), false, '日志里不许出现 tunnel token')
  assert.equal(snapshot.state, 'running')
  assert.equal(snapshot.hostname, HOSTNAME)
  assert.equal(snapshot.url, 'https://' + HOSTNAME)
  assert.equal(client.claimCalls, 1)
  assert.equal(client.lastClaim.originPort, 3090)
  assert.equal(process.calls[0].token, TOKEN)
  assert.equal(JSON.stringify(snapshot).includes(TOKEN), false, 'snapshot 不许带 tunnel token')
  assert.equal(saved.id, 'abcdefghijklmnopqrstuvwxyz')
  assert.equal(saved.hostname, HOSTNAME)
  assert.equal(JSON.stringify(saved).includes(TOKEN), false, '身份文件不许存 tunnel token')
})

test('cloudflared 参数不含 token，token 只从子进程环境变量传入', async () => {
  const args = bTunnelArgs()
  assert.deepEqual(args, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4', 'run'])
  assert.equal(args.join(' ').includes(TOKEN), false)

  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => { child.killed = true }
  let spawned = null
  const pending = startBCloudflared({
    binPath: 'cloudflared-test',
    token: TOKEN,
    publicUrl: 'https://' + HOSTNAME,
    spawnFn: (bin, argv, options) => {
      spawned = { bin, argv, options }
      return child
    },
    readyTimeoutMs: 1000,
  })
  queueMicrotask(() => child.stderr.emit('data', 'Registered tunnel connection conn-1'))
  const handle = await pending
  assert.equal(spawned.bin, 'cloudflared-test')
  assert.equal(spawned.argv.join(' ').includes(TOKEN), false, 'token 不许出现在命令行参数')
  assert.equal(spawned.options.env.TUNNEL_TOKEN, TOKEN)
  assert.equal(handle.url, 'https://' + HOSTNAME)
  handle.stop()
  assert.equal(child.killed, true)
})

test('没有激活码时也交给服务端判断，本地不再直接拒绝', async () => {
  const identity = loadOrCreateBRelayIdentity(mkdtempSync(join(tmpdir(), 'b-relay-nocode-')), null)
  const client = activeClient()
  const proc = processImpl()
  const provider = new BRelayProvider({
    client,
    identity,
    startProcess: proc.startProcess,
  })
  const snapshot = await provider.start({ activationCode: '', originPort: 3090 })
  assert.equal(snapshot.state, 'running')
  assert.equal(client.lastClaim.activationCode, '')
})

test('手动重连只重启 cloudflared，不重新 claim', async () => {
  const identity = loadOrCreateBRelayIdentity(mkdtempSync(join(tmpdir(), 'b-relay-reconnect-')), null)
  const client = activeClient()
  const proc = processImpl()
  const provider = new BRelayProvider({ client, identity, startProcess: proc.startProcess })
  const first = await provider.start({ activationCode: 'code', originPort: 3090 })
  assert.equal(first.state, 'running')
  assert.equal(proc.calls.length, 1)
  const second = await provider.reconnect()
  assert.equal(second.state, 'running')
  assert.equal(client.claimCalls, 1, '重连不许重新 claim')
  assert.equal(proc.calls.length, 2)
  assert.equal(proc.handles[0].stopped, true, '旧进程要停掉')
})

test('进程退出后按退避重启，但不重新 claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-b-restart-'))
  const identity = await makeIdentity(dir)
  const client = activeClient()
  const process = processImpl()
  const timer = fakeTimers()
  const changes = []
  const provider = new BRelayProvider({
    client,
    identity,
    saveIdentity: async () => {},
    startProcess: process.startProcess,
    onChange: (snapshot) => changes.push(snapshot.state),
    timer,
    now: () => 1000,
    random: () => 0.5,
    maxRestarts: 3,
    baseDelayMs: 100,
  })

  await provider.start({ activationCode: 'code', originPort: 3090 })
  assert.equal(process.calls.length, 1)
  process.handles[0].exit(1)
  let snapshot = provider.snapshot()
  assert.equal(snapshot.state, 'error')
  assert.equal(snapshot.restarting, true)
  assert.ok(snapshot.nextRetryAt > 1000)
  assert.equal(client.claimCalls, 1)

  await timer.runNext()
  snapshot = provider.snapshot()
  assert.equal(snapshot.state, 'running')
  assert.equal(process.calls.length, 2)
  assert.equal(process.calls[1].token, TOKEN)
  assert.equal(client.claimCalls, 1, '进程重连不许重新 claim')
  assert.ok(changes.includes('error'))
})

test('stop 停止进程并 release，不调用 retire；重复 stop 不重复 release', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-b-stop-'))
  const identity = await makeIdentity(dir)
  const client = activeClient()
  const process = processImpl()
  const provider = new BRelayProvider({
    client,
    identity,
    saveIdentity: async () => {},
    startProcess: process.startProcess,
  })
  await provider.start({ activationCode: 'code', originPort: 3090 })
  const released = await provider.stop()
  assert.equal(released.state, 'released')
  assert.equal(process.handles[0].stopped, true)
  assert.equal(client.releaseCalls, 1)
  assert.equal(client.retireCalls, 0, '停止不是 retire，不能自动删除资源')
  await provider.stop()
  assert.equal(client.releaseCalls, 1)
})

test('claim 失败只落到 B 自己的 error 状态，保留错误码与重试提示', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-b-error-'))
  const identity = await makeIdentity(dir)
  const client = activeClient()
  client.claim = async () => ({
    ok: false,
    status: 429,
    code: 'rate_limited',
    retryable: true,
    retryAfter: 20,
  })
  const provider = new BRelayProvider({
    client,
    identity,
    saveIdentity: async () => {},
    startProcess: async () => { throw new Error('不该启动进程') },
  })
  await assert.doesNotReject(() => provider.start({ activationCode: 'code', originPort: 3090 }))
  const snapshot = provider.snapshot()
  assert.equal(snapshot.state, 'error')
  assert.equal(snapshot.errorCode, 'rate_limited')
  assert.equal(snapshot.retryable, true)
  assert.equal(snapshot.retryAfter, 20)
  assert.match(snapshot.lastError, /20 秒/)
  assert.equal(JSON.stringify(snapshot).includes(TOKEN), false)
})

test('重新启动时端口变了：先按原端口 claim，再 renew 到新端口', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-b-renew-'))
  const identity = await makeIdentity(dir)
  const client = activeClient()
  const process = processImpl()
  const provider = new BRelayProvider({
    client,
    identity,
    saveIdentity: async () => {},
    startProcess: process.startProcess,
  })
  await provider.start({ activationCode: 'code', originPort: 3090 })
  await provider.stop({ release: false })
  await provider.start({ activationCode: 'code', originPort: 3091 })
  assert.equal(client.claimCalls, 2)
  assert.equal(client.lastClaim.originPort, 3090, 'claim 幂等键要沿用第一次的端口')
  assert.deepEqual(client.renewCalls, [{ originPort: 3091 }])
  assert.equal(identity.originPort, 3091)
  assert.equal(process.calls.length, 2)
})
