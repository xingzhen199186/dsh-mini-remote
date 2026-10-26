/**
 * 自建中继：用户自己的国内服务器 + 域名 + frp。
 *
 * 这一块只做三件事：把用户填的四项配置变成 frpc 的配置、把 frpc 作为子进程
 * 看住、把「进程活着」和「公网真的通」分开报给设置页。服务器那一半（frps +
 * Caddy + 证书）由 `relay-server/` 的一次性安装脚本负责，不在插件里做。
 *
 * 为什么不把 frpc 做成 Windows 服务：DSH 不在跑的时候，这个中继没有意义；
 * 插件子进程跟随 DSH 生命周期，既不需要管理员权限，也不会留下一个用户不知道
 * 怎么关的后台服务。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FRP_VERSION = '0.71.1'

const HERE = dirname(fileURLToPath(import.meta.url))
const START_TIMEOUT_MS = 20_000
const TEST_TIMEOUT_MS = 10_000
const RETRY_MIN_MS = 3_000
const RETRY_MAX_MS = 30_000

/** 公网地址统一成 `https://host`，不接受用户带路径或协议。 */
export function normalizePublicHost(value) {
  let host = String(value ?? '').trim()
  if (!host) return ''
  host = host.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) return ''
  return host.toLowerCase()
}

/** 服务器地址只留主机名，避免用户把 `https://` 或路径贴进来。 */
export function normalizeServerAddr(value) {
  let host = String(value ?? '').trim()
  if (!host) return ''
  host = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '')
  if (!/^[a-z0-9.-]+$/i.test(host)) return ''
  return host.toLowerCase()
}

/**
 * 把设置页那几项收敛成一份可用的配置。返回 `{ config, errors }`，
 * 不抛异常——设置页要把每一条错误分别显示出来。
 */
export function normalizeRelayConfig(input = {}) {
  const errors = []
  const serverAddr = normalizeServerAddr(input.serverAddr)
  const publicHost = normalizePublicHost(input.publicHost)
  const serverPort = Number(input.serverPort || 443)
  const token = String(input.token ?? '').trim()
  const transport = String(input.transport || (serverPort === 443 ? 'wss' : 'tcp')).toLowerCase()

  if (!serverAddr) errors.push('中继服务器地址不对：只填域名或 IP，不要带 https:// 和路径。')
  if (!publicHost) errors.push('公网地址不对：填完整域名，例如 remote.example.com。')
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    errors.push('控制端口要在 1～65535 之间。')
  }
  if (!token) errors.push('frp token 不能为空，去服务器安装脚本输出的那段里复制。')
  if (transport !== 'tcp' && transport !== 'wss') {
    errors.push('传输方式只支持 tcp 或 wss。')
  }
  if (transport === 'wss' && serverPort !== 443) {
    errors.push('wss 方式要求控制端口是 443。')
  }
  if (transport === 'tcp' && serverPort === 443) {
    errors.push('443 端口请用 wss；tcp 方式请填 frps 的 7000 端口。')
  }

  return {
    errors,
    config: {
      serverAddr,
      serverPort,
      token,
      publicHost,
      transport,
      frpcPath: String(input.frpcPath ?? '').trim(),
    },
  }
}

/** 公网入口。用户只填域名，不填路径。 */
export function publicUrlOf(config) {
  const host = normalizePublicHost(config?.publicHost)
  return host ? `https://${host}` : ''
}

/** 生成 frpc 的 TOML。token 只进这个文件，不进日志、不进状态。 */
export function buildFrpcConfig(config, localPort) {
  const port = Number(localPort)
  if (!Number.isInteger(port) || port <= 0) throw new Error('本机端口不对')
  const host = normalizePublicHost(config?.publicHost)
  if (!host) throw new Error('公网地址不对')
  const transport = config.transport === 'wss' ? 'wss' : 'tcp'
  const lines = [
    `serverAddr = ${JSON.stringify(config.serverAddr)}`,
    `serverPort = ${Number(config.serverPort)}`,
    'auth.method = "token"',
    `auth.token = ${JSON.stringify(config.token)}`,
    '',
    `transport.protocol = ${JSON.stringify(transport)}`,
    'transport.tls.enable = true',
    'transport.tcpMux = true',
  ]
  lines.push(
    '',
    '[[proxies]]',
    'name = "dsh-mini-remote"',
    'type = "http"',
    'localIP = "127.0.0.1"',
    `localPort = ${port}`,
    `customDomains = [${JSON.stringify(host)}]`,
    '',
  )
  return lines.join('\n')
}

/** frpc 可能放在三处：显式路径、插件自带、数据目录。 */
export function findFrpc({ configuredPath = '', dataDir = '', platform = process.platform } = {}) {
  const exe = platform === 'win32' ? 'frpc.exe' : 'frpc'
  const candidates = []
  if (configuredPath) candidates.push(configuredPath)
  candidates.push(join(HERE, 'bin', exe))
  if (dataDir) candidates.push(join(dataDir, 'bin', exe))
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

function shortTail(text, limit = 700) {
  return String(text ?? '').trim().slice(-limit)
}

/**
 * 一条 frpc 的看门狗。
 *
 * `start()` 只负责把进程拉起来并等到 frps 确认代理注册成功；`onExit` 之后按
 * 指数退避重试。`stop()` 是用户主动关，退出事件不再触发重试。
 */
export function createSelfRelay({ dataDir, localPort, log } = {}) {
  let config = null
  let child = null
  let wanted = false
  let starting = false
  let connected = false
  let error = null
  let retryTimer = null
  let retryDelay = RETRY_MIN_MS
  let lastConfigFile = ''
  let lastExit = null

  const stateDir = dataDir ? join(dataDir, 'self-relay') : ''

  function status() {
    return {
      enabled: wanted,
      running: Boolean(child),
      connected,
      url: config ? publicUrlOf(config) : '',
      error,
      frpcPath: config ? findFrpc({ configuredPath: config.frpcPath, dataDir }) || '' : '',
      version: FRP_VERSION,
      lastExit,
    }
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }

  function writeConfigFile() {
    if (!stateDir) throw new Error('没有数据目录，不能写 frpc 配置')
    mkdirSync(stateDir, { recursive: true })
    const file = join(stateDir, 'frpc.toml')
    writeFileSync(file, `${buildFrpcConfig(config, localPort)}\n`, { mode: 0o600 })
    try { chmodSync(file, 0o600) } catch { /* Windows 上不总是能改权限 */ }
    lastConfigFile = file
    return file
  }

  function scheduleRetry() {
    if (!wanted || retryTimer) return
    const wait = retryDelay
    retryDelay = Math.min(RETRY_MAX_MS, Math.round(retryDelay * 1.7))
    retryTimer = setTimeout(() => {
      retryTimer = null
      start().catch(() => {})
    }, wait)
    retryTimer.unref?.()
  }

  async function start() {
    if (!config) throw new Error('还没有填写自建中继配置')
    if (child || starting) return status()
    wanted = true
    starting = true
    error = null
    connected = false
    clearRetry()
    try {
      const bin = findFrpc({ configuredPath: config.frpcPath, dataDir })
      if (!bin) {
        throw new Error(
          '没找到 frpc。请把 frpc 放到插件的 lib/bin/ 目录，或安装时指定 frpc 路径。'
          + `\n当前查找位置：${join(HERE, 'bin', process.platform === 'win32' ? 'frpc.exe' : 'frpc')}`,
        )
      }
      const configFile = writeConfigFile()
      const proc = spawn(bin, ['-c', configFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child = proc
      let tail = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        connected = false
        error = `frpc 启动了，但 ${Math.round(START_TIMEOUT_MS / 1000)} 秒内没有注册成功。\n${shortTail(tail)}`
        try { proc.kill() } catch { /* 已退出 */ }
      }, START_TIMEOUT_MS)
      timer.unref?.()

      const onData = (chunk) => {
        const text = String(chunk)
        tail = (tail + text).slice(-4000)
        if (/start proxy success|login to server success/i.test(tail)) {
          connected = true
          error = null
          retryDelay = RETRY_MIN_MS
          if (!settled) {
            settled = true
            clearTimeout(timer)
          }
        }
        if (/error|failed|refused|timeout|token/i.test(text)) {
          error = shortTail(text)
        }
      }
      proc.stdout?.on('data', onData)
      proc.stderr?.on('data', onData)
      proc.on('error', (err) => {
        error = `frpc 起不来：${err?.message ?? err}`
        connected = false
      })
      proc.on('exit', (code, signal) => {
        clearTimeout(timer)
        if (child !== proc) return
        child = null
        connected = false
        lastExit = { code, signal, at: Date.now() }
        if (!wanted) return
        error = `frpc 退出了（${signal || code || '未知'}），正在自动重试。`
        scheduleRetry()
      })
      return status()
    } catch (err) {
      error = err?.message ?? String(err)
      connected = false
      scheduleRetry()
      throw err
    } finally {
      starting = false
    }
  }

  function stop() {
    wanted = false
    clearRetry()
    connected = false
    error = null
    const proc = child
    child = null
    if (proc) {
      try { proc.kill() } catch { /* 已退出 */ }
    }
    return status()
  }

  /** 真去打一次公网地址。返回 `{ ok, status, error }`，不抛异常。 */
  async function test() {
    if (!config) return { ok: false, error: '还没有填写自建中继配置', url: '' }
    const url = publicUrlOf(config)
    try {
      const res = await fetch(`${url}/mini/api/version`, {
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      })
      // 401 说明链路通、鉴权也在；200 也接受（某些版本/路径可能不带门）。
      if (res.status !== 401 && res.status !== 200) {
        return { ok: false, url, error: `公网返回 HTTP ${res.status}，多半是证书、域名或 frps 没配好。` }
      }
      connected = true
      error = null
      return { ok: true, url, status: res.status }
    } catch (err) {
      const code = err?.cause?.code ?? err?.code ?? ''
      connected = false
      error = `公网地址打不开：${code || err?.message || err}`
      return { ok: false, url, error }
    }
  }

  function setConfig(next) {
    config = next
    if (lastConfigFile) {
      try { writeConfigFile() } catch { /* 下次启动会再写 */ }
    }
    return status()
  }

  function dispose() {
    stop()
  }

  return { start, stop, test, status, setConfig, dispose, get configFile() { return lastConfigFile } }
}
