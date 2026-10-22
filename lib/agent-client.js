/**
 * B 端执行端的客户端。
 *
 * 它是**出站**的：B 主动连 A，A 不用连 B；所以 B 不用开端口，也不用管家里路由器。
 * 一轮就是「长轮询拿任务 → 在本地执行 → POST 结果」，没有常驻双向连接要维护。
 *
 * 这一版只做只读（list / read）。写和命令在下一步接，权限开关已经在配置里留好了
 * 位置，但没给它们实现任何执行路径——**没有入口比有一个忘了关的入口安全**。
 *
 * 路径规矩（最重要的一条）：
 *   · 只允许 `roots` 里的目录；
 *   · 先 resolve，再 realpath；符号链接指到外面也拒绝；
 *   · 新文件的 realpath 取父目录，避免“父目录是链接”这一手。
 * 这几条不是为了防住有恶意的 A——A 本来就是用户自己的电脑——而是防住**误操作**：
 * 一条 `../../` 或一个指向 C:\ 的链接，不该因为手滑就写到授权目录外面。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const MAX_FILE_BYTES = 256 * 1024
const MAX_LIST = 500
const ONLINE_POLL_MS = 25 * 1000
const BACKOFF_MIN_MS = 800
const BACKOFF_MAX_MS = 10 * 1000

export function normalizeRoots(roots) {
  const out = []
  for (const raw of Array.isArray(roots) ? roots : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const abs = resolve(raw)
    if (!existsSync(abs)) throw new Error(`授权的文件夹不存在：${abs}`)
    if (!statSync(abs).isDirectory()) throw new Error(`授权的路径不是文件夹：${abs}`)
    const real = realpathSync(abs)
    if (!out.includes(real)) out.push(real)
  }
  if (!out.length) throw new Error('还没有授权任何文件夹')
  return out
}

/**
 * 把 A 传来的路径落到 B 的授权目录里。
 * 相对路径按第一个授权根展开；绝对路径必须在某个根里。
 */
export function resolveInside(roots, requested) {
  const list = Array.isArray(roots) ? roots : []
  const raw = typeof requested === 'string' && requested ? requested : '.'
  const target = isAbsolute(raw) ? resolve(raw) : resolve(list[0] || '.', raw)
  for (const root of list) {
    const rel = relative(root, target)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      const real = existsSync(target)
        ? realpathSync(target)
        : join(realpathSync(dirname(target)), basename(target))
      const realRel = relative(root, real)
      if (realRel === '' || (!realRel.startsWith('..') && !isAbsolute(realRel))) return real
    }
  }
  throw new Error('路径不在 B 端授权的文件夹里')
}

function listDir(roots, requested) {
  const dir = resolveInside(roots, requested)
  const stat = statSync(dir)
  if (!stat.isDirectory()) throw new Error('这不是文件夹')
  const entries = []
  for (const name of readdirSync(dir)) {
    if (entries.length >= MAX_LIST) break
    const full = join(dir, name)
    let info
    try {
      info = lstatSync(full)
    } catch {
      continue
    }
    entries.push({
      name,
      type: info.isDirectory() ? 'dir' : info.isSymbolicLink() ? 'link' : 'file',
      size: info.isFile() ? info.size : null,
      mtime: info.mtimeMs,
    })
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  return { path: dir, entries, truncated: entries.length >= MAX_LIST }
}

function readFile(roots, requested, offset, limit) {
  const file = resolveInside(roots, requested)
  const stat = statSync(file)
  if (!stat.isFile()) throw new Error('这不是文件')
  if (stat.size > MAX_FILE_BYTES) throw new Error(`文件太大（${stat.size} 字节），超过 ${MAX_FILE_BYTES} 上限`)
  const start = Math.max(1, Number(offset) || 1)
  const count = Math.max(1, Math.min(2000, Number(limit) || 400))
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const slice = lines.slice(start - 1, start - 1 + count)
  return {
    path: file,
    content: slice.join('\n'),
    offset: start,
    totalLines: lines.length,
    truncated: start - 1 + count < lines.length,
  }
}

function readBodyConfig(file) {
  if (!file) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function saveAgentConfig(file, value) {
  if (!file) return
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * @param {object} opts
 * @param {string} opts.url A 端地址（不带尾斜杠）
 * @param {string} opts.token 配对换来的长期凭据
 * @param {string[]} opts.roots B 端本地授权的文件夹
 * @param {boolean} [opts.allowWrite] 预留；这一版不实现写
 * @param {boolean} [opts.allowShell] 预留；这一版不实现命令
 * @param {Function} [opts.fetchImpl] 测试注入
 */
export function createAgentClient({
  url, token, roots, allowWrite = false, allowShell = false,
  fetchImpl = globalThis.fetch, log = console,
} = {}) {
  const base = String(url || '').replace(/\/+$/, '')
  if (!base) throw new Error('缺少 A 端地址')
  if (!token) throw new Error('缺少配对凭据')
  const realRoots = normalizeRoots(roots)
  let stopped = false

  async function api(path, { method = 'GET', body, signal } = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    if (res.status === 204) return null
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
    return data
  }

  function execute(task) {
    const op = task && task.op
    const args = (task && task.args) || {}
    if (op === 'list') return listDir(realRoots, args.path)
    if (op === 'read') return readFile(realRoots, args.path, args.offset, args.limit)
    throw new Error(`B 端还不支持这个操作：${op}`)
  }

  async function run({ signal } = {}) {
    let backoff = BACKOFF_MIN_MS
    while (!stopped && !(signal && signal.aborted)) {
      try {
        const data = await api(`/mini-remote/agent/poll?wait=${ONLINE_POLL_MS}`, { signal })
        backoff = BACKOFF_MIN_MS
        if (!data || !data.task) continue
        const task = data.task
        let payload
        try {
          payload = { taskId: task.id, ok: true, output: execute(task) }
        } catch (err) {
          payload = { taskId: task.id, ok: false, error: err && err.message ? err.message : String(err) }
        }
        await api('/mini-remote/agent/result', { method: 'POST', body: payload, signal })
      } catch (err) {
        if (signal && signal.aborted) break
        log.warn?.(`B 端代理连接 A 失败：${err && err.message ? err.message : err}`)
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(BACKOFF_MAX_MS, backoff * 2)
      }
    }
  }

  function stop() { stopped = true }

  return {
    url: base,
    roots: realRoots,
    allowWrite: allowWrite === true,
    allowShell: allowShell === true,
    execute,
    run,
    stop,
    api,
  }
}

/** 配对：拿 A 端的一次性码换长期凭据。 */
export async function pairAgent({ url, code, name, platform, roots, allowWrite = false, allowShell = false, fetchImpl = globalThis.fetch } = {}) {
  const base = String(url || '').replace(/\/+$/, '')
  if (!base) throw new Error('缺少 A 端地址')
  const res = await fetchImpl(`${base}/mini-remote/agent/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      name,
      platform,
      roots: Array.isArray(roots) ? roots : [],
      allowWrite: allowWrite === true,
      allowShell: allowShell === true,
    }),
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || `HTTP ${res.status}`)
  return { agentId: data.agentId, token: data.token, url: base }
}

/** 命令行入口用：读一份配置。 */
export function loadAgentConfig(file) {
  return readBodyConfig(file)
}
