/**
 * 网卡识别：只挑出真正能用、也真正该让手机连的地址。
 *
 * 一台电脑上通常挂着好几个地址，其中大部分是废的。没拿到 IP 的空网卡会
 * 自报一个 169.254.x.x（系统给的临时占位地址，连不通），WSL、Hyper-V 这些
 * 虚拟网卡也各有各的内网地址，但它们只给虚拟机之间用。把这些一股脑列出来，
 * 等于让用户从六个地址里猜哪个是对的——本机实测就是这样：八个地址里只有
 * 两个能用。
 */
import { networkInterfaces } from 'node:os'

/** 169.254.0.0/16：没拿到 IP 时空网卡自报的占位地址。 */
function isLinkLocal(ip) {
  return ip.startsWith('169.254.')
}

/** 100.64.0.0/10：Tailscale 使用的运营商级 NAT 网段。 */
function isTailscale(ip) {
  if (!ip.startsWith('100.')) return false
  const second = Number(ip.split('.')[1])
  return second >= 64 && second <= 127
}

function isLoopback(ip) {
  return ip.startsWith('127.')
}

/** RFC1918 的三段内网地址。 */
function isPrivate(ip) {
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true
  const [a, b] = ip.split('.').map(Number)
  return a === 172 && b >= 16 && b <= 31
}

/**
 * 虚拟网卡按名字排除。它们的地址段（172.x、192.168.x）和真内网长得一样，
 * 靠地址本身分不出来，只能看网卡名。
 */
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|VMware|VirtualBox|Docker|Loopback|Npcap|TAP-|Bluetooth|蓝牙|Virtual Adapter/i

/** 返回 'lan' | 'tailscale' | 'loopback'，或 null 表示这个地址不该给用户。 */
export function classify(name, ip) {
  if (isLoopback(ip)) return 'loopback'
  if (isLinkLocal(ip)) return null
  if (isTailscale(ip)) return 'tailscale'
  if (VIRTUAL_ADAPTER.test(name)) return null
  if (isPrivate(ip)) return 'lan'
  // 公网地址：不主动暴露，用户没要求过
  return null
}

const LABELS = {
  lan: '内网',
  tailscale: 'Tailscale',
  loopback: '本机',
}

/**
 * 手机能用来连接的地址，内网排前面（在家时更常用）。
 * 每项形如 { kind, label, address, name }。
 */
export function reachableAddresses() {
  const found = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      const kind = classify(name, addr.address)
      if (!kind) continue
      found.push({ kind, label: LABELS[kind], address: addr.address, name })
    }
  }
  const rank = { lan: 0, tailscale: 1, loopback: 2 }
  found.sort((a, b) => rank[a.kind] - rank[b.kind] || a.address.localeCompare(b.address))
  return found
}

/**
 * 这个请求是不是来自这台电脑自己。
 *
 * 配对信息里带着 token，只允许本机读取——否则同一个 Wi-Fi 下谁都能把密码
 * 取走，token 也就形同虚设了。
 */
export function isLocalRequest(req) {
  const raw = req.socket?.remoteAddress ?? ''
  if (!raw) return false
  // Node 在双栈监听时会把 IPv4 报成 ::ffff:127.0.0.1
  const ip = raw.startsWith('::ffff:') ? raw.slice(7) : raw
  return ip === '::1' || isLoopback(ip)
}

/**
 * 该在哪些地址上开门。
 *
 * 'auto' 是默认值：内网 + Tailscale + 本机。比 0.0.0.0 精确——WSL 那些虚拟
 * 网卡不开门；也比只绑回环实用——手机连得上。传具体地址或 '0.0.0.0' 则照办。
 */
export function resolveBindAddresses(setting) {
  if (!setting || setting === 'auto') {
    // 本机始终留着——配对页要在电脑上打得开。内网/Tailscale 一个都没有
    // （比如网线没插、Tailscale 没登录）时，至少服务还在。
    return ['127.0.0.1', ...reachableAddresses().map((a) => a.address)]
  }
  return [setting]
}
