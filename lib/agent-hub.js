/**
 * B 端执行代理的 A 端账本。
 *
 * 这一块只做四件事：发配对码、认 agent、发任务、收结果。它**不碰 B 的文件**，
 * 也不决定 B 的权限——根目录和读写/命令权限由 B 端本地授予，这里只把 B 报上来的
 * 那份摘要记下来给设置页看。
 *
 * 传输用 HTTP 长轮询，不走 WebSocket：
 *   · A 端的 mini server 已经有完整的 HTTP 路由，长轮询不用再引入一条升级通道；
 *   · B 端是**出站**连接，不用在 B 上开端口、不用管 NAT；
 *   · 一次任务一个请求，日志和排错都比一条常驻双向连接直白。
 *
 * 安全边界（必须守住）：
 *   · 配对码一次性、十分钟过期；换来的 token 只存哈希；
 *   · `enabled()` 为假时，配对/轮询/结果三条路一条都不接；
 *   · 每个任务只认发起它的 agent，结果带 taskId，别的 agent 回不进来；
 *   · 任务有超时，撤销 agent 时把在途任务全部拒掉。
 *
 * 落盘只存长期名册（`agents.json`），不存队列和在途任务——那些是进程内的东西，
 * A 重启后应该由 B 重新连、重新发起，而不是从半截状态里“恢复”。
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 配对码有效期：十分钟。够 B 端慢慢输，又不至于长期挂着一个可猜的六位数。 */
const PAIR_TTL_MS = 10 * 60 * 1000
/** 长轮询单次最多等 25 秒：比常见的 30 秒代理超时短一截，留出回包余量。 */
const MAX_WAIT_MS = 25 * 1000
/** 默认任务超时：30 秒。文件读写够用；以后命令可以按任务单独放宽。 */
const DEFAULT_TASK_MS = 30 * 1000
/** 超过这么久没来轮询，就当离线。留三个长轮询周期，网络抖一下不至于误判。 */
const ONLINE_MS = 90 * 1000

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function sixDigits() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

function isLocalAddress(addr) {
  const s = String(addr || '')
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1'
}

function publicAgent(a, now) {
  return {
    id: a.id,
    name: a.name,
    platform: a.platform,
    roots: a.roots,
    createdAt: a.createdAt,
    lastSeen: a.lastSeen,
    online: isOnline(a, now),
  }
}

function isOnline(a, now) {
  return a.lastSeen > 0 && now - a.lastSeen < ONLINE_MS
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const text = await readBody(req)
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('invalid json')
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 建一份 agent 账本。
 *
 * @param {object} [opts]
 * @param {string|null} [opts.file] 长期名册落盘位置；null = 只存内存（测试用）
 * @param {() => boolean} [opts.enabled] 总开关；假时配对/轮询/结果全不接
 * @param {{info?:Function,warn?:Function}} [opts.log]
 * @param {() => number} [opts.now] 测试用时钟
 */
export function createAgentHub({ file = null, enabled = () => true, log = console, now = Date.now } = {}) {
  /** @type {Map<string, any>} */
  const agents = new Map()
  let pairCode = null
  /** 配对码尝试次数：每个来源一分钟最多 10 次。 */
  const pairAttempts = new Map()

  function pairRateLimited(ip) {
    const key = String(ip || 'unknown')
    const t = now()
    let row = pairAttempts.get(key)
    if (!row || t >= row.resetAt) {
      row = { count: 0, resetAt: t + 60 * 1000 }
      pairAttempts.set(key, row)
      if (pairAttempts.size > 500) {
        for (const [k, v] of pairAttempts) if (v.resetAt <= t) pairAttempts.delete(k)
      }
    }
    row.count += 1
    return row.count > 10
  }

  function save() {
    if (!file) return
    const rows = [...agents.values()].map((a) => ({
      id: a.id,
      name: a.name,
      platform: a.platform,
      roots: a.roots,
      tokenHash: a.tokenHash,
      createdAt: a.createdAt,
      lastSeen: a.lastSeen,
    }))
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      writeFileSync(tmp, `${JSON.stringify({ version: 1, agents: rows }, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, file)
    } catch (err) {
      log.warn?.(`B 端代理名册写不进去：${err && err.message ? err.message : err}`)
    }
  }

  function load() {
    if (!file) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      for (const row of Array.isArray(raw?.agents) ? raw.agents : []) {
        if (!row || typeof row.id !== 'string' || typeof row.tokenHash !== 'string') continue
        agents.set(row.id, {
          id: row.id,
          name: typeof row.name === 'string' ? row.name : '',
          platform: typeof row.platform === 'string' ? row.platform : '',
          roots: Array.isArray(row.roots) ? row.roots.filter((x) => typeof x === 'string') : [],
          tokenHash: row.tokenHash,
          createdAt: Number(row.createdAt) || 0,
          lastSeen: Number(row.lastSeen) || 0,
          online: false,
          queue: [],
          waiters: [],
          pending: new Map(),
        })
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') log.warn?.(`B 端代理名册读不出来：${err.message || err}`)
    }
  }

  load()

  function issuePairCode() {
    if (!enabled()) return { ok: false, error: 'B 端执行总开关关着' }
    const code = sixDigits()
    pairCode = { code, expiresAt: now() + PAIR_TTL_MS }
    return { ok: true, code, expiresAt: pairCode.expiresAt }
  }

  function pair({ code, name, platform, roots } = {}) {
    if (!enabled()) return { ok: false, error: 'B 端执行总开关关着' }
    if (!pairCode || pairCode.expiresAt <= now()) {
      pairCode = null
      return { ok: false, error: '配对码已过期，请让 A 端重新生成' }
    }
    if (String(code || '') !== pairCode.code) return { ok: false, error: '配对码不对' }
    pairCode = null
    const id = randomUUID()
    const token = randomBytes(32).toString('hex')
    const agent = {
      id,
      name: typeof name === 'string' && name ? name.slice(0, 80) : 'B 端电脑',
      platform: typeof platform === 'string' ? platform.slice(0, 80) : '',
      roots: Array.isArray(roots) ? roots.filter((x) => typeof x === 'string').slice(0, 20) : [],
      tokenHash: sha256(token),
      createdAt: now(),
      lastSeen: 0,
      online: false,
      queue: [],
      waiters: [],
      pending: new Map(),
    }
    agents.set(id, agent)
    save()
    log.info?.(`B 端执行代理已配对：${agent.name}`)
    return { ok: true, agentId: id, token }
  }

  function authenticate(token) {
    if (!token) return null
    const hash = sha256(token)
    for (const a of agents.values()) if (a.tokenHash === hash) return a
    return null
  }

  function list() {
    return [...agents.values()].map((a) => publicAgent(a, now()))
  }

  function revoke(id) {
    const a = agents.get(id)
    if (!a) return { ok: false, error: '没有这台 B 端电脑' }
    for (const waiter of a.waiters) waiter.resolve(null)
    a.waiters.length = 0
    for (const [, pending] of a.pending) pending.reject(new Error('B 端代理已撤销'))
    a.pending.clear()
    agents.delete(id)
    save()
    log.info?.(`B 端执行代理已撤销：${a.name}`)
    return { ok: true }
  }

  function onlineAgent(id) {
    const a = agents.get(id)
    if (!a) throw new Error('没有这台 B 端电脑')
    if (!isOnline(a, now())) throw new Error('这台 B 端电脑当前不在线')
    return a
  }

  function pickAgent(agentId) {
    if (agentId) return onlineAgent(agentId)
    const online = [...agents.values()].filter((a) => isOnline(a, now()))
    if (online.length === 1) return online[0]
    if (online.length === 0) throw new Error('没有在线的 B 端电脑')
    throw new Error('有多台 B 端电脑在线，请用 agent 参数指定一台')
  }

  /**
   * 给 B 发一个任务，等结果。
   *
   * 任务进的是**这台 agent 自己的队列**；结果必须带同一个 taskId 回来，
   * 这样两台 B 同时在线也不会串。
   */
  function call(op, args, { agentId, timeoutMs = DEFAULT_TASK_MS, signal } = {}) {
    const agent = pickAgent(agentId)
    const id = randomUUID()
    const task = { id, op, args: args ?? {} }
    return new Promise((resolve, reject) => {
      let timer = null
      const done = (fn, value) => {
        if (!agent.pending.has(id)) return
        agent.pending.delete(id)
        if (timer) clearTimeout(timer)
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort)
        }
        fn(value)
      }
      const onAbort = () => done(reject, new Error('任务已取消'))
      if (signal) {
        if (signal.aborted) return reject(new Error('任务已取消'))
        signal.addEventListener('abort', onAbort, { once: true })
      }
      timer = setTimeout(() => done(reject, new Error('B 端代理超时未回')), timeoutMs)
      agent.pending.set(id, { resolve: (v) => done(resolve, v), reject: (e) => done(reject, e) })
      agent.queue.push(task)
      if (agent.waiters.length) {
        const waiter = agent.waiters.shift()
        if (waiter.timer) clearTimeout(waiter.timer)
        waiter.resolve(agent.queue.shift() || null)
      }
    })
  }

  function poll(agent, waitMs = MAX_WAIT_MS) {
    agent.online = true
    agent.lastSeen = now()
    if (agent.queue.length) return Promise.resolve(agent.queue.shift())
    const ms = Math.max(0, Math.min(MAX_WAIT_MS, Number(waitMs) || 0))
    if (ms === 0) return Promise.resolve(null)
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null }
      waiter.timer = setTimeout(() => {
        const index = agent.waiters.indexOf(waiter)
        if (index >= 0) agent.waiters.splice(index, 1)
        resolve(null)
      }, ms)
      agent.waiters.push(waiter)
    })
  }

  function result(agent, taskId, value) {
    const pending = agent.pending.get(taskId)
    if (!pending) return false
    if (value && value.ok) pending.resolve(value.output)
    else pending.reject(new Error((value && value.error) || 'B 端执行失败'))
    return true
  }

  async function handle(req, res, path) {
    const sub = path.slice('/mini-remote/agent/'.length)
    const method = String(req.method || 'GET').toUpperCase()
    try {
      if (sub === 'pair-code' && method === 'POST') {
        if (!isLocalAddress(req.socket?.remoteAddress)) return sendJson(res, 403, { ok: false, error: '只允许本机生成配对码' })
        const out = issuePairCode()
        return sendJson(res, out.ok ? 200 : 403, out)
      }
      if (sub === 'pair' && method === 'POST') {
        if (pairRateLimited(req.socket?.remoteAddress)) {
          return sendJson(res, 429, { ok: false, error: '配对尝试太频繁，等一分钟再试。' })
        }
        const body = await readJson(req)
        const out = pair(body)
        return sendJson(res, out.ok ? 200 : 403, out)
      }
      if (sub === 'list' && method === 'GET') {
        if (!isLocalAddress(req.socket?.remoteAddress)) return sendJson(res, 403, { ok: false, error: '只允许本机查看' })
        return sendJson(res, 200, { ok: true, agents: list() })
      }
      if (sub === 'revoke' && method === 'POST') {
        if (!isLocalAddress(req.socket?.remoteAddress)) return sendJson(res, 403, { ok: false, error: '只允许本机撤销' })
        const body = await readJson(req)
        const out = revoke(String(body.id || ''))
        return sendJson(res, out.ok ? 200 : 404, out)
      }
      if (sub === 'poll' && method === 'GET') {
        if (!enabled()) return sendJson(res, 403, { ok: false, error: 'B 端执行总开关关着' })
        const agent = authenticate(bearer(req))
        if (!agent) return sendJson(res, 401, { ok: false, error: 'B 端凭据无效' })
        const url = new URL(req.url || '/', 'http://localhost')
        const task = await poll(agent, url.searchParams.get('wait'))
        if (!task) {
          res.writeHead(204, { 'cache-control': 'no-store' })
          res.end()
          return
        }
        return sendJson(res, 200, { ok: true, task })
      }
      if (sub === 'result' && method === 'POST') {
        if (!enabled()) return sendJson(res, 403, { ok: false, error: 'B 端执行总开关关着' })
        const agent = authenticate(bearer(req))
        if (!agent) return sendJson(res, 401, { ok: false, error: 'B 端凭据无效' })
        const body = await readJson(req)
        const ok = result(agent, String(body.taskId || ''), body)
        return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: '没有这个任务' })
      }
      return sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err && err.message ? err.message : String(err) })
    }
  }

  function bearer(req) {
    const raw = String(req.headers?.authorization || '')
    const match = /^Bearer\s+(.+)$/i.exec(raw)
    return match ? match[1].trim() : ''
  }

  return {
    issuePairCode,
    pair,
    authenticate,
    list,
    revoke,
    onlineAgent,
    pickAgent,
    call,
    poll,
    result,
    handle,
    get size() { return agents.size },
  }
}
