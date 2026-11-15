import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * ADB 配对引导的注入与文案（2026-11-15）。
 *
 * 这一行必须是 MainActivity 注入的，不能是页面写死的——否则网页端也会看到它。
 * 未配对/已配对两条文案分支都要在源码里，防止改丢。
 */

const activity = readFileSync(
  new URL('../android/app/src/main/java/com/dsh/miniremote/MainActivity.java', import.meta.url),
  'utf8'
)

const shellBackend = readFileSync(
  new URL('../android/app/src/main/java/com/dsh/miniremote/ShellBackend.java', import.meta.url),
  'utf8'
)

test('ADB 配对引导行由 MainActivity 注入，不是页面写死', () => {
  assert.match(activity, /miniAdbRow/, 'MainActivity 要注入 miniAdbRow')
  assert.match(activity, /miniAdbGo/, 'MainActivity 要注入 miniAdbGo 按钮')
  assert.match(activity, /miniAdbState/, 'MainActivity 要注入 miniAdbState 状态区')
})

test('未配对文案分支在源码里', () => {
  assert.match(activity, /手机执行命令（免 Termux）/, '标题要对')
  assert.match(activity, /电脑让手机跑命令时，不必安装 Termux。配对一次即可，约 1 分钟。/, '未配对说明要对')
  assert.match(activity, /开始配对/, '按钮文字要对')
})

test('已配对文案分支在源码里', () => {
  assert.match(activity, /已就绪。/, '已配对且无线调试开着时的文案')
  assert.match(activity, /已配对；无线调试没开时暂时用不了，会自动退回 Termux。/, '已配对但无线调试关着时的文案')
  assert.match(activity, /重新配对/, '已配对时按钮收成「重新配对」')
})

test('配对过程有进度提示', () => {
  assert.match(activity, /第 1 步：去开发者选项里打开「使用配对码配对设备」/, '等待端口提示')
  assert.match(activity, /第 2 步：看到端口了。在通知里填 6 位配对码/, '等待填码提示')
  assert.match(activity, /正在配对……/, '配对中提示')
  assert.match(activity, /配对成功！电脑现在可以直接指挥这台手机。/, '成功提示')
})

test('ShellBackend 兜底逻辑没被绕过', () => {
  // 自连通道失败必须返回 null，让 exec 退回 Termux。
  assert.match(shellBackend, /tryAdb.*return null/s, '自连失败要返回 null')
  assert.match(shellBackend, /TermuxRun\.exec/, '最终要退回 TermuxRun')
  assert.match(shellBackend, /reasonToSkip/, '没配对或要喂 stdin 时要跳过自连')
})

test('后台任务：自连通道与 Termux 退回', () => {
  // startJob / jobOutput / stopJob 在未配对时必须返回 null，让 BridgePoller 退回 Termux。
  assert.match(shellBackend, /static String startJob.*if \(!paired\(context\)\) return null/s, 'startJob 未配对要返回 null')
  assert.match(shellBackend, /static String jobOutput.*if \(!paired\(context\)\) return null/s, 'jobOutput 未配对要返回 null')
  assert.match(shellBackend, /static String stopJob.*if \(!paired\(context\)\) return null/s, 'stopJob 未配对要返回 null')
  // 自连通道的后台任务要用 setsid 脱离会话，输出与进程号写进 /data/local/tmp/.dsh_adb_jobs/。
  assert.match(shellBackend, /setsid sh -c/, '要用 setsid 起后台任务')
  assert.match(shellBackend, /\/data\/local\/tmp\/\.dsh_adb_jobs/, '输出与进程号要写进 .dsh_adb_jobs')
  // 停止要按进程组停，停完回读确认。
  assert.match(shellBackend, /kill -9 -- -\\"\$p\\"/, '停止要杀进程组')
  assert.match(shellBackend, /kill -0 \\"\$p\\"/, '停完要回读确认')
})

test('手机终端：三种通道文案分支都在', () => {
  assert.match(activity, /走自连通道：电脑执行命令不需要 Termux。/, 'adb 文案')
  assert.match(activity, /已配对；无线调试没开时暂时用不了，会退回 Termux。/, '已配对但无线调试没开文案')
  assert.match(activity, /走 Termux 执行命令。/, 'termux 文案')
  assert.match(activity, /还不能执行命令：既没配对自连通道，也没装 Termux。/, 'none 文案')
})

test('termuxState 里没有 refresh / sleep / connectEndpoint 这类阻塞调用', () => {
  const termuxState = activity.match(/public String termuxState\(\)[\s\S]*?\n        \}/)
  assert.ok(termuxState, 'termuxState 要存在')
  const body = termuxState[0]
  assert.doesNotMatch(body, /refresh/, 'termuxState 里不许调 refresh')
  assert.doesNotMatch(body, /sleep/, 'termuxState 里不许调 sleep')
  assert.doesNotMatch(body, /connectEndpoint/, 'termuxState 里不许调 connectEndpoint')
})

test('ShellBackend.backendState 判定正确', () => {
  // backendState 要用 ShellBackend.paired() 和 AdbDiscover.snapshot()，不许调 connectEndpoint。
  assert.match(shellBackend, /static String backendState/, 'backendState 要存在')
  assert.match(shellBackend, /AdbDiscover\.snapshot\(\)/, 'backendState 要用 snapshot()')
  const backendStateBody = shellBackend.match(/static String backendState[\s\S]*?\n    \}/)
  assert.ok(backendStateBody, 'backendState 方法体要存在')
  assert.doesNotMatch(backendStateBody[0], /connectEndpoint/, 'backendState 里不许调 connectEndpoint')
  // backend 字段要表达"现在实际会走哪条"：adb / termux / none。
  assert.match(shellBackend, /backend = "adb"/, 'adbReady 时 backend 要是 adb')
  assert.match(shellBackend, /backend = "termux"/, 'termux 可用时 backend 要是 termux')
  assert.match(shellBackend, /backend = "none"/, '都没有时 backend 要是 none')
})
