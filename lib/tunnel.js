/**
 * 起一条 cloudflared 快速隧道，把本机的手机服务暴露到一个公网网址。
 *
 * 「快速隧道」是 Cloudflare 提供的免账号模式：跑起来就给你一个
 * `https://<随机词>.trycloudflare.com` 的地址，转发回本机。代价是**这个网址
 * 每次重启都会换一个**，所以手机上的旧链接会失效，得重新扫一次二维码。
 */
import { spawn } from 'node:child_process'

/**
 * 从 cloudflared 的输出里挑出公网网址。
 *
 * 有个坑：输出里会**先**出现 `https://api.trycloudflare.com`——那是它向
 * Cloudflare 注册时用的接口地址，不是给你的网址。不加排除就会把用户送到一个
 * 打不开的地址上。所以用负向前瞻把 `api.` 开头的排掉。
 */
export const QUICK_TUNNEL_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i

/**
 * 公网隧道失败时，告诉用户「接下来做什么」。
 *
 * 2026-09-22 实测：本机代理的 **TUN 模式**（Clash 这类）会掐断 cloudflared 到 Cloudflare
 * 边缘的连接——cloudflared 好好活着，却一条 ESTABLISHED 都没有；DNS 还被劫持成
 * `198.18.x.x` 这种假地址（RFC 2544 保留段，真实世界不存在），走假地址访问隧道，
 * Cloudflare 回 530（也就是用户看到的 Error 1033）。
 *
 * 这个坑 dsh-pocket 也踩过，它的报错文案里就写着「是否开着代理/VPN（Clash 等 TUN 模式
 * 会掐断隧道连接）」。它没有解决，只是把它写进报错——因为**用户看到「连不上」的第一
 * 反应是重试，而正确的动作往往是关代理**。所以这句必须写出来，不能省。
 *
 * 顺带指一条走得通的路：这个插件本来就有 Tailscale 那条，不必在 Cloudflare 上死磕。
 *
 * 放在这里（而不是 index.js 里）是为了能单测：文案本身就是这次的交付物，
 * 少写一句「关代理」用户就会一直重试，值得钉住。
 */
export const TUNNEL_HINT = '如果电脑上开着代理或 VPN（Clash 这类），先关掉再试一次——它们的'
  + '「TUN 模式」会把隧道连接掐断。关掉还不行，就说明这条网络走不通 Cloudflare，'
  + '改用设置页里的 Tailscale 那条（出门在外它更稳）。'

/**
 * 从一段输出里挑出公网网址，没有就返回 null。
 * 单独抽出来是为了能直接测——这段正则的坑（`api.trycloudflare.com` 要先出现）
 * 值得用测试钉住，而不是靠真连一次 Cloudflare 去碰运气。
 */
export function parseTunnelUrl(text) {
  return QUICK_TUNNEL_URL_RE.exec(String(text ?? ''))?.[0] ?? null
}

/** 累积输出的上限。网址最多几十字节，留 8KB 足够，免得日志越攒越多。 */
const TAIL_LIMIT = 8000

const START_TIMEOUT_MS = 30_000

/**
 * @param {object} opts
 * @param {string} opts.binPath cloudflared 可执行文件
 * @param {number} opts.port 本机手机服务的端口
 * @returns {Promise<{url: string, stop: () => void, onExit: (cb: (code: number|null) => void) => () => void}>}
 */
export function startTunnel({ binPath, port, log }) {
  // --no-autoupdate 必须放在子命令**之前**：cloudflared 2026.x 去掉了 `tunnel`
  //   子命令层级的这个参数，全局位置仍然有效。
  // --protocol http2 是必要的：默认走 QUIC（UDP 7844），国内网络和不少企业网把
  //   UDP 封掉，表现是隧道报 error 1033 连不上；HTTP/2 走 TCP 443，基本都通。
  // --edge-ip-version 4 同样是必要的，而且更隐蔽：隧道控制面 region1/region2.
  //   v2.argotunnel.com 在不少网络里**只解析出 IPv6**，而那条路往往不通。实测
  //   不加这个参数时，cloudflared 要么卡在向 api.trycloudflare.com 注册（POST
  //   超时），要么拿到网址却连不上边缘（公网访问回 HTTP 530）；加上之后连接
  //   立刻注册成功。走 IPv4 的代价是可以接受的——隧道两端都是 Cloudflare 的
  //   任播地址，IPv4 覆盖没有短板。
  const child = spawn(
    binPath,
    [
      '--no-autoupdate',
      'tunnel',
      '--url', `http://127.0.0.1:${port}`,
      '--protocol', 'http2',
      '--edge-ip-version', '4',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const exitListeners = new Set()
  const stop = () => {
    try {
      child.kill()
    } catch {
      // 已经退出了
    }
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
    let tail = ''

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      stop()
      reject(new Error(`等了 30 秒还没拿到公网网址。cloudflared 最后说的话：\n${tail.trim().slice(-500)}`))
    }, START_TIMEOUT_MS)
    timer.unref?.()

    // 拿到网址之后仍然保持监听、只是不再处理——中途摘掉监听会让管道不再被消费，
    // 64KB 缓冲填满后 cloudflared 会被卡住。
    const onData = (chunk) => {
      if (settled) return
      // 要在**累积**的缓冲区里找，不能只看刚到这一块：网址有可能被拆成两次写出来。
      tail = (tail + String(chunk)).slice(-TAIL_LIMIT)
      const found = parseTunnelUrl(tail)
      if (!found) return
      settled = true
      clearTimeout(timer)
      log?.info?.(`公网地址：${found}`)
      resolve({ url: found, stop, onExit })
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`cloudflared 起不来：${err?.message ?? err}`))
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`cloudflared 提前退出了（退出码 ${code}）。它最后说的话：\n${tail.trim().slice(-500)}`))
    })
  })
}
