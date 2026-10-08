/**
 * **升级自检**：DSH 一升级，对着**活着的界面**照单跑一遍，看我们的适配还站不站得住。
 *
 * ## 一句话用法
 *
 *     node tools/structure-check.mjs              # 逐条查，中文报告；有失配就非零退出
 *     node tools/structure-check.mjs --table      # 只看那张清单（不开浏览器）
 *     node tools/structure-check.mjs --fault <id> # 自检：故意让某一条报失配，验这个检查不是摆设
 *
 * ## 它查的是什么
 *
 * 清单在 `tools/structure-deps.mjs`（**唯一真相**，和代码的一致性由
 * `test/structure-deps.test.mjs` 盯着）。这里只负责一件事：**把清单里的选择器
 * 拿到活页面上真查一遍**。
 *
 * 「活页面」= 我们自己的镜像入口 `http://127.0.0.1:<端口>/mini/mirror/`——
 * 面板、侧栏、插件市场那一节**都在那份文档里**，所以必须用真浏览器（无头 Edge + CDP）。
 *
 * ## 几件必须做对的事
 *
 * ① **分清「要打开才有」和「一直都有」**。清单每条都带 `scope`：
 *    `page`（一加载就有）/ `panel`（要开设置面板）/ `market`（还要切到那一节）。
 *    没打开面板就把面板里的标记判成失配，是误报——所以每一档都**先等它真的到了**才查。
 * ② **不许改任何开关状态**。这条通道只有一个写操作：把 `/mini/api/version` 在**请求阶段**
 *    答成**同一个 build**（页面每 30 秒叫它一次，答不一样它就 `location.reload()`，
 *    那会把这一轮量到的东西连根拔掉）。答的是同一个值，所以行为与不开拦截时完全一致。
 * ③ **不猜**。进不去那一节就如实说「没验到」，不报成失配（退出码也分开：0 全绿、
 *    1 有失配、2 环境没就绪/有没验到的）。
 *
 * ## 退出码
 *
 *   0  逐条都在，没有失配
 *   1  有失配（报告里逐条说清「没了会怎样」）
 *   2  环境没就绪，或有没验到的（README 上那几句「先启动宿主」）；**这一档也不是绿的**
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MARKERS, FAULT_PROBE, judge, renderTable, satisfiesRange } from './structure-deps.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(name)

const HARM_TEXT = {
  safe: '可以先不管（这条失配只是少一层适配，界面退回官方样子，不会更糟）',
  danger: '**要管**（它本来就是按子串猜的：失配说明官方动过这块，同一条选择器将来可能改到别的元素上）',
  guard: '**要管**（它管的是「别的东西不许进来」，它失配时症状会以别处的样子出现）',
}
const SCOPE_TEXT = { page: '一直都有', panel: '要开设置面板才有', market: '要进「插件市场」那一节才有' }
const STATE_MARK = { ok: '✓', missing: '✗', unexpected: '✗', 'not-applicable': '○', unverified: '？' }

/* ------------------------------------------------------------------ *
 * --table：不开浏览器，只把清单渲染出来
 * ------------------------------------------------------------------ */
if (has('--table') || has('--help') || has('-h')) {
  console.log('# 结构依赖清单（极简遥控器 · 镜像页的手机适配）\n')
  console.log('这张表由 `tools/structure-check.mjs --table` 从 `tools/structure-deps.mjs` 渲染，')
  console.log('和 `lib/mirror.js` 的一致性由 `test/structure-deps.test.mjs` 盯着——**不是手抄件**。\n')
  console.log(renderTable())
  const danger = MARKERS.filter((r) => r.harm === 'danger')
  console.log(`\n**「可能误伤」的有 ${danger.length} 条**（失配时最该先看这几条）：`)
  for (const r of danger) console.log(`  · ${r.marker} —— ${r.group}`)
  console.log(`\n另有 ${MARKERS.filter((r) => r.harm === 'guard').length} 条是「护栏」（管别的插件不许进来）。`)
  process.exit(0)
}

/* ------------------------------------------------------------------ *
 * 环境：令牌、端口、上游版本
 * ------------------------------------------------------------------ */
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DIR = join(HOME, 'dsh-mini-remote')

function readToken() {
  try { return readFileSync(join(DIR, 'token'), 'utf8').trim() } catch { return '' }
}
function readPort() {
  try {
    const s = JSON.parse(readFileSync(join(DIR, 'settings.json'), 'utf8'))
    if (Number.isFinite(s?.port)) return s.port
  } catch { /* 没有就用默认值 */ }
  return 3090
}

const port = Number(arg('--port', readPort()))
const token = readToken()
const BASE = `http://127.0.0.1:${port}`
const MIRROR_URL = `${BASE}/mini/mirror/?token=${encodeURIComponent(token)}`

function bail(lines) {
  console.error('\n' + lines.join('\n'))
  process.exit(2)
}

if (!token) {
  bail([
    `读不到访问令牌（找的是 ${join(DIR, 'token')}）。`,
    '这个文件由插件第一次启动时生成——先把电脑上的 DSH 起起来，再跑这一条。',
  ])
}

let version = null
try {
  const res = await fetch(`${BASE}/mini/api/version?token=${encodeURIComponent(token)}`)
  version = await res.json()
} catch (err) {
  bail([
    `连不上插件那台服务（${BASE}）：${String((err && err.message) || err)}`,
    '先把电脑上的 DSH 起起来（插件会监听这个端口），再跑这一条。',
  ])
}

/* ------------------------------------------------------------------ *
 * 无头 Edge + CDP
 * ------------------------------------------------------------------ */
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edgePath = EDGE_CANDIDATES.find((p) => existsSync(p))
if (!edgePath) {
  bail([
    '找不到无头 Edge（这两处都没有）：',
    ...EDGE_CANDIDATES.map((p) => `  ${p}`),
    '这一条必须用真浏览器查：面板、侧栏、插件市场那一节都在 iframe 里那份文档上。',
  ])
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CDP_PORT = 9200 + Math.floor(Math.random() * 700)
const profile = join(tmpdir(), `edge-cdp-structure-${CDP_PORT}`)
rmSync(profile, { recursive: true, force: true })

const child = spawn(edgePath, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`,
  '--window-size=390,844', 'about:blank'], { stdio: 'ignore', windowsHide: true })

async function listTargets() {
  for (let i = 0; i < 60; i += 1) {
    try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() } catch { await sleep(500) }
  }
  bail(['无头 Edge 起不来（CDP 端口没有应答）。'])
}
const targets = await listTargets()
const target = targets.find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let seq = 0
const pending = new Map()
const send = (method, params = {}) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
    return
  }
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params
    // **一个写操作都不做**：只把版本探测答成「和真服务器一样」的那一份。
    // 答成别的值页面会自己 reload；答成同一个值 = 它本来就会拿到的结果。
    if (request.url.includes('/mini/api/version')) {
      send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
        body: Buffer.from(JSON.stringify(version)).toString('base64'),
      }).catch(() => {})
    } else {
      send('Fetch.continueRequest', { requestId }).catch(() => {})
    }
  }
}
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { __error: String(JSON.stringify(r.exceptionDetails)).slice(0, 300) }
  return r.result.value
}
function finish(code) {
  try { ws.close() } catch { /* 已经断了 */ }
  try { child.kill() } catch { /* 已经没了 */ }
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* 占用中就留给系统清 */ }
  process.exit(code)
}

/* ------------------------------------------------------------------ *
 * 查：一档一批，只等「真到了」才查
 * ------------------------------------------------------------------ */
const faultId = arg('--fault', '')
if (faultId && !MARKERS.some((r) => r.id === faultId)) {
  console.error(`--fault 后面要给清单里的 id。可用的有：\n  ${MARKERS.map((r) => r.id).join('\n  ')}`)
  finish(2)
}
/** 注入故障时把它那条的侦查选择器换成一条永远查不到的（原本查「不该在」的换成永远在的）。 */
function probeOf(row) {
  if (row.id === faultId) return row.expect === 'absent' ? 'html' : FAULT_PROBE
  return row.probe
}

/**
 * 一批查完：把这一档的所有选择器**一次**送回页面数个数。
 * 一次一批（不是一条一次往返）——CDP 一次往返几十毫秒，29 条就是十几秒的差别。
 */
function batchExpression(rows) {
  const payload = rows.map((r) => ({ id: r.id, probe: probeOf(r), onlyIf: r.onlyIf || null }))
  return `(() => {
    const rows = ${JSON.stringify(payload)};
    const out = {};
    for (const row of rows) {
      let count = 0, error = null;
      try { count = document.querySelectorAll(row.probe).length } catch (e) { error = String((e && e.message) || e) }
      let onlyIfCount = null;
      if (row.onlyIf) { try { onlyIfCount = document.querySelectorAll(row.onlyIf).length } catch (e) { onlyIfCount = 0 } }
      out[row.id] = { count: count, error: error, onlyIfCount: onlyIfCount };
    }
    return JSON.stringify(out);
  })()`
}

const READY = {
  // 「应用挂上了吗」用的信号**不在清单里**（侧栏那一列 / 应用根），
  // 这样「清单里某个标记没了」才会报成失配，而不是被当成「没到那一档」。
  app: `!!document.querySelector('[data-pane="sidebar"], [data-slot="root"], #root, main')`,
  panel: `!!document.querySelector('[aria-modal="true"], button[aria-haspopup="dialog"][aria-expanded="true"]')`,
}

await send('Page.enable')
await send('Runtime.enable')
await send('Fetch.enable', { patterns: [{ urlPattern: '*/mini/api/version*' }] })
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await send('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
})
await send('Page.navigate', { url: MIRROR_URL })

let appReady = false
for (let i = 0; i < 40; i += 1) {
  if (await evalJs(READY.app)) { appReady = true; break }
  await sleep(1000)
}
await sleep(2500)

/** 发回车键切小节（`nav button` 的 `.click()` 和真鼠标点都无效——这条踩过）。 */
async function pressEnter() {
  for (const type of ['keyDown', 'char', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type, code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, text: type === 'char' ? '\r' : undefined,
    })
    await sleep(70)
  }
}

async function openPanel() {
  for (let i = 0; i < 4; i += 1) {
    if (await evalJs(READY.panel)) return true
    await evalJs(`(() => { const b = document.querySelector('button[aria-haspopup="dialog"][aria-expanded]')
      || document.querySelector('button[aria-haspopup="dialog"]'); if (b) b.click(); return !!b })()`)
    for (let w = 0; w < 12; w += 1) {
      await sleep(1000)
      if (await evalJs(READY.panel)) return true
    }
  }
  return false
}

/** 面板导航里所有小节的名字（进不去那一节时打到报告里，让人一眼知道是改了名还是没装）。 */
async function sectionNames() {
  return await evalJs(`JSON.stringify((() => {
    const p = document.querySelector('[data-shortcut-modal="settings"]')
    if (!p) return []
    return [...p.querySelectorAll('nav button')].map((b) => (b.textContent || '').trim()).filter(Boolean)
  })())`) || '[]'
}

/** 切到名字里带某个词的设置小节；返回 true 表示真的切过去了。 */
async function selectSection(pattern) {
  for (let i = 0; i < 7; i += 1) {
    const cur = await evalJs(`(() => { const p = document.querySelector('[data-shortcut-modal="settings"]')
      const a = p && p.querySelector('nav [aria-current]')
      return a ? (a.textContent || '').trim() : null })()`)
    if (typeof cur === 'string' && pattern.test(cur)) { await sleep(2000); return cur }
    const clicked = await evalJs(`(() => { const p = document.querySelector('[data-shortcut-modal="settings"]')
      if (!p) return 'no-panel'
      const b = [...p.querySelectorAll('nav button')].find((x) => ${pattern.toString()}.test((x.textContent || '').trim()))
      if (!b) return 'not-found'
      b.scrollIntoView({ inline: 'center', block: 'nearest' }); b.focus(); return 'ok' })()`)
    if (clicked === 'not-found') return null
    if (clicked === 'no-panel') return null
    await pressEnter()
    await sleep(3500)
  }
  return null
}

const pageRows = MARKERS.filter((r) => r.scope === 'page')
const panelRows = MARKERS.filter((r) => r.scope === 'panel')
const marketRows = MARKERS.filter((r) => r.scope === 'market')

const observed = new Map()
const unverified = new Map()   // id → 为什么没验到
async function runBatch(rows) {
  if (!rows.length) return
  const raw = await evalJs(batchExpression(rows))
  let parsed = {}
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}) } catch { parsed = {} }
  for (const row of rows) observed.set(row.id, parsed[row.id] || { count: 0, error: '页面没回值' })
}

await runBatch(appReady ? pageRows : [])
if (!appReady) for (const r of pageRows) unverified.set(r.id, '页面没加载起来')

let panelReady = false
if (appReady) {
  panelReady = await openPanel()
  if (panelReady) await runBatch(panelRows)
  else for (const r of panelRows) unverified.set(r.id, '设置面板没打开')
}

let marketState = 'skipped'   // skipped | reached | no-section | unreachable
if (panelReady) {
  const names = JSON.parse(await sectionNames())
  const marketPattern = /市场/
  if (!names.some((n) => marketPattern.test(n))) {
    marketState = 'no-section'
    for (const r of marketRows) unverified.set(r.id, `这台机器上没有带「市场」的设置节（现有：${names.join('、') || '读不到'}）`)
  } else {
    const landed = await selectSection(marketPattern)
    if (!landed) {
      marketState = 'unreachable'
      for (const r of marketRows) unverified.set(r.id, '切不到「插件市场」那一节')
    } else {
      marketState = 'reached'
      await runBatch(marketRows)
    }
  }
} else if (appReady) {
  for (const r of marketRows) unverified.set(r.id, '设置面板没打开')
} else {
  for (const r of marketRows) unverified.set(r.id, '页面没加载起来')
}

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */
const results = MARKERS.map((row) => {
  if (unverified.has(row.id)) {
    return { row, state: 'unverified', ok: false, title: '没验到', detail: unverified.get(row.id), count: null }
  }
  const got = observed.get(row.id) || { count: 0 }
  const verdict = judge(row, { count: got.count, onlyIfCount: got.onlyIfCount, faulted: row.id === faultId })
  return { row, ...verdict, count: got.count, error: got.error }
})

const mismatches = results.filter((r) => r.state === 'missing' || r.state === 'unexpected')
const unverifiedResults = results.filter((r) => r.state === 'unverified')
const okCount = results.filter((r) => r.state === 'ok').length
const naCount = results.filter((r) => r.state === 'not-applicable').length

const out = []
out.push('')
out.push('================ 极简遥控器 · 结构依赖自检 ================')
out.push('')
out.push(`查的是活着的界面：${BASE}/mini/mirror/`)
const range = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).engines?.dsh || ''
const inRange = satisfiesRange(version?.dshVersion, range)
out.push(`电脑上这份 DSH：${version?.dshVersion ?? '读不到'}`
  + `（我们声明能用的是 ${range}）`
  + (inRange === true ? ' ✓ 在范围内' : inRange === false ? ' ✗ **超出范围了**' : '（区间写法没认出来）'))
out.push(`镜像页 build：${version?.build ?? '读不到'}`)
out.push('手机视口：390×844（我们的适配整段写在 `max-width:640px` 里，只有窄屏才生效）')
out.push('')

const summary = [`清单共 ${MARKERS.length} 条：${okCount} 条还在，${mismatches.length} 条失配`
  + (naCount ? `，${naCount} 条不适用` : '')
  + (unverifiedResults.length ? `，${unverifiedResults.length} 条没验到` : '') + '。']
if (!mismatches.length && !unverifiedResults.length) {
  summary.push('结论：**这次升级，我们靠的这些标记一条都没动。**')
} else if (!mismatches.length) {
  summary.push('结论：**没有发现失配**；但有几条这次没验到（下面写清了为什么）——'
    + '那不等于它们没问题，只是这一轮看不到。')
} else {
  const danger = mismatches.filter((r) => r.row.harm === 'danger').length
  summary.push(`结论：**有 ${mismatches.length} 条失配**`
    + (danger ? `，其中 ${danger} 条属于「可能误伤」那一类，先看它们。` : '。'))
}
out.push(...summary)
out.push('')
out.push('（每条依赖各是什么、没了会怎样：`node tools/structure-check.mjs --table`）')

let lastGroup = null
let guardNoteDone = false
for (const item of results) {
  const { row } = item
  if (row.group !== lastGroup) {
    out.push('')
    out.push(`── ${row.group} ──`)
    lastGroup = row.group
  }
  // 那几条「看着不该出现」的护栏（不是「官方前缀还在不在」那条：那条绿就是真凭据）。
  if (row.harm === 'guard' && row.expect === 'absent' && !guardNoteDone) {
    guardNoteDone = true
    out.push('  （这一组查的是「活页面上不该看到」。**绿只说明这一轮没漏，不代表挡得住**——'
      + '那两家没装的时候它本来就绿；真正的证据是红。）')
  }
  if (item.state === 'ok' || item.state === 'not-applicable') {
    // 「本来就该没有」的那几条（护栏）不要说成「在」——那不叫在，那叫**没出现**。
    const how = item.state === 'not-applicable'
      ? `○ ${row.marker} —— 不适用`
      : row.expect === 'absent'
        ? `✓ ${row.marker} —— 没有出现（本来就该一个都没有）`
        : `✓ ${row.marker} —— 在（查到 ${item.count} 个）`
    out.push(`  ${how}`)
    if (item.state === 'not-applicable') out.push(`      ${item.detail}`)
    continue
  }
  // 失配 / 没验到：一条一段，写清「这一条没了会怎样」。
  out.push(`  ${STATE_MARK[item.state]} ${row.marker} —— ${item.title}${item.count === null ? '' : `（查到 ${item.count} 个）`}`)
  out.push(`      侦查范围：${SCOPE_TEXT[row.scope]}`)
  if (item.state === 'unverified') {
    out.push(`      为什么没验到：${item.detail}`)
    out.push('      （这不是失配：这一轮根本没走到那一档，所以不下结论。）')
    continue
  }
  out.push(`      它撑的是：${row.why}`)
  out.push(`      没了会怎样：${row.fail}`)
  out.push(`      要不要管：${HARM_TEXT[row.harm]}`)
  out.push(`      兜底：${row.guard}`)
  out.push(`      在哪用：${row.where}`)
}

const danger = MARKERS.filter((r) => r.harm === 'danger')
out.push('')
out.push(`一眼看重点：清单里标着「可能误伤」的共 ${danger.length} 条——${danger.map((r) => r.marker).join('、')}。`)
out.push('这几条是「失配了也不吭声、只会悄悄改到别的东西」那一类，升级后最该先看它们。')
if (faultId) {
  out.push('')
  out.push(`※ 这一轮带自检注入（--fault ${faultId}）：那一条的判断是**故意造出来的**，用来验这个检查真的会报出来。`)
}
out.push('')

console.log(out.join('\n'))

const code = mismatches.length ? 1 : (unverifiedResults.length ? 2 : 0)
finish(code)
