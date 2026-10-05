/**
 * 「进阶设置」：把电脑端界面（DSH Web GUI）经我们自己的端口转出去。
 *
 * ## 为什么要有这个东西
 *
 * 手机上那张遥控页是**专门为手机做的**，所以电脑上那些插件贡献的设置页它进不去。
 * 这个模块给你一条退路：**要改那些设置时，直接把电脑端的界面整个搬过来看**——
 * 不迁移任何页面，不逐个适配，**同一份界面**。
 *
 * ## 为什么必须经我们代理，不能直接连
 *
 * 实测：电脑端界面监听在 `127.0.0.1:19387`，**只绑回环**——手机根本够不着。
 * 而我们的端口本来就绑了局域网和 Tailscale，**手机够得着**。所以由我们中转。
 *
 * ## 认证：走正门，不绕过
 *
 * 那个界面要一个**按「权威域名」绑定、用本进程密钥签名**的 cookie（实测裸连回 401）。
 * 密钥是私有的，谁也拿不到——**我们也不去拿**。
 *
 * 走的是官方留的正门：宿主的 connection 服务有公开方法
 * `authenticatedUrl(baseUrl)`——「把本次启动的令牌加到应用地址上」。拿到的地址形如
 * `http://127.0.0.1:19387/?token=<令牌>`；**请求它一次，服务器就回 303 并铸出那个 cookie**
 * （官方 BrowserAuth.authorizeIndex 的原文：「A valid root query token mints the cookie
 * and redirects」）。
 *
 * 所以这个模块做的是：**服务端自己去走一次官方认证，把 cookie 收在自己手里**，
 * 之后每个转发请求替手机带上它。**手机全程碰不到任何官方凭据。**
 *
 * ## 两个必须钉死的细节
 *
 * ① **Host 头固定成目标自己的地址。** 官方那个 cookie 是**按 Host 签的**
 *    （requestAuthority 只看 `host` 头）：`payload.authority === 请求的 Host`。
 *    所以转发时必须让目标看到的 Host 和铸 cookie 时那一份**完全一致**，
 *    否则每个请求都 401。这里固定成上游自己的 `host:port`。
 * ② **不缓冲响应。** 那个界面的实时更新走 SSE（客户端用 EventSource、服务端发
 *    text/event-stream，实测不是 WebSocket）。一旦缓冲，界面就再也不刷新了。
 *    所以响应体一律 pipe，不攒。
 */
import { request as httpRequest } from 'node:http'

/** 这些头是「逐跳」的，不该被转发（RFC 7230 §6.1）。 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/**
 * 这些响应头会把「不许被嵌进框架」写死，我们要去掉——
 * 这个界面是要给手机看的（第一阶段开新标签，第二阶段可能就是内嵌）。
 * 去掉不等于放宽安全：能拿到这些响应的前提是**已经通过了我们自己的令牌**。
 */
const FRAME_BLOCKERS = new Set(['x-frame-options', 'content-security-policy'])

/**
 * 建一个镜像代理。
 *
 * @param {object} opts
 * @param {string | () => (string | null)} opts.upstream 上游地址（电脑端界面），
 *        如 `http://127.0.0.1:19387`。**可以传函数，而且推荐传函数**——宿主的 webServer
 *        服务就绪得晚，地址要到那一刻才知道（见 lib/index.js 里 mirrorUpstream 那段）。
 * @param {() => string | null} opts.tokenUrl 取「带官方令牌的地址」；拿不到返回 null。
 *        由插件注入（见 lib/index.js 里对 connection.authenticatedUrl 的调用）——
 *        这个模块**不认识宿主**，只认识一个返回字符串的函数，好测。
 * @param {(msg:string) => void} [opts.log]
 * @returns {{ handle, reset, available, stats }}
 */
export function createMirror({ upstream, tokenUrl, log }) {
  /** 上游地址**解析一次就记住**：它的 Host 要用来签 cookie，不能每次变。 */
  let target = null
  let targetHost = null

  function resolve() {
    if (target) return target
    const raw = typeof upstream === 'function' ? upstream() : upstream
    if (!raw) return null
    try {
      target = new URL(raw)
    } catch {
      return null
    }
    // 固定成上游自己的 host:port——官方 cookie 的「权威域名」按 Host 签，必须每次都一样。
    targetHost = target.host
    return target
  }

  /** 官方会话 cookie。**只存在服务端**，绝不转发给手机。 */
  let cookie = null
  /** 正在铸的那一次；并发请求共用，不重复铸。 */
  let minting = null
  let mints = 0
  let lastError = null

  function note(msg) {
    lastError = msg
    if (log) log(msg)
  }

  /**
   * 走一次官方认证，把 cookie 拿到手。
   *
   * 拿到的是 303 + `set-cookie: dsh-auth-<hash>=v1.<payload>.<sig>`，
   * 我们只要那个 cookie，不要它跳转的目的地（跳转是给浏览器看的）。
   */
  function mint() {
    if (minting) return minting
    minting = new Promise((resolvePromise, reject) => {
      const up = resolve()
      if (!up) {
        reject(new Error('这台电脑上找不到可用的电脑端界面地址。'))
        return
      }
      const url = tokenUrl ? tokenUrl() : null
      if (!url) {
        reject(new Error('这台电脑上的 DSH 没提供「带令牌的界面地址」的能力。'))
        return
      }
      let parsed
      try {
        parsed = new URL(url)
      } catch (err) {
        reject(new Error(`拿到的地址不是合法地址：${String(url).slice(0, 120)}`))
        return
      }
      const req = httpRequest({
        protocol: up.protocol,
        hostname: up.hostname,
        port: up.port,
        // 用带令牌的那条路径+查询去问（一般是 `/?token=xxx`）。
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        // ① 固定 Host：cookie 的权威域名靠它，铸和用必须是同一份。
        headers: { host: targetHost, accept: 'text/html' },
      }, (res) => {
        const setCookie = res.headers['set-cookie']
        const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : [])
        // 只要官方那枚会话 cookie；`dsh-auth-` 是官方 BrowserAuth 里的 COOKIE_PREFIX。
        const hit = list.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('dsh-auth-'))
        // 无论成没成都要把响应体读完，否则连接不释放。
        res.resume()
        res.on('end', () => {
          if (hit) resolvePromise(hit)
          else reject(new Error(`官方认证没有给出会话 cookie（状态 ${res.statusCode}）。`))
        })
      })
      req.on('error', (err) => reject(new Error(`连不上电脑端界面（${up.host}）：${err.message}`)))
      // 这一步是本机回环，不该拖太久。
      req.setTimeout(8000, () => req.destroy(new Error('官方认证超时')))
      req.end()
    }).then((value) => {
      cookie = value
      mints += 1
      lastError = null
      return value
    }).catch((err) => {
      note(err.message)
      throw err
    }).finally(() => {
      minting = null
    })
    return minting
  }

  async function ensureCookie() {
    if (cookie) return cookie
    return mint()
  }

  /** 把手机这一侧的请求头整理成给上游的。 */
  function upstreamHeaders(req) {
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase()
      if (HOP_BY_HOP.has(key)) continue
      // ② 我们自己那枚令牌的 cookie 不给上游；上游不认识它。
      if (key === 'cookie') continue
      if (key === 'host') continue
      headers[key] = v
    }
    headers.host = targetHost
    if (cookie) headers.cookie = cookie
    // 不让上游按压缩发——倒不是不能中转压缩流，而是这一层的目的是「看清楚」，
    // 明文方便排障；这个界面是本机到本机，压缩省下的那点不算什么。
    delete headers['accept-encoding']
    return headers
  }

  /** 一次转发。返回上游响应，交给调用方决定是一遍过还是重试。 */
  function forward(req, res, headers) {
    return new Promise((resolvePromise, reject) => {
      const up = resolve()
      if (!up) {
        reject(new Error('这台电脑上找不到可用的电脑端界面地址。'))
        return
      }
      const call = httpRequest({
        protocol: up.protocol,
        hostname: up.hostname,
        port: up.port,
        path: req.url,
        method: req.method,
        headers,
      }, (upRes) => resolvePromise(upRes))
      call.on('error', reject)
      // 上游是本机回环，但如果是一条 SSE 长连接，**不能设总超时**，只能设建连超时。
      call.setTimeout(15000, () => call.destroy(new Error('转发超时')))
      // 请求体直接管道过去（上传之类）；GET 没有体，pipe 也无害。
      req.pipe(call)
    })
  }

  function writeOut(upRes, res) {
    const headers = {}
    for (const [k, v] of Object.entries(upRes.headers)) {
      const key = k.toLowerCase()
      if (HOP_BY_HOP.has(key)) continue
      if (FRAME_BLOCKERS.has(key)) continue
      // 官方那枚会话 cookie **不转发给手机**：它只属于服务端这一侧。
      if (key === 'set-cookie') continue
      headers[key] = v
    }
    res.writeHead(upRes.statusCode ?? 502, headers)
    // ③ 不缓冲：直接管道，SSE 才流得动。
    upRes.pipe(res)
  }

  async function handle(req, res) {
    try {
      await ensureCookie()
    } catch (err) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`拿不到电脑端界面的访问凭据：${err.message}\n`)
      return
    }

    let upRes
    try {
      upRes = await forward(req, res, upstreamHeaders(req))
    } catch (err) {
      note(err.message)
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`转发到电脑端界面失败：${err.message}\n`)
      return
    }

    // 401 = 那枚 cookie 不认了（进程重启过、或者过期）。重铸一次再试一遍。
    // 只重试一次：再来一次还是 401，说明不是「cookie 陈旧」这么简单，
    // 该把真实原因露出来，而不是在这里转圈。
    if (upRes.statusCode === 401) {
      upRes.resume()
      cookie = null
      try {
        await ensureCookie()
        upRes = await forward(req, res, upstreamHeaders(req))
      } catch (err) {
        note(err.message)
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(`重新取凭据后仍然失败：${err.message}\n`)
        return
      }
    }

    writeOut(upRes, res)
  }

  return {
    handle,
    /**
     * 「现在能不能用」——上游地址解析得出来才算能用。
     *
     * 界面那一侧靠它决定要不要露出这一项：宿主的 webServer 就绪得晚，
     * 插件加载的那一刻往往还问不到地址，所以**不能只看「建没建出这个镜像」**。
     */
    available: () => Boolean(resolve()),
    /** 上游会话可能会失效（例如 DSH 重启），提供一个显式作废的入口给测试和上层用。 */
    reset: () => { cookie = null },
    stats: () => ({ mints, lastError }),
  }
}
