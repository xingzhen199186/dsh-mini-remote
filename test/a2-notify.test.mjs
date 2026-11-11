import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const notifier = read('android/app/src/main/java/com/dsh/miniremote/Notifier.java')
const control = read('android/app/src/main/java/com/dsh/miniremote/ConfirmationControl.java')
const receiver = read('android/app/src/main/java/com/dsh/miniremote/ConfirmActionReceiver.java')
const overlay = read('android/app/src/bridge/java/com/dsh/miniremote/ConfirmOverlay.java')
const manifest = read('android/app/src/main/AndroidManifest.xml')

test('A2：确认走通知，三个按钮由 PendingIntent 广播派发', () => {
  assert.match(notifier, /IMPORTANCE_HIGH/)
  assert.match(notifier, /"电脑想操作你的手机"/)
  assert.match(notifier, /PendingIntent\.getBroadcast/)
  assert.ok(notifier.includes('允许本任务') && notifier.includes('拒绝') && notifier.includes('允许'))
  assert.match(notifier, /ConfirmationState\.TASK\.equals\(card\.mode\)/)
  // 重写后：不做固定类名广播，而是每道题一个随机 action（旧通知的按钮命中不了新题）。
  assert.match(notifier, /MINI_CONFIRM\./)
  assert.match(notifier, /RECEIVER_NOT_EXPORTED/)
})

test('A2：通知按钮复用同一套状态机，不另写一份答案处理', () => {
  assert.match(receiver, /ConfirmationControl\.answerCard\(/)
  assert.doesNotMatch(receiver, /state\.grantCurrentTask|settle\(|writeLocalArmed/)
  // 只认当前这张卡：连点或点旧通知，第二次返回 false。
  assert.match(control, /cardId == null \|\| !cardId\.equals\(current\.card\.id\)/)
  assert.match(control, /if \(pending != current\) return;/)
})

test('A2：允许、拒绝、超时都撤通知，且同一时刻只有一条', () => {
  assert.match(control, /Notifier\.cancelConfirmCard\(current\.app, current\.card\.id\)/)
  assert.match(notifier, /confirmNotificationId/)
  // 新卡在状态机里排队，不会叠加出第二条通知。
  assert.match(control, /if \(pending == null\)/)
})

test('A2：通知发不出去时立刻失败，不空等 90 秒', () => {
  assert.match(control, /if \(!Notifier\.canPostConfirm\(app\)\)/)
  assert.match(control, /confirm_unavailable/)
  assert.match(notifier, /areNotificationsEnabled/)
})

test('A2：浮层可点，按钮自己收触摸事件', () => {
  assert.match(overlay, /setOnTouchListener/)
  assert.match(overlay, /ACTION_UP/)
  assert.doesNotMatch(overlay.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''), /new Button|setOnClickListener/)
  assert.match(overlay, /还剩 /)
})

test('A2：默认档仍然不碰通知这条路', () => {
  // 快路径必须排在“能不能发通知”这道检查之前，默认档才不会被通知权限拖慢。
  const fast = control.indexOf('ConfirmationState.OFF.equals(selected) && !state.needsExtendedDeadline(selected)')
  const allow = control.indexOf('return allow();', fast)
  const gate = control.indexOf('if (!Notifier.canPostConfirm(app))')
  assert.ok(fast > 0 && allow > fast && gate > allow, '默认档快路径要先于通知权限检查')
})
