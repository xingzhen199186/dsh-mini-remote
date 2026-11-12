import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 电脑和手机靠字符串约定对话（动作名、通知类型）。
 * 打错一个字母不会报错，只会静静地"永远不生效"——和 2026-11-12 那个
 * 字符串 == 属于同一类静默失败，所以这里把两边的字面量摆在一起核对。
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const host = read('lib/index.js')
const poller = read('android/app/src/main/java/com/dsh/miniremote/BridgePoller.java')
const bridge = read('lib/bridge.js')

// 电脑侧写的是 name: 'phone_xxx'，手机侧写的是 "phone_xxx".equals(tool)。
const hostNames = (text) => new Set([...text.matchAll(/name: '(phone_[a-z_]+)'/g)].map((m) => m[1]))
const phoneNames = (text) => new Set([...text.matchAll(/"(phone_[a-z_]+)"/g)].map((m) => m[1]))

test('电脑与手机认识同一批手机动作', () => {
  // 只比**真的发给手机**的那些：read/write/edit/glob/grep 是在电脑这侧翻译成命令再发出的，
  // 手机上并不需要认识它们。
  const forwarded = new Set([
    ...[...host.matchAll(/callPhone\('(phone_[a-z_]+)'/g)].map((m) => m[1]),
    ...[...host.matchAll(/phoneBridge\.call\([^,]+,\s*'(phone_[a-z_]+)'/g)].map((m) => m[1]),
  ])
  const onHost = forwarded
  const onPhone = phoneNames(poller)
  assert.ok(onHost.size >= 10, `电脑侧动作太少：${onHost.size}`)
  assert.deepEqual(
    [...onPhone].sort(),
    [...onHost].sort(),
    '两边的手机动作名必须完全一致，否则某个动作会静静地永远不生效',
  )
})

test('电脑发出的任务结束通知，手机认的是同一个名字', () => {
  assert.match(bridge, /kind: 'task-ended'/)
  assert.match(poller, /"task-ended"\.equals\(notice\.optString\("kind"\)\)/)
})

test('每个手机工具都真的被注册（不是被挤成别人参数）', () => {
  // 2026-11-12 真事故：插新工具时少了一个 `}))`，于是下一个工具对象变成了
  // defineTool 的第二个参数——不报错、不崩，那个工具直接消失。
  const firmly = [...host.matchAll(/name: '(phone_[a-z_]+)',/g)]
  assert.ok(firmly.length >= 12, `工具数量异常：${firmly.length}`)
  // 坏形状：`},` 后面紧跟 `{` 再紧跟 name，说明被并进了上一个 defineTool。
  assert.doesNotMatch(host, /\},\n\s*\{\n\s*name: 'phone_/)
  // 注册调用数必须不少于工具数，否则有工具没有自己的 register。
  const registers = [...host.matchAll(/tools\.register\(defineTool\(\{/g)].length
  assert.ok(registers >= firmly.length, `注册数 ${registers} 少于工具数 ${firmly.length}`)
})

test('有 Termux 才优先走终端，没有就回落点屏幕（两条都保留）', () => {
  const bridge = read('lib/bridge.js')
  const server = read('lib/server.js')
  // 手机随心跳上报，电脑记下来。
  assert.match(server, /termux: url\.searchParams\.get\('termux'\) === '1'/)
  assert.match(bridge, /if \(typeof info\.termux === 'boolean'\) entry\.termux = info\.termux/)
  // 指引必须分两种情形，且都保留无障碍那条路。
  assert.match(host, /if \(!armed\.termux\)/)
  assert.match(host, /do not call phone_shell/)
  // 现在有三条路：本机文件（不依赖 Termux）、终端（有 Termux 时）、无障碍（界面）。
  assert.match(host, /All routes stay available/)
  // 不给终端单独编"永远确认"的规则：确认档位仍是那三档。
  assert.doesNotMatch(host, /phone_shell[\s\S]{0,200}alwaysConfirm/)
})

test('手机文件能力走系统选择器，不碰"所有文件访问"', () => {
  // 商店只允许核心功能是文件管理的应用申请 MANAGE_EXTERNAL_STORAGE；
  // 我们不是文件管理器，硬报会被驳回——所以必须完全不声明它。
  const manifest = read('android/app/src/main/AndroidManifest.xml')
  assert.doesNotMatch(manifest, /MANAGE_EXTERNAL_STORAGE/)
  const activity = read('android/app/src/main/java/com/dsh/miniremote/MainActivity.java')
  assert.match(activity, /Intent\.ACTION_OPEN_DOCUMENT_TREE/)
  // 取持久授权，否则重启后又要用户重选。
  assert.match(activity, /takePersistableUriPermission/)
  // 只用 app: 与 work: 两种位置。
  const files = read('android/app/src/main/java/com/dsh/miniremote/NativeFiles.java')
  assert.match(files, /app:/)
  assert.match(files, /work:/)
})

test('终端只保留后台能力，界面上不出现', () => {
  const activity = read('android/app/src/main/java/com/dsh/miniremote/MainActivity.java')
  // 2026-11-12 用户决定：删掉全屏终端页，只留后台 phone_sh。
  assert.doesNotMatch(activity, /TerminalActivity/)
  assert.doesNotMatch(activity, /miniTerminalGo/)
  // 后台能力本身必须还在。
  const host = read('lib/index.js')
  assert.match(host, /name: 'phone_sh'/)
  const poller = read('android/app/src/main/java/com/dsh/miniremote/BridgePoller.java')
  assert.match(poller, /"phone_sh"\.equals\(tool\)/)
  const shell = read('android/app/src/main/java/com/dsh/miniremote/NativeShell.java')
  assert.match(shell, /new ProcessBuilder\("\/system\/bin\/sh", "-c", command\)/)
})

test('子页面能滑动返回，主页面不抢网页的横滑', () => {
  const swipe = read('android/app/src/main/java/com/dsh/miniremote/SwipeBack.java')
  // 只在左边缘、并且先横着走才算返回手势。
  assert.match(swipe, /EDGE_DP/)
  assert.match(swipe, /Math\.abs\(dy\) > Math\.abs\(dx\)/)
  // 阈值不能按"屏宽四分之一"算（那段划起来像没反应，2026-11-12 反馈过）。
  assert.doesNotMatch(swipe, /widthPixels \/ 4/)
  assert.match(swipe, /80 \* getResources\(\)\.getDisplayMetrics\(\)\.density/)
  // 三个子页面都要装上。
  for (const page of ['PairActivity', 'LineConfigActivity', 'CaptureActivity']) {
    assert.match(read(`android/app/src/main/java/com/dsh/miniremote/${page}.java`), new RegExp(`SwipeBack\\.install\\(this\\)`), `${page} 没装滑动返回`)
  }
  // 主页面是网页壳，不能装（会跟网页的横向手势打架）。
  const main = read('android/app/src/main/java/com/dsh/miniremote/MainActivity.java')
  assert.doesNotMatch(main, /SwipeBack\.install/)
})

test('手机页有自己的边缘滑动返回，且不动网页端', () => {
  const page = read('lib/page-app.js')
  // 只在我们这份手机页里；网页端不加载它。
  assert.match(page, /边缘滑动返回/)
  assert.match(page, /function backTarget\(\)/)
  // 四类页面都要能返回：子代理会话页、子代理列表、文件/指令面板、代码建的面板。
  assert.match(page, /subagentsBack/)
  assert.match(page, /subagentsClose/)
  assert.match(page, /opsClose/)
  // 没有可关的东西时什么都不做（不许把浏览器后退带出来）。
  assert.doesNotMatch(page, /history\.back\(\)/)
  // 只在左边缘起手。
  assert.match(page, /clientX <= 24/)
})

test('「手机终端」「工作文件夹」与「屏幕操作」平级', () => {
  const activity = read('android/app/src/main/java/com/dsh/miniremote/MainActivity.java')
  // 三件事各管一摊，谁也不该藏在谁的展开体里（2026-11-12 用户要求）。
  assert.match(activity, /termuxRow\.className='row'/)
  assert.match(activity, /workRow\.className='row'/)
  // 三块平级（2026-11-12 用户定的层次）：屏幕操作展开后才有「无障碍/确认档位/最近操作」。
  assert.match(activity, /a11y\.insertAdjacentElement\('afterend',termuxRow\)/)
  assert.match(activity, /termuxRow\.insertAdjacentElement\('afterend',workRow\)/)
  assert.match(activity, />无障碍</)
  assert.match(activity, />确认档位</)
  assert.match(activity, />最近操作</)
  // 箭头固定格宽并居中，不跟着状态文字漂。
  assert.match(activity, /#miniA11yChev\{flex:0 0 18px/)
  // 标题字号要跟别的分类一致：不许在这里写死 font-size（2026-11-12 用户反馈过小一号）。
  assert.doesNotMatch(activity, /#miniA11yHead\{[^}]*font-size/)
})

test('装好 Termux 之后就不再讲怎么装', () => {
  const activity = read('android/app/src/main/java/com/dsh/miniremote/MainActivity.java')
  // 说明要有 id，才能按状态显示/隐藏。
  assert.match(activity, /id=\\"miniTermuxHow\\"/)
  // 只在"没装"时显示：装了（不管有没有授权）都收起。
  assert.match(activity, /how\.hidden=st\.installed===true/)
})

test('左边缘要先从系统手势里排除，否则滑动永远收不到触摸', () => {
  const swipe = read('android/app/src/main/java/com/dsh/miniremote/SwipeBack.java')
  assert.match(swipe, /setSystemGestureExclusionRects/)
  const main = read('android/app/src/main/java/com/dsh/miniremote/MainActivity.java')
  // 2026-11-12 真机：网页里的边缘滑动一次都没触发，就是缺这一句。
  assert.match(main, /excludeEdgeFromSystemGestures/)
  assert.match(main, /setSystemGestureExclusionRects/)
})
