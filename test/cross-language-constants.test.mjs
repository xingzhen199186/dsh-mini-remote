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
