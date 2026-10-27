/**
 * 隧道监督器：管 cloudflared 的生命周期，不直接碰 HTTP 路由和设置页。
 *
 * 为什么单独一层：隧道有「进程活着」「边缘连上」「公网真的能访问」三种状态，
 * 把它们塞进 index.js 的开关函数里，最后一定会变成“看到进程在就报已连接”。
 * 这里只做一件事：根据目标、退出、探测结果，决定下一次动作。
 *
 * 不照搬任何外部项目的类结构；状态名、恢复预算和错误分类都是按本插件的
 * 使用方式定的。
 */
import { createHash } from 'node:crypto'

const DEFAULT_TIMER = {
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: (timer) => clearTimeout(timer),
}

const ACTIVE_PHASES = new Set(['starting', 'running', 'degraded', 'restarting'])

/** 目标指纹：只用于比较，不写日志、不进二维码。 */
export function targetFingerprint(target) {
  const raw = [
    target?.mode ?? '',
    String(target?.port ?? ''),
    target?.publicUrl ?? '',
    target?.token ?? '',
  ].join('\n')
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * 把一次失败归类。分类决定“要不要重试”，比错误原文更重要。
 * @returns {'config'|'auth'|'edge'|'dns'|'origin'|'hostname'|'unknown'}
 */
export function classifyTunnelFailure(error) {
  const message = String(error?.message ?? error ?? '').toLowerCase()
  if (!message) return 'unknown'
  if (/缺少 token|missing token|publicurl|公网地址|invalid url|不是 https/.test(message)) return 'config'
  if (/invalid tunnel secret|unauthorized|forbidden|401|403|token.*(invalid|expired|wrong)/.test(message)) return 'auth'
  // Clash / TUN 的 fake-ip：cloudflared 把 Cloudflare 边缘解析成 198.18.x.x，
  // 这不是 token 错，也不是隧道坏，重试之前必须先让用户关掉代理。
  if (/198\.18\.|fake-ip|fake ip|clash|tun 模式/.test(message)) return 'proxy'
  if (/enotfound|eai_again|getaddrinfo|dns|解析/.test(message)) return 'dns'
  if (/404|not found|hostname|public hostname|no route|路由/.test(message)) return 'hostname'
  if (/502|503|bad gateway|origin|127\.0\.0\.1|本机服务/.test(message)) return 'origin'
  if (/tls|handshake|edge|connection|cloudflared|econn|etimedout|eof/.test(message)) return 'edge'
  return 'unknown'
}

/** 指数退避，带一点抖动，避免所有客户端同一秒重连。 */
export function backoffDelay(attempt, options = {}) {
  const base = options.baseDelayMs ?? 5_000
  const max = options.maxDelayMs ?? 60_000
  const random = options.random ?? Math.random
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt - 1))
  const jitter = 0.8 + random() * 0.4
  return Math.round(raw * jitter)
}

function redact(value, token) {
  const text = String(value ?? '')
  if (!token) return text
  return text.split(String(token)).join('[token]')
}

/**
 * @param {object} options
 * @param {(target: object) => Promise<{url: string, stop: () => void, onExit?: Function}>} options.start
 * @param {(url: string) => Promise<{ok: boolean, kind?: string, detail?: string}>} options.probe
 * @param {(snapshot: object) => void} [options.onChange]
 * @param {object} [options.log]
 * @param {object} [options.timer]
 * @param {() => number} [options.now]
 * @param {() => number} [options.random]
 */
export class TunnelSupervisor {
  constructor(options) {
    this.startImpl = options.start
    this.probeImpl = options.probe
    this.onChange = options.onChange
    this.log = options.log
    this.timer = options.timer ?? DEFAULT_TIMER
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.autoRecover = options.autoRecover !== false
    this.maxAttempts = options.maxAttempts ?? 5
    this.baseDelayMs = options.baseDelayMs ?? 5_000
    this.maxDelayMs = options.maxDelayMs ?? 60_000
    this.probeIntervalMs = options.probeIntervalMs ?? 60_000
    this.probeFailures = options.probeFailures ?? 2
    this.stableMs = options.stableMs ?? 300_000

    this.target = null
    this.fingerprint = null
    this.handle = null
    this.phase = 'idle'
    this.url = null
    this.publicUrl = null
    this.attempts = 0
    this.nextRetryAt = null
    this.lastError = null
    this.lastErrorKind = null
    this.publicHealthy = null
    this.edgeConnected = false
    this.probeFails = 0
    this.stopped = false
    this.retryTimer = null
    this.probeTimer = null
    this.stableTimer = null
  }

  snapshot() {
    return {
      phase: this.phase,
      mode: this.target?.mode ?? null,
      url: this.url,
      publicUrl: this.publicUrl ?? this.target?.publicUrl ?? null,
      attempts: this.attempts,
      nextRetryAt: this.nextRetryAt,
      lastError: this.lastError,
      lastErrorKind: this.lastErrorKind,
      publicHealthy: this.publicHealthy,
      edgeConnected: this.edgeConnected,
      autoRecover: this.autoRecover,
    }
  }

  emit() {
    try {
      this.onChange?.(this.snapshot())
    } catch (error) {
      this.log?.warn?.(`隧道状态回调出错：${error?.message ?? error}`)
    }
  }

  clearRetry() {
    if (this.retryTimer !== null) {
      this.timer.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.nextRetryAt = null
  }

  clearProbe() {
    if (this.probeTimer !== null) {
      this.timer.clearTimeout(this.probeTimer)
      this.probeTimer = null
    }
    this.probeFails = 0
  }

  clearStable() {
    if (this.stableTimer !== null) {
      this.timer.clearTimeout(this.stableTimer)
      this.stableTimer = null
    }
  }

  async start(target) {
    const fingerprint = targetFingerprint(target)
    if (this.target && fingerprint === this.fingerprint && ACTIVE_PHASES.has(this.phase)) {
      return this.snapshot()
    }
    this.clearRetry()
    this.clearProbe()
    this.clearStable()
    this.handle?.stop()
    this.handle = null
    this.target = target
    this.fingerprint = fingerprint
    this.stopped = false
    this.attempts = 0
    this.publicUrl = target.publicUrl ?? null
    this.lastError = null
    this.lastErrorKind = null
    this.publicHealthy = null
    this.edgeConnected = false
    await this.spawn()
    return this.snapshot()
  }

  async spawn() {
    if (this.stopped || !this.target) return
    this.phase = 'starting'
    this.nextRetryAt = null
    this.emit()
    let handle
    try {
      handle = await this.startImpl(this.target)
    } catch (error) {
      this.fail(error)
      return
    }
    if (this.stopped) {
      try { handle?.stop?.() } catch { /* 已经退出 */ }
      return
    }
    this.handle = handle
    this.url = handle?.url ?? this.target.publicUrl ?? null
    this.edgeConnected = Boolean(this.url)
    this.phase = 'running'
    this.publicHealthy = null
    // 已经重新连上，上一次失败的原文不该继续挂在界面上；探测失败会再写回来。
    this.lastError = null
    this.lastErrorKind = null
    this.emit()
    this.log?.info?.(`隧道已连接：${this.url ?? '(未给地址)'}`)
    this.armStable()
    this.startProbe()
    handle?.onExit?.((code) => this.onExit(handle, code))
  }

  onExit(handle, code) {
    if (this.stopped || this.handle !== handle) return
    this.handle = null
    this.edgeConnected = false
    this.clearProbe()
    this.clearStable()
    this.publicHealthy = false
    if (this.target?.mode === 'named') {
      this.url = this.target.publicUrl ?? null
    } else {
      this.url = null
    }
    this.fail(new Error(`cloudflared 退出（退出码 ${code}）`), 'edge')
  }

  fail(error, forcedKind) {
    const kind = forcedKind ?? classifyTunnelFailure(error)
    this.lastErrorKind = kind
    this.lastError = redact(error?.message ?? error, this.target?.token)
    this.attempts += 1
    this.publicHealthy = false
    this.clearProbe()
    this.clearStable()
    if (kind === 'config' || kind === 'auth' || kind === 'hostname') {
      this.phase = 'failed'
      // 这几种错误下，固定地址本身也不可信；不要把死地址留在二维码里。
      this.url = null
      this.emit()
      return
    }
    if (!this.autoRecover || this.attempts >= this.maxAttempts) {
      this.phase = 'paused'
      this.emit()
      return
    }
    this.scheduleRetry()
  }

  scheduleRetry() {
    if (this.stopped) return
    const delay = backoffDelay(this.attempts, {
      baseDelayMs: this.baseDelayMs,
      maxDelayMs: this.maxDelayMs,
      random: this.random,
    })
    this.phase = 'restarting'
    this.nextRetryAt = this.now() + delay
    this.emit()
    this.retryTimer = this.timer.setTimeout(() => {
      this.retryTimer = null
      this.nextRetryAt = null
      void this.spawn()
    }, delay)
  }

  armStable() {
    this.clearStable()
    this.stableTimer = this.timer.setTimeout(() => {
      this.stableTimer = null
      this.attempts = 0
      this.lastError = null
      this.lastErrorKind = null
    }, this.stableMs)
  }

  startProbe() {
    this.clearProbe()
    if (!this.url || this.stopped) return
    const tick = async () => {
      if (this.stopped || !this.url) return
      let result
      try {
        result = await this.probeImpl(this.url)
      } catch (error) {
        result = { ok: false, kind: classifyTunnelFailure(error), detail: error?.message ?? String(error) }
      }
      if (this.stopped) return
      if (result?.ok) {
        this.publicHealthy = true
        this.probeFails = 0
        const recovered = this.phase === 'degraded' || this.lastError !== null
        if (this.phase === 'degraded') this.phase = 'running'
        if (recovered) {
          this.lastError = null
          this.lastErrorKind = null
          this.emit()
        }
      } else {
        this.probeFails += 1
        if (this.probeFails >= this.probeFailures) {
          const kind = result?.kind ?? 'edge'
          this.publicHealthy = false
          this.lastErrorKind = kind
          this.lastError = redact(result?.detail ?? '公网探测失败', this.target?.token)
          this.phase = 'degraded'
          this.emit()
          if (kind === 'dns' || kind === 'dns-local' || kind === 'origin' || kind === 'hostname') {
            // 这三类不是隧道进程的问题：本机 DNS、本机服务、路由配置。
            // 不重启隧道，保留固定地址，继续探测等用户修好。
            this.log?.warn?.(`公网探测失败（${kind}），不重启隧道：${this.lastError}`)
          } else {
            this.fail(new Error(this.lastError), kind)
            return
          }
        }
      }
      if (!this.stopped) {
        this.probeTimer = this.timer.setTimeout(tick, this.probeIntervalMs)
      }
    }
    // 先立刻探一次：cloudflared 说“已连接”不等于公网真的能打开。
    // 第一个 60 秒周期太长了，用户会在这段时间里看到一个假的“已连接”。
    this.probeTimer = this.timer.setTimeout(tick, 0)
  }

  retryNow() {
    if (this.stopped || !this.target) return this.snapshot()
    this.clearRetry()
    this.clearProbe()
    this.clearStable()
    this.attempts = 0
    this.phase = 'idle'
    this.lastError = null
    this.lastErrorKind = null
    void this.spawn()
    return this.snapshot()
  }

  stop() {
    this.stopped = true
    this.clearRetry()
    this.clearProbe()
    this.clearStable()
    this.handle?.stop()
    this.handle = null
    this.phase = 'stopped'
    this.url = null
    this.edgeConnected = false
    this.publicHealthy = null
    this.nextRetryAt = null
    this.emit()
  }
}
