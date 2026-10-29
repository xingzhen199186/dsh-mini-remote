/**
 * 专属固定地址的进程监督器：claim → cloudflared → 有界重连 → 停止时 release。
 *
 * tunnel token 只放在闭包里，并只通过 startProcess 的参数交给真正的启动函数；
 * 这里不拼命令行、不写日志、也不进 snapshot。
 */
import { spawn } from 'node:child_process'
import { B_HOSTNAME_RE, B_ID_RE } from './b-relay-identity.js'
import { backoffDelay } from './tunnel-supervisor.js'

const DEFAULT_TIMER = {
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: (timer) => clearTimeout(timer),
}

export const B_READY_RE = /Registered tunnel connection|Connection\s+\S+\s+registered/i

/** token 不进参数：cloudflared 从子进程的 TUNNEL_TOKEN 环境变量读。 */
export function bTunnelArgs() {
  return ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4', 'run']
}

export function startBCloudflared({
  binPath,
  token,
  publicUrl,
  spawnFn = spawn,
  readyTimeoutMs = 90_000,
  log,
}) {
  const child = spawnFn(binPath, bTunnelArgs(), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, TUNNEL_TOKEN: token },
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
    for (const cb of exitListeners) cb(code)
  })

  return new Promise((resolve, reject) => {
    let settled = false
    let readyText = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      stop()
      reject(new Error('cloudflared 启动超时，没有连上 Cloudflare。'))
    }, readyTimeoutMs)
    timer.unref?.()

    const onData = (chunk) => {
      if (settled) return
      // 日志可能被拆成多个 chunk，先拼一小段再匹配，避免漏掉
      // “Registered tunnel connection” 这类跨块的行。
      readyText = (readyText + String(chunk)).slice(-16_384)
      if (!B_READY_RE.test(readyText)) return
      settled = true
      clearTimeout(timer)
      log?.info?.(`专属固定地址隧道已连接：${publicUrl}`)
      resolve({ url: publicUrl, stop, onExit })
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('cloudflared 起不来。'))
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`cloudflared 提前退出（退出码 ${code}）。`))
    })
  })
}

function localFailure(code, message) {
  return { ok: false, status: 0, code, retryable: false, message }
}

export class BRelayProvider {
  constructor({
    client,
    identity,
    saveIdentity = async () => {},
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
    this.client = client
    this.identity = identity
    this.saveIdentity = saveIdentity
    this.startProcess = startProcess
    this.onChange = onChange
    this.log = log
    this.timer = timer
    this.now = now
    this.random = random
    this.maxRestarts = maxRestarts
    this.baseDelayMs = baseDelayMs
    this.maxDelayMs = maxDelayMs

    this.state = 'idle'
    this.hostname = identity?.hostname ?? null
    this.handle = null
    this.token = null
    this.error = null
    this.attempts = 0
    this.nextRetryAt = null
    this.restarting = false
    this.stopped = true
    this.retryTimer = null
    this.lastRelease = null
  }

  snapshot() {
    return {
      state: this.state,
      hostname: this.hostname,
      url: this.hostname ? `https://${this.hostname}` : null,
      lastError: this.error?.message ?? null,
      error: this.error,
      errorCode: this.error?.code ?? null,
      retryable: this.error?.retryable ?? false,
      retryAfter: this.error?.retryAfter ?? null,
      attempts: this.attempts,
      nextRetryAt: this.nextRetryAt,
      restarting: this.restarting,
      releasedAt: this.lastRelease?.releasedAt ?? null,
    }
  }

  emit() {
    try {
      this.onChange?.(this.snapshot())
    } catch (error) {
      this.log?.warn?.(`专属固定地址状态回调出错：${error?.message ?? error}`)
    }
  }

  clearRetry() {
    if (this.retryTimer !== null) this.timer.clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.nextRetryAt = null
    this.restarting = false
  }

  setFailure(result) {
    this.error = {
      code: typeof result?.code === 'string' ? result.code : 'b_relay_error',
      retryable: result?.retryable === true,
      ...(Number(result?.retryAfter) > 0 ? { retryAfter: Number(result.retryAfter) } : {}),
      message: this.messageOf(result),
    }
    this.lastError = this.error.message
  }

  messageOf(result) {
    if (typeof result?.message === 'string' && result.message.trim()) return result.message.trim()
    const code = result?.code
    if (code === 'timeout') return '连 B 控制面超时（8 秒）。'
    if (code === 'network_error') return '连不上 B 控制面，检查这台电脑的网络。'
    if (code === 'rate_limited') {
      const wait = Number(result?.retryAfter)
      return `操作太频繁，${wait > 0 ? `约 ${wait} 秒后` : '稍后'}再试。`
    }
    if (code === 'auth_failed') return 'B 激活码或本机身份不对。'
    if (code === 'activation_expired') return '这个 B 激活码已经过期或已经用过。'
    if (code === 'lease_retired') return '这个 专属固定地址已经退休，不能再使用。'
    if (code === 'state_conflict') return 'B 控制面当前状态不允许这个操作。'
    if (code === 'resource_conflict') return '固定地址对应的资源发生冲突，需要人工处理。'
    if (code === 'cf_api_unavailable') return 'B 控制面暂时连不上 Cloudflare，稍后再试。'
    if (code === 'invite_required') return '当前必须带激活码；请先填写激活码。'
    if (code === 'registration_closed') return '当前没有开放新实例注册。'
    if (code === 'self_service_capacity') return '专属固定地址容量已满，暂时不能开通。'
    if (code === 'identity_incomplete') return '本机 B 身份还没有完成认领。'
    return code ? `B 控制面返回：${code}` : 'B 控制面操作失败。'
  }

  failResult(result) {
    this.setFailure(result)
    this.state = 'error'
    this.emit()
  }

  async persistIdentity() {
    if (typeof this.saveIdentity === 'function') await this.saveIdentity(this.identity)
  }

  async start({ activationCode, originPort } = {}) {
    if (this.state === 'running' || this.state === 'claiming') return this.snapshot()
    this.stopped = false
    this.clearRetry()
    this.state = 'claiming'
    this.attempts = 0
    this.error = null
    this.emit()

    try {
      const code = typeof activationCode === 'string' ? activationCode.trim() : ''
      const claimPort = Number(this.identity.originPort) || originPort
      const claimed = await this.client.claim({ activationCode: code, originPort: claimPort })
      if (!claimed?.ok) {
        this.failResult(claimed)
        return this.snapshot()
      }
      if (!B_ID_RE.test(claimed.id ?? '') || !B_HOSTNAME_RE.test(claimed.hostname ?? '')
        || typeof claimed.tunnelToken !== 'string' || !claimed.tunnelToken) {
        this.failResult(localFailure('invalid_claim_response', 'B 控制面返回的开通信息不完整。'))
        return this.snapshot()
      }
      if (this.identity.id && this.identity.id !== claimed.id) {
        this.failResult(localFailure('identity_mismatch', 'B 控制面返回的地址和本机身份不一致。'))
        return this.snapshot()
      }

      this.identity.id = claimed.id
      this.identity.hostname = claimed.hostname
      if (!this.identity.originPort && Number.isInteger(claimPort)) this.identity.originPort = claimPort
      this.hostname = claimed.hostname
      this.token = claimed.tunnelToken
      await this.persistIdentity()

      // 停按钮可能在 claim 等待期间已经按下；保存身份后把刚拿到的租约释放掉，
      // 不启动一个用户已经关掉的进程。
      if (this.stopped) {
        this.token = null
        this.state = 'released'
        try { await this.client.release() } catch { /* 停止是本地事实，release 失败留给界面提示 */ }
        this.emit()
        return this.snapshot()
      }

      if (Number.isInteger(originPort) && originPort !== this.identity.originPort) {
        const renewed = await this.client.renew({ originPort })
        if (!renewed?.ok) {
          this.failResult(renewed)
          this.token = null
          return this.snapshot()
        }
        this.identity.originPort = originPort
        await this.persistIdentity()
      }

      await this.connect()
      return this.snapshot()
    } catch (error) {
      this.failResult(localFailure('b_relay_error', error?.message ?? String(error)))
      return this.snapshot()
    }
  }

  hasToken() {
    return Boolean(this.token)
  }

  /** 用户手动重连：不重新 claim，不换 token，只重启本地 cloudflared。 */
  async reconnect() {
    this.clearRetry()
    this.stopped = false
    this.attempts = 0
    this.error = null
    if (!this.token || !this.hostname) {
      this.state = 'error'
      this.setFailure(localFailure('reconnect_unavailable', '没有可重连的隧道，请重新开启。'))
      this.emit()
      return this.snapshot()
    }
    if (this.handle) {
      const handle = this.handle
      this.handle = null
      try { handle.stop?.() } catch { /* 已退出 */ }
    }
    this.state = 'claiming'
    this.emit()
    await this.connect()
    return this.snapshot()
  }

  async connect() {
    if (this.stopped || !this.token || typeof this.startProcess !== 'function') return
    this.state = 'claiming'
    this.emit()
    try {
      const publicUrl = `https://${this.hostname}`
      const handle = await this.startProcess({
        token: this.token,
        hostname: this.hostname,
        publicUrl,
      })
      if (this.stopped) {
        try { handle?.stop?.() } catch { /* 已退出 */ }
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
      this.log?.info?.(`专属固定地址已连接：${publicUrl}`)
    } catch (error) {
      this.setFailure(localFailure('cloudflared_start_failed', error?.message ?? String(error)))
      this.attempts += 1
      this.scheduleRestart()
    }
  }

  onExit(handle, code) {
    if (this.stopped || this.handle !== handle) return
    this.handle = null
    this.state = 'error'
    this.setFailure({
      code: 'cloudflared_exited',
      retryable: true,
      message: `cloudflared 退出（退出码 ${code ?? '未知'}）。`,
    })
    this.attempts += 1
    this.emit()
    this.scheduleRestart()
  }

  scheduleRestart() {
    if (this.stopped || !this.token) return
    if (this.attempts >= this.maxRestarts) {
      this.restarting = false
      if (this.error) {
        this.error = { ...this.error, retryable: false, message: `${this.error.message} 自动重连已停止。` }
        this.lastError = this.error.message
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
      void this.connect()
    }, delay)
  }

  async stop({ release = true } = {}) {
    if (this.stopped && (this.state === 'released' || this.state === 'idle')) return this.snapshot()
    this.stopped = true
    this.clearRetry()
    const handle = this.handle
    this.handle = null
    try { handle?.stop?.() } catch { /* 已退出 */ }
    this.token = null
    this.state = release ? 'released' : 'idle'
    this.error = null
    if (release && this.identity?.id) {
      let result
      try {
        result = await this.client.release()
      } catch {
        result = localFailure('network_error')
      }
      if (!result?.ok) this.setFailure(result)
      else this.lastRelease = result
    }
    this.emit()
    return this.snapshot()
  }
}

export function createBRelayProvider(options) {
  return new BRelayProvider(options)
}
