/**
 * 活体检查：对着**正在运行**的 DSH 打几个接口，确认插件真的在工作。
 *
 * 离线测试验的是逻辑，探针（.dsh-mini-remote-probe.mjs）验的是「能不能加载」，
 * 这个脚本验的是第三件事：**跑起来之后接口真的返回了真实数据**。
 * 三件事互不替代——逻辑对、能加载，不代表接口通、数据对。
 *
 * 必须从 DSH 进程外面跑，因为它验的就是那个进程。
 *
 *   node tools/live-check.mjs            # 打一次
 *   node tools/live-check.mjs --wait 60  # 最多等 60 秒，等**新代码**上线（重启后用）
 *   node tools/live-check.mjs --port 3090
 *   node tools/live-check.mjs --build <指纹>   # 手动指定要等的指纹
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 和 lib/build.js 算同一个指纹，用来确认应答我们的是不是这份代码。 */
function localBuild() {
  const lib = join(HERE, '..', 'lib')
  const hash = createHash('sha256')
  const files = []
  for (const f of readdirSync(lib).sort()) {
    if (f.endsWith('.js') || f.endsWith('.html')) files.push(join(lib, f))
  }
  files.push(join(HERE, '..', 'client', 'client.js'))
  // 立绘也算在里面（和 lib/build.js 保持一致）：换了图，指纹就该跟着变。
  try {
    for (const f of readdirSync(join(lib, 'art')).sort()) {
      if (f.endsWith('.webp')) files.push(join(lib, 'art', f))
    }
  } catch { /* 没有 art 目录就当没有立绘 */ }
  for (const file of files) {
    hash.update(file)
    try {
      hash.update(readFileSync(file))
    } catch {
      hash.update('(读不到)')
    }
  }
  return hash.digest('hex').slice(0, 12)
}

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DIR = join(HOME, 'dsh-mini-remote')

function readToken() {
  try {
    return readFileSync(join(DIR, 'token'), 'utf8').trim()
  } catch {
    return ''
  }
}

function readPort() {
  try {
    const s = JSON.parse(readFileSync(join(DIR, 'settings.json'), 'utf8'))
    if (Number.isFinite(s?.port)) return s.port
  } catch { /* 没有就用默认值 */ }
  return 3090
}

const port = Number(arg('--port', readPort()))
// 设置页那几个接口（`/mini-remote/*`）注册在 **DSH 自己的 web 服务**上，不是插件这台。
// 用 base 去打它们会拿到 404——2026-09-25 就是这么白跑了一轮，而且更糟：
// 404 的正文里没有 `serve` 字段，于是「serve 没开时不出现 https 那条」**假绿**了。
// 判据错的时候，绿比红危险。
const adminPort = Number(arg('--admin-port', 3080))
const adminBase = `http://127.0.0.1:${adminPort}`
const token = readToken()
const base = `http://127.0.0.1:${port}`

if (!token) {
  console.error(`读不到 token（找的是 ${join(DIR, 'token')}）。这个文件由插件第一次启动时生成。`)
  process.exitCode = 1
  throw new Error('no token')
}

async function get(path) {
  const res = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function post(path, payload) {
  const res = await fetch(`${base}${path}?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

const wait = Number(arg('--wait', 0))
if (wait > 0) {
  // 等「服务应答」是不够的——重启期间旧进程还在应答；等「某个接口返回 200」也不够，
  // 那个接口很可能上一轮就已经部署了。这两条我都踩过。所以改成等**构建指纹**：
  // 只有新代码才会报出这个指纹。
  const want = arg('--build', localBuild())
  const deadline = Date.now() + wait * 1000
  let last = ''
  for (;;) {
    try {
      const r = await get('/mini/api/version')
      last = `HTTP ${r.status} build=${r.body?.build ?? '?'}`
      if (r.status === 200 && r.body?.build === want) break
    } catch (err) {
      last = err?.message ?? String(err)
    }
    if (Date.now() > deadline) {
      console.error(`等了 ${wait} 秒，指纹还是对不上（想要 ${want}，最后一次：${last}）。`)
      process.exitCode = 1
      throw new Error('new code never came up')
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

const problems = []
function check(label, ok, detail) {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!ok) problems.push(label)
}

// 1. 服务活着
const state = await get('/mini/api/state')
check('服务应答', state.status === 200, `HTTP ${state.status}`)

// 1b. 应答我们的到底是不是这份代码。这条放在最前面，因为它决定下面所有结论算不算数。
const mine = localBuild()
const version = await get('/mini/api/version')
check('跑的是这份代码', version.body?.build === mine,
  `进程报 ${version.body?.build ?? '?'}，本地是 ${mine}`
  + (version.body?.build === mine ? '' : '（指纹不同：下面所有结论都是对旧代码下的，不算数）'))

// 「正在执行」必须跟着会话走。这里只读不改——活体检查跑在用户正在用的实例上，
// 不能顺手把人家的绑定状态改了。
check('状态里带 running', typeof state.body?.running === 'boolean',
  `running=${JSON.stringify(state.body?.running)}，绑定的是 ${state.body?.boundSessionId ?? '(未绑定)'}`)
const boundRow = (state.body?.sessions ?? []).find((s) => s.id === state.body?.boundSessionId)
if (boundRow) {
  check('running 与绑定会话自身一致', state.body.running === Boolean(boundRow.running),
    `快照说 ${state.body.running}，会话表说 ${boundRow.running}`)
}

// 显示内容不能跨会话串。用户实机报过两次同一个病根（先 running，后 latest）。
// 这里只读不改——活体检查跑在用户正在用的实例上。
const bound = state.body?.boundSessionId
const wrongLatest = state.body?.latest && state.body.latest.sessionId !== bound
check('latest 属于当前绑定的会话', !wrongLatest,
  wrongLatest ? `绑定的是 ${bound}，latest 却是 ${state.body.latest.sessionId} 的` : '')
const strayHistory = (state.body?.history ?? []).filter((m) => m.sessionId && m.sessionId !== bound)
check('聊天记录里没有别的会话的消息', strayHistory.length === 0,
  strayHistory.length ? `${strayHistory.length} 条不属于 ${bound}` : '')

// 2. 会话树那两个服务到位了没有——这是重启后最该确认的一条
const ws = await get('/mini/api/workspaces')
check('工作区接口可用', ws.status === 200, `HTTP ${ws.status}`)
const list = ws.body?.workspaces ?? []
check('读到工作区', list.length > 0, `${list.length} 个`)
if (list.length) {
  // 挑一个**非空**的来展开。
  //
  // 2026-09-24 踩到过：导航栏改成「空工作区也列出来」之后（那是为了修「新建的工作区
  // 在列表里看不见」——新建出来的工作区一开始本来就是空的），`list[0]` 可能正好是
  // 个空工作区，展开它当然 0 条，这条检查就**假红**了。
  //
  // 真机上的假红最费时间，因为它看着像 bug：实际是本机注册表里攒了一堆别的工具
  // 留下的空目录（`.claude/projects` 那些），再加上我们自己的测试残留。
  const emptyOnes = list.filter((w) => w.empty)
  check('空工作区也列得出来（新建的那个一开始就是空的）', 'empty' in list[0],
    `${list.length} 个里 ${emptyOnes.length} 个是空的`)

  const first = list.find((w) => !w.empty) ?? list[0]
  console.log(`      挑来展开的：${first.title}（${first.count} 个会话，${first.running} 个在跑）`)
  console.log(`      路径：${first.path}`)

  // 3. 展开一个工作区，确认会话和标题真的取得到
  const sess = await get(`/mini/api/workspaces/${encodeURIComponent(first.id)}/sessions`)
  check('展开工作区能取到会话', sess.status === 200 && (sess.body?.sessions?.length ?? 0) > 0,
    `${sess.body?.sessions?.length ?? 0} 条 / 共 ${sess.body?.total ?? '?'} 条`)

  // 空工作区展开要**干净地返回 0 条**：不报错、不 404。手机上点开一个刚建好的
  // 工作区走的正是这条路径，它得好看。
  if (emptyOnes.length) {
    const es = await get(`/mini/api/workspaces/${encodeURIComponent(emptyOnes[0].id)}/sessions`)
    check('展开空工作区返回 0 条而不是报错',
      es.status === 200 && (es.body?.sessions?.length ?? 0) === 0,
      `HTTP ${es.status} / ${es.body?.sessions?.length ?? '?'} 条`)
  }
  const withTitle = (sess.body?.sessions ?? []).filter((s) => s.title)
  console.log(`      其中 ${withTitle.length} 条有标题`)
  // 真机上出过一次：readTitleSnapshots 返回的是「标题快照」对象而不是字符串，
  // 直接塞进界面就成了 [object Object]。离线测试的假数据当时返回的是字符串，
  // 所以这个 bug 只有打真接口才抓得到。
  const rows = sess.body?.sessions ?? []
  const notString = rows.filter((s) => s.title && typeof s.title !== 'string')
  check('标题是字符串', notString.length === 0,
    notString.length ? `有 ${notString.length} 条不是：${JSON.stringify(notString[0].title).slice(0, 80)}` : '')
  const objLike = rows.filter((s) => String(s.title ?? '').includes('[object'))
  check('标题没变成 [object Object]', objLike.length === 0, objLike.length ? objLike[0].title : '')
  for (const s of rows.slice(0, 3)) {
    const when = s.createdAt ? new Date(s.createdAt).toLocaleString('zh-CN') : '无时间'
    console.log(`      · ${s.title || '(无标题，界面显示日期)'}  ${when}${s.running ? '  运行中' : ''}`)
  }
}

// 4. 没 token 必须被挡住——安全底线，每次都要验
//
// 2026-09-24 扩到新接口：权限档位那个接口能**把电脑提到完全权限**，工作区浏览能
// **看到各盘的目录结构**，新建会话能**让 Agent 真的开工**。这三样只要漏一个，
// 整条安全底线就穿了，所以它们必须和 /workspaces 一样逐条验。
for (const p of [
  '/mini/api/workspaces',
  '/mini/api/permissions',
  '/mini/api/browse/roots',
  '/mini/api/browse?path=' + encodeURIComponent('I:\\'),
]) {
  const anon = await fetch(`${base}${p}`)
  check(`匿名访问被拒 ${p.split('?')[0]}`, anon.status === 401, `HTTP ${anon.status}`)
}

// 5. 手机页面本身：新加的东西真的送到手机上了吗
const page = await fetch(`${base}/mini?token=${token}`)
const html = await page.text()
// 插件源码：有些规则只活在服务端（页面里看不到），比如「多长才认它是回答」
//
// 注意读的是**插件源码目录**（`tools/` 的上一级），不是数据目录 `DIR`
// （`~/.dsh/dsh-mini-remote`，那里只有 token、settings.json 和 bin）。
// 2026-09-22 这里原本写的是 `join(DIR, 'lib', 'index.js')`，直接 ENOENT 崩掉——
// 整层活体检查都跑不起来，而它本该是四层验证里的第三层。
const SRC = join(HERE, '..')
const pluginSrc = readFileSync(join(SRC, 'lib', 'index.js'), 'utf8')
check('手机页面能取到', page.status === 200 && html.length > 5000,
  `HTTP ${page.status}, ${html.length} 字节`)
for (const id of ['btnNav', 'navBody', 'btnNavClose', 'btnNavRefresh']) {
  check(`页面里有 id="${id}"`, html.includes(`id="${id}"`))
}
check('markdown 渲染器在', html.includes('function mdToHtml'))
check('复制有 execCommand 退路', html.includes("execCommand('copy')"))
check('设置里旧的会话下拉已移除', !html.includes('selSession'))
// 2026-09-21 用户裁决：两个按了没用的按钮、以及它们所在的两行，都从设置里撤掉
// （明文 http 下浏览器不给用）。知识记在代码注释和 tasks/lessons.md 里，不占界面。
//
// 2026-09-25 中间试过一半：Tailscale 那条路接上 HTTPS 之后，「锁屏也能提醒」回来过
// 一次。**当天晚些又撤了**——试到底的结论是手机锁屏会冻结后台页面，实时连接断掉，
// 回复到不了页面，没人去发通知。这一次不是"前提没到"，是"浏览器这条路本来就有上限"，
// 用户决定留到以后做成 App 时再说。
check('麦克风图标已移除', !html.includes('btnMic'))
// 2026-09-25 用户裁决：浏览器里不做系统通知了（试到底的结论是锁屏会冻结后台页面，
// 实时连接断掉，回复到不了页面）。**代码留着，只是不露出来**——所以查的是
// 「没有把它露出来的那行代码」，不是「这段代码不存在」。
check('系统通知那一行是藏着的', /id="rowNotify"[^>]*style="display:none"/.test(html))
// **不能直接 includes() 查它不在**：那行代码是注释掉留着的，字符串还在文件里，一查就命中
// （写测试的时候就这么错过一次，测试反过来抓住了我）。按行看：提到它的行必须都是注释。
const revealLines = html.split('\n').filter((l) => l.includes("rowNotify').style.display"))
check('那行代码以注释形式留着', revealLines.length > 0 && revealLines.every((l) => l.trim().startsWith('//')))
check('通知那段逻辑留着（将来做 App 用得上）', html.includes('showNotification'))
check('设置里没有「语音输入」这一行', !html.includes('micHint'))
// 手机上传文件：按钮、藏起来的文件选择器、附件小条，三样都得真的送到手机上
for (const id of ['btnAttach', 'filePick', 'attachBar']) {
  check(`上传那一套里有 id="${id}"`, html.includes(`id="${id}"`))
}
check('文件选择器是藏起来的', /id="filePick"[^>]*hidden/.test(html))
check('上传上限由服务端注入，页面里没有第二份',
  /var MAX_UPLOAD = \d+;/.test(html) && !html.includes('__MAX_UPLOAD__'))
// 回答流式生成：那段「正在写」的样式和渲染函数都得在
check('流式那一段有独立样式', html.includes('.live {') && html.includes('@keyframes caret'))
check('流式那一段由 liveBlock 渲染', html.includes('function liveBlock'))
check('快照里的 live 接得住', html.includes("if ('live' in snap)"))
// 旁白不许在手机上闪一下再消失（用户 2026-09-22：「出现又迅速消失，就像泄露出来的一样」）。
// 判据本身要到这一步末尾才知道，所以只能用长度兜底——插件源码里那条线得在。
check('太短的内容不往外露（旁白挡在门外）', /const STREAM_MIN_CHARS = \d+/.test(pluginSrc) &&
  /streaming\.text\.length < STREAM_MIN_CHARS/.test(pluginSrc))
// 流式一开始吐字，鲸鱼娘要让位（用户 2026-09-22 实机提的：回答在底下长出来了，
// 底下还挂着它，重复又抢注意力）
check('流式吐字时鲸鱼娘让位', /var busy = \(state\.running \|\| queued > 0\) && !state\.live/.test(html))
// 指令气泡和回答之间的间距要比同一条消息内部大（原来 10px 太挤）
{
  const css = html.slice(html.indexOf('.bubble {'), html.indexOf('.bubble.user'))
  const m = css.match(/margin-bottom:\s*(\d+)px/)
  check('指令和回答之间留够了间距', !!m && Number(m[1]) >= 16, `margin-bottom = ${m ? m[1] : '?'}px`)
}
// 鲸鱼娘那七个姿势是装饰性轮播，轮到哪张图跟 Agent 实际状态无关。
// 所以气泡里的话不许报忧——用户正在等结果，看到「不对劲」会当真。
// 用户 2026-09-22 实机指着「这里有点不对劲」问过这一句。
{
  const poses = html.slice(html.indexOf('var POSES = ['), html.indexOf('var POSE_MS'))
  const lines = [...poses.matchAll(/line:\s*'([^']*)'/g)].map((m) => m[1])
  const alarming = lines.filter((l) => /不对劲|出错|错误|失败|坏了|异常|有问题/.test(l))
  // 8 条里有一条是空串（冲刺那张不带词条），空串不参与报忧检查但也要数进来
  check('鲸鱼娘说的话不报忧', lines.length === 8 && alarming.length === 0,
    alarming.length ? `有问题的是：${alarming.join('、')}` : `${lines.length} 条，其中 ${lines.filter((l) => !l).length} 条故意留空`)
}
// 不带词条的姿势，气泡要整个收起来——留个空泡泡在那儿比不放更怪
check('空词条会把气泡收起来',
  /\$\('workBubble'\)\.hidden = !line;/.test(html) && /var line = POSES\[index\]\.line \|\| ''/.test(html))
// 冲刺是姿势之间的过渡，不是第 8 个姿势：序列得是「姿势→冲刺→姿势→冲刺」
check('轮播把冲刺插在每一对姿势之间', html.includes('function poseSequence') &&
  /if \(POSES\[i\]\.gap\) continue;/.test(html))
// 2026-09-22 改：这条原来叫「冲刺停得比姿势短」，写死 `GAP_MS = 2400`——
// 那是**被用户推翻的前提**（他两次要求拉长，现在冲刺和正常姿势一样长，都是 3600，
// 因为 2.4 秒「看着还是一闪而过」）。钉着旧数字等于钉着一条错的规则，只会以假警报咬人。
// 现在钉**结构**：冲刺走自己那个常量，将来要单独调它不必动 POSE_MS。
check('冲刺有自己的停留时长，不跟姿势共用',
  /POSES\[index\]\.gap \? GAP_MS : POSE_MS/.test(html) && /var GAP_MS = \d+/.test(html))
// 单帧模式下「正在执行」要加在上一条回答下面，不能把它顶掉
check('执行提示是加在下面的一条', html.includes('id="work"') && html.includes('work-progress'))
check('发指令时不再清空上一条回答', !/state\.latest\s*=\s*null/.test(html))

// 6b. 停止：按钮得真送到手机上，路由得真在
check('页面上有停止按钮', html.includes('id="btnStop"'))
check('停止按钮打的是 /mini/api/stop', html.includes("'/mini/api/stop'"))
// 路由是服务端建的：页面有按钮而路由没部署的话，按下去就是 404。
//
// 但这一条**经常会被跳过**，而且是故意的。两个原因：
//   1. 鉴权在路由**之前**，所以匿名那一发 401 证明不了路由存在（随便编个 api 路径也是 401），
//      得带 token 打一发才知道；
//   2. 带 token 真打一发就是**真停**——会打断你手上正在跑的任务。
//      而活体检查通常就是在一个正在跑的会话里执行的，running 多半是 true。
// 宁可不验，也不打断。路由本身在 test/plugin.test.mjs 里已经用真 HTTP 打过一遍了；
// 而「跑着的到底是不是这份代码」由上面的指纹那条把关。这里只是多一层保险。
if (state.body?.running) {
  check('停止路由（跳过：有任务正在跑，不去打断它）', true, 'running=true')
} else {
  const stopKnown = await post('/mini/api/stop', {})
  const stopUnknown = await post('/mini/api/nope', {})
  check('停止路由存在（不是 404）', stopKnown.status !== 404, `HTTP ${stopKnown.status}`)
  // 对照组：证明「不是 404」这个判据本身有效，而不是所有 POST 都返回非 404。
  check('对照：编出来的路由确实是 404', stopUnknown.status === 404, `HTTP ${stopUnknown.status}`)
}

// 6c. 排队：跑着也能发、排了什么看得见、能撤
//
// 这几条都是**只读**的，不像停止那条有副作用——它们查的是「快照里有没有队列这个字段」
// 和「页面上有没有那块东西」，不会去动用户手上的任务。
check('页面上有排队那一块', html.includes('id="queue"'))
check('页面上打的是 /mini/api/unqueue', html.includes("'/mini/api/unqueue'"))
check('跑着的时候不再禁用输入框和发送键',
  !/inputEl\.disabled\s*=\s*state\.running/.test(html)
  && !/\$\('btnSend'\)\.disabled\s*=\s*state\.running/.test(html))
const snapForQueue = await (await fetch(`${base}/mini/api/state?token=${token}`)).json()
check('快照里带队列字段，而且是个数组', Array.isArray(snapForQueue.queued),
  `queued = ${JSON.stringify(snapForQueue.queued)?.slice(0, 80)}`)
// 对照组：编出来的字段本来就不该在。证明上面那条不是「什么字段都算有」。
check('对照：快照里没有编出来的字段', !('definitelyNotAField' in snapForQueue))

// 6d. 聊天模式的气泡宽度
//
// 块级元素宽度默认撑满容器，只写 max-width 只是封了个顶——短消息会变成一个大方块。
// 这条钉的就是那个 fit-content 别被删掉。纯样式，没有别的验法。
check('聊天模式气泡按文字收（不是固定撑满）', /\.bubble \{[^}]*width:\s*fit-content/.test(html))
check('对照：气泡的 86% 封顶还在', /\.bubble \{[^}]*max-width:\s*86%/.test(html))

// 6e. 新加的三样：新建会话 / 权限档位 / 目录浏览
//
// 这三样离线测试里都验过逻辑了，但**离线测不出真机上接口到底通不通**——
// 2026-09-24 就是这么连着翻了两回车：单元测试 392 条全绿，真机上却是
// 「新建的工作区看不见」「权限档位点不动」。逻辑对，不等于接口通。
const ver = await get('/mini/api/version')
check('版本接口带新建会话的能力位', typeof ver.body?.canCreateSession === 'boolean',
  `canCreateSession = ${ver.body?.canCreateSession}`)

// 权限档位：手机界面直接照这两个字段画——名字是给人看的，dangerous 决定点它要不要
// 二次确认。所以两件都不能错：名字不能拿英文键名充数；危险标记必须**恰好一个**，
// 而且必须落在完全权限那一档上。标错就等于点一下直接提权、中间那道确认没了。
const perm = await get('/mini/api/permissions')
check('权限档位接口可用', perm.status === 200, `HTTP ${perm.status}`)
if (perm.status === 200 && perm.body?.ok) {
  const opts = perm.body.options ?? []
  check('读到权限档位', opts.length >= 2,
    `${opts.length} 档：${opts.map((o) => o.name).join(' / ')}`)
  const noName = opts.filter((o) => !o.name || o.name === o.value)
  check('每一档都有给人看的名字（不是拿英文键名充数）', noName.length === 0,
    noName.length ? `没名字的是 ${noName.map((o) => o.value).join(', ')}` : '')
  const danger = opts.filter((o) => o.dangerous)
  check('危险的档位恰好标了一个（多标少标都等于确认那一步失效）', danger.length === 1,
    danger.length ? `标在 ${danger[0].value}` : '一个都没标')
  check('标危险的那一档就是完全权限',
    danger.length === 1 && danger[0].value === 'danger-full-access',
    danger.length ? danger[0].value : '')
  check('当前档位在列表里（界面要能标出「现在是哪一档」）',
    opts.some((o) => o.value === perm.body.currentValue),
    `currentValue = ${perm.body.currentValue}`)
}

// 目录浏览：手机挑工作区走的就是它。除了「读得到」，还要验**当初定的那条边界**——
// 手机只看得到文件夹，看不到文件。这条边界现在是靠接口结构保证的（只回 dirs，
// 根本没有 files 那个字段），所以钉住「那个字段不存在」比钉住「过滤掉了」可靠。
const roots = await get('/mini/api/browse/roots')
check('常用位置读得到', roots.status === 200 && (roots.body?.drives?.length ?? 0) > 0,
  `家目录 + ${roots.body?.drives?.length ?? 0} 个盘 + ${roots.body?.recent?.length ?? 0} 个最近`)
const br = await get('/mini/api/browse?path=' + encodeURIComponent(homedir()))
check('浏览一个真实目录读得到', br.status === 200, `HTTP ${br.status}`)
if (br.status === 200) {
  check('浏览只回文件夹——结构上就没有「文件」这个字段',
    Array.isArray(br.body?.dirs) && !('files' in br.body) && !('entries' in br.body),
    `dirs = ${br.body?.dirs?.length ?? '?'}，顶层键 ${Object.keys(br.body ?? {}).join(',')}`)
}

// 6. 鲸鱼娘立绘：8 张都要真能取到，而且没登录的人拿不到
const POSES = [
  'work-1-ready', 'work-2-reading', 'work-3-typing', 'work-4-checking',
  'work-5-thinking', 'work-6-running', 'work-8-sprinting', 'work-7-waiting',
]
for (const p of POSES) {
  const r = await fetch(`${base}/mini/art/${p}.webp?token=${token}`)
  const buf = Buffer.from(await r.arrayBuffer())
  // WebP 的魔数：RIFF....WEBP。只看状态码不够——404 的 JSON 也是 200 字节的正文。
  const isWebp = buf.length > 1000 && buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP'
  check(`立绘 ${p} 取得到且是真 WebP`, r.status === 200 && isWebp,
    `HTTP ${r.status}, ${buf.length} 字节`)
}
const anonArt = await fetch(`${base}/mini/art/work-1-ready.webp`)
check('立绘匿名访问被拒', anonArt.status === 401, `HTTP ${anonArt.status}`)
const trav = await fetch(`${base}/mini/art/..%2F..%2Fpackage.json?token=${token}`)
check('立绘路径穿越被挡', trav.status === 404, `HTTP ${trav.status}`)
check('页面把立绘地址带上了 token', html.includes("'/mini/art/' + file + '.webp?token='"))
check('页面把构建指纹带上了立绘地址', html.includes("&v=' + encodeURIComponent(BUILD)"))
check('立绘是两帧雪碧图', html.includes('poseFlip') && html.includes('background-size: 244px 106px'))

// Tailscale 的 HTTPS 那条路（2026-09-24）。
//
// **只读，绝不去拨那个开关。** POST /mini-remote/serve 能真的开/关这台电脑上的
// Tailscale serve，探活脚本去拨它，等于每次跑检查都可能改掉用户的设置。
// 但只读也够：配对信息里带着 serve 的状态，那条 https 地址也带着。
//
// 用 adminBase：`/mini-remote/*` 注册在 DSH 自己的 web 服务上，不在插件这台。
const pairing = await fetch(`${adminBase}/mini-remote/pairing`)
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
  .catch((err) => ({ status: 0, body: null, error: String((err && err.message) || err) }))
check(
  '配对接口可用',
  pairing.status === 200,
  pairing.status ? `HTTP ${pairing.status}` : pairing.error,
)

// **先确认拿到的真是配对信息，再看里面有什么。**
// 拿到 404 的话，`serve` 字段自然不存在，下面每一条都会安静地走向「没问题」那一支——
// 2026-09-25 就假绿过一次：三项检查里两项红、第三项「不出现 https 那条」绿得毫无意义。
// 判据错的时候，绿比红危险。
const isPairing = Boolean(pairing.body && Array.isArray(pairing.body.entries))
check(
  '拿到的确实是配对信息，不是 404 之类',
  isPairing,
  isPairing ? `${pairing.body.entries.length} 条地址` : JSON.stringify(pairing.body).slice(0, 120),
)

if (isPairing) {
  const serve = pairing.body.serve
  check(
    '配对信息里带 serve 状态',
    typeof serve?.installed === 'boolean',
    JSON.stringify(serve),
  )
  const httpsEntry = pairing.body.entries.find((e) => e.kind === 'tailscale-https')
  if (serve?.on) {
    check(
      'serve 开着时，面板上有一条 https 的 Tailscale 地址',
      Boolean(httpsEntry) && /^https:\/\//.test(httpsEntry.url || ''),
      httpsEntry ? httpsEntry.url : '没找到',
    )
    if (httpsEntry) {
      // 真发一次请求。证书、代理、Host 头、token 校验，一次全过——这是唯一能证明
      // 「手机走这条路真的连得上」的办法，光看配置对不对说明不了问题。
      // 注意第一次可能要等十几秒（Tailscale 要去签证书），之后就快了。
      const vurl = `${String(serve.url || '').replace(/\/+$/, '')}/mini/api/version?token=${token}`
      const t0 = Date.now()
      const https = await fetch(vurl)
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
        .catch((err) => ({ status: 0, error: String((err && err.message) || err) }))
      check(
        '走 https 真能连上这台电脑，而且跑的是同一份代码',
        https.status === 200 && https.body?.build === mine,
        https.status ? `HTTP ${https.status}, ${Date.now() - t0}ms` : https.error,
      )
    }
  } else {
    check('serve 没开时，面板上不出现 https 那条', !httpsEntry, httpsEntry ? httpsEntry.url : '')
  }
}

// service worker：它只为系统通知而存在（见 lib/sw.js），但**响应头少一个就整个不工作**。
//
// 页面在 `/mini`，不在 `/mini/` 底下，而这个文件从 `/mini/sw.js` 发出去，默认作用域
// 只到 `/mini/`——够不着那个页面。少了 `Service-Worker-Allowed`，注册会直接失败，
// 而失败只在浏览器控制台里报，用户那边看到的是「开关开了但永远收不到通知」。
{
  const res = await fetch(`${base}/mini/sw.js`).catch(() => null)
  check('service worker 发得出来', Boolean(res && res.status === 200), res ? `HTTP ${res.status}` : '取不到')
  check(
    '带了 Service-Worker-Allowed，作用域放开到根',
    Boolean(res && res.headers.get('service-worker-allowed')),
    res ? String(res.headers.get('service-worker-allowed')) : '',
  )
}

console.log('')
console.log(problems.length ? `有 ${problems.length} 项没过：${problems.join('、')}` : '全部通过。')
// 用 exitCode 而不是 process.exit()：直接退会在 fetch 的 keep-alive 连接还开着时
// 触发 libuv 的 UV_HANDLE_CLOSING 断言，输出一堆吓人的红字（不影响结果，但很难看）。
process.exitCode = problems.length ? 1 : 0
