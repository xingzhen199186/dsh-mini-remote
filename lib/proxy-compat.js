import { execFileSync as defaultExecFileSync } from 'node:child_process'
import { networkInterfaces as defaultNetworkInterfaces } from 'node:os'

export const PROXY_BYPASS_DOMAINS = Object.freeze([
  'dsh-everywhere.com',
  'dsh-mini-remote.com',
  'trycloudflare.com',
  'argotunnel.com',
  'cloudflare.com',
  'ts.net',
])

const INTERNET_SETTINGS_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
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
    const output = execFileSync('reg', ['query', INTERNET_SETTINGS_KEY], {
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
    execFileSync('reg', ['add', INTERNET_SETTINGS_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', current, '/f'], {
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
    execFileSync('reg', ['add', INTERNET_SETTINGS_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', String(original ?? ''), '/f'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

export function proxyBypassRulesText() {
  return [
    'PROCESS-NAME,cloudflared.exe,DIRECT',
    ...PROXY_BYPASS_DOMAINS.map((domain) => `DOMAIN-SUFFIX,${domain},DIRECT`),
  ].join('\n')
}

function privatePriority(address) {
  if (address.startsWith('192.168.')) return 0
  if (address.startsWith('10.')) return 1
  const second = Number(address.split('.')[1])
  if (address.startsWith('172.') && second >= 16 && second <= 31) return 2
  return 3
}

export function pickPhysicalIPv4(networkInterfaces) {
  const candidates = []
  for (const [name, entries] of Object.entries(interfacesOf(networkInterfaces))) {
    if (TUN_NAME_RE.test(name)) continue
    for (const entry of Array.isArray(entries) ? entries : []) {
      const address = String(entry?.address ?? '')
      const ipv4 = entry?.family === 'IPv4' || entry?.family === 4
      if (!ipv4 || entry?.internal || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) continue
      if (address.startsWith('127.') || address.startsWith('169.254.') || address.startsWith('198.18.') || address.startsWith('198.19.')) continue
      candidates.push({ address, priority: privatePriority(address), order: candidates.length })
    }
  }
  candidates.sort((a, b) => a.priority - b.priority || a.order - b.order)
  return candidates[0]?.address ?? null
}
