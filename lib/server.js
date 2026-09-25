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
import { timingSafeEqual } from 'node:crypto'
import { renderPage, readArt, readSw } from './page.js'

const COOKIE = 'dsh_mini_token'

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

/** 定长比较，避免 token 被逐字节试探。 */
function tokenEquals(a, b) {
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
 * @param {object} opts
 * @param {import('./store.js').createStore extends (...a:any)=>infer R ? R : never} opts.store
 * @param {{port:number, defaultMode:string}} opts.config
 * @param {string[]} opts.bindAddresses 要监听的地址；第一个应是 127.0.0.1
 * @param {string} opts.token
 * @param {() => string | null} [opts.tunnelHost] 当前公网域名（没开隧道时返回 null），只用于限速分桶
 * @param {(text:string)=>Promise<{ok:boolean, error?:string, sessionId?:string}>} opts.onInstruction
 * @param {()=>Promise<{ok:boolean, error?:string, sessionId?:string}>|{ok:boolean, error?:string, sessionId?:string}} opts.onStop
 * @param {(id:string)=>{ok:boolean, error?:string, sessionId?:string}} opts.onUnqueue
 * @returns {Promise<{port:number, addresses:string[], failed:{address:string,message:string}[], close:()=>Promise<void>, broadcast:(event:string, data:unknown)=>void}>}
 */
export async function createMiniServer({ store, config, token, bindAddresses, tunnelHost, onInstruction, onStop, onUnqueue, onUpload, log, tree, browse, build }) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set()

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
  }

  // 目录浏览的空壳。它**只依赖 node:fs**，不像 tree 那样依赖 DSH 的服务，
  // 所以正常情况下永远用真的那个；这个空壳是给测试用的（测试不该真去读盘）。
  const files = browse ?? {
    listRoots: async () => ({ home: '', drives: [], recent: [] }),
    listDirectory: async () => ({ ok: false, reason: 'unavailable' }),
    makeDirectory: async () => ({ ok: false, reason: 'unavailable' }),
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

  function isAuthorized(req, url) {
    const fromQuery = url.searchParams.get('token')
    const fromCookie = parseCookies(req.headers.cookie)[COOKIE]
    const fromHeader = req.headers['x-mini-token']
    return tokenEquals(fromQuery, token)
      || tokenEquals(fromCookie, token)
      || tokenEquals(fromHeader, token)
  }

  /** 这次请求到底有没有带凭据。没带只是没登录，不算试错。 */
  function hasCredential(req, url) {
    return Boolean(
      url.searchParams.get('token')
      || parseCookies(req.headers.cookie)[COOKIE]
      || req.headers['x-mini-token'],
    )
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

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    // 试错太多的来源一律挡住，页面和接口都一样——否则可以拿页面接口
    // 当测密码的探针。
    if (isBlocked(req)) {
      sendJson(res, 429, { error: '密码错误次数太多，等一分钟再试。' })
      return
    }

    // ---- 页面本身 -------------------------------------------------------
    // 允许用 ?token=xxx 直接进（二维码扫的就是这个地址），
    // 校验通过后写 cookie，后续请求就不必再带参数。
    if (req.method === 'GET' && (path === '/' || path === '/mini' || path === '/mini/')) {
      const provided = url.searchParams.get('token')
      if (provided && tokenEquals(provided, token)) {
        noteSuccess(req)
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Set-Cookie': `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; SameSite=Lax`,
        })
        res.end(renderPage({ defaultMode: config.defaultMode, build, maxUpload: MAX_UPLOAD }))
        return
      }
      if (isAuthorized(req, url)) {
        noteSuccess(req)
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(renderPage({ defaultMode: config.defaultMode, build, maxUpload: MAX_UPLOAD }))
        return
      }
      // 带了密码但不对，记一次失败；压根没带不算——那只是打开页面而已
      if (hasCredential(req, url)) noteFailure(req)
      // 没带 token：给一个只用于输入 token 的极简页面。
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(renderPage({ defaultMode: config.defaultMode, needsToken: true, build, maxUpload: MAX_UPLOAD }))
      return
    }

    // ---- 立绘 -----------------------------------------------------------
    // 静态资源，但同样要鉴权：它只服务于这个页面，没必要对没登录的人开放。
    // 页面给 <img> 拼的是 /mini/art/x.webp?token=...&v=<指纹>，所以走 query 就够，
    // 不依赖 cookie（从门禁页手输 token 进来时是没有 cookie 的）。
    if (req.method === 'GET' && path.startsWith('/mini/art/')) {
      if (!isAuthorized(req, url)) {
        if (hasCredential(req, url)) noteFailure(req)
        sendJson(res, 401, { error: '未授权：token 不正确' })
        return
      }
      noteSuccess(req)
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

    // ---- 其余一律要鉴权 -------------------------------------------------
    if (!path.startsWith('/mini/api/')) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (!isAuthorized(req, url)) {
      // 只有「带了密码但不对」才算试错；压根没带只是没登录。
      if (hasCredential(req, url)) noteFailure(req)
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

      const cleanup = () => {
        clearInterval(beat)
        clients.delete(res)
      }
      req.on('close', cleanup)
      res.on('close', cleanup)
      return
    }

    if (req.method === 'GET' && path === '/mini/api/state') {
      sendJson(res, 200, store.snapshot())
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
      sendJson(res, 200, { ok: true, build: build ?? 'unknown', canCreateSession })
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

    // 左侧导航栏：先列工作区（便宜），展开某个再取它的会话（要读日志折标题，贵）。
    // `refresh=1` 是导航栏那个 ⟳ 按钮用的：绕过服务端缓存，真去读一遍。
    if (req.method === 'GET' && path === '/mini/api/workspaces') {
      const runningIds = new Set(
        (store.snapshot().sessions ?? []).filter((s) => s.running).map((s) => s.id),
      )
      // includeEmpty：手机能自己新建工作区了，刚建好的那个本来就是空的。
      // 不列出来的话，建完它当场消失，用户只会以为没建成。
      const workspaces = await nav.listWorkspaces(
        runningIds, url.searchParams.get('refresh') === '1', true,
      )
      sendJson(res, 200, { ok: true, workspaces })
      return
    }

    const wsSessions = /^\/mini\/api\/workspaces\/([^/]+)\/sessions$/.exec(path)
    if (req.method === 'GET' && wsSessions) {
      const asked = Number(url.searchParams.get('limit'))
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 100) : undefined
      const result = await nav.listSessionsOf(
        decodeURIComponent(wsSessions[1]),
        limit,
        url.searchParams.get('refresh') === '1',
      )
      if (!result) {
        sendJson(res, 404, { ok: false, error: '没有这个工作区。' })
        return
      }
      sendJson(res, 200, { ok: true, ...result })
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
      const current = store.snapshot().sessions?.find((s) => s.id === boundSessionId) ?? null
      sendJson(res, 200, {
        ok: true,
        boundSessionId,
        // 「现在用哪个」取会话上记着的那份（来自 request/header 事件，是真值不是猜的）
        current: current
          ? { provider: current.provider ?? null, model: current.model ?? null, reasoningEffort: current.reasoningEffort ?? null }
          : null,
        ...result.catalog,
      })
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

      if (path === '/mini/api/stop') {
        // 停的是「手机正在遥控的那个会话」，和 send 同一套口径——
        // 手机上按的停止，不该停掉你在电脑上另开的那个任务。
        const result = await onStop()
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

      // 在一个已有的工作区里新建会话，建完立刻把手机绑过去。
      //
      // 为什么排在这么靠后、而不是跟上面那条 GET 挨着：这两条都要读请求体，
      // 而 `readBody` 在后面才调（上面那条 GET 不用读，所以能排在前面）。
      // 同一个路径上 GET 是「列出来」、POST 是「建一个」——同一条资源的两种动作。
      //
      // 建完顺手 bind + 广播：手机发一次请求就完成了「建 + 切过去」，
      // 不用再补一次 bind，也就不会出现「建好了但没切过去」这种半截状态。
      if (req.method === 'POST' && wsSessions) {
        const created = await nav.createSession(decodeURIComponent(wsSessions[1]))
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
        const workspaces = await nav.listWorkspaces(new Set(), true, true)
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
  }
}
