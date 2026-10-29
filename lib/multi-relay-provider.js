/**
 * 自建多用户中继的本地状态机：claim → 写 frpc 配置 → 起 frpc → 有界重连。
 *
 * frpToken 只放在本机身份和 0600 的 frpc 配置里；snapshot 和日志都不含 token。
 * stop 只停本地 frpc；release 是明确动作，才会调用服务端 /api/release。
 */
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { backoffDelay } from './tunnel-supervisor.js'
import { buildFrpcConfig, findFrpc } from './self-relay.js'
import {
  createMultiRelayClient,
  multiRelayErrorMessage,
  normalizeControlUrl,
} from './multi-relay-client.js'
import {
  createMultiRelayIdentity,
  MULTI_RELAY_HOST_RE,
  MULTI_RELAY_ID_RE,
} from './multi-relay-identity.js'

const DEFAULT_TIMER = {
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: (timer) => clearTimeout(timer),
}

export const MULTI_RELAY_READY_RE = /start proxy success/i
const START_TIMEOUT_MS = 20_000

function localFailure(code, message) {
  return {
    ok: false,
    status: 0,
    code,
    retryable: false,
    message: message || multiRelayErrorMessage(code),
  }
}

function redact(text, secrets) {
  let out = String(text ?? '')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) out = out.split(secret).join('[token]')
  }
  return out
}

/** 只给本机 frpc 用的配置；文件权限由调用方收紧到 0600。 */
export function buildMultiRelayFrpcConfig(identity, originPort) {
  return buildFrpcConfig({
    serverAddr: identity.controlHost,
    serverPort: Number(identity.frpsPort || 443),
    token: identity.frpToken,
    publicHost: identity.publicHost,
    transport: identity.transport,
  }, originPort)
}

export function startMultiRelayFrpc({
  binPath,
  configFile,
  publicUrl,
  spawnFn = spawn,
  readyTimeoutMs = START_TIMEOUT_MS,
  log,
}) {
  const child = spawnFn(binPath, ['-c', configFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const exitListeners = new Set()
  let stopped = false
  const stop = () => {
    stopped = true
    try { child.kill() } catch { /* 已退出 */ }
  }
  const onExit = (cb) => {
    exitListeners.add(cb)
    return () => exitListeners.delete(cb)
  }
  child.on('exit', (code) => {
    if (stopped) return
    for (const cb of exitListeners) cb(code)
  })

  return new Promise((resolve, reject) => {
    let settled = false
    let readyText = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      stop()
      reject(new Error('frpc 启动超时，没有看到 start proxy success。'))
    }, readyTimeoutMs)
    timer.unref?.()

    const onData = (chunk) => {
      if (settled) return
      readyText = (readyText + String(chunk)).slice(-16_384)
      if (!MULTI_RELAY_READY_RE.test(readyText)) return
      settled = true
      clearTimeout(timer)
      log?.info?.(`自建多用户中继已连接：${publicUrl}`)
      resolve({ url: publicUrl, stop, onExit })
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('frpc 起不来。'))
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`frpc 提前退出（退出码 ${code}）。`))
    })
  })
}

export class MultiRelayProvider {
  constructor({
    client,
    createClient,
    identity,
    saveIdentity = async () => {},
    dataDir = '',
    startProcess,
    onChange,
    log,
    timer = DEFAULT_TIMER,
    now = Date.now,
    random = Math.random,
    maxRestarts = 5,
    baseDelayMs = 1_000,
    maxDelayMs = 30_000,
  }) {
    this.client = client ?? null
    this.createClient = createClient ?? ((nextIdentity, controlUrl) => createMultiRelayClient({
      identity: nextIdentity,
      controlUrl,
    }))
    this.identity = identity ?? null
    this.saveIdentity = saveIdentity
    this.dataDir = dataDir
    this.startProcess = startProcess ?? ((args) => this.startLocalFrpc(args))
    this.onChange = onChange
    this.log = log
    this.timer = timer
    this.now = now
    this.random = random
    this.maxRestarts = maxRestarts
    this.baseDelayMs = baseDelayMs
    this.maxDelayMs = maxDelayMs

    this.state = 'idle'
    this.controlUrl = this.identity?.controlUrl ?? null
    this.originPort = null
    this.handle = null
    this.error = null
    this.attempts = 0
    this.nextRetryAt = null
    this.restarting = false
    this.stopped = true
    this.retryTimer = null
  }

  hasToken() {
    return Boolean(this.identity?.frpToken && this.identity?.publicHost)
  }

  snapshot() {
    const publicHost = this.identity?.publicHost ?? null
    return {
      state: this.state,
      controlUrl: this.identity?.controlUrl ?? this.controlUrl ?? '',
      id: this.identity?.id ?? null,
      publicHost,
      url: publicHost ? `https://${publicHost}` : null,
      lastError: this.error?.message ?? null,
      error: this.error,
      errorCode: this.error?.code ?? null,
      attempts: this.attempts,
      nextRetryAt: this.nextRetryAt,
      restarting: this.restarting,
      reconnectable: this.hasToken(),
      busy: this.state === 'claiming',
    }
  }

  emit() {
    try {
      this.onChange?.(this.snapshot())
    } catch (error) {
      this.log?.warn?.(`自建多用户中继状态回调出错：${error?.message ?? error}`)
    }
  }

  clearRetry() {
    if (this.retryTimer !== null) this.timer.clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.nextRetryAt = null
    this.restarting = false
  }

  setFailure(result) {
    const fallback = result?.message
    this.error = {
      code: typeof result?.code === 'string' ? result.code : 'http_error',
      retryable: result?.retryable === true,
      ...(Number(result?.retryAfter) > 0 ? { retryAfter: Number(result.retryAfter) } : {}),
      message: multiRelayErrorMessage(result?.code, fallback),
    }
  }

  fail(code, message) {
    this.setFailure(localFailure(code, message))
    this.state = 'error'
    this.emit()
  }

  async persistIdentity() {
    await this.saveIdentity(this.identity)
  }

  ensureClient() {
    if (!this.client) {
      this.client = this.createClient(this.identity, this.identity.controlUrl)
    }
    return this.client
  }

  /** 进程停了就不再留一份 token 配置；下次启动会用身份文件里的 token 重写。 */
  removeFrpcConfig() {
    if (!this.dataDir) return
    try { rmSync(join(this.dataDir, 'multi-relay', 'frpc.toml'), { force: true }) } catch { /* 被占用时下次覆盖 */ }
  }

  async startLocalFrpc({ identity, originPort, publicUrl }) {
    if (!this.dataDir) {
      const error = new Error('没有插件数据目录，不能写 frpc 配置。')
      error.code = 'frpc_not_found'
      throw error
    }
    const bin = findFrpc({ dataDir: this.dataDir })
    if (!bin) {
      const error = new Error('没找到 frpc。请把 frpc 放进插件数据目录的 bin/ 下。')
      error.code = 'frpc_not_found'
      throw error
    }
    const stateDir = join(this.dataDir, 'multi-relay')
    mkdirSync(stateDir, { recursive: true })
    const configFile = join(stateDir, 'frpc.toml')
    writeFileSync(configFile, `${buildMultiRelayFrpcConfig(identity, originPort)}\n`, { mode: 0o600 })
    try { chmodSync(configFile, 0o600) } catch { /* Windows 上不总是能改权限 */ }
    try {
      return await startMultiRelayFrpc({
        binPath: bin,
        configFile,
        publicUrl,
        log: this.log,
      })
    } catch (error) {
      try { rmSync(configFile) } catch { /* 已经不存在 */ }
      throw error
    }
  }

  async start({ controlUrl, inviteCode, originPort } = {}) {
    if (this.state === 'running' || this.state === 'claiming') return this.snapshot()
    this.stopped = false
    this.clearRetry()
    this.state = 'claiming'
    this.attempts = 0
    this.error = null
    this.originPort = originPort
    this.emit()

    try {
      const requested = normalizeControlUrl(controlUrl || this.identity?.controlUrl)
      if (!requested) {
        this.fail('invalid_control_url')
        return this.snapshot()
      }
      if (this.identity?.controlUrl && normalizeControlUrl(this.identity.controlUrl) !== requested) {
        this.fail('control_url_mismatch')
        return this.snapshot()
      }

      if (!this.identity) {
        this.identity = createMultiRelayIdentity(requested)
        await this.persistIdentity()
      }
      this.controlUrl = requested

      if (!this.hasToken()) {
        const code = typeof inviteCode === 'string' ? inviteCode.trim() : ''
        if (!code) {
          this.fail('invite_required', '第一次开通需要邀请码。')
          return this.snapshot()
        }
        const client = this.ensureClient()
        const claimed = await client.claim({ inviteCode: code, originPort })
        if (!claimed?.ok) {
          this.setFailure(claimed)
          this.state = 'error'
          this.emit()
          return this.snapshot()
        }
        if (!MULTI_RELAY_ID_RE.test(claimed.id ?? '')
          || !MULTI_RELAY_HOST_RE.test(claimed.publicHost ?? '')
          || !MULTI_RELAY_HOST_RE.test(claimed.controlHost ?? '')
          || typeof claimed.frpToken !== 'string' || claimed.frpToken.length < 20) {
          this.fail('invite_token_missing', '服务端返回的开通信息不完整，没有可用于启动的 frp token。')
          return this.snapshot()
        }
        this.identity.id = claimed.id
        this.identity.publicHost = claimed.publicHost
        this.identity.controlHost = claimed.controlHost
        this.identity.frpsPort = Number(claimed.frpsPort || 443)
        this.identity.transport = 'wss'
        this.identity.frpToken = claimed.frpToken
        await this.persistIdentity()
      }

      if (this.stopped) {
        this.state = 'idle'
        this.emit()
        return this.snapshot()
      }
      await this.connectProcess()
      return this.snapshot()
    } catch (error) {
      const message = redact(error?.message ?? String(error), [this.identity?.frpToken])
      this.fail(error?.code || 'frpc_start_failed', message)
      return this.snapshot()
    }
  }

  async connectProcess() {
    if (this.stopped || !this.hasToken()) return
    this.state = 'claiming'
    this.emit()
    try {
      const publicUrl = `https://${this.identity.publicHost}`
      const handle = await this.startProcess({
        identity: this.identity,
        token: this.identity.frpToken,
        originPort: this.originPort,
        publicUrl,
      })
      if (this.stopped) {
        try { handle?.stop?.() } catch { /* 已退出 */ }
        this.removeFrpcConfig()
        return
      }
      this.handle = handle
      this.state = 'running'
      this.restarting = false
      this.nextRetryAt = null
      this.error = null
      this.attempts = 0
      handle?.onExit?.((code) => this.onExit(handle, code))
      this.emit()
      this.log?.info?.(`自建多用户中继已连接：${publicUrl}`)
    } catch (error) {
      const message = redact(error?.message ?? String(error), [this.identity?.frpToken])
      this.setFailure(localFailure(error?.code || 'frpc_start_failed', message))
      this.attempts += 1
      this.state = 'error'
      this.emit()
      this.scheduleRestart()
    }
  }

  onExit(handle, code) {
    if (this.stopped || this.handle !== handle) return
    this.handle = null
    this.removeFrpcConfig()
    this.state = 'error'
    this.setFailure({
      code: 'frpc_exited',
      retryable: true,
      message: `frpc 退出（退出码 ${code ?? '未知'}）。`,
    })
    this.attempts += 1
    this.emit()
    this.scheduleRestart()
  }

  scheduleRestart() {
    if (this.stopped || !this.hasToken()) return
    if (this.attempts >= this.maxRestarts) {
      this.restarting = false
      if (this.error) {
        this.error = { ...this.error, retryable: false, message: `${this.error.message} 自动重连已停止。` }
      }
      this.emit()
      return
    }
    const delay = backoffDelay(this.attempts, {
      baseDelayMs: this.baseDelayMs,
      maxDelayMs: this.maxDelayMs,
      random: this.random,
    })
    this.restarting = true
    this.nextRetryAt = this.now() + delay
    this.emit()
    this.retryTimer = this.timer.setTimeout(() => {
      this.retryTimer = null
      this.nextRetryAt = null
      this.restarting = false
      void this.connectProcess()
    }, delay)
  }

  /** 只重启本地 frpc，不重新 claim。 */
  async reconnect({ originPort } = {}) {
    this.clearRetry()
    this.stopped = false
    this.attempts = 0
    this.error = null
    if (Number.isInteger(originPort)) this.originPort = originPort
    if (!this.hasToken()) {
      this.fail('reconnect_unavailable')
      return this.snapshot()
    }
    if (this.handle) {
      const handle = this.handle
      this.handle = null
      try { handle.stop?.() } catch { /* 已退出 */ }
    }
    this.state = 'claiming'
    this.emit()
    await this.connectProcess()
    return this.snapshot()
  }

  /** 只停本地进程；不调用 release，身份和固定地址都保留。 */
  async stop() {
    if (this.stopped && (this.state === 'idle' || this.state === 'released')) return this.snapshot()
    this.stopped = true
    this.clearRetry()
    const handle = this.handle
    this.handle = null
    try { handle?.stop?.() } catch { /* 已退出 */ }
    this.removeFrpcConfig()
    this.attempts = 0
    this.error = null
    this.state = this.state === 'released' ? 'released' : 'idle'
    this.emit()
    return this.snapshot()
  }

  /** 明确释放：停本地进程，并调用服务端 release；成功后才清本地 token。 */
  async release() {
    this.stopped = true
    this.clearRetry()
    const handle = this.handle
    this.handle = null
    try { handle?.stop?.() } catch { /* 已退出 */ }
    this.removeFrpcConfig()
    if (!this.identity?.id) {
      this.fail('identity_incomplete')
      return this.snapshot()
    }
    this.state = 'claiming'
    this.emit()
    let result
    try {
      result = await this.ensureClient().release()
    } catch {
      result = localFailure('network_error')
    }
    if (!result?.ok) {
      this.setFailure(result)
      this.state = 'error'
      this.emit()
      return this.snapshot()
    }
    this.identity.frpToken = null
    await this.persistIdentity()
    this.state = 'released'
    this.error = null
    this.attempts = 0
    this.emit()
    return this.snapshot()
  }
}

export function createMultiRelayProvider(options) {
  return new MultiRelayProvider(options)
}
