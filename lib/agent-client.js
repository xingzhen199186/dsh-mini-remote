/**
 * B 端执行端的客户端。
 *
 * 它是**出站**的：B 主动连 A，A 不用连 B；所以 B 不用开端口，也不用管家里路由器。
 * 一轮就是「长轮询拿任务 → 在本地执行 → POST 结果」，没有常驻双向连接要维护。
 *
 * 文件读、写、搜索、目录管理、一次性命令和持久终端都在这里；每一项都由 B 端本地
 * 的开关单独放行，路径一律限制在授权目录里。
 *
 * 路径规矩（最重要的一条）：
 *   · 只允许 `roots` 里的目录；
 *   · 先 resolve，再 realpath；符号链接指到外面也拒绝；
 *   · 新文件的 realpath 取父目录，避免“父目录是链接”这一手。
 * 这几条不是为了防住有恶意的 A——A 本来就是用户自己的电脑——而是防住**误操作**：
 * 一条 `../../` 或一个指向 C:\ 的链接，不该因为手滑就写到授权目录外面。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
function realTarget(target) {
  if (existsSync(target)) return realpathSync(target)
  // 新路径的父目录可能也不存在（例如 mkdir 的 a/b/c）：向上找到最近一个存在的
  // 祖先做 realpath，再把缺的几段接回去。缺失的段不可能是符号链接，接回去是安全的。
  let current = target
  const tail = []
  while (!existsSync(current)) {
    tail.unshift(basename(current))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return join(realpathSync(current), ...tail)
}

export function resolveInside(roots, requested) {
  const list = Array.isArray(roots) ? roots : []
  const raw = typeof requested === 'string' && requested ? requested : '.'
  const target = isAbsolute(raw) ? resolve(raw) : resolve(list[0] || '.', raw)
  for (const root of list) {
    const rel = relative(root, target)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      const real = realTarget(target)
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

function writeText(roots, requested, content, allowWrite) {
  if (!allowWrite) throw new Error('B 端还没有授予写文件权限')
  const file = resolveInside(roots, requested)
  try {
    if (statSync(file).isDirectory()) throw new Error('这是文件夹，不能当文件写')
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err
  }
  const text = typeof content === 'string' ? content : String(content ?? '')
  writeFileSync(file, text, 'utf8')
  return { path: file, bytes: Buffer.byteLength(text, 'utf8') }
}

/** 把一个 glob 模式转成只匹配相对路径的正则；支持 **、*、?。 */
export function globToRegExp(pattern) {
  const p = String(pattern || '*').replace(/\\/g, '/').replace(/^\.\//, '')
  let out = ''
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        i += 1
        if (p[i + 1] === '/') { i += 1; out += '(?:.*/)?' } else out += '.*'
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

function walkFiles(dir, relBase, visit, state) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    state.scanned += 1
    if (state.scanned > 20000) { state.truncated = true; return }
    const full = join(dir, entry.name)
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      visit(full, rel, 'dir')
      walkFiles(full, rel, visit, state)
    } else if (entry.isFile()) {
      visit(full, rel, 'file')
    }
    if (state.stop) return
  }
}

function globFiles(roots, { path: base = '.', pattern = '*', limit = 200 } = {}) {
  const dir = resolveInside(roots, base)
  if (!statSync(dir).isDirectory()) throw new Error('这不是文件夹')
  const re = globToRegExp(pattern)
  const matches = []
  const state = { scanned: 0, truncated: false, stop: false }
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200))
  walkFiles(dir, '', (full, rel, type) => {
    if (!re.test(rel)) return
    if (matches.length >= cap) { state.truncated = true; state.stop = true; return }
    let info
    try { info = lstatSync(full) } catch { return }
    matches.push({ path: full, type, size: info.isFile() ? info.size : null })
    if (matches.length >= cap) state.truncated = true
  }, state)
  return { path: dir, matches, truncated: state.truncated }
}

function grepFiles(roots, { path: base = '.', pattern, glob, limit = 100, ignoreCase = true } = {}) {
  const dir = resolveInside(roots, base)
  if (!statSync(dir).isDirectory()) throw new Error('这不是文件夹')
  if (!pattern) throw new Error('搜索内容不能为空')
  let re
  try { re = new RegExp(String(pattern), ignoreCase ? 'i' : '') } catch (err) { throw new Error(`正则写错了：${err.message}`) }
  const filter = glob ? globToRegExp(glob) : null
  const cap = Math.max(1, Math.min(500, Number(limit) || 100))
  const matches = []
  const state = { scanned: 0, truncated: false, stop: false }
  walkFiles(dir, '', (full, rel, type) => {
    if (state.stop || type !== 'file') return
    if (filter && !filter.test(rel)) return
    let stat
    try { stat = statSync(full) } catch { return }
    if (stat.size > 512 * 1024) return
    let text
    try { text = readFileSync(full, 'utf8') } catch { return }
    if (text.includes('\u0000')) return
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      if (!re.test(lines[i])) continue
      if (matches.length >= cap) { state.truncated = true; state.stop = true; return }
      matches.push({ path: full, line: i + 1, text: lines[i].slice(0, 300) })
    }
  }, state)
  return { path: dir, matches, truncated: state.truncated }
}

function assertManage(allowManage) {
  if (!allowManage) throw new Error('B 端还没有授予管理文件夹权限')
}

function assertNotRoot(roots, target) {
  if (roots.includes(target)) throw new Error('不允许直接操作授权根目录本身')
}

function mkdirPath(roots, requested, allowManage) {
  assertManage(allowManage)
  const dir = resolveInside(roots, requested)
  assertNotRoot(roots, dir)
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error('目标已经是一个文件')
    return { path: dir, created: false }
  }
  mkdirSync(dir, { recursive: true })
  return { path: dir, created: true }
}

function copyPath(roots, from, to, allowManage, confirm) {
  assertManage(allowManage)
  const src = resolveInside(roots, from)
  const dst = resolveInside(roots, to)
  assertNotRoot(roots, dst)
  if (!existsSync(src)) throw new Error('源不存在')
  if (src === dst) throw new Error('源和目标是同一个路径')
  const rel = relative(src, dst)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) throw new Error('不能把文件夹复制到自己里面')
  if (existsSync(dst) && confirm !== true) throw new Error('目标已存在；确认覆盖请带 confirm: true')
  cpSync(src, dst, { recursive: true, force: true, errorOnExist: false })
  return { from: src, to: dst, overwritten: existsSync(dst) }
}

function movePath(roots, from, to, allowManage, confirm) {
  assertManage(allowManage)
  if (confirm !== true) throw new Error('移动或改名需要 confirm: true')
  const src = resolveInside(roots, from)
  const dst = resolveInside(roots, to)
  assertNotRoot(roots, src)
  assertNotRoot(roots, dst)
  if (!existsSync(src)) throw new Error('源不存在')
  if (src === dst) throw new Error('源和目标是同一个路径')
  if (existsSync(dst)) throw new Error('目标已存在；先删除或换一个名字')
  const rel = relative(src, dst)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel) && statSync(src).isDirectory()) throw new Error('不能把文件夹移动到自己里面')
  try {
    renameSync(src, dst)
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      cpSync(src, dst, { recursive: true, force: false, errorOnExist: true })
      rmSync(src, { recursive: true, force: false })
    } else throw err
  }
  return { from: src, to: dst }
}

function deletePath(roots, requested, allowManage, confirm, recursive) {
  assertManage(allowManage)
  if (confirm !== true) throw new Error('删除需要 confirm: true')
  const target = resolveInside(roots, requested)
  assertNotRoot(roots, target)
  if (!existsSync(target)) throw new Error('要删除的路径不存在')
  if (statSync(target).isDirectory() && recursive !== true) throw new Error('删除文件夹需要 recursive: true')
  rmSync(target, { recursive: recursive === true, force: false })
  return { path: target, deleted: true }
}

async function runShell(roots, command, cwd, allowShell) {
  if (!allowShell) throw new Error('B 端还没有授予执行命令权限')
  const cmd = String(command || '').trim()
  if (!cmd) throw new Error('命令是空的')
  if (cmd.length > 8000) throw new Error('命令太长')
  const dir = cwd ? resolveInside(roots, cwd) : roots[0]
  if (!statSync(dir).isDirectory()) throw new Error('工作目录不是文件夹')
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, cwd: dir, windowsHide: true, env: process.env })
    const cap = 64 * 1024
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    const collect = (target, chunk) => {
      const text = chunk.toString('utf8')
      if (target.length >= cap) { truncated = true; return target }
      const room = cap - target.length
      if (text.length > room) truncated = true
      return target + text.slice(0, room)
    }
    child.stdout.on('data', (d) => { stdout = collect(stdout, d) })
    child.stderr.on('data', (d) => { stderr = collect(stderr, d) })
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* 忽略 */ }
    }, 30 * 1000)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code, truncated, timedOut, cwd: dir })
    })
  })
}

function openTerminal(roots, { cwd, name } = {}, allowShell, terminals) {
  if (!allowShell) throw new Error('B 端还没有授予执行命令权限')
  const dir = cwd ? resolveInside(roots, cwd) : roots[0]
  if (!statSync(dir).isDirectory()) throw new Error('工作目录不是文件夹')
  const shell = process.env.ComSpec || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')
  const child = spawn(shell, [], { cwd: dir, windowsHide: true, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  const term = {
    id: randomUUID(),
    name: String(name || '').slice(0, 60),
    cwd: dir,
    child,
    log: '',
    pending: '',
    lastData: Date.now(),
    closed: false,
  }
  const cap = 128 * 1024
  const onData = (chunk) => {
    const text = chunk.toString('utf8')
    term.log = (term.log + text).slice(-cap)
    term.pending = (term.pending + text).slice(-cap)
    term.lastData = Date.now()
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('close', () => { term.closed = true; term.lastData = Date.now() })
  child.on('error', () => { term.closed = true })
  terminals.set(term.id, term)
  return { id: term.id, cwd: term.cwd, name: term.name }
}

function getTerminal(terminals, id) {
  const term = terminals.get(String(id || ''))
  if (!term) throw new Error('没有这个 B 端终端')
  return term
}

async function waitTerminal(term, waitMs) {
  const started = Date.now()
  const max = Math.max(800, Math.min(15000, Number(waitMs) || 800)) + 3000
  while (true) {
    if (term.closed) return { id: term.id, output: term.pending, closed: true }
    if (Date.now() - term.lastData >= 300 && Date.now() - started >= 120) {
      return { id: term.id, output: term.pending, closed: false }
    }
    if (Date.now() - started > max) return { id: term.id, output: term.pending, closed: false, timedOut: true }
    await new Promise((r) => setTimeout(r, 60))
  }
}

async function sendTerminal(terminals, id, text, waitMs) {
  const term = getTerminal(terminals, id)
  if (term.closed) throw new Error('这个终端已经关闭')
  term.pending = ''
  term.child.stdin.write(`${String(text ?? '')}\n`)
  return waitTerminal(term, waitMs)
}

function readTerminal(terminals, id, count) {
  const term = getTerminal(terminals, id)
  const lines = term.log.split(/\r?\n/)
  const n = Math.max(1, Math.min(2000, Number(count) || 200))
  return { id: term.id, output: lines.slice(-n).join('\n'), closed: term.closed }
}

async function closeTerminal(terminals, id) {
  const term = getTerminal(terminals, id)
  try { term.child.kill() } catch { /* 忽略 */ }
  terminals.delete(term.id)
  return { id: term.id, closed: true }
}

function listTerminals(terminals) {
  return [...terminals.values()].map((t) => ({ id: t.id, name: t.name, cwd: t.cwd, closed: t.closed }))
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
 * @param {boolean} [opts.allowWrite] 允许写文件
 * @param {boolean} [opts.allowManage] 允许建目录、移动、复制、删除
 * @param {boolean} [opts.allowShell] 允许一次性命令和持久终端
 * @param {Function} [opts.fetchImpl] 测试注入
 */
export function createAgentClient({
  url, token, roots, allowWrite = false, allowShell = false, allowManage = false,
  fetchImpl = globalThis.fetch, log = console,
} = {}) {
  const base = String(url || '').replace(/\/+$/, '')
  if (!base) throw new Error('缺少 A 端地址')
  if (!token) throw new Error('缺少配对凭据')
  const realRoots = normalizeRoots(roots)
  const terminals = new Map()
  let stopped = false
  let lastPollAt = 0
  let lastError = null

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
    if (op === 'write') return writeText(realRoots, args.path, args.content, allowWrite)
    if (op === 'shell') return runShell(realRoots, args.command, args.cwd, allowShell)
    if (op === 'glob') return globFiles(realRoots, args)
    if (op === 'grep') return grepFiles(realRoots, args)
    if (op === 'mkdir') return mkdirPath(realRoots, args.path, allowManage)
    if (op === 'copy') return copyPath(realRoots, args.from, args.to, allowManage, args.confirm)
    if (op === 'move') return movePath(realRoots, args.from, args.to, allowManage, args.confirm)
    if (op === 'delete') return deletePath(realRoots, args.path, allowManage, args.confirm, args.recursive)
    if (op === 'terminal_open') return openTerminal(realRoots, args, allowShell, terminals)
    if (op === 'terminal_send') return sendTerminal(terminals, args.sessionId, args.text, args.waitMs)
    if (op === 'terminal_read') return readTerminal(terminals, args.sessionId, args.count)
    if (op === 'terminal_close') return closeTerminal(terminals, args.sessionId)
    if (op === 'terminal_list') return { terminals: listTerminals(terminals) }
    throw new Error(`B 端还不支持这个操作：${op}`)
  }

  async function run({ signal } = {}) {
    let backoff = BACKOFF_MIN_MS
    while (!stopped && !(signal && signal.aborted)) {
      try {
        const data = await api(`/mini-remote/agent/poll?wait=${ONLINE_POLL_MS}`, { signal })
        lastPollAt = Date.now()
        lastError = null
        backoff = BACKOFF_MIN_MS
        if (!data || !data.task) continue
        const task = data.task
        let payload
        try {
          payload = { taskId: task.id, ok: true, output: await execute(task) }
        } catch (err) {
          payload = { taskId: task.id, ok: false, error: err && err.message ? err.message : String(err) }
        }
        await api('/mini-remote/agent/result', { method: 'POST', body: payload, signal })
      } catch (err) {
        if (signal && signal.aborted) break
        lastError = err && err.message ? err.message : String(err)
        log.warn?.(`B 端代理连接 A 失败：${lastError}`)
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(BACKOFF_MAX_MS, backoff * 2)
      }
    }
  }

  function stop() {
    stopped = true
    for (const term of terminals.values()) {
      try { term.child.kill() } catch { /* 忽略 */ }
    }
    terminals.clear()
  }

  return {
    url: base,
    roots: realRoots,
    allowWrite: allowWrite === true,
    allowShell: allowShell === true,
    allowManage: allowManage === true,
    execute,
    run,
    stop,
    status: () => ({ lastPollAt, lastError, stopped }),
    api,
  }
}

/** 配对：拿 A 端的一次性码换长期凭据。 */
export async function pairAgent({ url, code, name, platform, roots, allowWrite = false, allowShell = false, allowManage = false, fetchImpl = globalThis.fetch } = {}) {
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
      allowManage: allowManage === true,
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
