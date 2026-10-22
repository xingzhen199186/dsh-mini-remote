/**
 * 插件自带的轻量 HTTP 服务。
 *
 * 为什么不挂在 ctx.webServer 上：DSH 主服务的 host 只能是 127.0.0.1 或
 * 0.0.0.0（见 dsh-host-webserver 的 Config 声明），没法只绑 Tailscale 虚拟 IP。
 * 而把主 GUI 暴露到 0.0.0.0 是不可接受的。所以这里自己起一个 node:http，
 * 绑定地址完全由插件配置决定。
 *
 * 传输用 SSE 而不是 WebSocket：
 *   - 零依赖（不用 ws）
 *   - EventSource 自带断线重连，移动端切后台回来能自愈
 *   - 只需要服务端→手机单向推送；手机发指令用普通 POST 即可
 */
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPage, readArt, readImage, readSw } from './page.js'
import { credentialLooksLikeOurs } from './devices.js'
import { isLocalRequest } from './net.js'

const COOKIE = 'dsh_mini_token'

/**
 * 「设备身份」那枚凭据存放的名字（见 lib/devices.js）。
 *
 * **另起一个名字，不共用令牌那个 cookie**：令牌是「入场邀请函」（带配对码打开
 * `/mini?token=…` 那一下用它），设备凭据是进门之后的长期身份。两者的寿命和撤销
 * 方式都不一样——混在一个 cookie 里，撤销一台设备就成了「连口令一起作废」。
 *
 * `HttpOnly`：手机页一行 JS 都不需要读它（浏览器自己带），而**不放进 JS 能碰到的
 * 地方**顺带堵掉一条路——页面里那些拼 URL 的代码（立绘、SSE、镜像框）就永远
 * 不会把它写进地址里。
 */
const DEVICE_COOKIE = 'dsh_mini_device'

/**
 * 「远程窗口」那张一次性票换来的窗口会话，存在浏览器里的名字。
 *
 * **它不是令牌**（所以另起一个名字，不共用上面那个 cookie）：它只够进
 * `/mini/mirror` 这一层，由 `lib/mirror.js` 的 `windowValid` 认，**寿命跟着宿主进程走**
 * （DSH 一重启就不认了，见 lib/mirror.js 的 PROCESS_SECRET）。
 * 桌面端的「远程窗口」面板就靠它——**令牌全程不进浏览器**（设计稿那条硬规矩）。
 *
 * 会话里还签着**这一扇窗是谁的**（2026-10-16 第四步）：一台设备的 id，或者下面那个
 * `LOCAL_WINDOW_DEVICE`。设备 id 那一种**每次验完会话都要回头查一次名册**，记录不在
 * 就当场拒——这就是「撤销一台设备，它开着的窗口下一次请求就 401」（见 windowSession）。
 *
 * `HttpOnly`：框里跑的是官方界面那一整套客户端代码，它没有理由读得到这枚值。
 */
const WINDOW_COOKIE = 'dsh_mini_window'

/**
 * 「本机那一半」在窗口会话里的身份标记。
 *
 * 桌面端那个面板的票是**这台电脑自己的软件**来换的（`/mini-remote/window`，只允许
 * 本机调用，见 lib/index.js），它跟名册里的设备不是一回事：本机的软件本来就有这台
 * 电脑的全部权限，也没有"把这一台撤销掉"这种操作。所以按 `local` 记，**不查名册**。
 *
 * 它不是凭据、也换不出任何东西——只是把「这扇窗是谁的」这一格填上，让远程设备那一
 * 路必须有名册里的身份才能开窗（见 ticketWindowOwner 的第三条）。
 * **发票那一方要给的就是这个值**（lib/index.js 那条本机路由把它记进票里，兑票时再
 * 从票上读出来，见 ticketWindowOwner），所以它导出去给那边用——不在第二个文件里
 * 另写一个 'local' 字面量。
 */
export const LOCAL_WINDOW_DEVICE = 'local'

/**
 * 镜像页「诊断模式」那份样本落在哪。
 *
 * **`scratch/` 是 gitignore 的**，所以诊断日志扔在这里不会入库；
 * 路径按本文件的位置算（`lib/server.js` 的上一级就是插件根目录），
 * 装到哪儿都不用再配一次。
 *
 * `DSH_MINI_DIAG_LOG` 可以整体换掉它——**测试用它写到临时文件**，
 * 免得测试的样本混进真机上那一份里，让读日志的人分不清哪条是真机报的。
 */
function diagLogPath() {
  const override = process.env.DSH_MINI_DIAG_LOG
  if (override) return override
  return fileURLToPath(new URL('../scratch/diag.log', import.meta.url))
}

/**
 * 配置的端口被占时，往后最多再试几个。
 *
 * 5 是个折中：够躲开「某个程序占了 3090」这种最常见的冲突，又不会在端口段整个
 * 被防火墙或别的服务吃掉时，在这里白白等一圈。
 */
const PORT_TRIES = 5

/**
 * 手机上传的单个文件上限。
 *
 * DSH 那边**不设**文件大小上限（图片才有），所以这个数是我们的取舍：手机上常见的
 * 是照片、截图、PDF，几十兆足够覆盖；再大就是视频了，而这条路上没有进度条，传一个
 * 几百兆的文件会让用户对着一个转圈的界面干等，还不知道要等多久。宁可早一点、
 * 明确地拒绝，也不要让它悬着。
 */
const MAX_UPLOAD = 50 * 1024 * 1024

/** 把字节数说成人话。 */
function mb(bytes) {
  return `${Math.round(bytes / 1024 / 1024)} MB`
}
const MAX_BODY = 64 * 1024
const HEARTBEAT_MS = 25_000

/**
 * 密码试错的限速。
 *
 * 默认放开到内网之后，同一个 Wi-Fi 下的任何设备都能连到这个端口。token 是
 * 128 位随机值，猜不出来；但万一它从别处漏了（比如二维码截图被转发），
 * 限速是最后一道闸。同一来源一分钟内错 5 次，就挡一分钟。
 */
const RATE_WINDOW_MS = 60_000
const RATE_MAX_FAILURES = 5

/**
 * 定长比较，避免 token 被逐字节试探。
 *
 * 导出是给「配对」那条路由用的（lib/index.js 的 `/mini-remote/pair`，它拿口令换凭据）：
 * 同一件事在第二处再写一遍，迟早一处改了另一处没改——而这里写错的表现是"口令变得猜得动"。
 */
export function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * 限速分桶用的键。
 *
 * 走隧道进来的请求，源地址全是 127.0.0.1（cloudflared 在本机回环上回连我们）。
 * 要是按源地址分桶，随便谁在公网上错 5 次密码，就能把你自己手机也一起锁在
 * 外面一分钟；反复触发就是一条拒绝服务的路子。所以隧道流量改按 cloudflared
 * 填进来的真实客户端地址分桶。
 *
 * 隧道流量靠 Host 头识别——cloudflared 会把 Host 设成公网域名。Host 是可以
 * 伪造的，但伪造它最多只能绕开限速；限速本来就是 128 位 token 之外的第二道
 * 保险，绕开它照样猜不出 token。
 */
export function clientKey(req, tunnelHost) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  if (tunnelHost && host && (host === tunnelHost || host.startsWith(`${tunnelHost}:`))) {
    const forwarded = forwardedClient(req)
    if (forwarded) return `fwd:${forwarded}`
  }
  return `src:${req.socket?.remoteAddress ?? 'unknown'}`
}

function forwardedClient(req) {
  const cf = req.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.trim()) return cf.trim()
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim()
  return null
}

function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * 镜像那几条路径**此刻走不通**时，回给手机的那一页（调用处见 `handle` 里的兜底 404）。
 *
 * ## 为什么非要有它（2026-10-08 真机截图）
 *
 * `/mini/mirror` 那一整块路由是挂在开关上的（见 `handle` 里 `mirrorEnabled()` 那一行），
 * 所以「开关关着」和「电脑端还没就绪」这两种时候，`/mini/mirror/…` 会掉进兜底 404，
 * 原来回的是 `{"error":"not found"}`。**而手机那一页是把镜像嵌在 iframe 里的**：
 * 这个 JSON 于是成了框里的**文档**，被浏览器当成页面渲染出来——用户看到的是框里一条
 * 外星文（华为浏览器还给它套了个「美观输出」的 JSON 查看器），外面那条
 * 「电脑端界面 / 返回」却还好端端地在，看起来就像界面坏了。**给程序看的正文跑到了人眼前。**
 *
 * ## 三条要求
 *
 * ① **人话**：现在打不开、以及下一步做什么；
 * ② **自己会重试**：宿主刚重启那几十秒里上游地址还没解析出来，等一下它自己就好了
 *    ——真机上「有时候打得开、有时候打不开」就是这一段（见 lib/mirror.js 的 resolveReady）；
 * ③ **有出口**：那个框里没有别的按钮，所以给一个「返回手机页」——它给外层页发一条消息，
 *    `lib/page.html` 里接住、把那整屏收起来。
 *
 * **状态码仍然是 404**：这条路此刻确实不存在（开关关着时它就该像不存在一样），
 * 这里换掉的只是**正文**，不是「这条路存不存在」这件事本身。
 */
export function sendMirrorUnavailable(res) {
  // 重试次数放在地址里（`&retry=n`）：不依赖 localStorage，也不会让框里的历史变长
  // （用 location.replace）。**次数用尽就停下**——一直空转会烧手机的电，也永远不给交代。
  // 入口那一下会把整个查询串丢掉，所以这个参数绝不会漏到上游去。
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>电脑端界面现在打不开</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 24px 18px; color: #1b1b1b; background: #fff;
         font: 15px/1.7 system-ui, -apple-system, "Noto Sans CJK SC", sans-serif; }
  h1 { margin: 0 0 12px; font-size: 17px; }
  p { margin: 0 0 10px; color: #555; }
  .acts { display: flex; gap: 10px; margin-top: 20px; }
  button { font: inherit; padding: 10px 16px; border-radius: 2px; color: inherit;
           border: 1px solid #d6d6d6; background: #f6f6f6; }
  @media (prefers-color-scheme: dark) {
    body { color: #eee; background: #111; }
    p { color: #aaa; }
    button { border-color: #3a3a3a; background: #1e1e1e; }
  }
</style>
</head>
<body>
<h1>电脑端界面现在打不开</h1>
<p id="why">正在等电脑端就绪…</p>
<p>电脑端刚起来的那几十秒里会是这样，等一下通常就好。如果一直打不开：回到手机页，在「进阶设置」里确认「电脑端界面」是开着的，再点一次「打开」。</p>
<div class="acts">
  <button id="retry" type="button">重试</button>
  <button id="back" type="button">返回手机页</button>
</div>
<script>(function () {
  var MAX = 5;                 // 自己最多重试几次
  var GAP = 2500;              // 每次之间隔多久
  var why = document.getElementById('why');
  var url = new URL(location.href);
  var n = Number(url.searchParams.get('retry') || 0);
  if (!(n >= 0)) n = 0;
  document.getElementById('retry').addEventListener('click', function () {
    var clean = new URL(location.href);
    clean.searchParams.delete('retry');
    location.replace(clean.toString());
  });
  document.getElementById('back').addEventListener('click', function () {
    try { window.parent.postMessage('mini-mirror-close', '*'); } catch (e) {}
  });
  if (n >= MAX) {
    why.textContent = '还没等到电脑端就绪（也可能是手机那边的开关关着）。';
    return;
  }
  why.textContent = '正在等电脑端就绪…（第 ' + (n + 1) + ' 次，共 ' + MAX + ' 次）';
  url.searchParams.set('retry', String(n + 1));
  setTimeout(function () { location.replace(url.toString()); }, GAP);
})();</script>
</body>
</html>`
  const buf = Buffer.from(html, 'utf8')
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  })
  res.end(buf)
}

/**
 * 「这张票不作数了」那一页（票不对、过期、或者已经用过）。
 *
 * 为什么也要一页人话：这张票唯一的用处就是被塞进 iframe 的地址（见
 * `lib/index.js` 的 `/mini-remote/window`），所以**它的读者是框，不是程序**。
 * 回 JSON 的话，用户看到的就是框里一段外星文——和 2026-10-08 那次
 * `{"error":"not found"}` 是同一个毛病（见上面 sendMirrorUnavailable）。
 *
 * 说清两件事就够了：为什么没进来（票是一次性的、只活 30 秒），下一步做什么
 * （回到「远程窗口」重新打开一次）。**不给重试按钮**：票已经废了，重试一万次
 * 也还是这张废票，得由面板那边重新要一张。
 *
 * 状态码 403：这次请求确实没有通行资格（不是「这条路不存在」）。
 */
export function sendWindowTicketBad(res) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>这个窗口的通行证过期了</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 24px 18px; color: #1b1b1b; background: #fff;
         font: 15px/1.7 system-ui, -apple-system, "Noto Sans CJK SC", sans-serif; }
  h1 { margin: 0 0 12px; font-size: 17px; }
  p { margin: 0 0 10px; color: #555; }
  @media (prefers-color-scheme: dark) {
    body { color: #eee; background: #111; }
    p { color: #aaa; }
  }
</style>
</head>
<body>
<h1>这个窗口的通行证过期了</h1>
<p>通往电脑端界面的通行证是一次性的，而且只活 30 秒。</p>
<p>回到「远程窗口」，重新打开一次就会换一张新的。</p>
</body>
</html>`
  const out = Buffer.from(html, 'utf8')
  res.writeHead(403, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': out.length,
    'Cache-Control': 'no-store',
  })
  res.end(out)
}

/**
 * @param {object} opts
 * @param {import('./store.js').createStore extends (...a:any)=>infer R ? R : never} opts.store
 * @param {{port:number, defaultMode:string}} opts.config
 * @param {string[]} opts.bindAddresses 要监听的地址；第一个应是 127.0.0.1
 * @param {string} opts.token
 * @param {{pair?:Function, remoteWindow?:Function, browse?:Function, browseRoots?:Function, browseMkdir?:Function, workspaces?:Function}} [opts.remoteRoutes]
 *        「跨机那两条」（配对 / 跨机取票）**在手机服务这个端口上的第二份挂载点**——
 *        处理函数由 lib/index.js 原样递进来（那边是唯一的实现），这里只负责"这个地址
 *        也走那一份"。见 `handle` 里那段说明：加上它就是"B 只填一条地址"成立的原因。
 *        两个字段都可以先空着（createMiniServer 起来的时候那两条路由还没挂），
 *        每次请求现取。不给这个参数，手机服务就跟从前一模一样。
 * @param {{verify:(credential:string)=>object|null, register:(opts?:object)=>object}} [opts.devices]
 *        「设备身份」名册（见 lib/devices.js）。不给就是「这一步没开设备身份」——
 *        手机照旧靠令牌进来，只是不会被登记。
 */
// ---------------------------------------------------------------------------
// 插件主体取用「推提问给手机」「手机还在不在」这两个能力的地方。
//
// **为什么不靠 createMiniServer 的回执**：实测那句 `mini.server = createMiniServer(…)`
// 拿到的凭据兑现出来是 `undefined`（仪表原样打出来的），而这两个能力确实写在了函数
// 末尾的返回对象里。回执为什么是空的还没查清，但插件真正需要的只是这两个功能能用——
// 所以改成服务启动时**主动把能力放到这个固定位置**，插件直接来取，不经过回执那一道。
// 这样无论回执是空的还是满的，功能都不受影响。
//
// 做成模块级单例：一个进程里只会起一个遥控服务（测试里会起多个，后起的覆盖先起的；
// 有一条用例会临时替换这两个字段来验提问钩子，用完就还回去）。
export const miniControl = {
  askPhone: null,
  hasPhone: null,
}

/**
 * @param {object} opts
 * @param {() => string | null} [opts.tunnelHost] 当前公网域名（没开隧道时返回 null），只用于限速分桶
 * @param {(text:string)=>Promise<{ok:boolean, error?:string, sessionId?:string}>} opts.onInstruction
 * @param {()=>({ok:boolean, error?:string, commands?:object[]})} [opts.onCommands] 列这台电脑上这个会话能用的斜杠指令
 * @param {(line:string)=>Promise<{ok:boolean, error?:string}>} [opts.onCommand] 执行一条斜杠指令
 * @param {()=>Promise<{ok:boolean, error?:string, sessionId?:string}>|{ok:boolean, error?:string, sessionId?:string}} opts.onStop
 * @param {(id:string)=>{ok:boolean, error?:string, sessionId?:string}} opts.onUnqueue
 * @param {() => (string|undefined)[]} [opts.imageRoots] 正文里相对路径图的额外候选根
 *        （由插件递进「当前已注册工作区的目录」，见 extraImageRoots 那段）
 * @returns {Promise<{port:number, addresses:string[], failed:{address:string,message:string}[], close:()=>Promise<void>, broadcast:(event:string, data:unknown)=>void, broadcastTrajectory:(payload:object)=>void, broadcastTrajectoryLive:(payload:object)=>void}>}
 */
export async function createMiniServer({ store, config, token, bindAddresses, tunnelHost, onInstruction, onCommands, onCommand, onStop, onUnqueue, onUpload, onSessionOpened, log, tree, browse, build, imageRoots, mirror, mirrorEnabled, remoteRoutes, devices, agentHub }) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set()

  /**
   * 这条连接到底是谁——**订阅要按连接记，就得先有身份**。
   *
   * SSE 那边只有一个 `res`，一次普通的 POST 认不出「我是哪条流」。所以由客户端自己
   * 生成一个随机串，两处都带上：连流时 `?clientId=…`，之后每一次开关订阅也带它。
   * 客户端没报的（比如现在这版手机页面）服务端也给它编一个，只为日志里能对上号——
   * 那种连接**订不了轨迹**，也就不会为这份体积付钱。
   */
  const clientsById = new Map()
  /**
   * 想要执行轨迹推送的那几条连接。
   *
   * 为什么必须按连接分流：轨迹的体积是回答正文的 **90.7 倍**（单轮最高约 946KB，
   * 单条输出最大 49,930 字符），而现在的 `state` 是「每条广播都发整份快照」。
   * 把它塞进那条路会把手机压垮，所以它走单独的增量帧，并且**只有声明要「完整」模式的
   * 那几台**才推。声明有两条路：
   *   ① 连上来时带 `?full=1`——断线重连之后自动重新对齐，不用先握手一次；
   *   ② 连上之后 `POST /mini/api/trajectory/subscribe`——切模式时用，不必重连。
   */
  const trajectorySubscribers = new Set()
  /**
   * **要正文流式的那几条连接**（2026-10-21 加）：手机页的「流式」开关开着时，
   * 连上来带 `?stream=1`。和上面那批分开，因为正文帧比思考帧重得多——开关关着的
   * 设备不该为它花流量。**这批连接同时也是 `trajectorySubscribers` 的一部分**
   * （正文要在轨迹里显示，本来就得是完整模式），这里只是"额外再收一种帧"。
   */
  const liveTextSubscribers = new Set()
  let clientSeq = 0

  /**
   * 「刚种下窗口 cookie」的时刻，以及**种下之后却没被带回来**的次数（2026-10-18）。
   *
   * 为什么要专门盯它：那枚 cookie 被浏览器拒掉的后果是**静默的**——跨机那一屏会停在
   * 「Loading plugins…」，用户只会以为"对面没开"或者"网络不通"。而真正的原因往往是
   * 浏览器/企业策略拦了「第三方 cookie」，换一个浏览器、或者把地址加进例外就好了。
   *
   * 判据只认"兑过票之后短时间内又来了不带这枚 cookie 的请求"：兑票那一次本来就不带
   * （那时还没种下），所以 `ticketOpen` / `frameOpen` 那两下要排除掉。
   * **连两次才算数**——一次可能只是竞态（刚改过密码、或者用户同时开了两个浏览器）。
   */
  let windowCookieAt = 0
  let windowCookieMisses = 0

  /**
   * 「这条活连接是哪台设备的」——撤销时要**主动掐断**它，所以得先记得住。
   *
   * 为什么非记不可（用户拍板的第 4 条）：手机那边是 SSE 单向推送，撤销之后它只要
   * 还挂着那条流就照样收得到新消息。只靠「下一次请求被拒」，用户看到的是"撤销了但
   * 那台手机还在动"，于是以为没生效——这正是要避免的假象。
   *
   * 两张表分别对两条长连接：
   *   · `deviceStreams` —— `/mini/api/stream` 那条 SSE（手机页的主路）；
   *   · `deviceSockets` —— 镜像里那个框的 WebSocket（`/api/remote.mux`，官方界面
   *     那条常驻连接）。框里的 HTTP 请求撤销后自然会 401，但已经握手成功的 WS
   *     不查权限、会一直活着，所以它也得跟着断。
   *
   * **只记 id，不记凭据**：凭据（密钥那半截）从不进内存表，也从不进日志。
   */
  const deviceStreams = new Map()
  const deviceSockets = new Map()

  /**
   * 「这一代服务」的编号。进程重启、服务重起都会换一个。
   *
   * 客户端拿它认出「对面换人了」：那种时候帧序号会从头开始，手里的轨迹该整个重拉一次。
   * 光看 seq 是不够的——重启后 seq 也是从 1 开始，看着就像什么都没发生。
   */
  const EPOCH = randomBytes(4).toString('hex')

  // 导航栏的数据比普通状态更适合做 stale-while-revalidate：工作区和会话不会因为
  // 用户打开一次菜单就必须重新清点。第一次没有缓存时仍然等待真实结果；之后先回上次
  // 整理好的列表，再在后台刷新。手动点刷新时由请求方显式 force，保持原来的语义。
  const NAV_CACHE_TTL_MS = 30_000
  let navWorkspaceCache = { value: null, at: 0, inflight: null }
  const SUBAGENT_CACHE_TTL_MS = 5_000
  const subagentCaches = new Map()
  function invalidateNavigation() {
    navWorkspaceCache = { value: null, at: 0, inflight: null }
  }

  function invalidateSubagents(sessionId) {
    if (sessionId) subagentCaches.delete(sessionId)
    else subagentCaches.clear()
  }

  async function loadSubagents(sessionId) {
    if (!sessionId) return nav.subagents(sessionId)
    const hit = subagentCaches.get(sessionId)
    if (hit && Date.now() - hit.at < SUBAGENT_CACHE_TTL_MS) return hit.value
    if (hit?.inflight) return hit.inflight
    const inflight = Promise.resolve(nav.subagents(sessionId, { includeMetrics: false, scheduleMetrics: true })).then((value) => {
      subagentCaches.set(sessionId, { value, at: Date.now(), inflight: null })
      return value
    }).finally(() => {
      const current = subagentCaches.get(sessionId)
      if (current?.inflight === inflight) current.inflight = null
    })
    subagentCaches.set(sessionId, { value: hit?.value ?? null, at: hit?.at ?? 0, inflight })
    return hit?.value ?? inflight
  }

  async function loadWorkspaces(runningIds, force = false) {
    const now = Date.now()
    const fresh = navWorkspaceCache.value && now - navWorkspaceCache.at < NAV_CACHE_TTL_MS
    if (!force && navWorkspaceCache.value) {
      if (!fresh && !navWorkspaceCache.inflight) {
        navWorkspaceCache.inflight = refreshWorkspaces(runningIds, false)
          .finally(() => { navWorkspaceCache.inflight = null })
      }
      return navWorkspaceCache.value
    }
    if (navWorkspaceCache.inflight) return navWorkspaceCache.inflight
    navWorkspaceCache.inflight = refreshWorkspaces(runningIds, force)
      .finally(() => { navWorkspaceCache.inflight = null })
    return navWorkspaceCache.inflight
  }

  async function refreshWorkspaces(runningIds, force) {
    const started = performance.now()
    const value = await nav.listWorkspaces(runningIds, force, true)
    navWorkspaceCache = { value, at: Date.now(), inflight: null }
    const elapsed = Math.round(performance.now() - started)
    log?.info?.(`导航工作区读取 ${elapsed}ms（${value.length} 个）`)
    return value
  }

  // 没传 tree（测试里就是这样，headless 组合里也拿不到那两个服务）时给个空壳，
  // 导航栏显示「取不到」，遥控本身照常。
  // `createSession` 的空壳回 `no-controller`，跟真服务缺位时走同一条错误路径——
  // 这样「没这个能力」只有一种说法，不用分两处处理。
  const nav = tree ?? {
    listWorkspaces: async () => [],
    listSessionsOf: async () => null,
    createSession: async () => ({ ok: false, reason: 'no-controller' }),
    createWorkspace: async () => ({ ok: false, reason: 'no-registry' }),
    permissions: async () => ({ ok: false, reason: 'no-service' }),
    setPermission: async () => ({ ok: false, reason: 'no-service' }),
    // 模型那两个的**空壳**：测试里没有真的 DSH，照上面的样式如实说"没这个能力"。
    modelCatalog: async () => ({ ok: false, reason: 'unavailable' }),
    selectModel: async () => ({ ok: false, reason: 'unavailable' }),
    // 子智能体那四个的空壳，同样如实说"没这个能力"，不假装有一份空列表。
    subagents: async () => ({ ok: false, error: '这台电脑上的 DSH 没提供子智能体。' }),
    subagentTranscript: async () => ({ ok: false, error: '这台电脑上的 DSH 没提供子智能体。' }),
    stopSubagent: async () => ({ ok: false, error: '这台电脑上的 DSH 没提供子智能体。' }),
    askSubagent: async () => ({ ok: false, error: '这台电脑上的 DSH 没提供子智能体。' }),
    // 会话条目那六个动作、以及三个读状态的空壳。同样如实说"没这个能力"——
    // 假装成功会让手机把一次没发生的归档画成已归档，那是最坏的一种假。
    sessionFlags: () => ({ ok: false, reason: 'no-registry', archived: [], pinned: [] }),
    sessionSummaries: async () => ({ ok: false, reason: 'unavailable', byId: new Map() }),
    pendingInteractions: () => ({}),
    renameSession: async () => ({ ok: false, reason: 'no-service' }),
    forkSession: async () => ({ ok: false, reason: 'no-service' }),
    pinSession: async () => ({ ok: false, reason: 'no-registry' }),
    unpinSession: async () => ({ ok: false, reason: 'no-registry' }),
    archiveSession: async () => ({ ok: false, reason: 'no-registry' }),
    unarchiveSession: async () => ({ ok: false, reason: 'no-registry' }),
  }

  // 目录浏览的空壳。它**只依赖 node:fs**，不像 tree 那样依赖 DSH 的服务，
  // 所以正常情况下永远用真的那个；这个空壳是给测试用的（测试不该真去读盘）。
  const files = browse ?? {
    listRoots: async () => ({ home: '', drives: [], recent: [] }),
    listDirectory: async () => ({ ok: false, reason: 'unavailable' }),
    makeDirectory: async () => ({ ok: false, reason: 'unavailable' }),
  }

  /**
   * 会话列表的**分组口径**——手机导航栏那一屏照着它画。
   *
   * 这套口径是照 PC 侧栏的官方说法对齐的（0.2.0-rc.2 的 `sidebar.workspaces` 文档原文）：
   *   · 「视图选项以一组显式三选一控制显隐：**隐藏已归档（默认项）**隐藏已归档 Session，
   *     全部对话（显示已归档）将其纳入列表……」→ 我们只做两档（默认隐藏 / 显示），
   *     因为手机这个抽屉只有一层筛选，多一档就是多一次"我到底在哪一档"的困惑。
   *   · 「**正在运行的 Session（包括有子会话正在运行的父会话）始终按原顺序显示，
   *     不占用这五条配额**」→ 配额只数空闲的（这一层只管"是不是在跑"，5 条那个数
   *     属于界面状态，在页面上算）。
   *   · 「当前选中的空白**新会话**在首条提示词落地前也作为额外行」→ 空白会话整条不列，
   *     但**当前绑定的那一个例外**——你自己刚在手机上建的那个不能当场消失。
   *   · 「未保存标题的历史会话显示本地化名称『未命名 / Untitled』，**不使用目录名兜底**」
   *     → 标题为空就是空，页面显示「未命名会话」，我们不在这一层编一个名字。
   *
   * **空白这条判据拿不到时一条都不隐藏**（`blankKnown:false`）：拿"标题为空"当空白
   * 会让一条只是标题没读出来的老会话当场消失，那是拿猜测当事实。宁可少做，不编。
   */
  async function shapeSessions(result, { showArchived, boundSessionId }) {
    const flags = nav.sessionFlags ? nav.sessionFlags() : { ok: false, archived: [], pinned: [] }
    const archivedSet = new Set(flags.archived ?? [])
    // 官方置顶顺序是"最近置顶的在前"，界面就照这个顺序排——自己按时间重排会把
    // 用户刚置顶的那一条排到第二位，那是明的错的。
    const pinRank = new Map((flags.pinned ?? []).map((id, index) => [id, index]))
    const pending = nav.pendingInteractions ? nav.pendingInteractions() : {}
    const summaries = nav.sessionSummaries ? await nav.sessionSummaries() : { ok: false }
    const blankKnown = summaries?.ok === true
    const summaryOf = (id) => (summaries?.ok ? summaries.byId.get(id) : undefined)
    const isBlank = (id) => blankKnown && summaryOf(id)?.blank === true

    const rows = []
    let hiddenBlank = 0
    let hiddenArchived = 0
    for (const s of result.sessions ?? []) {
      const archived = archivedSet.has(s.id)
      if (archived && !showArchived) { hiddenArchived += 1; continue }
      // 空白那一条**不适用于已归档的行**：用户把「显示已归档」打开，要的就是
      // "把我收起来的那几条拿回来看看"，而归档会话里恰恰有一批是没来得及起名字的
      // （本机实测：3 条已归档里就有 1 条没有标题）。这时候还按空白把它藏起来，
      // 那个开关就等于白按，而且归档提示里那句"之后可以在『显示已归档』里找回来"会变成假话。
      if (isBlank(s.id) && s.id !== boundSessionId && !archived) { hiddenBlank += 1; continue }
      const summary = summaryOf(s.id)
      rows.push({
        id: s.id,
        title: typeof s.title === 'string' ? s.title : '',
        createdAt: s.createdAt ?? 0,
        // 两个来源取"或"：`agents` 那份是插件自己看着的活会话，官方摘要那份覆盖更全
        // （比如不是经由我们事件流起来的）。任一说在跑，这一行就不该被配额吃掉。
        running: s.running === true || summary?.running === true,
        archived,
        pinned: pinRank.has(s.id),
        pending: typeof pending[s.id] === 'string' ? pending[s.id] : null,
        blank: isBlank(s.id),
      })
    }
    rows.sort((a, b) => {
      // 置顶的永远在最前，且按官方的置顶顺序；其余按创建时间倒序（和原来一样）。
      const pa = a.pinned ? (pinRank.get(a.id) ?? 0) : Number.POSITIVE_INFINITY
      const pb = b.pinned ? (pinRank.get(b.id) ?? 0) : Number.POSITIVE_INFINITY
      if (pa !== pb) return pa - pb
      return (b.createdAt ?? 0) - (a.createdAt ?? 0)
    })

    return {
      // 树那一层给的东西**原样留着**（workspaceId / total / truncated / pending，以及
      // 将来它会加的任何字段）：这一层只负责"筛选和排序"，不该顺手把别人的字段丢掉。
      ...result,
      sessions: rows,
      // 这几个数是给页面和验收用的**事实**，不是估算：
      shown: rows.length,
      hiddenBlank,
      hiddenArchived,
      blankKnown,
      archivedKnown: flags.ok === true,
    }
  }

  /**
   * 正文里写相对路径的图（`![](scratch/a.png)`）要多试的几个根：**当前已注册的工作区目录**。
   *
   * 为什么需要它（2026-09-28 实测确诊）：正文里的相对路径相对的是**那段对话的工作目录**，
   * 而它可能是别的项目——那次是 `I:\DSH\dsh-jev-ultrafast`，正文写的是
   * `scratch/preview-0.2.3-settings.png`。插件原先只按自己的两个根（仓库根、lib/art）找，
   * 于是 404，手机上就是破图；图就在盘上，接口本身也没毛病。
   *
   * **只放宽「在哪找」。** 仍然要令牌、仍然只发图片扩展名、仍然卡体积、相对写法里的 `..`
   * 仍然被拒（后两条在 page.js 的 readImage 里，这一版一个字没动）。
   * 额外根拿不到（服务还没起来）时退回空列表，也就是原来的行为。
   *
   * 缓存 30 秒：列一遍注册表要遍历所有工作区，而这张表几乎不变；晚半分钟知道新建的工作区
   * 没有影响——图的地址是用户在正文里写的，不会正好卡在那半分钟上。
   */
  const IMAGE_ROOTS_TTL_MS = 30_000
  let imageRootsCache = { at: 0, list: [] }
  function extraImageRoots() {
    const now = Date.now()
    if (now - imageRootsCache.at < IMAGE_ROOTS_TTL_MS) return imageRootsCache.list
    let list = []
    try {
      const got = imageRoots?.()
      // 去重：工作区里本来就可能包含插件根那个目录，重复只换来几次白跑的系统调用。
      if (Array.isArray(got)) list = [...new Set(got.filter((r) => typeof r === 'string' && r))]
    } catch {
      // `workspaceRegistry.list()` 在服务还没就绪时会抛。少认几张图，不该拖垮整条取图的路。
      list = []
    }
    imageRootsCache = { at: now, list }
    return list
  }

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) {
      try {
        res.write(frame)
      } catch {
        clients.delete(res)
      }
    }
  }

  /**
   * 只发给「要轨迹」的那几台连接。**别人一个字节都不收**。
   *
   * 帧里只有这一批的变化（新条目 + 改动），不是整份：整份单轮最高约 946KB，而
   * 一次工具调用也就是一条几 KB 的条目。`seq` 让客户端认出漏帧，`epoch` 认出重启。
   */
  function broadcastTrajectory(payload) {
    if (!trajectorySubscribers.size) return
    const frame = `event: trajectory\ndata: ${JSON.stringify({ epoch: EPOCH, ...payload })}\n\n`
    for (const res of trajectorySubscribers) {
      try {
        res.write(frame)
      } catch {
        trajectorySubscribers.delete(res)
        clients.delete(res)
      }
    }
  }

  /**
   * 轨迹的活片段（2026-10-04 用户解禁「流式不做」，只给完整模式看）：模型正在想的
   * 那一句，随打字顺出来。和上面那条增量帧走**同一批连接**（就是完整模式那几条），
   * 但**不占它的 seq/epoch**——它是「还没落定」的影子，落定的字由增量帧接管。
   *
   * **2026-10-21：正文（`kind: 'text'`）改走另一批连接** —— 手机页那个「流式」开关
   * 开着，连上来时才带 `?stream=1`。分开的理由很实际：正文比思考重得多（60 毫秒一帧，
   * 一段回答几十帧），开关关着的设备不该为它花流量。
   */
  function broadcastTrajectoryLive(payload) {
    // 正文和工具参数**都是"流式开关开着才有意义"的东西**，走同一批连接（`?stream=1`）；
    // 思考是完整模式本来就有的能力，走老那批。分开的账要算清，不然关掉流式还会白收帧。
    const isLive = Boolean(payload) && (payload.kind === 'text' || payload.kind === 'tool')
    const targets = isLive ? liveTextSubscribers : trajectorySubscribers
    if (!targets.size) return
    const frame = `event: trajectory-live\ndata: ${JSON.stringify(payload)}\n\n`
    for (const res of targets) {
      try {
        res.write(frame)
      } catch {
        targets.delete(res)
        trajectorySubscribers.delete(res)
        liveTextSubscribers.delete(res)
        clients.delete(res)
      }
    }
  }

  /**
   * 按身份名开/关轨迹推送。
   * @returns 点到的连接数。**0 = 那条连接已经不在了**，客户端据此重连一次
   *          （不然会出现「以为订上了，其实一条都收不到」这种最难查的静默状态）。
   */
  function setTrajectorySubscription(clientId, on) {
    const group = clientsById.get(clientId)
    if (!group) return 0
    for (const res of group) {
      if (on) trajectorySubscribers.add(res)
      else trajectorySubscribers.delete(res)
    }
    return group.size
  }

  /**
   * **把某台设备手上的活连接全掐掉**（撤销那一步调它，见 lib/index.js 的
   * `/mini-remote/devices/revoke`）。
   *
   * 为什么非要主动掐，而不是等它下一次请求被拒：手机那边是**服务端单向推**的。
   * 撤销之后那条 SSE 要是还挂着，新消息照旧往那台手机上送，用户看在眼里就是
   * "撤销了但它还在动"——于是他会怀疑撤销没生效，再点几次、甚至以为功能坏了。
   * 掐断的**可见信号**是即时且明确的：客户端那条流当场 EOF，页面自己会知道要说
   * 什么（手机页当前的做法是重连，重连撞上 401，于是回到门禁页）。
   *
   * 断的方式就是 `res.end()` / `socket.destroy()`——**不去删表**：断开的收尾交给
   * 它们自己那两条 close 监听（SSE 的 cleanup、WS 的 socket close），这样"谁负责
   * 清理"只有一处，不会出现两张表各删一半、状态对不上的情况。
   *
   * ## 「远程窗口」那一扇窗：掐的是它的长连接，不是它的每一条请求（2026-10-16 第四步）
   *
   * 窗口里那些请求是**浏览器自动带 cookie 发的短请求**（静态资源、`/api/*`），不是一条
   * 常驻连接——所以**掐不掉"下一次请求"**，也不需要掐：撤销之后 `windowSession` 每次
   * 都回头查名册，那条记录已经不在了，**下一次请求当场 401**（这才是窗口失效的那一步）。
   *
   * 这里能掐的、也必须掐的是它**那条 WebSocket**（`/api/remote.mux`，界面和主机之间那条
   * 常驻连接）：它握手之后就一直在，不因为 HTTP 401 而消失。所以升级那一下要把
   * 窗口会话里的设备身份也记上（见上面 upgrade），这里才点得到名。
   *
   * **给用户看的那句话**：撤销之后那扇窗**不会立刻变**——它会等到下一次点击/自动轮询
   * 才变成 401（页面随后回门禁页）。别把它说成"当场断开"。
   *
   * @param {string} deviceId 要撤销的那台设备
   * @returns {number} 真的掐掉了几条（0 = 它手上本来就没有活连接，这也是正常结果）
   */
  function dropDeviceConnections(deviceId) {
    if (typeof deviceId !== 'string' || !deviceId) return 0
    let dropped = 0
    for (const [res, owner] of deviceStreams) {
      if (owner !== deviceId) continue
      dropped += 1
      try { res.end() } catch { /* 已经断了 */ }
    }
    for (const [socket, owner] of deviceSockets) {
      if (owner !== deviceId) continue
      dropped += 1
      try { socket.destroy() } catch { /* 已经断了 */ }
    }
    return dropped
  }

  // ---- 手机上答题 ------------------------------------------------------
  //
  // **这两样必须放在这一层**（和 `clients`、`broadcast` 同一层，全程只建一次）。
  // 我第一版把它们写在了下面路由那一堆里——那是「每来一个请求就执行一次」的地方，
  // 于是推送提问时放进去的清单、和收答案时去读的清单**是两个不同的清单**，
  // 答案永远对不上、功能静默失效。放错一层就会这样，所以挪回来。
  const waitingQuestions = new Map()
  let questionSeq = 0

  /**
   * 手机上有没有人在看。**这就是「手机还在不在」那条判据**，不倒计时。
   *
   * **不能只看此刻连着几个。** 手机这一端会来回断（锁屏、切网、页面重连），
   * 2026-09-27 的日志里一分钟能连断几十次；审批恰好落在断开的那一瞬，就被判成
   * "手机不在"，于是让给了电脑——用户看到的就是"手机上什么都没弹"（他报的正是这个）。
   * 所以判据改成"此刻连着，**或者最近这段时间露过面**"，让抖动不再决定归属。
   * 露面有两个信号：SSE 连着（clients），或者最近来过一次带凭据的请求（notePhoneSeen）。
   * 窗口给 20 秒：够跨过抖动，又不至于让"真的锁屏很久"的手机一直霸着审批。
   */
  const PHONE_GRACE_MS = 20000
  let phoneSeenAt = 0
  function notePhoneSeen() {
    phoneSeenAt = Date.now()
  }
  function hasPhone() {
    return clients.size > 0 || (phoneSeenAt > 0 && Date.now() - phoneSeenAt < PHONE_GRACE_MS)
  }

  /**
   * 「除了手机，还有别人在等这道题吗」——**收摊判据的第二个来源**。
   *
   * 手机全断开就立刻把问题还给电脑（上面那条，防的是永远卡住）；可飞书那条路
   * （见 lib/lark.js）也能答同一道题，手机上没人不等于没人答。所以由调用方传一个
   * `keepAlive()` 进来，它说「还挂着」就不收摊。
   *
   * **绝不因为这一句把题卡死**：没传、或者它抛了，一律当「没人在等」——宁可还给电脑，
   * 也不能因为另一条路的内部错误让问题悬在半空。
   */
  function stillWaited(opts) {
    try {
      return opts?.keepAlive?.() === true
    } catch {
      return false
    }
  }

  /**
   * 一道题/一条审批刚刚有结果了——**主动告诉手机页**。
   *
   * 为什么必须有这一条：手机和飞书可能同时看着同一道题（用户就在两个界面之间切）。
   * 谁先答谁生效的语义本来就有（后到的那边拿到 `expired`），但那只在**后到的人自己动手**
   * 时才说话。手机页那张卡片是推一次就留在屏幕上的，用户在飞书里答完，手机上那张还挂在
   * 原地——他没法知道这道题已经有人答了，只能盯着它发愣（2026-10-02 真机就是这个现象）。
   *
   * 所以这里用**现成的 SSE 通道**补一条状态：手机页收到就把卡片收起来、换一行说明。
   * 只说「哪一道、谁答的」，不重复推题目本身——两边都不重复打扰。
   */
  function notifySettled(kind, id, source) {
    broadcast(`${kind}-done`, { id, source: source ?? '' })
  }

  /**
   * 题挂上之后当场告诉调用方它的编号。
   *
   * **飞书那条路就靠这个号对号入座**（用户回的那句话是对哪一道题的答复），交出去的是
   * 这一层内部用的编号（`q1`/`a1` 这种），不是界面上的顺序号。回调抛错只写一行日志，
   * 不影响这道题本身——推不出去的只是「另一个界面也来问」这件事。
   */
  function notifyPending(opts, id) {
    try {
      opts?.onPending?.(id)
    } catch (err) {
      log?.warn?.(`遥控服务：通知另一条通路失败（${err?.message ?? err}）`)
    }
  }

  /**
   * 把这个提问推到手机上，等它答。
   * @param {{keepAlive?: () => boolean, onPending?: (id: string) => void}} [opts]
   *        见上面 stillWaited / notifyPending 两段说明。
   * @returns 答案对象；手机没了就返回 null，调用方据此**把问题还给电脑**。
   */
  function askPhone(questions, agentId, opts) {
    const id = 'q' + (++questionSeq)
    return new Promise((resolve) => {
      let watch = null
      const settle = (value, from) => {
        if (!waitingQuestions.has(id)) return
        waitingQuestions.delete(id)
        if (watch) clearInterval(watch)
        // 先通知、再落定：谁先答谁生效的语义一个字没动，这里只是**把结果说出去**，
        // 让另一侧那张还挂着的卡片自己收起来（见 notifySettled）。
        notifySettled('question', id, from ?? opts?.source)
        resolve(value)
      }
      // 题目本身也存进来（不只是 settle）：手机中途重连上来时要能补发给它，见 replayQuestions。
      waitingQuestions.set(id, { settle, agentId, questions })
      notifyPending(opts, id)
      broadcast('question', { id, agentId, questions })
      // 用户选的是「一直等，不还回电脑」——但那不等于「手机都没了还等」。
      // 手机一旦全断开（锁屏、关了页面、网断），立刻收摊还给电脑，否则会永远卡住。
      watch = setInterval(() => {
        if (!hasPhone() && !stillWaited(opts)) settle(null)
      }, 2000)
    })
  }

  /**
   * 把正在等的题补发给**刚连上来的那一个**连接。
   *
   * 题目只在上面推一次，没有第二次。可手机这一端并不总是接着：
   * 页面正在重连、锁屏醒来刚接上、切了个网络——那一下就错过了，而电脑那边还在等，
   * 手机上却什么都看不见（2026-09-27 用户报的「电脑弹了选项、手机上什么都没有」，
   * 有这一类情形在里面）。所以新连接一进来就把还在等的题发给它。
   *
   * **只发这一个新连接，不重播给所有人**：已经在看的那个手机可能已经勾好了选项，
   * 再推一次会把它的勾清掉。
   */
  function replayQuestions(res) {
    for (const [id, entry] of waitingQuestions) {
      try {
        res.write(`event: question\ndata: ${JSON.stringify({ id, agentId: entry.agentId, questions: entry.questions })}\n\n`)
      } catch {
        return
      }
    }
  }

  // ---- 手机上来拍板审批 --------------------------------------------------
  //
  // 和上面那一套是**同一个形状**（推一次、等、手机没了就还给电脑），所以刻意并排写、
  // 守同样的规矩：清单和函数都留在这一层，不写进下面"每来一个请求执行一次"的地方
  // （那种错 2026-09-27 犯过一次，见上面那段注释）。
  // 唯一不同的是交回来的东西：提问交的是答案，审批交的是**结论**。
  const waitingApprovals = new Map()
  let approvalSeq = 0

  /**
   * 把一条命令确认推到手机上，等它拍板。
   * @param {{keepAlive?: () => boolean, onPending?: (id: string) => void}} [opts]
   *        和提问同一条：飞书那边也能拍这一板（见 lib/lark.js）。
   * @returns 'allowed-once' 或 'rejected'；手机没了返回 null，调用方据此还给电脑。
   */
  function askApproval(req, agentId, command, opts) {
    const id = 'a' + (++approvalSeq)
    return new Promise((resolve) => {
      let watch = null
      const settle = (value, from) => {
        if (!waitingApprovals.has(id)) return
        waitingApprovals.delete(id)
        if (watch) clearInterval(watch)
        // 和提问那条同一句：通知另一侧那张卡片自己收起来（见 notifySettled）。
        notifySettled('approval', id, from ?? opts?.source)
        resolve(value)
      }
      // 推给手机的就是这几样：工具名 + 为什么来问我。**不带命令正文**——
      // 正文要另外去取，而且那是用户自己的东西，不进日志也不进这条帧。
      const view = {
        id,
        agentId,
        toolName: typeof req?.toolName === 'string' && req.toolName ? req.toolName : '某个工具',
        reason: typeof req?.reason === 'string' ? req.reason : '',
        // 命令原文（取不到就是空串）。**只发给手机，不进日志。**
        command: typeof command === 'string' ? command : '',
      }
      waitingApprovals.set(id, { settle, agentId, view })
      notifyPending(opts, id)
      broadcast('approval', view)
      // 和提问同一条判据：**不倒计时，看手机还在不在**。全断开了就立刻收摊还给电脑
      // （飞书那边还挂着就除外，见 stillWaited）。
      watch = setInterval(() => {
        if (!hasPhone() && !stillWaited(opts)) settle(null)
      }, 2000)
    })
  }

  /** 把还在等的审批补发给**刚连上来的那一个**连接（同 replayQuestions 的理由）。 */
  function replayApprovals(res) {
    for (const [, entry] of waitingApprovals) {
      try {
        res.write(`event: approval\ndata: ${JSON.stringify(entry.view)}\n\n`)
      } catch {
        return
      }
    }
  }
  /**
   * 把一道题的答案交回去。**这是答题的唯一入口**，两个界面都走它：
   *   手机页：POST /mini/api/answer
   *   飞书：  miniControl.answerQuestion（见 lib/lark.js 的 onAnswer）
   *
   * 为什么收成一处：手机和飞书可能**同时**看着同一道题（用户就在两个人机界面之间切换），
   * 「谁先答谁生效、另一个自动失效」不该写成两遍——这里只有一个 settle，第二个来的人
   * 自然拿到 `expired`。这是现成的语义，不是为飞书新加的一套。
   *
   * @param {string} id 题号（waitingQuestions 里的那个）
   * @param {{answers?: Array, cancel?: boolean}} input `cancel:true` = 不答：
   *        按 settle(null) 处理，也就是和「手机全断了」**同一条路**——
   *        调用方据此把问题还给电脑（见 lib/index.js 的 .then(answer => !answer → next())）。
   * @param {'phone'|'feishu'} [from] 谁答的。**只用来通知另一侧**（见 notifySettled）：
   *        「已在飞书答过」这句话要有出处，猜不得。
   * @returns {{ok: boolean, error?: 'expired'|'bad'}}
   */
  function answerQuestion(id, input, from) {
    const entry = waitingQuestions.get(id)
    if (!entry) return { ok: false, error: 'expired' }
    if (input?.cancel === true) {
      entry.settle(null, from)
      return { ok: true }
    }
    if (!Array.isArray(input?.answers)) return { ok: false, error: 'bad' }
    entry.settle({ answers: input.answers }, from)
    return { ok: true }
  }

  /**
   * 把一条审批的结论交回去。形状、理由和 answerQuestion 一模一样（见上面那段）——
   * 只是交回去的东西是结论，且**只认那两个值**：一个没见过的结论宁可说 bad，
   * 也不能让电脑收到一个它看不懂的答复。
   * @param {'phone'|'feishu'} [from] 谁拍的板。只用来通知另一侧（同 answerQuestion）。
   */
  function decideApproval(id, input, from) {
    const entry = waitingApprovals.get(id)
    if (!entry) return { ok: false, error: 'expired' }
    if (input?.cancel === true) {
      entry.settle(null, from)
      return { ok: true }
    }
    if (input?.decision !== 'allowed-once' && input?.decision !== 'rejected') {
      return { ok: false, error: 'bad' }
    }
    entry.settle(input.decision, from)
    return { ok: true }
  }

  // 把这两个能力放到插件够得着的固定位置（见文件上方 `miniControl` 的说明）。
  // 放在这里是因为它俩都已定义（函数声明本来也会提升），且不受下面那堆路由逻辑影响。
  miniControl.hasPhone = hasPhone
  miniControl.askPhone = askPhone
  miniControl.askApproval = askApproval
  miniControl.answerQuestion = answerQuestion
  miniControl.decideApproval = decideApproval

  /**
   * 把 UA 和来源地址压成一句人看的：设备类型 + 地址。
   *
   * **为什么要它**：SSE 那两行日志原来只说"连上了/断开了"，一分钟几十次成对出现时，
   * 分不清是手机在抖、还是电脑上另有一个 /mini 页面也在连（两个都开着就会这样）。
   * 只取设备类型和地址，**不记 token，也不记整个 UA**——够定位就行，多余的不留。
   */
  function describeClient(ua, ip) {
    const u = String(ua ?? '')
    const kind = /iPhone|iPad/i.test(u) ? 'iOS'
      : /Android/i.test(u) ? 'Android'
      : /Windows/i.test(u) ? 'Windows'
      : (u ? '其他' : '无 UA')
    return kind + (ip ? '@' + String(ip).replace('::ffff:', '') : '')
  }
  /**
   * 这次请求到底带了什么凭据（**只取原值，不判对错**）。
   *
   * 三处和令牌一一对应：地址里的参数、cookie、请求头。认哪一处由调用方决定——
   * `isAuthorized` 要判对错，`hasCredential` 只问「带没带」（用来把「没登录」和
   * 「密码错了」分开：前者不算试错，后者才记一次失败）。
   *
   * **设备身份走的是同一道门**（见下面 isAuthorized 的第二路）：不是另开一条路，
   * 也不是「先过令牌再看设备」——两条路谁对上都放行。
   */
  function presentCredentials(req, url) {
    const jar = parseCookies(req.headers.cookie)
    return {
      token: [url.searchParams.get('token'), jar[COOKIE], req.headers['x-mini-token']],
      device: [url.searchParams.get('device'), jar[DEVICE_COOKIE], req.headers['x-mini-device']],
    }
  }

  /**
   * 这次请求手上那几枚设备凭据，兑出来是哪一台（没有就 null）。
   *
   * **单独一个函数**（而不是塞进 isAuthorized 里就算了）：SSE 连上来那一下要知道
   * 「这条流是谁的」，撤销时才掐得准。认人一律走 `devices.verify`——每一条现查名册，
   * 记录被删掉当场认不出来（见 lib/devices.js）。
   */
  function deviceIdOf(cred) {
    if (!devices) return null
    for (const value of cred.device) {
      const hit = devices.verify(value)
      if (hit) return hit.id
    }
    return null
  }

  function isAuthorized(req, url) {
    const cred = presentCredentials(req, url)
    // **设备那一路先认，不管令牌认没认下来**：老设备可能同时带着令牌 cookie 和刚补上的
    // 设备凭据（第二步那一下之后就不带了），而 lastSeen 是按设备记的——让令牌那条短路
    // 掉它，那台设备的"最近使用时间"就永远不动。
    const deviceId = deviceIdOf(cred)
    const ok = cred.token.some((value) => tokenEquals(value, token))
      // 设备凭据：**每一枚都现查名册**（见 lib/devices.js 的 verify）。
      // 记录被删掉之后，同一台设备的下一次请求就过不去了——「删掉即失效」就落在这儿。
      || Boolean(deviceId)
    // 手机每来一次请求都算"露过面"——这是「手机还在不在」的第二个信号。
    // 只看 SSE 连接数会被抖动骗到（见 hasPhone 上面那段），请求时间戳稳得多。
    if (ok) notePhoneSeen()
    // 「最近使用时间」的**唯一**写入点就在这一行。名册那边自己节流（最多一分钟写一次
    // 盘，见 lib/devices.js 的 touch），所以这里不必再挡——认人本身一个字节都不写。
    if (deviceId) devices.touch(deviceId)
    return ok
  }

  /** 这次请求到底有没有带凭据。没带只是没登录，不算试错。 */
  function hasCredential(req, url) {
    const cred = presentCredentials(req, url)
    return cred.token.some(Boolean) || cred.device.some(Boolean)
  }

  /**
   * 这次请求没被放行时，**该不该记一次"试错"**。
   *
   * ## 为什么只记令牌、不记设备凭据（2026-10-16 第三步，真机链路里试出来的）
   *
   * 限速是给**令牌**准备的：令牌是**用户自己定的**（最短 12 位），猜得动，所以要挡。
   * 设备凭据不是——它是 256 位随机数，猜不动，限速它一个字节的安全都换不来。
   *
   * 而把它算成失败会造出一个死结，**恰恰发生在撤销之后**：
   *   · 那台手机页上挂着一条 SSE（EventSource）；被掐断之后浏览器**每 3 秒自动重连一次**，
   *     每次都是 401；
   *   · 5 次就是 5 次"试错"（`RATE_MAX_FAILURES`），来源当场被封一分钟；
   *   · 于是用户拿着电脑上那张新二维码重新扫码时，撞上的是「密码错误次数太多」——
   *     撤销之后本来就要重新扫码，这条路上他一定会踩到，而屏幕上没有半个字说明
   *     这是他刚才那个动作造成的。
   *
   * 判据：**只有令牌那一枚算数**。既没带令牌（或带的令牌是对的）就不记——带设备凭据的
   * 请求再多也只是"那台设备进不来"，不是有人在猜密码。
   */
  function noteTokenFailure(req, url) {
    if (!presentCredentials(req, url).token.some(Boolean)) return
    noteFailure(req)
  }

  /**
   * 新设备默认叫什么。
   *
   * **名字只是标签**：设备类型只用来给个像样的默认名，认人从不看它（也从不看指纹，
   * 见 lib/devices.js 开头那段）。复用 describeClient 那份判断，免得同一件事在两处
   * 各写一遍——两处迟早不一致，而不一致的表现是「同一个设备两个叫法」。
   */
  function defaultDeviceName(ua) {
    const kind = describeClient(ua)
    return kind === '无 UA' ? '新设备' : kind
  }

  /**
   * 打开手机页那一下顺手发的设备凭据（登记点只有两个调用处，都在页面那一支里）。
   *
   * 已经有**有效**凭据的设备回 null：不重发、不新建、不写盘——绝大多数页面加载
   * 走的都是这一条，所以响应头逐字不变。
   *
   * 拿到的凭据放在 cookie 里（HttpOnly）：浏览器自己带，手机页一行 JS 都不用改，
   * SSE、立绘、镜像框那些请求全都自动沾光。寿命给一年，和令牌 cookie 一样——
   * 换个短寿命只会让用户莫名其妙地重新扫码，而他什么都没做错。
   */
  function issueDeviceCookie(req) {
    if (!devices || typeof devices.register !== 'function') return null
    const had = parseCookies(req.headers.cookie)[DEVICE_COOKIE]
    if (had && devices.verify(had)) return null
    const issued = devices.register({ name: defaultDeviceName(req.headers['user-agent']) })
    // 这一行是**给以后查问题用的**：哪台设备什么时候进来的。不记凭据、不记密钥。
    if (issued) console.log(`[dsh-mini-remote] 新设备已登记：${issued.name}（${issued.id}）`)
    return issued
      ? `${DEVICE_COOKIE}=${encodeURIComponent(issued.credential)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`
      : null
  }

  /**
   * 「远程窗口」那一侧的凭据：票换来的窗口会话（见 lib/mirror.js 的 redeemTicket）。
   *
   * **和令牌是两码事，各有各的用处**：
   *   · 令牌 = 这台电脑的口令。它进得了 `/mini/api/*` 全部接口，所以**绝不能进浏览器**；
   *   · 窗口会话 = 只够进镜像这一层，**寿命跟着宿主进程走**（见 lib/mirror.js 的 PROCESS_SECRET）。
   *
   * 桌面端那个面板拿票进门，之后框里那些请求（静态资源、`/api/*`、WebSocket）
   * 带不上票，就靠这一枚认人。
   *
   * ## 认人不只看签名，还要**回头查一次名册**（2026-10-16 第四步）
   *
   * 签名只说明「是本进程签的」。会话里还签着「这一扇窗是谁的」：
   *   · 一台设备的 id → **每一次都现查名册**（`devices.has`，它自己也先对一次磁盘，
   *     见 lib/devices.js）：记录不在了（被撤销、或者文件里那一行被人手删了）就当场拒。
   *     这就是「撤销之后那扇开着的窗下一次请求 401」落地的位置。
   *   · `local`（本机那一半）→ 不查名册：它不是名册里的设备，也没有"撤销这一台"这回事。
   *
   * **没有身份的会话一律不认**：生产路径上兑票那一下必须给出身份（拿不到就不兑现，
   * 见 ticketWindowOwner），所以匿名会话只可能是别人的手笔——宁可拒。
   * 桩（测试里那个假 mirror）没有 `windowDevice` 这个口子：那种情况下照旧只看签名。
   *
   * @returns {{session:string, deviceId:string} | null} 会话本身 + 它是谁的；进不来回 null
   */
  function windowSession(req) {
    if (!mirror || typeof mirror.windowValid !== 'function') return null
    const raw = parseCookies(req.headers.cookie)[WINDOW_COOKIE]
    if (!raw || !mirror.windowValid(raw)) return null
    if (typeof mirror.windowDevice !== 'function') return { session: raw, deviceId: '' }
    const owner = mirror.windowDevice(raw)
    // 没有身份（老形状 / 兑票时就没给）：不认。
    if (!owner) return null
    // 本机那一半：它不是名册里的设备，没有"撤销"这一说。
    if (owner === LOCAL_WINDOW_DEVICE) return { session: raw, deviceId: owner }
    // 来自远程设备的那一扇窗：**回头查名册**——那条记录还在不在。
    if (!devices || typeof devices.has !== 'function' || !devices.has(owner)) return null
    return { session: raw, deviceId: owner }
  }

  /**
   * 这一扇窗是**哪台设备**的（本机那一半、或者认不出设备就回 null）。
   *
   * 只给"要按设备掐线"的地方用（镜像那个框的 WebSocket，见下面升级处理器）。
   */
  function windowDeviceId(req) {
    const open = windowSession(req)
    if (!open || !open.deviceId || open.deviceId === LOCAL_WINDOW_DEVICE) return null
    return open.deviceId
  }

  /**
   * **这一扇窗是谁的**——兑票那一下的身份判据。**只在这一处用。**
   *
   * ## 身份从票上读，不再问"这次请求带了什么"（2026-10-16 第五步）
   *
   * 票发出去的时候就把主人定下来了（见 lib/mirror.js 的 issueTicket，两条取票路由
   * 在 lib/index.js）。兑票这一下只做三件事：
   *
   *   ① **票上没写主人** → `null`：**这张票不兑现**，进不去。将来的新取票口要是忘了
   *      说明这扇窗是谁的，表现是这一扇窗打不开，而**不是**悄悄开成一扇撤不掉的窗
   *      （fail closed）。
   *   ② **票上写的是 `local`**（本机那一半，桌面端面板那条）→ 还要**这次请求确实是
   *      这台电脑自己发的**（回环、也不是隧道转进来的）才认。**桌面端面板走的就是
   *      这一条**：票由这台电脑自己的软件发出（见 lib/index.js 的 `/mini-remote/window`，
   *      只允许本机调用），浏览器也在这台电脑上。
   *   ③ **票上写的是名册里那台设备** → **兑现这一刻也回头查一次名册**（`devices.has`，
   *      它自己也先对一次磁盘，见 lib/devices.js）：记录不在了就不兑现。**跨机那条路
   *      走的是这一条**（见 lib/index.js 的 `/mini-remote/remote/window`：票是拿已验过的
   *      设备凭据换的）。
   *
   * ## 为什么不看请求里的凭据了
   *
   * 跨机那条路上，**票是在对面那台电脑的浏览器里打开的**：那个浏览器**没有设备凭据**
   * （凭据只活在对面那个宿主进程里，永远不进浏览器），也**不是本机回环**。照原来的
   * 口径它两条都不占，于是永远是"不兑现"——票发得出来，对面兑不了。
   *
   * ## 为什么这样**不比原来松**
   *
   * 原来的口径是**靠来源猜身份**：没带凭据、又看着像本机 → 记 `local`。而隧道流量在
   * 回环上也长得像本机（cloudflared 就是从 `127.0.0.1` 回连我们的，见 clientKey 上面
   * 那段），所以那一条得靠"带转发头就不算本机"这个补丁兜着。现在 `local` **不再由
   * 来源猜出来**，只能来自「只对本机开放的那条取票路由」发出来的票——请求自称不了
   * `local`。② 保留回环这一关，等于**只多不少**：带转发头的隧道请求拿到一张本机票
   * 也照样进不来。
   *
   * **票上写着身份 ≠ 可以不查名册**：这里查的是"兑现这一刻"，会话签出来之后
   * **每一次放行都还要再查一次**（见 windowSession），撤销对已经开着的窗同样生效。
   */
  function ticketWindowOwner(req, ticket) {
    const owner = typeof mirror.ticketOwner === 'function' ? mirror.ticketOwner(ticket) : null
    if (!owner) return null
    if (owner === LOCAL_WINDOW_DEVICE) {
      return isLocalRequest(req) && !forwardedClient(req) ? owner : null
    }
    if (!devices || typeof devices.has !== 'function' || !devices.has(owner)) return null
    return owner
  }

  /** 来源 -> { firstAt, count, blockedUntil } */
  const attempts = new Map()

  function isBlocked(req) {
    const rec = attempts.get(clientKey(req, tunnelHost?.()))
    return Boolean(rec && rec.blockedUntil > Date.now())
  }

  function noteFailure(req) {
    const key = clientKey(req, tunnelHost?.())
    const now = Date.now()
    let rec = attempts.get(key)
    if (!rec || now - rec.firstAt > RATE_WINDOW_MS) {
      rec = { firstAt: now, count: 0, blockedUntil: 0 }
      attempts.set(key, rec)
    }
    rec.count += 1
    if (rec.count >= RATE_MAX_FAILURES) rec.blockedUntil = now + RATE_WINDOW_MS
    // 别让这张表无限长大；正常情况下它只有个位数条目
    if (attempts.size >= 512) {
      for (const [k, v] of attempts) {
        if (now - v.firstAt > RATE_WINDOW_MS && v.blockedUntil <= now) attempts.delete(k)
      }
    }
  }

  function noteSuccess(req) {
    attempts.delete(clientKey(req, tunnelHost?.()))
  }

  /**
   * 把**我们自己那些凭据**从地址里摘掉，其余一个字符都不动。
   *
   * 为什么必须摘（两条都是真机上试出来的）：
   *   ① 那个界面的插件脚本走一条合并加载路径（`plugins/??a/client.js&rev=x`），
   *      上游对它是**精确匹配**——多一个 `&token=...` 就当场 404，脚本一 404，
   *      界面就卡在启动画面报「HTML did not preload …」。
   *   ② **凭据绝不能跟着请求进上游**（日志、链路、第三方）。上游本来就不认识它们。
   *
   * **判据是「值」，不是「参数名」**（2026-10-16 修）。原来只摘「参数名是 `token`
   * 且值等于我们令牌」的那一种，而设备身份那枚凭据只要换个参数名（哪怕只是写成
   * `device=`）就会被原样转发出去——凭据泄漏，或者上游精确匹配 404 白屏。
   * 现在两档，都不看参数名：
   *   · 值等于我们的令牌（`token=` 这个名字照旧，别的名字也一并摘）；
   *   · 值长得像我们的设备凭据（`<32 位 hex>.<32 位 hex>`，见 lib/devices.js）。
   * 只多摘「确实是我们自己的东西」：同名但值不是我们的参数**一个都不许碰**
   * （那可能是界面自己在用的），这条有测试钉着。
   *
   * **逐段切、再拼回去，不走 URLSearchParams**：那条合并路径里有 `@`、`/`、`,` 这些字符，
   * 交给它解析再序列化会被百分号编码，路径就变了——那等于换个法子把它弄坏。
   */
  function stripOurSecrets(rawUrl) {
    const at = rawUrl.indexOf('?')
    if (at < 0) return rawUrl
    const head = rawUrl.slice(0, at)
    const parts = rawUrl.slice(at + 1).split('&')
    const encoded = encodeURIComponent(token)
    const kept = parts.filter((p) => {
      const eq = p.indexOf('=')
      if (eq < 0) return true
      const value = p.slice(eq + 1)
      if (value === token || value === encoded) return false
      return !credentialLooksLikeOurs(value)
    })
    if (kept.length === parts.length) return rawUrl
    return kept.length ? `${head}?${kept.join('&')}` : head
  }

  /**
   * 把**我们自己那个** `diag=1` 摘掉，其余一个字符都不动。
   *
   * 和上面的 token 是同一个道理（真机上试出来的）：上游对一部分地址是**精确匹配**，
   * 多带一个参数就当场 404。`diag` 是我们读的开关，上游不认识它，
   * 所以往上游转之前必须摘掉。**入口那一下本来就把查询串整个丢了**，
   * 这里管的是前缀下面的那些地址（`/mini/mirror/assets/x?diag=1` 这种）。
   *
   * 只摘 `diag=1` 这一个形状，别的一律不碰——上游自己要用同名参数也不至于被误伤。
   */
  function stripDiagFlag(rawUrl) {
    const at = rawUrl.indexOf('?')
    if (at < 0) return rawUrl
    const head = rawUrl.slice(0, at)
    const parts = rawUrl.slice(at + 1).split('&')
    const kept = parts.filter((p) => p !== 'diag=1')
    if (kept.length === parts.length) return rawUrl
    return kept.length ? `${head}?${kept.join('&')}` : head
  }

  /**
   * 手机页这一趟该写下的 cookie：**设备凭据（可能）+ 把令牌 cookie 收回去（可能）**。
   *
   * 为什么要有「收回去」这一手（2026-10-16 第二步）：令牌是**入场邀请函**，只在门口
   * 用一次。它一旦长期留在手机浏览器里，「名册里删掉那条记录 = 那台设备当场什么都做
   * 不了」就不成立——那台设备还能拿邀请函进门，撤销就是假的。所以从这一步起：入场
   * 不再把令牌 cookie 递回手机，手上已经有的（老设备）在补上设备凭据的**同一个响应**
   * 里作废——**人不被踢**（凭据已经给了），但从这一刻起走的是设备身份。
   *
   * 什么时候**不许**收：这台设备接下来没有凭据回来的时候。设备身份没开（`devices`
   * 缺失），或者既没发下新凭据、手上那枚又无效——这时候收走邀请函等于把用户关在门外。
   * 判据就一句：**要么这次发了新凭据，要么手上那枚还是有效的**。
   */
  function pageCookies(req, { entry = false } = {}) {
    const jar = parseCookies(req.headers.cookie)
    const device = issueDeviceCookie(req)
    const out = []
    if (device) out.push(device)
    const hasIdentity = Boolean(device)
      || Boolean(devices && devices.verify(jar[DEVICE_COOKIE]))
    if (jar[COOKIE] && hasIdentity) {
      // 手里那枚邀请函收回来（见上面那段）。
      out.push(`${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`)
    } else if (entry && !hasIdentity) {
      // **设备身份没开**（`devices` 缺失，见上面 createMiniServer 的参数说明）时，
      // 门口只能照旧把令牌 cookie 递回去：什么都不给的话，手机下一趟请求就一个凭据都
      // 带不上，等于把用户关在门外。真机上这条路走不到——lib/index.js 永远传名册。
      out.push(`${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; SameSite=Lax`)
    }
    return out
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    // 试错太多的来源一律挡住，页面和接口都一样——否则可以拿页面接口
    // 当测密码的探针。
    if (isBlocked(req)) {
      sendJson(res, 429, { error: '密码错误次数太多，等一分钟再试。' })
      return
    }

    // B 端执行代理：自己带 Bearer 凭据，**不过手机服务那道令牌门**。
    // 必须排在下面 remoteRoutes / 镜像 / 鉴权之前；它自己的路由里有本机限制和总开关。
    if (agentHub && path.startsWith('/mini-remote/agent/')) {
      await agentHub.handle(req, res, path)
      return
    }

    /**
     * 「跨机那两条」在**手机服务这个端口**上也接一份（2026-10-17 第七步）。
     *
     * ## 为什么非挂不可（"B 填哪条地址"那个毛病的根）
     *
     * A 上本来有两个端口，两条跨机路各长在一边：
     *   · `/mini-remote/pair`（配对）和 `/mini-remote/remote/window`（跨机取票）——
     *     **宿主那一半**，挂在 DSH 自己的 web 端口上（见 lib/index.js）；
     *   · `/mini/mirror/` —— **服务那一半**，就是这个服务器（默认 3090）。
     *
     * 而取票回来的那条地址用的是**请求到达时的 Host**（见 lib/index.js 的
     * `requestOrigin`）：B 拿哪条地址来换票，那张票就开在哪条地址上。B 手上只有一条
     * 地址，于是**填哪一边都有一半对不上**——填宿主那一半，框里那条 `/mini/mirror/`
     * 打不到（404）；填这一半，配对那一下先被门拦住（401/404：这条请求手上还没有
     * 任何凭据，而手机服务那道门只认令牌/设备凭据）。
     *
     * 挂上这两条之后，**B 只填一条地址**——就是手机页那条地址：配对、取票、兑票、
     * 框里那些请求全在同一个源上（`/mini/mirror/` 本来就是这儿的）。
     *
     * ## 为什么是"同一份实现多一个挂载点"，不是在这边重写一遍
     *
     * 这两条路自己的规矩（`allowRemoteComputers` 总开关、口令的定长比较、设备凭据的
     * 三种带法、"撤销立刻失效"、试错限速那张**和手机服务共用的表**、票怎么发）全都在
     * lib/index.js 那一处，**一个字节都不搬过来**：处理函数由那边原样递进来。复制一份的
     * 下场是两处各改各的，而那种不一致的表现是"这头能进那头不能进"。
     *
     * ## 为什么**排在手机服务自己那道鉴权之前**
     *
     * 这两条本来就是给**外面**那台电脑调的（见 lib/index.js 的 `pair` 那一段：来配对的
     * 人手上还没有凭据，凭据正是它来这儿要的东西），所以它们**不能**过 `isAuthorized`
     * ——和它们在宿主那一半的做法一致（不调 `localOnly`），自己带闸：总开关 + 口令/凭据
     * + 限速。**手机服务原有的鉴权一个字都没动**：其余每一条路径照旧走下面那道门。
     *
     * 位置挑在**镜像那一块之前**：那一段会把 `/mini-remote/*` 转给上游（镜像里的客户端
     * 插件要读宿主那些状态），但它挂在「进阶设置」开关上、还要先过鉴权——配对这条两条
     * 都不满足，转上去只会是 401/404。这两条得先接住。
     */
    if (remoteRoutes) {
      const hostHalf = path === '/mini-remote/pair' ? remoteRoutes.pair
        : path === '/mini-remote/remote/window' ? remoteRoutes.remoteWindow
          // 「远程窗口里挑目录 / 登记工作区」（2026-10-19 加）：远程窗口嵌的是
          // 官方界面，它那个「新建工作区」会走官方的 native 对话框——**弹在 A 的屏幕上**，
          // 用户在 B 前面点不到（实测 HTTP 502）。这三条让 B 能列 A 的目录、让 A 登记工作区。
          : path === '/mini-remote/remote/browse' ? remoteRoutes.browse
            : path === '/mini-remote/remote/browse/roots' ? remoteRoutes.browseRoots
              : path === '/mini-remote/remote/browse/mkdir' ? remoteRoutes.browseMkdir
                : path === '/mini-remote/remote/workspaces' ? remoteRoutes.workspaces
                  : null
      if (typeof hostHalf === 'function') {
        await hostHalf(req, res)
        return
      }
    }

    // ---- 页面本身 -------------------------------------------------------
    // 允许用 ?token=xxx 直接进（二维码扫的就是这个地址），
    // 校验通过后写 cookie，后续请求就不必再带参数。
    //
    // ## 「设备身份」的**登记点就是这里**（2026-10-16）
    //
    // 只有「打开手机页」这一下会登记一台新设备，普通接口请求一次都不登记。
    // 判据是**这个 if 的位置**，不是某个函数内部的开关：issueDeviceCookie() 的
    // 调用点只有下面两处（都在这个分支里，都经由 pageCookies），要改这一条，
    // 先看这两处并想清楚后果。
    //
    // 为什么非要这么卡：登记要是跟着普通请求走，客户端一抖、页面一刷新就会不停
    // 造新设备——「谁是谁」当场失真，名册也成了流水账。而这两处是**用户真的在
    // 拿一台设备进门**的那一下：
    //   · 第一处 = 第一次带配对码（`?token=`）进来，也就是扫码那一下 → 顺手发凭据，
    //     用户零动作（设计上的硬要求：首次仍是两步，之后 0 步）；
    //   · 第二处 = 已经有凭据的老设备打开手机页（老设备只有令牌 cookie）→
    //     **自动升级成设备身份，但不踢它**：令牌照旧认，只是顺手补一枚凭据。
    if (req.method === 'GET' && (path === '/' || path === '/mini' || path === '/mini/')) {
      const provided = url.searchParams.get('token')
      if (provided && tokenEquals(provided, token)) {
        noteSuccess(req)
        const cookies = pageCookies(req, { entry: true })
        const head = {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        }
        // **入场那一下不再递回令牌 cookie**（2026-10-16 第二步）：门口验过就换成设备
        // 凭据，手机手上不留邀请函——留着它，「删掉记录」就永远撤不掉这台设备。
        if (cookies.length) head['Set-Cookie'] = cookies
        res.writeHead(200, head)
        res.end(renderPage({ defaultMode: config.defaultMode, build, maxUpload: MAX_UPLOAD }))
        return
      }
      if (isAuthorized(req, url)) {
        noteSuccess(req)
        // 已经有有效设备凭据的这一次（绝大多数页面加载）什么都不发，响应头和从前逐字一样。
        const cookies = pageCookies(req)
        const head = {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        }
        if (cookies.length) head['Set-Cookie'] = cookies
        res.writeHead(200, head)
        res.end(renderPage({ defaultMode: config.defaultMode, build, maxUpload: MAX_UPLOAD }))
        return
      }
      // 带了密码但不对，记一次失败；压根没带不算——那只是打开页面而已
      if (hasCredential(req, url)) noteTokenFailure(req, url)
      /**
       * 这台设备是**被撤销了**，还是**从来没进过门**？
       *
       * 两种都是"进不来"，但下一步动作完全不同：前者要去电脑上重新扫码（他什么都没
       * 做错，所以得告诉他发生了什么），后者只是第一次来（照旧给输入框）。
       *
       * 判据只有一条：手上那枚凭据**长得像我们的**（`<32hex>.<32hex>`，见 lib/devices.js），
       * 可名册里已经查不出来了——那只能是被删掉的那一枚（乱填的撞不上这个形状，
       * 真凭据又只可能来自我们）。**不看 IP、不看指纹，也不给"是谁"留任何记录。**
       */
      const revoked = Boolean(devices) && presentCredentials(req, url).device
        .some((value) => credentialLooksLikeOurs(value) && !devices.verify(value))
      // 没带 token：给一个只用于输入 token 的极简页面。
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(renderPage({
        defaultMode: config.defaultMode, needsToken: true, deviceRevoked: revoked, build, maxUpload: MAX_UPLOAD,
      }))
      return
    }

    // ---- 立绘 -----------------------------------------------------------
    // 静态资源，但同样要鉴权：它只服务于这个页面，没必要对没登录的人开放。
    // 页面给 <img> 拼的是 /mini/art/x.webp?token=...&v=<指纹>，所以走 query 就够，
    // 不依赖 cookie（从门禁页手输 token 进来时是没有 cookie 的）。
    if (req.method === 'GET' && path.startsWith('/mini/art/')) {
      if (!isAuthorized(req, url)) {
        if (hasCredential(req, url)) noteTokenFailure(req, url)
        sendJson(res, 401, { error: '未授权：token 不正确' })
        return
      }
      noteSuccess(req)
      // 取图有两条路，都挂在这个前缀下：
      //   ① /mini/art/<名字>.webp —— 立绘。名字受白名单限制，地址里带构建指纹，可以长缓存。
      //   ② /mini/art/?p=<路径>   —— 正文里直接写了一张图在电脑上的位置（绝对路径，或相对
      //      项目根／lib/art／已注册的工作区目录）。只发图片类型，地址里没有指纹，所以不
      //      让浏览器缓存。
      const wanted = url.searchParams.get('p')
      if (wanted) {
        const hit = readImage(wanted, extraImageRoots())
        if (!hit) {
          sendJson(res, 404, { error: 'not found' })
          return
        }
        res.writeHead(200, {
          'Content-Type': hit.type,
          'Content-Length': hit.buf.length,
          'Cache-Control': 'no-cache, no-transform',
        })
        res.end(hit.buf)
        return
      }
      const buf = readArt(path.slice('/mini/art/'.length))
      if (!buf) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Content-Length': buf.length,
        // 地址里带着构建指纹，内容不会在同一个地址下变化，可以放心长缓存。
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
      res.end(buf)
      return
    }

    // ---- service worker -------------------------------------------------
    // 它只为系统通知而存在（见 lib/sw.js）。
    //
    // **这一条不鉴权，是故意的。** 别处都鉴权，这里不行，理由是时序：service worker
    // 必须在页面加载时就注册，而 token 要等用户过了门禁页才知道（从门禁页手输进来
    // 时连 cookie 都没有，见上面立绘那段）。要是在这儿卡一道 token，那所有手输 token
    // 的用户都会注册失败——而失败只在浏览器控制台里报，表现就是「开关开了但永远收不到
    // 通知」，最难查的那种。
    //
    // 代价是零：这个文件里没有 token、没有用户数据、对所有人都是同一份。
    //
    // **`Service-Worker-Allowed: /` 这一行不能省。** 页面在 `/mini`，不在 `/mini/`
    // 底下，而这个文件从 `/mini/sw.js` 发出去，默认作用域只到 `/mini/`——够不着那个
    // 页面，注册会直接失败。放开到根，它才管得着。
    if (req.method === 'GET' && path === '/mini/sw.js') {
      const src = readSw()
      if (!src) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      const buf = Buffer.from(src, 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': buf.length,
        'Service-Worker-Allowed': '/',
        // 地址里带着构建指纹，内容不会在同一个地址下变化，可以放心长缓存。
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
      res.end(buf)
      return
    }

    // ---- 「进阶设置」：电脑端界面的镜像 --------------------------------
    //
    // 见 lib/mirror.js 开头的说明。这里只负责三件事：**认路、鉴权、放行**。
    //
    // ## 认路这件事比想的绕，两次才做对
    //
    // 那个界面里的请求有**两种**写法，两种都要能通：
    //
    // ① **相对的**：外壳里写的是 `<base href="./">` + `./assets/index-xxx.js`。
    //    它本来就是按「可以被挂在任意子路径下」设计的。所以入口必须**带尾斜杠**，
    //    并且把 `/mini/mirror/` 这个前缀剥掉再转发——否则 `./` 会解析到 `/mini/`，
    //    那些脚本就跑到`/mini/assets/...` 上、被当成我们自己的地盘，全 404。
    //    **第一版就是这么白屏的**（真浏览器打开验出来的：DOM 拿到了、但一片空白）。
    // ② **绝对的**：它调 API 走 `/api/...`、插件资源走 `/plugins/...`。
    //    这些没法靠前缀，所以反过来——**凡是不是我们自己的路径，一律转给它**。
    //    我们自己的地盘只有 `/`、`/mini`、`/mini/*`。
    //
    // **鉴权不能省**：这条路由等于把整个电脑端设置面（模型配置、凭据页、
    // 插件装卸、会话记录……）交给持有我们令牌的人。所以要求和 `/mini/api/*` 同一道门。
    // 手机那边不必每次都带参数——入口那一下写好了 cookie，而 cookie 的 Path 是 `/`，
    // 界面自己发的那些请求会自然带上。
    //
    // ## 还有一条：**我们自己的 `token` 参数不许跟着转发上去**
    //
    // 这是真机上试出来的：那个界面的插件脚本走一条合并加载路径
    // （`plugins/??@a/client.js&rev=xxx`），**上游对它是精确匹配**——多带一个
    // `&token=...` 就当场 404。而脚本一 404，界面就卡在启动画面报
    // 「HTML did not preload @deepseek-ai/dsh-client-modules/client.js」。
    // 所以转发前先把自己那个参数摘掉（**只在它确实是我们的令牌时摘**，
    // 免得误伤界面自己可能用到的同名参数）。
    // **认路要在门之前算出来**：这次要不要接，同时看「开关」和「是不是持票来的」两件事。
    const MIRROR_PREFIX = '/mini/mirror'
    const mirrorEntry = req.method === 'GET'
      && (path === MIRROR_PREFIX || path === `${MIRROR_PREFIX}/`)
    const mirrorUnder = path.startsWith(`${MIRROR_PREFIX}/`)
    // 票只可能在镜像那几条路径上（宿主把它拼进 iframe 的地址，见 lib/index.js）。
    const windowTicket = (mirrorEntry || mirrorUnder)
      ? String(url.searchParams.get('ticket') ?? '')
      : ''
    const windowOpen = Boolean(windowSession(req))
    /**
     * 票这一下**兑现没兑现**（`ticketOpen`）与**这一页是不是凭票嵌出来的**（`frameOpen`）。
     *
     * 两个分开是有原因的，见下面那段「两条路」：**票只授权那一次**，之后这条地址
     * 里就只剩一个「这一页是我嵌的」标记——它本身什么都打不开。
     */
    let ticketOpen = false
    let frameOpen = false
    if (windowTicket && mirror) {
      if (typeof mirror.ticketGranted === 'function' && mirror.ticketGranted(windowTicket)) {
        // 兑现过的票（iframe 重新加载同一条地址时就是这样）：只算取景凭据，不算通行证。
        frameOpen = true
      } else {
        // **兑现这一下先把「这扇窗是谁的」定下来**（2026-10-16 第四步）：身份会被签进
        // 会话体，之后每一次验会话都拿它回头查名册（见 windowSession）。
        // 这一下**读的是票上写着的主人**（发票那一刻定下的，见 lib/mirror.js 的
        // issueTicket / ticketOwner），不看这次请求带了什么凭据——跨机那条路上，票是在
        // 对面那台电脑的浏览器里打开的，它手上只有这张票（见 ticketWindowOwner）。
        // 定不下来（票没写主人、或者那台设备已经被撤销）就**不兑现**：票留着过期，
        // 门给一页人话（`sendWindowTicketBad` 认得这两种：票不对 / 通行证不对）。
        const owner = ticketWindowOwner(req, windowTicket)
        const opened = owner && typeof mirror.redeemTicket === 'function'
          ? mirror.redeemTicket(windowTicket, owner)
          : null
        if (!opened) {
          // 票不对、过期、或者已经用过：**不给门、也不给取景**，回一页人话走人。
          sendWindowTicketBad(res)
          return
        }
        ticketOpen = true
        frameOpen = true
        // 窗口会话：iframe 里那些请求（静态资源、`/api/*`、WebSocket）带不上票，只能靠它。
        //
        // **`SameSite=None; Secure` 不是随便选的**（2026-10-15 实测）：桌面端自己的页面
        // 跑在自定义协议 `dsh-app://app/` 上，对我们的 `http://127.0.0.1:<端口>` 来说是
        // **跨站**——`Lax` 的 cookie 在跨站子框架里根本不会被带上，界面上就是一片 401。
        // `Secure` 在 `http://127.0.0.1` 上是允许的（回环算可信来源），所以这一条成立。
        //
        // ## `Partitioned` 试过，**撤回了**（2026-10-18）
        //
        // 本来加它是为了防"浏览器收紧第三方 cookie"（CHIPS）：把它标成只属于「这个第三方 +
        // 这个顶层站点」这一个组合，浏览器就不再当追踪工具。想法本身没错，我们的场景也确实
        // 是 1:1 关系。
        //
        // **但顶层是 `dsh-app://app/` 这种自定义协议——那不是有效的分区上下文**，浏览器于是
        // 可能把整枚 cookie 拒掉。真机症状（B 电脑点开「远程窗口」）：框里能看到
        // 「Loading plugins…」（说明带票那次请求成功了、HTML 到了），但之后**子资源全过不去**，
        // 页面永远加载不完，20 秒后报「那台电脑的界面一直没打开」。撤掉就恢复了。
        //
        // **教训**：加之前我在本机验过"它确实发出去了"（`Set-Cookie` 里带着 `Partitioned`），
        // 但"发出去"和"浏览器肯收下"是两件事——后者只有真机点开那一屏才看得出来。
        //
        // 将来要再碰这一块，先解决"分区键从哪来"：要么把这个自定义协议注册成可信来源，
        // 要么让顶层页面走一个真正的 http(s) 地址。
        res.setHeader('Set-Cookie',
          // **不写 `Max-Age`**（2026-10-15）：窗口会话的寿命是「这个宿主进程活着」
          // （见 lib/mirror.js 的 PROCESS_SECRET），浏览器这边就跟着做成**会话 cookie**。
          // 写死一个过期时刻，等于又造一个固定寿命，还会在进程好好活着的时候先把面板弄成 401。
          //
          // ## 「没有闲置超时」是有意选的，不是漏了（2026-10-17 记下）
          //
          // 窗口会话只在两件事上失效：**DSH 重启**（换进程密钥，旧会话的签名当场对不上）
          // 与**对面那台电脑被撤销**（设备身份那一种每次放行都现查名册，见 windowSession）。
          // **没有"闲置多久就过期"这种机制**。竞品主流是给会话一个过期时刻，我们**不做**：
          // 撤销已经是即时的，安全那一半已经拿到；再加一个"闲置就断"只会把"开着看很久"
          // 变成一次次重新取票，体验变差，换来的安全边际接近于零。
          // 本机那一半（`local`）连撤销都不适用（它不是名册里的设备），寿命就是进程本身。
          `${WINDOW_COOKIE}=${opened.session}; Path=/; SameSite=None; Secure; HttpOnly`)
        // 记下这一刻：之后要是又来了"不带这枚 cookie"的请求，就说明浏览器没存下它。
        windowCookieAt = Date.now()
        windowCookieMisses = 0
      }
    }
    // 刚种下这枚窗口 cookie，这次请求却没带回来 —— 浏览器多半没存下它。
    //
    // 后果是**静默的**：框里停在「Loading plugins…」，用户以为是网络或对面没开。
    // 所以在这里记一笔，第二次就报一条人话（见上面 windowCookieAt 那段说明）。
    if (!windowOpen && !ticketOpen && !frameOpen && windowCookieAt
        && Date.now() - windowCookieAt < 30_000) {
      windowCookieMisses += 1
      if (windowCookieMisses === 2) {
        log.warn('窗口凭据没被浏览器收下：跨机那一屏会一直停在加载中。'
          + '常见原因是浏览器或企业策略阻止了「第三方 cookie」，或者开着严格的隐私模式；'
          + '换一个浏览器、或把这个地址加进允许名单，通常就好了。')
      }
    }
    const openForWindow = (ticketOpen || frameOpen || windowOpen)
      && typeof mirror.available === 'function' && mirror.available()

    /**
     * ## 进这一层有**两条路**（2026-10-15）
     *
     * **① 手机页那条（原来就有的）**：带我们的令牌进来（`?token=`，或者入口那一趟
     *    写下的 `dsh_mini_token` cookie）。整块路由挂在「进阶设置」开关上，
     *    关着时一条都不接。
     *
     * **② 桌面端「远程窗口」那条（新的）**：地址里带着宿主发的**一次性票**
     *    （`?ticket=`）。票在门这里兑现成窗口会话 cookie（进门之后全靠它认人），
     *    而票自己**只授权那一次**。**这条路上没有令牌**——令牌拼进 iframe 地址
     *    会留在那台电脑的浏览历史里（见 lib/mirror.js 的票）。
     *
     * ## 取景政策：**只有带合法票的请求才放行被嵌**（设计稿门 1）
     *
     * 默认给的是「只许同源」（见 lib/mirror.js 的 FRAME_SELF_ONLY，手机页那一层照常能嵌）。
     * 跨源那一层（桌面端在 `dsh-app://app`，镜像在 `http://127.0.0.1:<端口>`）要嵌，
     * 地址里必须带着那张票。**别有用心的站点把这条地址嵌进自己的页面时地址里没有票**，
     * 于是取景政策当场把它挡下——`SameSite=None` 的窗口会话会被浏览器带过去，
     * 所以这一条不能靠 cookie 来判，只能靠票。
     *
     * ②为什么不挂「进阶设置」那个开关：那是**给手机令牌扩权**的开关（手机令牌本来
     * 只够用我们那张手机页），而这里的票只有**本机回环上的宿主那一半**发得出来
     * （见 `lib/index.js` 的 `/mini-remote/window`，`localOnly`）。本机的软件本来
     * 就有这台电脑的全部权限，谈不上绕过。**开关状态本身一个字都没改。**
     */
    if (mirror && typeof mirrorEnabled === 'function' && (mirrorEnabled() || openForWindow)) {
      /**
       * **诊断模式开关**（`?diag=1`）。
       *
       * 之后注入的那段采样脚本只看这一个参数（见 lib/mirror.js 的 DIAG_SCRIPT），
       * **不带它时行为完全不变**——这一条有测试钉着。
       *
       * 必须**在这里、在改写 `req.url` 之前**读出来：入口那一下会把查询串整个丢掉
       * （上游那条精确匹配的路由不认我们这些参数），丢掉之后就没得读了。
       */
      const diag = url.searchParams.get('diag') === '1'
      const ours = path === '/' || path === '/mini' || path === '/mini/'
        || path === '/mini/sw.js' || path.startsWith('/mini/art/')
      // 三种都要放行：入口、挂在 `/mini/mirror/` 下面的相对路径、以及界面自己发的
      // 绝对路径（`/api/...`、`/plugins/...`）。**第二种漏掉过一次**——剥前缀那段
      // 就成了死代码，测试当场抓住。
      //
      // **第二种曾经还写错过一次**（2026-10-06 真机）：当时限制成「只收 GET」，
      // 而界面外壳写着 `<base href="./">`，**它所有请求都带这个前缀**——于是那些 POST
      // （`/mini/mirror/api/session/list`、`settings/describe`、`agentPresets/list` …）
      // 全掉进我们自己的 404，界面上就是一片「加载不出来」。
      // 前缀下面的路径**本来就只可能是界面的**（我们自己的接口都在 `/mini/api/`），
      // 所以这里不该按方法设限。
      // **我们自己的客户端插件在镜像里也在跑**，它按同源取 `/mini-remote/*`
      // ——那几条是**宿主那边的**路由（`lib/index.js` 注册的），不是我们的。
      //
      // 可这些路径以 `/mini` 开头，会被下面那条「凡不是我们自己的地盘就转上游」判成
      // **我们的地盘**，于是回我们自己的 404 JSON：镜像里的「手机遥控」那一节就永远读不到
      // 配对/隧道/飞书的状态。2026-10-08 在活服务上量到：同一条路径在宿主那边是 200
      // （7360 字节 JSON），在我们这边是 `{"error":"not found"}`。
      //
      // 所以把它一并转上游。**它挂在开关里面**——开关关着时一个都不接，和别的路径同一条口径。
      const miniRemote = path === '/mini-remote' || path.startsWith('/mini-remote/')
      const toUpstream = mirrorEntry || mirrorUnder || miniRemote
        || (!ours && !path.startsWith('/mini'))
      if (toUpstream) {
        // 令牌、窗口会话、或者**刚兑现的那张票**（只有兑现它的那一次请求），有一枚对的就放行。
        // 注意票**不在这里兑现**——门口那一段已经兑现过了（那里才知道能不能兑现）。
        if (!isAuthorized(req, url) && !windowOpen && !ticketOpen) {
          if (hasCredential(req, url)) noteTokenFailure(req, url)
          sendJson(res, 401, { error: '未授权：token 不正确' })
          return
        }
        noteSuccess(req)

        if (mirrorEntry) {
          // **入口这一下不再把令牌写成 cookie**（2026-10-16 第三步，用户点名的那个缝）。
          //
          // 原来这里会在 `?token=…` 进门时顺手种一枚一年期的令牌 cookie。手机页已经不
          // 这么拼地址了（第二步：框里就是 `/mini/mirror/`，靠的是设备 cookie），可**谁
          // 手动打开过那个地址，那台浏览器里就留下一枚令牌**——它进得了 `/mini/api/*`
          // 全部接口。于是「名册里删掉那条记录 = 那台手机什么都做不了」在那台浏览器上
          // 就不成立了，撤销成了半真的。
          //
          // 那界面进去之后确实会发一堆 `/api/…`、`/plugins/…`（**那些请求不会带
          // `?token=`**），靠什么认：
          //   · 手机页那条路——`dsh_mini_device` 那枚设备 cookie（Path=/，框里每一条请求
          //     都自动带上，撤销之后整框一起 401，这才是我们要的）；
          //   · 桌面端「远程窗口」——进门那一下兑现的窗口会话 cookie。
          // 两样都没有的浏览器（有人拿地址栏手敲 `?token=…`）：这一页会打开，但里面
          // 每一格 401。**这是有意的**——宁可让那一格空着，也不把令牌留在浏览器里。
          if (path === MIRROR_PREFIX) {
            // 补上尾斜杠。**这一步不是洁癖**：外壳写着 `<base href="./">`，
            // 在 `/mini/mirror` 上它解析成 `/mini/`，在 `/mini/mirror/` 上才是
            // `/mini/mirror/`——差这一个字符，里面的脚本会全 404、界面白屏。
            // 补完就带上 cookie 了，所以这里不再带查询串——
            // **只有诊断开关要带过去**：用户拿到的那条链接可能没写尾斜杠，
            // 跳一下就把「诊断模式」丢了的话，真机上跑一次就白跑了。
            res.writeHead(302, {
              location: diag ? `${MIRROR_PREFIX}/?diag=1` : `${MIRROR_PREFIX}/`,
              'cache-control': 'no-store',
            })
            res.end()
            return
          }
          // 带斜杠的入口：就是上游的首页，**查询串整个丢掉**（里面只有我们的令牌，
          // 上游不认识它，留着反而会被它的精确路由判成不匹配）。
          const saved = req.url
          req.url = '/'
          try {
            await mirror.handle(req, res, { diag, embed: frameOpen })
          } finally {
            req.url = saved
          }
          return
        }

        // 剥掉挂载前缀：`/mini/mirror/assets/x` → 上游的 `/assets/x`。
        // **只有这一种要改路径。** 绝对路径（`/api/...`、`/plugins/...`）原样转发——
        // 第一版这里写成了「不是前缀就映射到 `/`」，等于把每个 API 调用都打到首页上，
        // 是测试当场抓住的。
        const saved = req.url
        req.url = stripDiagFlag(stripOurSecrets(mirrorUnder ? req.url.slice(MIRROR_PREFIX.length) : req.url))
        try {
          await mirror.handle(req, res, { embed: frameOpen })
        } finally {
          req.url = saved
        }
        return
      }
    }

    // ---- 其余一律要鉴权 -------------------------------------------------
    if (!path.startsWith('/mini/api/')) {
      // **镜像那几条路径走不通时，不许回那个给程序看的 JSON。**
      //
      // 上面那一整块镜像路由挂在开关上（`mirrorEnabled()` 同时看「开关」和「上游地址
      // 解没解析出来」），所以「开关关着」和「电脑端还没就绪」这两种时候，`/mini/mirror/…`
      // 会掉到这里。原来回的是 `{"error":"not found"}`——而手机那边是把镜像**嵌在 iframe 里**的，
      // 这个 JSON 就成了框里的**文档**，被浏览器当页面渲染（2026-10-08 用户真机截图：
      // 框里一条 `{"error":"not found"}`、外面那条「电脑端界面 / 返回」还好好地在）。
      // 这里改回一页人话；**状态码仍然是 404**（此刻这条路确实不存在），换的只是正文。
      if (path === '/mini/mirror' || path.startsWith('/mini/mirror/')) {
        sendMirrorUnavailable(res)
        return
      }
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (!isAuthorized(req, url)) {
      // 只有「带了密码但不对」才算试错；压根没带只是没登录。
      if (hasCredential(req, url)) noteTokenFailure(req, url)
      sendJson(res, 401, { error: '未授权：token 不正确' })
      return
    }
    noteSuccess(req)

    // ---- SSE 推送流 ----------------------------------------------------
    if (req.method === 'GET' && path === '/mini/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(': connected\n\n')
      clients.add(res)
      // 这条流是**哪台设备**的：撤销那一下就是按这个 id 掐的（见 dropDeviceConnections）。
      // 令牌进来的连接（老路）认不出设备，于是也记不上——那种连接不受"撤销设备"影响，
      // 它归令牌管（令牌换掉就重启，那是另一件事）。
      const ownerId = deviceIdOf(presentCredentials(req, url))
      if (ownerId) deviceStreams.set(res, ownerId)
      // 这条连接的身份 + 它要不要轨迹。身份是客户端自己报的随机串（见 clientsById），
      // 没报就编一个：编出来的那种订不了轨迹，也就不用替这份体积付钱。
      const askedClientId = String(url.searchParams.get('clientId') ?? '').slice(0, 64)
      const clientId = askedClientId || `anon${++clientSeq}`
      let sameId = clientsById.get(clientId)
      if (!sameId) clientsById.set(clientId, (sameId = new Set()))
      sameId.add(res)
      // `?full=1` = 「我这一端是完整模式」：连上就订上，重连之后自动重新对齐。
      if (url.searchParams.get('full') === '1') trajectorySubscribers.add(res)
      // `?stream=1` = 「这台设备的流式开关是开的，正文也给我推」。**只在完整模式里才有意义**
      // （正文流式贴在轨迹上），所以顺带把轨迹也订上——省得前端还要发两个参数还要对齐。
      if (url.searchParams.get('stream') === '1') {
        liveTextSubscribers.add(res)
        trajectorySubscribers.add(res)
      }
      // 留痕：手机连没连上、一共有几台，就看这一句。2026-09-27 测自言自语的这天
      // 正是卡在这儿——「她怎么没说话」和「手机压根没连上」当时根本分不开。
      // 还要看**是谁**连的、**活了多久**：2026-09-27 日志里一分钟几十次成对出现，
      // 当时分不清是手机自己抖，还是电脑上另开着一个 /mini 页面在连。
      const who = describeClient(req.headers['user-agent'], req.socket?.remoteAddress)
      const openedAt = Date.now()
      console.log(`[dsh-mini-remote] 手机连上了，现在连着 ${clients.size} 台（${who}）`)

      const beat = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          clearInterval(beat)
          clients.delete(res)
        }
      }, HEARTBEAT_MS)
      if (beat.unref) beat.unref()

      // 连上就先补一次全量状态，手机刷新后不用再单独拉一次。
      res.write(`event: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`)

      // 接着把还在等手机回答的题补给它——重连上来的那一下最容易错过（见 replayQuestions）。
      replayQuestions(res)
      replayApprovals(res)

      // 顺带把这个会话的完整历史准备好：手机上「刷新一下就只剩重启之后的事」
      // 就是这么来的（手里那份只有插件在场时看见的）。读完会再广播一份快照。
      onSessionOpened?.(store.snapshot().boundSessionId)

      // 断开只记一次：req 和 res 各会 close 一次，不挡一下就会打两遍（含义却相反）。
      let said = false
      const cleanup = () => {
        if (said) return
        said = true
        clearInterval(beat)
        clients.delete(res)
        trajectorySubscribers.delete(res)
        liveTextSubscribers.delete(res)
        deviceStreams.delete(res)
        const group = clientsById.get(clientId)
        if (group) {
          group.delete(res)
          if (!group.size) clientsById.delete(clientId)
        }
        console.log(`[dsh-mini-remote] 手机断开了，还剩 ${clients.size} 台`
          + `（${who}，活了 ${Date.now() - openedAt} ms）`)
      }
      req.on('close', cleanup)
      res.on('close', cleanup)
      return
    }

    if (req.method === 'GET' && path === '/mini/api/state') {
      const snap = store.snapshot()
      // 页面刷新、重新打开：也该看到当前会话的完整历史，而不是只有重启之后的事。
      onSessionOpened?.(snap.boundSessionId)
      sendJson(res, 200, snap)
      return
    }

    /**
     * 执行轨迹：手机「完整」模式要的那一组一组过程。
     *
     * **它不在 `state` 快照里**，这是这次改动最要紧的一条：实测轨迹正文是回答正文的
     * 90.7 倍（单轮最高约 946KB），而快照是**每条广播都发整份**的——塞进去等于把
     * 每一次工具调用都变成一次几百 KB 的推送（公网隧道下尤其不可接受）。
     * 所以全量快照照旧，轨迹走增量帧（`event: trajectory`），这份接口只负责
     * 「重连 / 切到完整模式 / 换个会话时，一次把当前这一段补齐」。
     *
     * `turn=N` 只给那一轮：手机切回来时想对齐的是**当前正在跑的那一轮**，不必把
     * 前面一百多条条目再拖一遍。
     *
     * 和 /state 同一条口径：没读过这个会话的记录就先读一次（`onSessionOpened`），
     * 读完会广播 state；手机据此再拉一次，那时 `loading` 就不是 true 了。
     */
    if (req.method === 'GET' && path === '/mini/api/trajectory') {
      const asked = url.searchParams.get('sessionId')
      const sessionId = asked || store.targetSessionId()
      if (!sessionId) {
        sendJson(res, 200, {
          ok: true, sessionId: null, epoch: EPOCH, seq: 0, turn: null,
          turns: [], truncated: false, note: null, loading: false,
        })
        return
      }
      let onlyTurn = null
      if (url.searchParams.has('turn')) {
        onlyTurn = Number(url.searchParams.get('turn'))
        if (!Number.isFinite(onlyTurn)) {
          sendJson(res, 400, { ok: false, error: 'turn 要是一个数字。' })
          return
        }
      }
      onSessionOpened?.(sessionId)
      const view = store.trajectoryOf(sessionId)
      const turns = onlyTurn === null
        ? view.turns
        : view.turns.filter((g) => g.turn === onlyTurn)
      sendJson(res, 200, {
        ok: true,
        sessionId,
        epoch: EPOCH,
        seq: view.seq,
        turn: onlyTurn,
        turns,
        truncated: view.truncated,
        note: view.note ?? null,
        loading: view.loading === true,
      })
      return
    }

    // 构建指纹。重启期间旧进程还在应答，这个接口用来确认「跑的是不是新代码」。
    //
    // `canCreateSession` 是**运行时**事实，不是配置推断：它问的是「这一刻 DSH 真的
    // 把会话服务给我们了吗」。配置里挂了 `dsh-api-session-controller` 只说明它该在，
    // 而服务可能因为组合不同、启动顺序、加载失败而没来——那种情况下手机上的 ＋
    // 会一直报「没提供这个能力」，光看代码是查不出来的。放这儿就能一条命令问清楚。
    if (req.method === 'GET' && path === '/mini/api/version') {
      let canCreateSession = false
      try {
        canCreateSession = nav.canCreateSession?.() === true
      } catch (err) {
        // 探测本身不该把接口带崩：问不到就当没有。
        canCreateSession = false
      }
      // 版本号问**正在跑的这只 Host**（见 index.js 的 dshVersion）。
      // 早先这里是读磁盘上的 package.json，桌面端读不到，一直报 unknown。
      const version = (await nav.dshVersion?.()) || 'unknown'
      sendJson(res, 200, { ok: true, build: build ?? 'unknown', dshVersion: version, canCreateSession })
      return
    }

    // 插件列表：手机端「插件」页面用。分三块——
    //   bundles  ：npm 包（官方可装的 + 用户装的第三方）
    //   cards    ：官方那几张**设置卡片**（终端 / Agent 循环 / 子智能体 / 网页搜索）。
    //             它们不是包，是注册了设置页的官方插件，宿主这边只能照 DSH 客户端
    //              源码列一张表 + 按「宿主 served 了那个命名空间没」筛选。
    //   entries/presets：**内置插件**（Cordis Loader 的实时条目表），也就是
    //             「全局插件」和「会话插件」两块。2026-10-04 用户指出：内置插件
    //             不能拿 npm 包充数（那只有几个），DSH 是「一切皆插件，无特权核心」。
    // 三块各带各的错：一块读不到不该把另两块也弄没。
    if (req.method === 'GET' && path === '/mini/api/plugins') {
      const [list, inv, official] = await Promise.all([
        nav.pluginList?.() ?? { ok: false, reason: 'unavailable' },
        nav.pluginInventory?.() ?? { ok: false, reason: 'unavailable' },
        nav.officialPlugins?.() ?? { ok: false, reason: 'unavailable' },
      ])
      sendJson(res, 200, {
        ok: list.ok !== false || inv.ok !== false,
        bundles: list.bundles ?? [],
        bundlesError: list.ok === false ? String(list.reason || '读不到') : '',
        official: official.cards ?? [],
        officialError: official.ok === false ? String(official.reason || '读不到') : '',
        entries: inv.entries ?? [],
        presets: inv.presets ?? [],
        builtinError: inv.ok === false ? String(inv.reason || '读不到') : '',
      })
      return
    }

    // latest / history 都取**当前绑定会话**的那一份，不取全局的。
    if (req.method === 'GET' && path === '/mini/api/latest') {
      const snap = store.snapshot()
      sendJson(res, 200, { latest: snap.latest, sessionId: snap.boundSessionId })
      return
    }

    if (req.method === 'GET' && path === '/mini/api/history') {
      sendJson(res, 200, { history: store.snapshot().history })
      return
    }

    // ---- 子智能体 ------------------------------------------------------
    // 列表取**当前绑定会话**名下那一份（和 send / stop 同一套口径）。
    // 失败一律 200 + ok:false：这是"这道能力现在没有"或"这台电脑没开这条路"，
    // 不是请求本身有错——用 4xx 会让页面上的重试逻辑把它当网络故障。
    if (req.method === 'GET' && path === '/mini/api/subagents') {
      const result = await loadSubagents(store.snapshot().boundSessionId)
      sendJson(res, 200, result)
      return
    }

    // 某一道子智能体**自己的运行过程**（它自己的会话记录重放出来的聊天记录）。
    if (req.method === 'GET' && path === '/mini/api/subagent') {
      const childId = url.searchParams.get('id') ?? ''
      const result = await nav.subagentTranscript(childId, store.snapshot().boundSessionId)
      sendJson(res, 200, result)
      return
    }

    // ---- 繁忙时的发送行为 ------------------------------------------------
    // 智能体跑着的时候，你发的那句话是排队等这一轮跑完（queue），还是当场插进去
    // 让它调整方向（steer）。**PC 上的「设置 → 通用 → 繁忙时的发送行为」就是它**，
    // 两端共用宿主那一份用户设置文档（用户 2026-10-05 拍板）。
    //
    // 读不到就如实说 unavailable，手机那边整条不显示——**不摆一个假的开关**。
    if (req.method === 'GET' && path === '/mini/api/busy-enter') {
      const result = await nav.busyEnterSetting()
      sendJson(res, result.ok ? 200 : 503, result)
      return
    }

    if (req.method === 'POST' && path === '/mini/api/busy-enter') {
      const body = await readBody(req)
      const result = await nav.setBusyEnter(body?.value)
      sendJson(res, result.ok ? 200 : 400, result)
      return
    }

    // ---- 镜像页「诊断模式」的上报口 ---------------------------------------
    //
    // 只有 `?diag=1` 打开的那一页会往这里发东西（见 lib/mirror.js 的 DIAG_SCRIPT）。
    // **样本追加写到 scratch/diag.log**，一行一条、带时间戳——用户不用看，
    // 开发者读它就能把「首帧没字」的根因定死（点击前/点击后两份样本一比，
    // 到底哪个属性变了就露出来了）。
    //
    // 它不是「诊断模式」本身，只是一个**只写不读**的收件口，所以：
    //   · 走和其他 `/mini/api/*` 同一道门（没令牌进不来）；
    //   · 不跟着镜像开关关——开关关着时根本没有哪一页会发东西过来，跟着关没意义；
    //   · 写失败就**如实回错误**（前端那条小条会把原话显示出来），
    //     免得「真机跑一次、日志里什么都没有」这种事还要再猜一轮。
    if (req.method === 'POST' && path === '/mini/api/mirror-diag') {
      try {
        const payload = await readBody(req)
        const file = diagLogPath()
        await mkdir(dirname(file), { recursive: true })
        await appendFile(file, `\n=== ${new Date().toISOString()} ===\n${JSON.stringify(payload, null, 2)}\n`, 'utf8')
        sendJson(res, 200, { ok: true })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
      return
    }

    // ---- 「进阶设置（电脑端界面）」的开关 ---------------------------------
    // 只是那个开关的状态与读写；**真正的代理在 handle() 上面那一段**。
    // 两件事分开是有意的：状态随时可查（界面进来就要知道该画成什么样），
    // 而那条代理路由**关着时根本不存在**。
    if (req.method === 'GET' && path === '/mini/api/mirror') {
      const result = await nav.mirrorSetting()
      sendJson(res, result.ok ? 200 : 503, result)
      return
    }

    if (req.method === 'POST' && path === '/mini/api/mirror') {
      const body = await readBody(req)
      const result = await nav.setMirror(body?.enabled)
      sendJson(res, result.ok ? 200 : 400, result)
      return
    }

    // ---- 斜杠指令列表 ----------------------------------------------------
    // 手机在输入框里打 `/` 时要显示的那一份。**名单来自 DSH 自己的指令账本**，
    // 所以电脑上新装一个带指令的插件，手机上刷新就有了，不用改这个插件。
    //
    // 拿不到的时候如实说为什么（会话没在跑 / 这台电脑没有指令服务），
    // 让手机显示那句话——**不能回一个空列表**：空列表的意思是「一条指令都没有」，
    // 那是另一回事，用户会以为自己的 `/compact` 打错了。
    if (req.method === 'GET' && path === '/mini/api/commands') {
      if (!onCommands) {
        sendJson(res, 503, { ok: false, error: '这台电脑上的 DSH 没提供指令。' })
        return
      }
      const result = onCommands()
      sendJson(res, result.ok ? 200 : 409, result)
      return
    }

    // 左侧导航栏：先列工作区（便宜），展开某个再取它的会话（要读日志折标题，贵）。
    // `refresh=1` 是导航栏那个 ⟳ 按钮用的：绕过服务端缓存，真去读一遍。
    if (req.method === 'GET' && path === '/mini/api/workspaces') {
      const runningIds = new Set(
        (store.snapshot().sessions ?? []).filter((s) => s.running).map((s) => s.id),
      )
      // includeEmpty：手机能自己新建工作区了，刚建好的那个本来就是空的。
      // 不列出来的话，建完它当场消失，用户只会以为没建成。
      const workspaces = await loadWorkspaces(
        runningIds, url.searchParams.get('refresh') === '1',
      )
      sendJson(res, 200, { ok: true, workspaces })
      return
    }

    // Agent 模式清单（2026-10-04）：手机新建会话时挑模式用。拿不到能力时如实回
    // unavailable——手机那边会直接建默认模式，**不摆没得选的选择题**。
    if (path === '/mini/api/agent-presets' && req.method === 'GET') {
      sendJson(res, 200, await nav.agentPresets?.() ?? { ok: false, reason: 'unavailable' })
      return
    }

    const wsSessions = /^\/mini\/api\/workspaces\/([^/]+)\/sessions$/.exec(path)
    if (req.method === 'GET' && wsSessions) {
      const asked = Number(url.searchParams.get('limit'))
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 100) : undefined
      const workspaceId = decodeURIComponent(wsSessions[1])
      const started = performance.now()
      const result = await nav.listSessionsOf(
        workspaceId,
        limit,
        url.searchParams.get('refresh') === '1',
        (title) => broadcast('navigation-title', title),
      )
      log?.info?.(`导航会话读取 ${Math.round(performance.now() - started)}ms（工作区 ${workspaceId}）`)
      if (!result) {
        sendJson(res, 404, { ok: false, error: '没有这个工作区。' })
        return
      }
      // 分组口径（隐藏已归档 / 隐藏空白 / 排序）在服务端这一层做：
      // 树那一层（lib/tree.js）只回答"这个工作区有哪些会话"，界面口径不该渗进去。
      const shaped = await shapeSessions(result, {
        showArchived: url.searchParams.get('archived') === '1',
        boundSessionId: store.snapshot().boundSessionId,
      })
      sendJson(res, 200, { ok: true, ...shaped })
      return
    }

    // ---- 权限档位（作用在当前绑定的那个会话上）--------------------------
    // 拿不到服务时**如实说没这个能力**，手机据此整块不显示。
    // 不伪装成「只有一档」——那会让用户以为自己的权限被降过。
    if (req.method === 'GET' && path === '/mini/api/permissions') {
      const boundSessionId = store.snapshot().boundSessionId
      const result = await nav.permissions(boundSessionId)
      sendJson(res, 200, { boundSessionId, ...result })
      return
    }

    // ---- 改模型 / 改思考强度 ---------------------------------------------
    // 作用在当前绑定的那个会话上，和权限档位同一个口径。
    //
    // 强度**可以不传**——那表示「用这个模型自己的默认」。我们不替它猜一个值：
    // 猜错了用户会以为那是自己选的，而真正生效的是别的档位。
    //
    // 强度和模型必须**一起**交给 DSH：`ModelSelection` 里强度是模型选择的一部分，
    // 不是一项独立设置。分两次改会出现「模型换了、强度还停在旧模型那一档」的中间态。
    if (req.method === 'POST' && path === '/mini/api/set-model') {
      const boundSessionId = store.snapshot().boundSessionId
      const body = await readBody(req)
      const result = await nav.selectModel(boundSessionId, {
        provider: body?.provider,
        model: body?.model,
        ...(body?.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
      })
      if (!result.ok) {
        sendJson(res, 503, { ok: false, error: '这台电脑上的 DSH 没提供改模型的能力。' })
        return
      }
      // 把改完的值就手记到这个会话上。
      //
      // 为什么非记不可：DSH 那边要等这个会话**下一次发请求**才会把新模型报出来
      // （request/header 事件），中间这段时间插件手里还是旧值。不补这一笔，用户
      // 改完切走再切回来就会看到旧模型——那是他自己刚改的，等于界面自己打自己的脸。
      const sel = result.selected
      if (sel && typeof sel.model === 'string') {
        store.touchSession(boundSessionId, {
          provider: typeof sel.provider === 'string' ? sel.provider : null,
          model: sel.model,
          reasoningEffort: typeof sel.reasoningEffort === 'string' ? sel.reasoningEffort : null,
        })
      }
      sendJson(res, 200, { ok: true, boundSessionId, selected: result.selected })
      return
    }

    // ---- 模型与思考强度（作用在当前绑定的那个会话上）----------------------
    // 目录里带着每个模型**自己声明**支持哪几档强度（`reasoning`）。手机照着它长界面：
    // 不支持调强度的模型，那一行就不出现——**不给一个拖了没反应的滑块**。
    //
    // 目录是全局的，选中的那个是会话级的，所以这里两个都给出去：清单 + 当前绑定的那个。
    // 拿不到能力时如实说没这个能力（503），和权限档位同一个口径。
    if (req.method === 'GET' && path === '/mini/api/models') {
      const boundSessionId = store.snapshot().boundSessionId
      const result = await nav.modelCatalog(boundSessionId)
      if (!result.ok) {
        sendJson(res, 503, { ok: false, error: '这台电脑上的 DSH 没提供模型目录。' })
        return
      }
      // 「这个会话现在用哪个」以 **DSH 那边**为准：它读的是会话日志里最后那条请求配置，
      // 重启过、插件没看见过的会话一样问得出来。
      //
      // 为什么要改：原来只从插件自己记的那份里取（靠 request/header 事件一点点攒），
      // 没跑过的会话就是空的。手机上一版又给空值兜了「目录默认值」，于是把**不知道**
      // 显示成了「上次选过的那个模型」——用户切过去看到的是一个像模像样的错答案。
      // 现在问不到就如实给 null，怎么讲由界面决定，反正不编。
      const asked = nav.sessionModel ? await nav.sessionModel(boundSessionId) : { ok: false }
      const remembered = store.snapshot().sessions?.find((s) => s.id === boundSessionId) ?? null
      /**
       * 手机上要看「上下文用了多少」，这份是分子分母凑齐的一份。
       *
       * 第一来源是内存里那份：会话跑起来时每一步的 usage 都会刷新它，最鲜活。
       * 内存里没有才问日志（`nav.sessionContext`）——**这一条是必须的**：窗口那条
       * 事件一个会话只写一次，插件晚一步起来（重启过、或早就开着的会话）就永远
       * 等不到它，光靠内存会一直空着，用户看到的就是「这个功能没了」
       * （2026-09-28 用户报的）。日志里那份同样是 DSH 记下的事实，不是估的。
       */
      const context = remembered?.context
        ?? (nav.sessionContext ? await nav.sessionContext(boundSessionId) : null)
      const current = asked.ok
        ? asked.model
        : (remembered && remembered.model
            ? {
                provider: remembered.provider ?? null,
                model: remembered.model,
                reasoningEffort: remembered.reasoningEffort ?? null,
              }
            : null)
      sendJson(res, 200, {
        ok: true,
        boundSessionId,
        current,
        // { used, window } 或 null。缺任一半就是 null，界面据此整段不显示——不编、不放占位符。
        context,
        ...result.catalog,
      })
      return
    }

    if (req.method === 'POST' && path === '/mini/api/answer') {
      const body = await readBody(req)
      // 判据、错误文案都收在 answerQuestion 里——和飞书那条路共用同一处（见上面那段说明）。
      const out = answerQuestion(body?.id, body, 'phone')
      if (!out.ok && out.error === 'expired') {
        // 409 而不是 200：多半是这个提问早就结束了，如实说，别装作收下了。
        // 落一句痕：这是「手机答了、电脑没动静」唯一能查到的线索——手机那边原来
        // 把失败咽掉了，插件这边再不留痕，下次还是只能靠猜（2026-09-27）。
        console.log('[dsh-mini-remote] 手机上答晚了：这道题已经交回电脑（' + String(body?.id) + '），没接')
        sendJson(res, 409, { ok: false, error: '这个提问已经结束了。' })
        return
      }
      if (!out.ok) {
        sendJson(res, 400, { ok: false, error: '答案格式不对。' })
        return
      }
      sendJson(res, 200, { ok: true })
      return
    }

    // ---- 手机上来拍板审批 ------------------------------------------------
    // 交回来的东西和上面的答案不同：这里只要一个结论。措辞照 /mini/api/answer 那一支——
    // 过期了如实说、格式不对就说格式不对，别装作收下了。
    if (req.method === 'POST' && path === '/mini/api/approval') {
      const body = await readBody(req)
      // 手机页交上来的说法是 allow / deny，换成清单里的结论值；飞书那边直接交结论。
      const decision = body?.decision === 'allow'
        ? 'allowed-once'
        : (body?.decision === 'deny' ? 'rejected' : body?.decision)
      const out = decideApproval(body?.id, { ...body, decision }, 'phone')
      if (!out.ok && out.error === 'expired') {
        console.log('[dsh-mini-remote] 手机上拍晚了：这条审批已经交回电脑（' + String(body?.id) + '），没接')
        sendJson(res, 409, { ok: false, error: '这条审批已经结束了。' })
        return
      }
      if (!out.ok) {
        sendJson(res, 400, { ok: false, error: '审批的结论只有同意或拒绝两种。' })
        return
      }
      sendJson(res, 200, { ok: true })
      return
    }
    // ---- 目录浏览（挑工作区用）------------------------------------------
    // 只列目录，绝不列文件、绝不读内容。手机上要的是「挑一个文件夹」。
    if (req.method === 'GET' && path === '/mini/api/browse/roots') {
      // 「最近用过的目录」直接拿已登记工作区的路径：那些正是他用过的地方，
      // 不用我们另外记一份「最近打开过什么」的状态。
      const recent = (nav.listWorkspaces ? await nav.listWorkspaces(new Set(), false) : [])
        .map((w) => w.path)
        .filter(Boolean)
      sendJson(res, 200, { ok: true, ...(await files.listRoots({ recent })) })
      return
    }

    if (req.method === 'GET' && path === '/mini/api/browse') {
      const asked = url.searchParams.get('path')
      if (!asked) {
        sendJson(res, 400, { ok: false, error: '要带 path 参数。' })
        return
      }
      const result = await files.listDirectory(asked)
      if (!result.ok) {
        // 读不出来时如实说，**不当作空目录**：空目录和「没有权限」在界面上
        // 长得一模一样，而后者用户需要知道。
        const known = {
          'bad-path': [400, '这个路径不合法。'],
          unreadable: [404, '读不到这个目录，可能是不存在或者没有权限。'],
          // 空壳才会走到这儿（生产里 browse 一直传得进来）。口径跟其它
          // 「没这个能力」统一成 503，不混进 500 里。
          unavailable: [503, '这台电脑上的 DSH 没提供目录浏览。'],
        }
        const [status, message] = known[result.reason]
          ?? [500, `读目录失败：${result.error ?? '原因未知'}`]
        sendJson(res, status, { ok: false, error: message })
        return
      }
      sendJson(res, 200, result)
      return
    }

    // ---- 上传文件 -------------------------------------------------------
    // 这一段**必须排在下面那个 readBody 前面**：readBody 既只认 JSON，又把请求体
    // 限死在 64 KB（MAX_BODY）。手机拍一张照片就有好几兆，走它必然失败，而且失败得
    // 很难看——先是「请求体过大」，用户完全不知道该怎么办。这里直接把请求流喂给
    // 插件的保存回调，DSH 那边边收边落盘，不在内存里攒整份。
    if (req.method === 'POST' && path === '/mini/api/upload') {
      if (!onUpload) {
        sendJson(res, 503, { error: '这台电脑上的 DSH 没装附件服务，传不了文件。' })
        return
      }
      const name = url.searchParams.get('name') ?? undefined
      // 客户端声明的长度只能当提示：够长就早点拒绝，省得白白传上来再失败。
      // 但它不算依据——真正的闸门在下面那道数着字节的闸门上。
      const declared = Number(url.searchParams.get('size') ?? '')
      if (Number.isFinite(declared) && declared > MAX_UPLOAD) {
        sendJson(res, 413, { error: `文件太大了（${mb(declared)}），最多 ${mb(MAX_UPLOAD)}。` })
        return
      }
      let seen = 0
      async function* capped() {
        for await (const chunk of req) {
          seen += chunk.length
          if (seen > MAX_UPLOAD) throw new Error(`超过 ${mb(MAX_UPLOAD)}`)
          yield chunk
        }
      }
      try {
        const result = await onUpload({ data: capped(), name })
        sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        // 手机中途断了、或者文件太大，都会走到这里。这不是「服务坏了」，
        // 如实把原因说出来就行。
        sendJson(res, 400, { error: `文件没存下：${err?.message ?? err}` })
      }
      return
    }

    if (req.method === 'POST') {
      let body
      try {
        body = await readBody(req)
      } catch (err) {
        sendJson(res, 400, { error: err.message })
        return
      }

      if (path === '/mini/api/send') {
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        const uploadIds = Array.isArray(body.uploadIds) ? body.uploadIds : []
        // 只传文件不写字也是合法的——「这份文件你看一下」本来就是常见用法。
        // 两样都没有才算空。
        if (!text && !uploadIds.length) {
          sendJson(res, 400, { error: '指令为空' })
          return
        }
        const result = await onInstruction(text, uploadIds)
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }

      if (path === '/mini/api/command') {
        // 执行一条斜杠指令。**结果不在这条响应里**——指令跑完会把
        // `command/run` / `command/done` 两条事件写进会话记录，手机上那条「指令行」
        // 是跟着事件流出现的（和电脑端同一份账）。这里只负责「收下并开跑」，
        // 或者「不收，并说明为什么」。
        const line = typeof body.line === 'string' ? body.line : ''
        if (!line.trim()) {
          sendJson(res, 400, { ok: false, error: '指令为空。' })
          return
        }
        if (!onCommand) {
          sendJson(res, 503, { ok: false, error: '这台电脑上的 DSH 没提供指令。' })
          return
        }
        const result = await onCommand(line)
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }

      if (path === '/mini/api/stop') {
        // 停的是「手机正在遥控的那个会话」，和 send 同一套口径——
        // 手机上按的停止，不该停掉你在电脑上另开的那个任务。
        const result = await onStop()
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }

      if (path === '/mini/api/subagent/stop') {
        // 停一道子智能体**当前这一轮**。父会话 id 由服务端自己取，不信请求体里的——
        // 权限凭据是「谁的父会话」，让手机随便填就等于谁都能停别人的。
        const childId = typeof body.id === 'string' ? body.id : ''
        const mode = typeof body.mode === 'string' ? body.mode : ''
        const result = await nav.stopSubagent(childId, store.snapshot().boundSessionId, mode)
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }

      if (path === '/mini/api/subagent/ask') {
        // 跟一道子智能体接着说一句话。同样，父会话 id 服务端自己取。
        const childId = typeof body.id === 'string' ? body.id : ''
        const mode = typeof body.mode === 'string' ? body.mode : ''
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) {
          sendJson(res, 400, { ok: false, error: '话是空的。' })
          return
        }
        const result = await nav.askSubagent(childId, store.snapshot().boundSessionId, mode, text)
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }

      if (path === '/mini/api/unqueue') {
        // 撤掉一条还在排队的指令。撤的是「手机正在遥控的那个会话」队列里的那一条，
        // 和 send / stop 同一套口径。
        const id = typeof body.id === 'string' ? body.id : ''
        if (!id) {
          sendJson(res, 400, { error: 'id 为空' })
          return
        }
        const result = onUnqueue(id)
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }

      if (path === '/mini/api/trajectory/subscribe') {
        // 开/关轨迹推送（见 trajectorySubscribers）。**只点到 clientId 名下那条连接**，
        // 别的连接一个字节都不受影响——单帧/聊天模式的手机不该为这份体积付钱。
        const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
        if (!clientId) {
          sendJson(res, 400, { ok: false, error: 'clientId 不能空——订阅是按连接记的。' })
          return
        }
        const on = body.on !== false
        const hit = setTrajectorySubscription(clientId, on)
        if (!hit) {
          // 认不出这条连接：多半是那条流已经断了（或者连流时没报 clientId）。
          // **如实说没订上**，别让手机以为订上了却一条都收不到——那是最难查的一种静默失败。
          sendJson(res, 404, { ok: false, error: '这条连接已经不在了，重新连一次流。' })
          return
        }
        sendJson(res, 200, { ok: true, clientId, subscribed: on, connections: hit, epoch: EPOCH })
        return
      }

      // 在一个已有的工作区里新建会话，建完立刻把手机绑过去。
      //
      // 为什么排在这么靠后、而不是跟上面那条 GET 挨着：这两条都要读请求体，
      // 而 `readBody` 在后面才调（上面那条 GET 不用读，所以能排在前面）。
      // 同一个路径上 GET 是「列出来」、POST 是「建一个」——同一条资源的两种动作。
      //
      // 建完顺手 bind + 广播：手机发一次请求就完成了「建 + 切过去」，
      // 不用再补一次 bind，也就不会出现「建好了但没切过去」这种半截状态。
      if (req.method === 'POST' && wsSessions) {
        // agentPreset（2026-10-04，手机上也能选模式）：选了才带，没选让 DSH 用默认。
        const preset = typeof body.agentPreset === 'string' && body.agentPreset.trim()
          ? body.agentPreset.trim()
          : undefined
        const created = await nav.createSession(decodeURIComponent(wsSessions[1]), preset)
        if (!created.ok) {
          const known = {
            'no-controller': [503, '这台电脑上的 DSH 没提供新建会话的能力。'],
            'no-workspace': [404, '没有这个工作区。'],
          }
          const [status, message] = known[created.reason]
            ?? [500, `新建会话失败：${created.error ?? '原因未知'}`]
          sendJson(res, status, { ok: false, error: message })
          return
        }
        store.bind(created.sessionId)
        // 新会话会改变工作区的数量；下次打开导航栏必须重新整理一次。
        invalidateNavigation()
        const snap = store.snapshot()
        broadcast('state', snap)
        sendJson(res, 200, {
          ok: true,
          sessionId: created.sessionId,
          workspaceTitle: created.workspaceTitle,
          boundSessionId: created.sessionId,
          state: snap,
        })
        return
      }

      // ---- 会话条目的执行功能（2026-10-09）------------------------------
      //
      // 五条动作都**作用在传进来的那个会话上**，不是"当前绑定的会话"。
      // 为什么和 send / stop 的口径不一样：那一套是"你在遥控哪一个会话"，
      // 而这一套是从列表里对着**某一行**动的手——用户点的就是那一行，
      // 拿绑定会话去改会改错人（列表里明明点的是别人）。
      //
      // 每条都把官方的拒绝**翻译成一句人话**，并把失败原因（reason）一起带回去。
      // 手机那边照着 reason 决定说什么，不靠中文字面去猜。
      if (path === '/mini/api/session/rename') {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        // 空标题在**请求边界**先挡一次（另一道在 lib/index.js 的 renameSession，
        // 那里是"官方会抛"的那一种）。两处都留：这一处省一趟往返、并且让 400 这句话
        // 和其它路由的措辞放在一起；那一处保证任何调用方都绕不过去。
        if (typeof body.title !== 'string' || !body.title.trim()) {
          sendJson(res, 400, { ok: false, reason: 'blank', error: '标题不能为空。' })
          return
        }
        const result = await nav.renameSession(sessionId, body.title)
        if (!result.ok) {
          const known = {
            'no-service': [503, '这台电脑上的 DSH 没提供改标题的能力。'],
            blank: [400, '标题不能为空。'],
            'not-found': [404, '这个会话不在了，刷新一下再看看。'],
          }
          const [status, message] = known[result.reason]
            ?? [500, `改标题失败：${result.error ?? '原因未知'}`]
          sendJson(res, status, { ok: false, reason: result.reason, error: message })
          return
        }
        sendJson(res, 200, { ok: true, sessionId, title: result.title })
        return
      }

      if (path === '/mini/api/session/fork') {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const result = await nav.forkSession(sessionId)
        if (!result.ok) {
          const known = {
            'no-service': [503, '这台电脑上的 DSH 没提供分叉会话的能力。'],
            // 这两条**原话转发**：`result.error` 里装的就是 Host 抛出来的那句话
            // （见 lib/index.js 的 forkSession）。在这里再包一层我们自己的话，
            // 用户就看不到真正的原因了——那是这一条路唯一要防的事。
            'no-turn': [409, result.error],
            'not-found': [404, result.error],
          }
          const [status, message] = known[result.reason]
            ?? [500, `分叉失败：${result.error ?? '原因未知'}`]
          sendJson(res, status, { ok: false, reason: result.reason, error: message })
          return
        }
        sendJson(res, 200, {
          ok: true,
          sessionId: result.sessionId,
          sourceSessionId: sessionId,
          title: result.title,
        })
        return
      }

      if (path === '/mini/api/session/pin') {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const want = body.pinned !== false
        const result = want
          ? await nav.pinSession(sessionId)
          : await nav.unpinSession(sessionId)
        if (!result.ok) {
          const known = {
            'no-registry': [503, '这台电脑上的 DSH 没提供工作区服务。'],
            archived: [409, '已归档的会话不能置顶，先取消归档。'],
            'not-found': [404, '这个会话不在了，刷新一下再看看。'],
          }
          const [status, message] = known[result.reason]
            ?? [500, `置顶失败：${result.error ?? '原因未知'}`]
          sendJson(res, status, { ok: false, reason: result.reason, error: message })
          return
        }
        sendJson(res, 200, {
          ok: true,
          sessionId,
          pinned: want,
          archivedSessionIds: result.archived,
          pinnedSessionIds: result.pinned,
        })
        return
      }

      if (path === '/mini/api/session/archive') {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const result = await nav.archiveSession(sessionId, body.stop === true)
        if (!result.ok) {
          // 「还有工作在跑」不是错误，是**两段式流程的第一段**：官方拒一次，同时给出
          // 会停掉什么。原样交给手机，由它弹确认框问过用户再带 stop:true 回来。
          if (result.reason === 'active') {
            sendJson(res, 409, {
              ok: false,
              reason: 'active',
              sessionId,
              activity: result.activity,
              error: '这个会话还有工作在跑，归档会先停掉它们。',
            })
            return
          }
          const known = {
            'no-registry': [503, '这台电脑上的 DSH 没提供工作区服务。'],
            'not-found': [404, '这个会话不在了，刷新一下再看看。'],
          }
          const [status, message] = known[result.reason]
            ?? [500, `归档失败：${result.error ?? '原因未知'}`]
          sendJson(res, status, { ok: false, reason: result.reason, error: message })
          return
        }
        sendJson(res, 200, {
          ok: true,
          sessionId,
          archived: true,
          stopped: body.stop === true,
          archivedSessionIds: result.archived,
          pinnedSessionIds: result.pinned,
        })
        return
      }

      if (path === '/mini/api/session/unarchive') {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const result = await nav.unarchiveSession(sessionId)
        if (!result.ok) {
          const known = { 'no-registry': [503, '这台电脑上的 DSH 没提供工作区服务。'] }
          const [status, message] = known[result.reason]
            ?? [500, `取消归档失败：${result.error ?? '原因未知'}`]
          sendJson(res, status, { ok: false, reason: result.reason, error: message })
          return
        }
        sendJson(res, 200, {
          ok: true,
          sessionId,
          archived: false,
          archivedSessionIds: result.archived,
          pinnedSessionIds: result.pinned,
        })
        return
      }

      // 切权限档位。作用在当前绑定的那个会话上——手机只绑一个会话，
      // 所以「当前会话」和「绑定会话」是同一件事。
      if (path === '/mini/api/permissions') {
        const boundSessionId = store.snapshot().boundSessionId
        const done = await nav.setPermission(
          boundSessionId, typeof body.name === 'string' ? body.name : '',
        )
        if (!done.ok) {
          const known = {
            'no-service': [503, '这台电脑上的 DSH 没提供权限档位。'],
            // 409 而不是 400：请求本身没问题，是当前状态不满足——
            // 得先挑一个会话。
            'no-session': [409, '还没绑定会话，先挑一个会话再切权限。'],
            'unknown-preset': [400, '没有这个权限档位。'],
          }
          const [status, message] = known[done.reason]
            ?? [500, `切换失败：${done.error ?? '原因未知'}`]
          sendJson(res, status, { ok: false, error: message })
          return
        }
        // 切完把最新状态回过去：手机据此更新高亮，不用再补一趟请求。
        const after = await nav.permissions(boundSessionId)
        sendJson(res, 200, { ...after, ok: true, name: done.name, boundSessionId })
        return
      }

      // 把一个目录登记成工作区。
      // 跟上面那条 GET 同一条路径：GET 是「列出来」，POST 是「登记一个」。
      if (path === '/mini/api/workspaces') {
        const target = typeof body.path === 'string' ? body.path : ''
        const made = await nav.createWorkspace(target)
        if (!made.ok) {
          const known = {
            'no-registry': [503, '这台电脑上的 DSH 没提供工作区服务。'],
            'bad-path': [400, '没给路径。'],
          }
          const [status, message] = known[made.reason]
            ?? [400, `登记不了这个目录：${made.error ?? '原因未知'}`]
          sendJson(res, status, { ok: false, error: message })
          return
        }
        // 登记完立刻把最新的工作区列表带回去：手机拿到就能直接画出来，
        // 不用再补一趟请求，也就不会出现「建好了但列表里还没有」。
        const workspaces = await loadWorkspaces(new Set(), true)
        sendJson(res, 200, {
          ok: true, created: made.created, workspace: made.workspace, workspaces,
        })
        return
      }

      // 在选中的目录下新建一个子目录。
      // `name` 必须是**单个目录名**，不接受路径——手机是网络对面来的输入，
      // 一个带 `..` 或分隔符的「名字」能让新建落到别的地方去。
      if (path === '/mini/api/browse/mkdir') {
        const result = await files.makeDirectory(body.path, body.name)
        if (!result.ok) {
          const known = {
            'bad-name': [400, '文件夹名不合法：不能为空、不能带斜杠，也不能是 . 或 ..'],
            'bad-path': [400, '这个路径不合法。'],
            exists: [409, '这个名字已经有一个文件夹了。'],
          }
          const [status, message] = known[result.reason]
            ?? [500, `建文件夹失败：${result.error ?? '原因未知'}`]
          sendJson(res, status, { ok: false, error: message })
          return
        }
        sendJson(res, 200, result)
        return
      }

      if (path === '/mini/api/bind') {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (!sessionId) {
          sendJson(res, 400, { error: 'sessionId 为空' })
          return
        }
        store.bind(sessionId)
        // 切过去的这个会话，完整历史该读就读（异步补，读完再广播一份快照）。
        // 这一下是「点开工作区里的会话，能看到它之前的每一轮」能成立的关键。
        onSessionOpened?.(sessionId)
        const snap = store.snapshot()
        broadcast('state', snap)
        // 顺手把快照放回响应里。手机拿到就能立刻渲染，不用等 SSE 那一趟；
        // 万一那一刻连接正好断了，切换也还是自足的。
        sendJson(res, 200, { ok: true, boundSessionId: sessionId, state: snap })
        return
      }

      if (path === '/mini/api/presence') {
        store.markSeen(body.state === 'background' ? 'background' : 'foreground')
        sendJson(res, 200, { ok: true })
        return
      }

      if (path === '/mini/api/heartbeat') {
        store.markSeen()
        sendJson(res, 200, { ok: true })
        return
      }
    }

    sendJson(res, 404, { error: 'not found' })
  }

  const onRequest = (req, res) => {
    handle(req, res).catch((err) => {
      log?.warn?.(`dsh-mini-remote: 请求处理失败 ${req.url} — ${err?.message ?? err}`)
      if (!res.headersSent) {
        sendJson(res, 500, { error: '内部错误' })
      } else {
        res.destroy()
      }
    })
  }

  // 一个地址一个监听。127.0.0.1 排在第一个，配置成 0 端口时由它把真实端口
  // 定下来，其余地址复用同一个端口。
  const wanted = Array.isArray(bindAddresses) && bindAddresses.length
    ? bindAddresses
    : ['127.0.0.1']

  /**
   * 在某个端口上把地址逐个绑一遍。
   *
   * 逐个绑是刻意的：某个地址绑不上（比如 DHCP 换过 IP、Tailscale 退出了）不该
   * 拖垮整个服务——其余的照常工作，只是这个地址用不了。
   */
  async function bindOn(startPort) {
    const listeners = []
    const failed = []
    let port = startPort
    for (const address of wanted) {
      const server = createServer(onRequest)
      // WebSocket 不走 onRequest——它是一条 `Upgrade` 握手，Node 单独发这个事件。
      //
      // **手机和宿主之间那条常驻连接就是 WebSocket**（`/api/remote.mux`）。少了这一段，
      // 镜像里的界面会「一直正在重新连接」，插件那一列只剩图标没有文字、权限那栏写
      // 「permission catalog has no active Host connection」——**看起来像一堆显示毛病，
      // 其实全是同一条连接没通**（2026-10-06 真机报上来的）。
      //
      // 路由口径和 HTTP 那边保持一致：**我们自己的地盘（`/mini/...`）不转**，
      // 开关关着就一个都不接（不给一个绕过开关的通道）。
      // 路由口径和 HTTP 那边一致，但有一处不能照抄：官方那条连接是按页面的 base 解析出来的，
      // 而 base 是 `/mini/mirror/`（外壳写着 base href="./"），所以它实际请求的是
      // `/mini/mirror/api/remote.mux`——挂在镜像前缀**下面**。照 HTTP 那样「凡是 /mini/ 都拒掉」
      // 会把它一起拒掉，界面就永远在重连。（第一版就是这么写的，靠测试改成真实路径形态才发现。）
      const MIRROR_PREFIX = '/mini/mirror'
      server.on('upgrade', (req, socket, head) => {
        // 和 HTTP 那边同一条口径：开关开着**或者**这次是持窗口会话来的（桌面端「远程窗口」）。
        // 漏掉后面那一半的话，镜像里的界面会一直「正在重新连接」——
        // 官方那条常驻连接就是 WebSocket（`/api/remote.mux`），握手被拒就全盘不对。
        const sessionOpen = Boolean(windowSession(req))
        if (!mirror || typeof mirror.upgrade !== 'function'
          || typeof mirrorEnabled !== 'function'
          || (!mirrorEnabled() && !sessionOpen)) {
          socket.destroy()
          return
        }
        const upPath = String(req.url ?? '/').split('?')[0]
        const under = upPath === MIRROR_PREFIX || upPath.startsWith(`${MIRROR_PREFIX}/`)
        const ours = !under
          && (upPath === '/mini' || upPath === '/mini/' || upPath.startsWith('/mini/'))
        if (ours) {
          socket.destroy()
          return
        }
        // 这条长连接是哪台设备的——撤销时要跟着断（见 dropDeviceConnections）。
        // 镜像这条 WS**本身不查我们的凭据**（它靠上游那套认人），所以这里只做"记得住"：
        // 撤销一台设备时，它手上那个已经握手的框不会因为 HTTP 401 而消失，得点名断。
        //
        // **两种身份都要记**（2026-10-16 第四步）：手机页那条框带的是设备 cookie（第一路）；
        // 桌面端「远程窗口」那个框带的是**窗口会话**——会话里签着它是哪台设备的
        // （第二路，见 windowDeviceId）。少了第二路，跨机那扇窗在撤销之后就漏了一条活连接。
        const wsOwner = deviceIdOf(presentCredentials(req, new URL(req.url ?? '/', 'http://x')))
          ?? windowDeviceId(req)
        if (wsOwner) {
          deviceSockets.set(socket, wsOwner)
          socket.on('close', () => deviceSockets.delete(socket))
        }
        // 挂在挂载点下面的剥掉前缀，绝对路径（`/api/...`）原样转——和 HTTP 那边一致。
        // `diag=1` 同样要摘掉（和 HTTP 那边同一个道理：上游不认它）。
        req.url = stripDiagFlag(under
          ? stripOurSecrets(req.url.slice(MIRROR_PREFIX.length) || '/')
          : stripOurSecrets(req.url))
        mirror.upgrade(req, socket, head)
      })
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, address, resolve)
        })
        port = server.address().port
        listeners.push({ address, server })
      } catch (err) {
        failed.push({ address, message: err?.message ?? String(err) })
        server.close()
      }
    }
    return { listeners, failed, port }
  }

  // 端口被占就往后挪一个再试。
  //
  // 一个非技术用户撞上「3090 被别的程序占了」时，自己是没有办法的：设置界面里
  // 没有改端口的地方，日志他也不会去看，而端口号对他毫无意义。所以这里自己让开，
  // 别让他去配。只往后试 PORT_TRIES 个——万一整个端口段都被占，不能在这儿转圈。
  let listeners = []
  let failed = []
  let port = config.port
  for (let i = 0; i < PORT_TRIES; i += 1) {
    const attempt = await bindOn(config.port + i)
    listeners = attempt.listeners
    failed = attempt.failed
    port = attempt.port
    if (listeners.length) {
      if (i > 0) log?.info?.(`端口 ${config.port} 被占用，改用 ${port}。`)
      break
    }
  }

  if (!listeners.length) {
    // 分清两种成因：端口被占（用户改个端口就行）和地址都不可用（网络的事）。
    // 这两件事的下一步动作完全不同，合成一句等于什么都没说。
    const busy = failed.length > 0 && failed.every((f) => /EADDRINUSE/.test(f.message))
    throw new Error(busy
      ? `端口 ${config.port} 往后连续 ${PORT_TRIES} 个都被占用了。`
      : `没有任何地址能监听：${failed.map((f) => `${f.address}（${f.message}）`).join('、')}`)
  }

  return {
    port,
    /** 真正绑定成功的地址。 */
    addresses: listeners.map((l) => l.address),
    /** 想绑但失败的地址，交给调用方决定怎么提示。 */
    failed,
    broadcast,
    /**
     * 掐掉某台设备手上的活连接（SSE 流 + 镜像那个框的 WebSocket）。**撤销设备时调它**
     * ——只靠"下一次请求被拒"，用户会以为撤销没生效（见 dropDeviceConnections）。
     * @param {string} deviceId
     * @returns {number} 真的掐掉了几条
     */
    dropDeviceConnections,
    /**
     * 试错限速那一套（`attempts` 那张表本身，**只有这一份**）。
     *
     * 为什么要交出去：「配对」那条路由（lib/index.js 的 `/mini-remote/pair`）是**唯一一条
     * 允许外面调的 `/mini-remote/*`**——它拿口令换设备凭据，也就是一条猜口令的路，必须挂闸。
     * 而"同一来源一分钟错 5 次就挡一分钟"这套闸门本来就长在这里，**不另写第二份**：
     * 同一个来源在手机页上猜错、在配对接口上猜错，记的是同一个桶——换个入口不该重新拿到
     * 5 次机会。（分桶见 clientKey：走隧道按真实客户端地址，其余按源地址。）
     */
    rateLimit: { isBlocked, noteFailure, noteSuccess },
    /**
     * 认一枚**设备凭据**：对得上就回那台设备的 id，否则 `null`。
     *
     * 为什么交出去：「跨机取票」那条路由（lib/index.js 的
     * `/mini-remote/remote/window`）跑在宿主那一半、不在这个服务器里，而它要认的正是
     * 设备凭据（不是令牌）。**不另写一套**：三种带法（`?device=` / cookie /
     * `X-Mini-Device` 头）、定长比对（`devices.verify` 里的 `timingSafeEqual`）、
     * 「撤销之后当场失效」（每次都现查名册）全都在这一份实现里——第二处复制一遍，
     * 迟早一处改了一处没改，而那种不一致的表现是"撤销了还进得来"。
     *
     * **只认不记**（和 `devices.verify` 同一条口径）：不回写 `lastSeen`，也不动
     * `hasPhone` 那个时间戳。这是有意的——后者是"手机还在不在"的信号，一台电脑来换票
     * 并不代表手机在看；记错了会让提问被推给一台根本没开着的手机。
     */
    verifyDevice: (req, url) => deviceIdOf(presentCredentials(req, url)),
    /** 执行轨迹的增量帧：只发给声明了「完整」模式的那几条连接（见 broadcastTrajectory）。 */
    broadcastTrajectory,
    /** 轨迹的活片段帧：同一批连接，不占 seq/epoch（见 broadcastTrajectoryLive）。 */
    broadcastTrajectoryLive,
    invalidateNavigation,
    invalidateSubagents,
    close: async () => {
      for (const res of clients) {
        try { res.end() } catch { /* 已经断了 */ }
      }
      clients.clear()
      await Promise.all(listeners.map(({ server }) => new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })))
    },
    // 给插件主体用：把提问推给手机、以及「手机还在不在」。
    // 两个都挂在返回对象上，是因为提问是插件主体接到的，而「连着的手机」在这边。
    askPhone,
    hasPhone,
  }
}
