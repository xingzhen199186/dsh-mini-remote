import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const card = read('android/app/src/bridge/java/com/dsh/miniremote/ConfirmOverlay.java')
const notifier = read('android/app/src/main/java/com/dsh/miniremote/Notifier.java')

// 2026-11-11 真机推翻了“让浮层可获得焦点就能点”的判断：荣耀在系统层就不允许
// 无障碍浮层接收触摸（AppOps CREATE_ACCESSIBILITY_OVERLAY）。确认入口因此整体
// 挪到通知，浮层降级为纯展示——下面锁住的是新事实，而不是那个被推翻的修法。
test('A2：浮层按钮走 onTouch，和能点的停止胶囊同一套', () => {
  // 2026-11-11 纠错：之前把"点不动"误判为系统禁止浮层触摸。
  // 真正的差别是 Button+onClick（等系统派发） vs TextView+onTouch（自己收事件）。
  // 现在锁的是后一种接法，别再改回 Button.onClick。
  assert.match(card, /setOnTouchListener/)
  assert.match(card, /MotionEvent\.ACTION_UP/)
  assert.match(card, /answerCard\(card\.id/)
  assert.doesNotMatch(card.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''), /new Button|setOnClickListener/)
})

test('A2：卡上倒计时每秒刷新，到点自己消失', () => {
  assert.match(card, /还剩 /)
  assert.match(card, /deadlineAt - System\.currentTimeMillis\(\)/)
  assert.match(card, /ticker\.postDelayed\(this, 250\)/)
  assert.match(card, /if \(left <= 0\)/)
  assert.match(card.slice(card.indexOf('void dismiss()')), /ticker\.removeCallbacks\(tick\)/)
})

test('A2：确认按钮由系统绘制的通知提供', () => {
  assert.match(notifier, /addAction/)
  assert.match(notifier, /PendingIntent\.getBroadcast/)
})
