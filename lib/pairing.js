/**
 * 配对信息：手机该扫哪个码、点哪条链接。
 *
 * 这是整个插件唯一一处主动把 token 交出去的地方，所以它只允许「本机」读取
 * （来源判断在 index.js 的路由里）。二维码里连 token 一起编进去——扫完直接
 * 进，不用手敲密码。
 */
import QRCode from 'qrcode'
import { execFileSync } from 'node:child_process'
import { reachableAddresses } from './net.js'

const HINTS = {
  lan: '手机连同一个 Wi-Fi 时用这个',
  tailscale: '在外面（用手机流量）也能用',
  public: '不用装任何东西，出门在外也能用。刚打开时等半分钟再扫；地址每次重启 DSH 会换',
}

/** 官方下载页。给没装的人一个明确的下一步。 */
export const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download'

/**
 * Tailscale 这个命令在不在。
 *
 * 只在**没探到 Tailscale 地址**的时候才问一次，所以正常（装了并且登录着）的情况下
 * 根本不会跑。为什么值得问：探不到地址有两种成因——没装，和装了但没登录。这两种
 * 给用户的下一步动作完全不同（去下载 vs 去登录），界面上那句话该怎么说就取决于它。
 *
 * 超时卡死 1.5 秒：tailscale 装了但后台服务没起来的时候，这个命令会挂住。问不出来
 * 就当作「装了但状态不明」，界面上退回一句两种成因都覆盖的话——宁可说得含糊，
 * 也不能让人白等，或者叫人去装一个他已经装了的软件。
 */
function tailscaleCliPresent() {
  try {
    execFileSync('tailscale', ['version'], { timeout: 1500, stdio: 'ignore' })
    return true
  } catch (err) {
    // ENOENT = 系统里根本没有这个命令；超时或别的错 = 装了，只是问不出来。
    return err?.code !== 'ENOENT'
  }
}

/**
 * 没探到 Tailscale 地址时，给界面一句话；探到了就返回 null（那一行不用出现）。
 *
 * 抽成纯函数是为了能单测：真实那条路要看本机网卡、还要起一个子进程，测起来
 * 又慢又依赖环境。这里只做判断，取数据的事交给调用方。
 */
export function tailscaleNotice(detected, cliPresent) {
  if (detected.some((a) => a.kind === 'tailscale')) return null
  return { installed: cliPresent, download: TAILSCALE_DOWNLOAD }
}

/**
 * 交给面板的公网网址，该给还是该收回。
 *
 * 2026-09-22：用户照着一个写着「已开启」的面板去扫码，扫出来是 Cloudflare 的
 * Error 1033——cloudflared 进程活着，但它到边缘的连接早断了，插件只认「网址打印出来了」。
 * 补了一道自测（见 index.js 的 startTunnelProbe），判死之后**不再把网址交出去**：
 * 拿到网址就会画一条二维码，而那条现在扫了只会得到 1033。宁可什么都不给，
 * 也不要给一个扫不开的码。
 *
 * 抽成纯函数是为了能单测：真那条路要起 cloudflared、要等定时器、还要联网。
 *
 * @param {boolean|null} healthy true=通，false=判死，null=还不知道
 * @param {string|null|undefined} url cloudflared 打印出来的网址
 */
export function tunnelUrlFor(healthy, url) {
  if (healthy === false) return null
  return url ?? null
}

/**
 * 隧道自测失败时，这到底是「隧道坏了」还是「本机 DNS 坏了」。
 *
 * 两者必须分开，因为处置完全不同：
 * - `dns`：隧道是好的，只是**这台电脑**解析不了那个域名。手机在外面走运营商的 DNS
 *   很可能好好的，所以**不能收回网址**，只提醒一句。2026-09-22 实测：cloudflared
 *   连着 3 条边缘连接、公共 DNS 都解析得出、强制指到真实 IP 打过去是 200，
 *   可本机路由器（192.168.1.1）就是查不到 *.trycloudflare.com。
 * - `dead`：真的连不上，该判死、该收回网址。
 */
export function tunnelProbeVerdict(code) {
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  return 'dead'
}

/** 二维码编成 PNG 的 data URL，前端直接塞进 <img src>。 */
async function qr(text) {
  try {
    return await QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 220 })
  } catch {
    // 画不出二维码不该让整个面板挂掉，前端会退化成只显示链接
    return null
  }
}

/**
 * @param {object} opts
 * @param {number} opts.port 手机服务实际监听的端口
 * @param {string} opts.token
 * @param {string[]} [opts.bound] 真正绑定成功的地址；不传则用探测结果
 * @param {{enabled?: boolean, url?: string|null, starting?: boolean, error?: string|null}} [opts.tunnel] 公网隧道状态
 */
export async function buildPairing({ port, token, bound, tunnel }) {
  const detected = reachableAddresses()
  const usable = bound ? detected.filter((a) => bound.includes(a.address)) : detected

  const entries = []
  for (const a of usable) {
    const url = `http://${a.address}:${port}/mini?token=${token}`
    entries.push({
      kind: a.kind,
      label: a.label,
      hint: HINTS[a.kind] ?? '',
      url,
      qr: await qr(url),
    })
  }

  // 公网那条排在最后：它是补充，不是主路
  if (tunnel?.url) {
    const url = `${tunnel.url}/mini?token=${token}`
    entries.push({
      kind: 'public',
      label: '公网',
      hint: HINTS.public,
      url,
      qr: await qr(url),
    })
  }

  const status = {
    enabled: Boolean(tunnel?.enabled),
    up: Boolean(tunnel?.url),
    starting: Boolean(tunnel?.starting),
    error: tunnel?.error ?? null,
  }

  /**
   * 没探到 Tailscale 地址时，也要给界面一句话。
   *
   * 原来那一行是**直接不出现**的——用户看到的不是「你没有 Tailscale」，而是
   * 「这里什么都没有」。他不知道自己缺了什么，也就不会想到去装。而他恰恰是
   * 最需要这条路的人：不装 Tailscale，手机出门在外就只剩公网隧道那条路。
   */
  const tailscale = tailscaleNotice(detected, tailscaleCliPresent())

  if (!entries.length) {
    // 一条能用的都没有。三种成因要分开说，否则用户不知道该去改配置、去查网络，
    // 还是去查隧道——这三件事的下一步动作完全不同。
    if (status.enabled && status.error) {
      return { ok: false, error: `公网访问没起来：${status.error}`, tunnel: status, tailscale }
    }
    if (detected.length) {
      return {
        ok: false,
        error: '现在设置成只有这台电脑能连。把 settings.json 里的 bindAddress 改成 "auto"，'
          + '重启 DSH 之后手机就能连了。',
        tunnel: status,
        tailscale,
      }
    }
    return {
      ok: false,
      error: '没找到手机能连上的地址。检查一下这台电脑的 Wi-Fi／网线，或者 Tailscale 是否登录。',
      tunnel: status,
      tailscale,
    }
  }

  return { ok: true, port, token, entries, tunnel: status, tailscale }
}
