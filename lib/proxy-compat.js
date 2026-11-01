import { execFileSync as defaultExecFileSync } from 'node:child_process'
import { networkInterfaces as defaultNetworkInterfaces } from 'node:os'
import { join } from 'node:path'

export const PROXY_BYPASS_DOMAINS = Object.freeze([
  'dsh-everywhere.com',
  'dsh-mini-remote.com',
  'trycloudflare.com',
  'argotunnel.com',
  'cloudflare.com',
  'ts.net',
])

const INTERNET_SETTINGS_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
const REG_EXE = process.platform === 'win32'
  ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  : 'reg'
const TUN_NAME_RE = /tun|tap|wintun|clash|mihomo|sing[-_ ]?box|wireguard/i

function errorText(error) {
  return String(error?.message ?? error ?? '未知错误')
}

function envValue(env, name) {
  const value = env?.[name] ?? env?.[name.toLowerCase()]
  return typeof value === 'string' ? value.trim() : ''
}

function interfacesOf(input) {
  try {
    return (typeof input === 'function' ? input() : input) ?? {}
  } catch {
    return {}
  }
}

function registryValues(execFileSync) {
  try {
    const output = execFileSync(REG_EXE, ['query', INTERNET_SETTINGS_KEY], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const values = {}
    const pattern = /^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_[A-Z_]+\s+(.*)$/gim
    let match
    while ((match = pattern.exec(String(output ?? '')))) values[match[1].toLowerCase()] = match[2].trim()
    return { ok: true, values, error: null }
  } catch (error) {
    return { ok: false, values: {}, error: errorText(error) }
  }
}

function proxyEnabled(value) {
  return /^(?:0x0*1|1)$/i.test(String(value ?? '').trim())
}

function normalizeOverrideEntry(entry) {
  return String(entry ?? '').trim().toLowerCase().replace(/^\*?\./, '')
}

export function detectProxy({
  platform = process.platform,
  env = process.env,
  execFileSync = defaultExecFileSync,
  networkInterfaces = defaultNetworkInterfaces,
} = {}) {
  const envProxy = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']
    .some((name) => Boolean(envValue(env, name)))
  // NO_PROXY 只用于感知环境；插件不改环境变量，也不把它暴露到配对数据。
  envValue(env, 'NO_PROXY')

  let systemProxy = false
  let proxyServer = ''
  if (platform === 'win32') {
    const registry = registryValues(execFileSync)
    systemProxy = registry.ok && proxyEnabled(registry.values.proxyenable)
    proxyServer = registry.values.proxyserver ?? ''
  }

  const interfaces = interfacesOf(networkInterfaces)
  const tunNames = Object.keys(interfaces).filter((name) => TUN_NAME_RE.test(name))
  return {
    systemProxy,
    proxyServer,
    envProxy,
    tun: tunNames.length > 0,
    tunNames,
    bypassDomains: [...PROXY_BYPASS_DOMAINS],
  }
}

export function ensureSystemProxyBypass({
  platform = process.platform,
  execFileSync = defaultExecFileSync,
  domains = PROXY_BYPASS_DOMAINS,
} = {}) {
  const empty = { changed: false, original: '', current: '', domains: [], error: null }
  if (platform !== 'win32') return empty

  const registry = registryValues(execFileSync)
  if (!registry.ok) return { ...empty, error: registry.error }
  if (!proxyEnabled(registry.values.proxyenable)) return empty

  const original = registry.values.proxyoverride ?? ''
  // Windows 的 ProxyOverride 对子域名要写 *.example.com；只写 example.com 时
  // control.example.com 这类子域仍会进代理。两个都补，避免只对裸域生效。
  const existing = new Set(original.split(';').map((entry) => String(entry ?? '').trim().toLowerCase()).filter(Boolean))
  const wanted = domains.flatMap((domain) => [domain, '*.' + domain])
  const missing = wanted.filter((entry) => !existing.has(entry.toLowerCase()))
  if (!missing.length) return { ...empty, original, current: original }

  const current = `${original}${original && !original.endsWith(';') ? ';' : ''}${missing.join(';')}`
  try {
    execFileSync(REG_EXE, ['add', INTERNET_SETTINGS_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', current, '/f'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    return { changed: true, original, current, domains: missing, error: null }
  } catch (error) {
    return { changed: false, original, current: original, domains: [], error: errorText(error) }
  }
}

export function restoreSystemProxyBypass(original, {
  platform = process.platform,
  execFileSync = defaultExecFileSync,
} = {}) {
  if (platform !== 'win32') return { ok: true, error: null }
  try {
    execFileSync(REG_EXE, ['add', INTERNET_SETTINGS_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', String(original ?? ''), '/f'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}


/** 选一个物理网卡 IPv4，供 cloudflared 在 TUN 环境里尝试直连边缘。 */
export function pickPhysicalIPv4(networkInterfaces = defaultNetworkInterfaces) {
  const interfaces = interfacesOf(networkInterfaces)
  const candidates = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (TUN_NAME_RE.test(name)) continue
    for (const item of addresses ?? []) {
      if (item?.family !== 'IPv4' || item.internal) continue
      const address = String(item.address ?? '')
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) continue
      if (/^198\.(?:18|19)\./.test(address)) continue
      let priority = 9
      if (/^192\.168\./.test(address)) priority = 0
      else if (/^10\./.test(address)) priority = 1
      else if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(address)) priority = 2
      candidates.push({ address, priority })
    }
  }
  candidates.sort((a, b) => a.priority - b.priority)
  return candidates[0]?.address ?? null
}
