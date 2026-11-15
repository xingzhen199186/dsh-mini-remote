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
