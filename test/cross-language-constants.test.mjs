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

test('自研终端：走系统 sh，不依赖 Termux，并说清边界', () => {
  const shell = read('android/app/src/main/java/com/dsh/miniremote/NativeShell.java')
  // 必须用 ProcessBuilder 传参数，不能用 Runtime.exec 拼字符串（引号会被错误拆分）。
  assert.match(shell, /new ProcessBuilder\("\/system\/bin\/sh", "-c", command\)/)
  assert.doesNotMatch(shell, /Runtime\.getRuntime\(\)\.exec\(/)
  // 要有超时兜底，否则挂住的命令会一直占着。
  assert.match(shell, /process\.waitFor/)
  assert.match(shell, /process\.destroy\(\)/)
  // 边界要写在代码里：本 App 身份、看不到 SAF 工作文件夹。
  assert.match(shell, /看不到用户在系统选择器里选的那个工作文件夹/)
  // 界面里要有三块：终端、Termux 指引、阿尔卑斯说明。
  const activity = read('android/app/src/main/java/com/dsh/miniremote/MainActivity.java')
  // 2026-11-12 用户要求：终端独立成页，不塞在设置里。
  const terminal = read('android/app/src/main/java/com/dsh/miniremote/TerminalActivity.java')
  assert.match(terminal, /class TerminalActivity/)
  assert.match(activity, /TerminalActivity\.class/)
  assert.doesNotMatch(activity, /miniTermOut/)
  assert.match(activity, /allow-external-apps = true/)
  // 2026-11-12 用户否决了"内置系统"那条路，界面上不该再出现它的入口。
  assert.doesNotMatch(activity, /阿尔卑斯/)
})

test('终端用真 PTY（Termux 的 Apache 模块），不是"发一条命令等结果"', () => {
  const terminal = read('android/app/src/main/java/com/dsh/miniremote/TerminalActivity.java')
  // 真的会话对象 + 真的终端控件。
  assert.match(terminal, /new TerminalSession\(/)
  assert.match(terminal, /new TerminalView\(/)
  assert.match(terminal, /attachSession\(/)
  // 常用控制键要能发出去（手机键盘上没有 Esc/Ctrl）。
  assert.match(terminal, /\\u001b\[A/)   // 上箭头
  assert.match(terminal, /\\u0003/)      // Ctrl-C
  // 预编译的本地库必须随模块带上，否则会话起不来。
  const exists = (() => {
    try { read('android/terminal-emulator/src/main/jniLibs/arm64-v8a/libtermux.so'); return true }
    catch { return false }
  })()
  assert.ok(exists, 'libtermux.so 不在 jniLibs 里')
  // 许可声明必须留档。
  const notices = read('android/THIRD-PARTY-NOTICES.md')
  assert.match(notices, /Apache License 2\.0/)
  assert.match(notices, /GPLv3/)
})

test('终端的能力边界必须写在设置页上', () => {
  const activity = read('android/app/src/main/java/com/dsh/miniremote/MainActivity.java')
  const row = activity.indexOf('miniTerminalGo')
  assert.ok(row > 0, '设置页里没有终端那一行')
  const around = activity.slice(Math.max(0, row - 1200), row)
  // 三条边界，缺一条都会让人误判能力。
  assert.match(around, /装不了新命令/, '没写"装不了新命令"')
  assert.match(around, /App 自己的目录/, '没写只能碰 App 自己的目录')
  assert.match(around, /工作文件夹要用下面的文件工具/, '没写工作文件夹要走文件工具')
  assert.match(around, /碰不到别的 App 的数据/, '没写不是 root')
})
