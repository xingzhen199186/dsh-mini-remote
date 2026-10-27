/**
 * A 固定中继的插件侧状态机：只负责“把当前 quick 地址登记到中继”，
 * 不碰 cloudflared 生命周期，也不碰手机配对。
 *
 * 为什么单独一层：quick 的地址会因自动恢复而变化，登记也会遇到 5xx、429、
 * Worker 故障。把这些塞进 TunnelSupervisor 会让两个不同的恢复预算互相打架。
 * 这里只订阅 quick URL，维护 generation、心跳、退避和回退。
 *
 * Phase 0 只提供状态机；register/unregister/probe 由后续 Worker 接入时注入。
 */
import { backoffDelay } from './tunnel-supervisor.js'

const DEFAULT_TIMER = {
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: (timer) => clearTimeout(timer),
}

/** 这些错误重试也不会好；直接停，不把固定地址继续挂出去。 */
function terminalFailure(status, error) {
  if (status === 400 || status === 401 || status === 403) return true
  return /invalid|auth|forbidden|unauthorized|target|invite|参数|邀请|鉴权/i.test(String(error ?? ''))
}

export class RelayProvider {
  /**
   * @param {object} options
   * @param {(input: {quickUrl: string, generation: number}) => Promise<{ok: boolean, publicUrl?: string, status?: number, error?: string, retryAfterMs?: number}>} options.register
   * @param {(input: {quickUrl: string, publicUrl: string}) => Promise<unknown>} [options.unregister]
   * @param {(publicUrl: string) => Promise<{ok: boolean, kind?: string, detail?: string}>} [options.probe]
   * @param {(snapshot: object) => void} [options.onChange]
   * @param {object} [options.log]
   * @param {object} [options.timer]
   * @param {() => number} [options.now]
   * @param {() => number} [options.random]
   */
  constructor(options) {
    this.registerImpl = options.register
    this.unregisterImpl = options.unregister
    this.probeImpl = options.probe
    this.onChange = options.onChange
    this.log = options.log
    this.timer = options.timer ?? DEFAULT_TIMER
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    // 不做 15 分钟心跳：只在 quick 地址变化/启动时登记，像参考项目一样
    // 把写入压到最低；固定地址靠 90 天 TTL 和显式注销兜底。
    this.heartbeatMs = options.heartbeatMs ?? 0
    this.ttlMs = options.ttlMs ?? 90 * 24 * 60 * 60_000
    this.baseDelayMs = options.baseDelayMs ?? 5_000
    this.maxDelayMs = options.maxDelayMs ?? 5 * 60_000
    this.maxAttempts = options.maxAttempts ?? 5

    this.state = 'off'
    this.quickUrl = null
    this.publicUrl = null
    this.attempts = 0
    this.nextRetryAt = null
    this.lastError = null
    this.lastErrorKind = null
    this.publicHealthy = null
    this.expiresAt = null
    this.generation = 0
    this.retryTimer = null
    this.heartbeatTimer = null
    this.expiryTimer = null
    this.stopped = false
  }

  snapshot() {
    return {
      state: this.state,
      quickUrl: this.quickUrl,
      publicUrl: this.publicUrl,
      attempts: this.attempts,
      nextRetryAt: this.nextRetryAt,
      lastError: this.lastError,
      lastErrorKind: this.lastErrorKind,
      publicHealthy: this.publicHealthy,
      expiresAt: this.expiresAt,
      generation: this.generation,
    }
  }

  emit() {
    this.onChange?.(this.snapshot())
  }

  clearTimers() {
    for (const key of ['retryTimer', 'heartbeatTimer', 'expiryTimer']) {
      if (this[key]) this.timer.clearTimeout(this[key])
      this[key] = null
    }
  }

  /** 订阅当前 quick URL；同 URL 去重，新 URL 会作废旧代次。 */
  async attach(quickUrl) {
    if (this.stopped) return this.snapshot()
    if (!quickUrl) {
      await this.detach()
      return this.snapshot()
    }
    if (this.quickUrl === quickUrl && (this.state === 'active' || this.state === 'registering')) {
      return this.snapshot()
    }
    const generation = ++this.generation
    this.clearTimers()
    this.quickUrl = quickUrl
    this.state = 'registering'
    this.attempts = 0
    this.nextRetryAt = null
    this.lastError = null
    this.lastErrorKind = null
    this.publicHealthy = null
    // 旧固定地址在换 target 期间先保留，手机至少还能看到它；
    // 首次登记则没有地址可留。
    this.emit()
    await this.tryRegister(generation)
    return this.snapshot()
  }

  async tryRegister(generation) {
    if (generation !== this.generation || this.stopped) return
    const quickUrl = this.quickUrl
    let result
    try {
      result = await this.registerImpl({ quickUrl, generation })
    } catch (error) {
      result = { ok: false, status: 0, error: error?.message ?? String(error) }
    }
    // 迟到的响应不能改回已经换掉/停掉的代次。
    if (generation !== this.generation || this.stopped) return

    if (result?.ok) {
      const publicUrl = typeof result.publicUrl === 'string' && result.publicUrl
        ? result.publicUrl
        : this.publicUrl
      if (!publicUrl) {
        this.fail(generation, 0, '中继没有返回固定地址', 'config')
        return
      }
      this.publicUrl = publicUrl
      this.attempts = 0
      this.nextRetryAt = null
      this.lastError = null
      this.lastErrorKind = null
      this.publicHealthy = true
      this.expiresAt = this.now() + this.ttlMs
      this.state = 'active'
      this.scheduleHeartbeat(generation)
      this.scheduleExpiry(generation)
      this.emit()

      // 固定地址本身也要真的能打开；失败只降级，不把 quick 进程拖下水。
      if (this.probeImpl) {
        let probe
        try { probe = await this.probeImpl(publicUrl) } catch (error) { probe = { ok: false, kind: 'edge', detail: error?.message ?? String(error) } }
        if (generation !== this.generation || this.stopped) return
        if (probe?.ok === false) {
          this.publicHealthy = false
          // 登记成功不等于固定地址现在就能打开；按同一套退避再试，
          // 不能等 15 分钟后的心跳才发现。
          this.fail(generation, 0, probe.detail ?? '固定地址探测失败', probe.kind ?? 'edge')
        }
      }
      return
    }

    this.fail(generation, Number(result?.status) || 0, result?.error ?? '登记失败', result?.kind, Number(result?.retryAfterMs) || 0)
  }

  fail(generation, status, error, kind, retryAfterMs = 0) {
    if (generation !== this.generation || this.stopped) return
    this.lastError = String(error ?? '登记失败')
    this.lastErrorKind = kind ?? (status === 429 ? 'rate-limit' : terminalFailure(status, error) ? 'config' : 'edge')

    if (terminalFailure(status, error)) {
      this.state = 'paused'
      this.publicUrl = null
      this.publicHealthy = false
      this.nextRetryAt = null
      this.clearTimers()
      this.emit()
      return
    }

    this.attempts += 1
    if (this.attempts >= this.maxAttempts) {
      this.state = 'paused'
      this.nextRetryAt = null
      this.clearTimers()
      this.emit()
      return
    }

    this.state = 'degraded'
    const delay = retryAfterMs > 0
      ? retryAfterMs
      : backoffDelay(this.attempts, {
        baseDelayMs: this.baseDelayMs,
        maxDelayMs: this.maxDelayMs,
        random: this.random,
      })
    this.nextRetryAt = this.now() + delay
    this.retryTimer = this.timer.setTimeout(() => {
      this.retryTimer = null
      void this.tryRegister(generation)
    }, delay)
    this.emit()
  }

  scheduleHeartbeat(generation) {
    if (!this.heartbeatMs || this.heartbeatMs <= 0) return
    if (this.heartbeatTimer) this.timer.clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = this.timer.setTimeout(() => {
      this.heartbeatTimer = null
      if (generation !== this.generation || this.stopped) return
      void this.tryRegister(generation)
    }, this.heartbeatMs)
  }

  scheduleExpiry(generation) {
    if (this.expiryTimer) this.timer.clearTimeout(this.expiryTimer)
    const delay = Math.max(0, this.ttlMs)
    this.expiryTimer = this.timer.setTimeout(() => {
      this.expiryTimer = null
      if (generation !== this.generation || this.stopped) return
      if (this.expiresAt !== null && this.now() >= this.expiresAt) {
        this.publicUrl = null
        this.publicHealthy = false
        this.state = 'degraded'
        this.lastError = '固定地址登记已过期'
        this.lastErrorKind = 'expired'
        this.emit()
      }
    }, delay)
  }

  /** 停止登记；unregister 只在明确关闭/切换路线时发，普通 quick 重连不注销。 */
  async detach({ unregister = true } = {}) {
    const quickUrl = this.quickUrl
    const publicUrl = this.publicUrl
    this.generation += 1
    this.clearTimers()
    this.state = 'off'
    this.quickUrl = null
    this.publicUrl = null
    this.attempts = 0
    this.nextRetryAt = null
    this.lastError = null
    this.lastErrorKind = null
    this.publicHealthy = null
    this.expiresAt = null
    this.emit()
    if (unregister && publicUrl && this.unregisterImpl) {
      try {
        await this.unregisterImpl({ quickUrl, publicUrl })
      } catch (error) {
        this.log?.warn?.(`中继注销失败（不影响本地停止）：${error?.message ?? error}`)
      }
    }
  }

  stop() {
    this.stopped = true
    void this.detach({ unregister: true })
  }
}
