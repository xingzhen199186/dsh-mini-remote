/**
 * 用 Tailscale 自带的 HTTPS 地址，把本机服务暴露给 tailnet。
 *
 * 为什么值得做：手机端有三样东西被明文 http 挡着——完成后提醒（系统通知）、
 * 语音输入（麦克风）、剪贴板的完整能力。浏览器规定，非安全上下文一律不给用。
 * Tailscale 的 serve 给的是 Let's Encrypt 签的真证书，浏览器认。
 *
 * **这不是新的一条路，是 Tailscale 那条路上的一个升级。** 原来的
 * `http://100.92.105.99:3090` 照旧能用，这里多给一个
 * `https://<机器名>.<tailnet>.ts.net/`——而且不用写端口，更好记。
 *
 * 2026-09-24 本机实测：证书 Let's Encrypt 签、域名精确匹配、
 * 稳态往返 18 毫秒（第一次 30 秒是在签发证书）。
 *
 * **一件事必须先说清楚**：tailnet 上得先开 Serve 这个功能，否则命令会失败。
 * 那是个一次性开关，只有 tailnet 管理员能开——但 Tailscale 把开启链接直接印在
 * 报错里了，所以这里的做法是**把那条链接原样交给用户**，而不是自己写一句
 * 「请到后台开启」。见 enableLinkFrom()。
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'

/**
 * 去哪儿找 tailscale 这个命令。
 *
 * 原来写死成 `'tailscale'`、靠 PATH。这台电脑上 PATH 里有，所以一直没出问题——
 * 但这个插件不是给一个人用的，别人完全可能装在别处，或者 PATH 里没有。
 * 那对他来说就是「插件说找不到 Tailscale」，而其实装着呢。
 *
 * 按顺序试：先认环境变量给的（也是测试用的口子），再认 PATH，最后认几个常见位置。
 * 挨个试不费时间——不存在的那几个立刻回 ENOENT。
 */
export function cliCandidates() {
  const out = []
  const override = process.env.DSH_MINI_REMOTE_TAILSCALE
  if (override) out.push(override)
  out.push('tailscale')
  if (process.platform === 'win32') {
    out.push(join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'))
    out.push(join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe'))
  } else if (process.platform === 'darwin') {
    // Mac 的 GUI 版把命令行工具放在 app 包里，不一定进 PATH
    out.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  } else {
    out.push('/usr/bin/tailscale', '/usr/local/bin/tailscale')
  }
  return out
}

/**
 * 问现状给 2 秒就够——`serve status` 是查本地配置，正常几十毫秒。
 */
const STATUS_TIMEOUT_MS = 2000

/**
 * 开/关给 15 秒。这是**兜底**，正常走不到——见下面 runTailscale() 的 stopWhen。
 *
 * 为什么不是两三秒：tailnet 没开 Serve 的时候，这个命令**打印完提示还会继续挂着**
 * （2026-09-24 实测挂了 180 秒没退）。打印很快，挂着的是后面那一步。给太短会把
 * 已经拿到手的提示一起丢掉，用户就看不到那条开启链接了。
 */
const ACTION_TIMEOUT_MS = 15000

/** `Web` 里的键长这样：`<机器名>.<tailnet>.ts.net:443`。 */
const HOST_KEY_RE = /^([a-z0-9.-]+\.ts\.net):(\d+)$/i

/**
 * 跑一次 tailscale，成功失败都把输出带回来。
 *
 * **异步，不用 execFileSync。** 这个进程同时还在给手机推实时消息，同步版会把整个
 * 事件循环卡住——最长能卡 15 秒，手机上表现为「突然不动了」。查配置那一下虽然快，
 * 但快是常态、不是保证，所以两条路都用异步。
 *
 * **失败时 stdout 和 stderr 都要留**：「没开 Serve」那条关键提示印在 stderr 上，
 * 而正常的 serve status JSON 印在 stdout 上，两边都不能丢。
 *
 * **边跑边看（stopWhen）。** 「没开 Serve」那种情况，命令会先把提示打印出来、
 * 然后一直挂着不退出。只等回调的话，用户点一下开关要干等 15 秒才看到那条链接——
 * 而他明明一秒前就能看到。给了 stopWhen，就在输出里认出目标的那一刻收工、把它杀掉。
 * `stopped: true` 表示「是我叫停的，不是它自己跑完的」——**调用方必须当失败处理**，
 * 别当成开成功了。
 */
export function runTailscale(args, timeout, { stopWhen } = {}) {
  const bins = cliCandidates()
  return new Promise((resolve) => {
    let settled = false
    let acc = ''
    const finish = (ok, missing, stopped) => {
      if (settled) return
      settled = true
      resolve({ ok, out: acc, missing: Boolean(missing), stopped: Boolean(stopped) })
    }
    const attempt = (i) => {
      if (settled) return
      if (i >= bins.length) {
        finish(false, true)
        return
      }
      let child
      try {
        child = execFile(bins[i], args, { timeout, encoding: 'utf8', windowsHide: true })
      } catch {
        attempt(i + 1)
        return
      }
      let sawData = false
      const onData = (d) => {
        sawData = true
        acc += d
        if (stopWhen && stopWhen(acc)) {
          try {
            child.kill()
          } catch {
            /* 已经退了就无所谓 */
          }
          finish(true, false, true)
        }
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('error', (err) => {
        // 这个路径下没这个命令 → 试下一个。已经开始说话的就不换了，那是真出错。
        if (err?.code === 'ENOENT' && !sawData) {
          acc = ''
          attempt(i + 1)
          return
        }
        finish(false, err?.code === 'ENOENT')
      })
      child.on('close', (code) => finish(code === 0, false))
    }
    attempt(0)
  })
}

/**
 * tailnet 没开 Serve 时，Tailscale 会在报错里直接印出开启链接。把它抠出来。
 *
 * 为什么值得单独做一个函数：这是整个功能里**门槛最高的一步**——要去 tailnet
 * 后台开一个开关。而官方已经把它压缩成「点一下这个链接」了。我们自己写一句
 * 「请到后台开启 Serve 功能」等于把门槛又加回去，还指错了路。
 *
 * 实测原文：
 *     Serve is not enabled on your tailnet.
 *     To enable, visit:
 *             https://login.tailscale.com/f/serve?node=nKZqMyw1VE11CNTRL
 */
export function enableLinkFrom(text) {
  const m = /https:\/\/login\.tailscale\.com\/f\/serve\?node=[A-Za-z0-9]+/.exec(String(text ?? ''))
  return m ? m[0] : null
}

/**
 * 从 `serve status --json` 里读出：配了没有、配的是不是我们想要的那个端口。
 *
 * 用 JSON 不用文本：文本那版是印给人看的，格式随版本变；JSON 是契约。
 * 1.102.3 实测的形状：
 *
 *     { "TCP": { "443": { "HTTPS": true } },
 *       "Web": { "desktop-gbsdc68.tail0429e3.ts.net:443":
 *                { "Handlers": { "/": { "Proxy": "http://127.0.0.1:3090" } } } } }
 *
 * 没配的时候是 `{}`。
 *
 * **为什么要比对端口**：serve 可以指向任何一个本地服务。用户完全可能拿它转发
 * 别的东西（他自己的网站、别的工具）。指向别人的时候我们不能说「HTTPS 已开启」，
 * 那会把一个扫不开的地址摆到手机上。
 *
 * @param {string} json `serve status --json` 的输出
 * @param {number} port 我们的服务在听的端口
 * @returns {{url: string|null, proxyPort: number|null, servingUs: boolean}}
 */
export function readServeStatus(json, port) {
  const none = { url: null, proxyPort: null, servingUs: false }
  let data
  try {
    data = JSON.parse(String(json ?? ''))
  } catch {
    return none
  }
  const web = data?.Web
  if (!web || typeof web !== 'object') return none
  for (const [hostPort, cfg] of Object.entries(web)) {
    const m = HOST_KEY_RE.exec(hostPort)
    if (!m) continue
    const proxy = String(cfg?.Handlers?.['/']?.Proxy ?? '')
    const pm = /:(\d+)\/?$/.exec(proxy)
    const proxyPort = pm ? Number(pm[1]) : null
    return {
      url: `https://${m[1]}/`,
      proxyPort,
      // 端口对得上才算「在给我们服务」。对不上时 url 仍然带回来，
      // 好让界面说清楚「serve 配着，但指的是别的端口」，而不是含糊地说「没开」。
      servingUs: proxyPort === port,
    }
  }
  return none
}

/**
 * 问一次现状。界面每次刷新配对信息都会调它。
 *
 * 装都没装的时候直接返回 `installed: false`，不去跑 serve status——
 * 那只会多花一次超时。
 */
/**
 * 开 serve 失败时，这到底是哪种失败。
 *
 * 抽成纯函数是为了能单测：真那条路要起子进程、要装 Tailscale、还依赖 tailnet 的
 * 后台设置，测起来又慢又不可复现。而**这一支恰恰是整个功能里最要紧的一支**——
 * 它是「用户点了一下开关，结果发现要去后台开个东西」那条路，处理得对不对，
 * 决定了这个功能对非技术用户是能用还是不能用。
 *
 * 三种成因的下一步动作完全不同，所以必须分开：
 *   · `tailnet`   → 点那条链接（Tailscale 官方印出来的开启链接）
 *   · `missing`   → 去装 Tailscale
 *   · `other`     → 把原始输出截一段给用户，别吞
 *
 * @param {string} out 命令的 stdout + stderr
 * @param {boolean} missing 是不是 ENOENT（根本没这个命令）
 */
export function classifyEnableFailure(out, missing) {
  const link = enableLinkFrom(out)
  if (link) {
    return {
      reason: 'tailnet',
      error: 'Tailscale 的 Serve 功能还没在这个账号上打开。点下面这条链接开一下，'
        + '然后回来再试一次——这是个一次性的开关，开过就不用再开了。',
      enableLink: link,
    }
  }
  if (missing) {
    return {
      reason: 'missing',
      error: '这台电脑上没装 Tailscale，所以拿不到 HTTPS 地址。',
      enableLink: null,
    }
  }
  return {
    reason: 'other',
    error: `开 HTTPS 地址失败了。Tailscale 说：${String(out ?? '').trim().slice(0, 300) || '（没有输出）'}`,
    enableLink: null,
  }
}

/**
 * 从 `tailscale status --json` 里读后端状态。
 *
 * 为什么需要它：`serve status` 失败的时候，只说得出「问不出来」，可成因差别很大——
 * **没登录**的人下一步是去登录，**没开 Serve** 的人下一步是去点开启链接，
 * 而这两件事都发生在浏览器里、都得用户自己动手。笼统说一句「没开」，用户会去干错的事。
 *
 * `AuthURL` 只在需要登录时才由 Tailscale 给出，正好可以原样递给用户——
 * 和那条开启链接是同一个套路。
 */
export function readBackendState(text) {
  const none = { state: null, authUrl: null }
  let d
  try {
    d = JSON.parse(text)
  } catch {
    return none
  }
  if (!d || typeof d !== 'object') return none
  return {
    state: typeof d.BackendState === 'string' ? d.BackendState : null,
    // 只认 https 的，别把一个奇怪的串塞进 href 里
    authUrl: typeof d.AuthURL === 'string' && /^https:\/\//.test(d.AuthURL) ? d.AuthURL : null,
  }
}

export async function serveState(port) {
  // 这里也挂 stopWhen：tailnet 没开 Serve 时，`serve status` 很可能和 `--bg` 一样
  // 「打印完提示就挂着」。那样的话，面板一加载就能拿到那条开启链接——用户连开关
  // 都不用点，一眼就看到该去哪儿开。
  const r = await runTailscale(['serve', 'status', '--json'], STATUS_TIMEOUT_MS, {
    stopWhen: (out) => Boolean(enableLinkFrom(out)),
  })
  if (!r.ok) {
    const enableLink = enableLinkFrom(r.out)
    // 问不出来的时候再问一次后端状态。没装的话不用问——`missing` 已经说清楚了。
    let backend = { state: null, authUrl: null }
    if (!r.missing) {
      const st = await runTailscale(['status', '--json'], STATUS_TIMEOUT_MS)
      if (st.ok) backend = readBackendState(st.out)
    }
    const needsLogin = backend.state === 'NeedsLogin' || backend.state === 'NeedsMachineAuth'
    return {
      installed: !r.missing,
      configured: false,
      servingUs: false,
      url: null,
      urlOfOtherPort: null,
      backendState: backend.state,
      needsLogin,
      /** 需要登录时 Tailscale 给的登录链接，原样递给用户。 */
      loginUrl: needsLogin ? backend.authUrl : null,
      error: r.missing
        ? null
        : needsLogin
          ? 'Tailscale 装了，但这个账号还没登录。'
          : '问不出来 Tailscale serve 的现状。',
      enableLink,
    }
  }
  const s = readServeStatus(r.out, port)
  return {
    installed: true,
    configured: Boolean(s.url),
    servingUs: s.servingUs,
    url: s.servingUs ? s.url : null,
    /** serve 配着、但指的是别的端口。界面要说清楚，不能含糊成「没开」。 */
    urlOfOtherPort: s.url && !s.servingUs ? s.url : null,
    // 下面这几个成功路径上也要带，形状才对得齐——界面不用分情况取字段。
    backendState: 'Running',
    needsLogin: false,
    loginUrl: null,
    error: null,
    enableLink: null,
  }
}

/**
 * 打开。成功时返回拿到的网址。
 *
 * 失败要分三种说清楚，因为下一步动作完全不同：
 *   · 没装 Tailscale          → 去装
 *   · tailnet 没开 Serve      → 点那条链接（enableLink）
 *   · 别的（超时、权限…）      → 把原始输出截一段给用户，别吞
 */
export async function serveEnable(port) {
  // stopWhen：输出里一出现那条开启链接就立刻收工，不必等它挂满 15 秒。
  // 收工后 r.stopped 为真，**必须当失败处理**：命令是被我叫停的，serve 并没有开成。
  const r = await runTailscale(['serve', '--bg', String(port)], ACTION_TIMEOUT_MS, {
    stopWhen: (out) => Boolean(enableLinkFrom(out)),
  })
  if (!r.ok || r.stopped) return { ok: false, ...classifyEnableFailure(r.out, r.missing) }
  // 开完再问一次，把真实网址取回来——不从这次输出里抠，免得格式变了就错。
  const s = await serveState(port)
  return { ok: true, url: s.url, state: s }
}

/**
 * 关掉。
 *
 * 用 `--https=443 off` 而不是 `serve reset`：reset 会把**所有** serve 配置一起清掉，
 * 包括用户自己拿它转发的别的东西。我们只该收自己开的那一扇门。
 */
export async function serveDisable() {
  const r = await runTailscale(['serve', '--https=443', 'off'], ACTION_TIMEOUT_MS, {
    stopWhen: (out) => Boolean(enableLinkFrom(out)),
  })
  if (r.ok) return { ok: true }
  return {
    ok: false,
    error: `关掉 HTTPS 地址失败了。Tailscale 说：${r.out.trim().slice(0, 300) || '（没有输出）'}`,
  }
}
