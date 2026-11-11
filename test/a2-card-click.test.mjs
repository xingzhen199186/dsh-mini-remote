import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const card = read('android/app/src/bridge/java/com/dsh/miniremote/ConfirmOverlay.java')

test('A2：确认卡窗口可获得焦点（真机点击失效的修复）', () => {
  // 注释里会提到“不再是 FLAG_NOT_FOCUSABLE”，判断前先把注释去掉，只看真正的代码。
  const code = card.replace(/\/\/[^\n]*/g, '')
  const params = code.slice(code.indexOf('WindowManager.LayoutParams next'), code.indexOf('try {'))
  assert.doesNotMatch(params, /FLAG_NOT_FOCUSABLE/, '不可获得焦点时荣耀上按钮收不到点击')
  assert.match(params, /FLAG_NOT_TOUCH_MODAL/, '卡片以外仍要能点到底下的界面')
  assert.match(code, /setFocusableInTouchMode\(true\)/)
  assert.match(code, /requestFocus\(\)/)
  // 不抢输入法：否则用户正在别的 App 打字时键盘会被顶掉。
  assert.match(code, /SOFT_INPUT_STATE_UNCHANGED/)
  assert.match(code, /SOFT_INPUT_ADJUST_NOTHING/)
})

test('A2：卡上倒计时每秒刷新，到点自己消失', () => {
  assert.match(card, /还剩 /)
  assert.match(card, /deadlineAt - System\.currentTimeMillis\(\)/)
  assert.match(card, /ticker\.postDelayed\(this, 250\)/)
  assert.match(card, /if \(left <= 0\)/)
  assert.match(card.slice(card.indexOf('void dismiss()')), /ticker\.removeCallbacks\(tick\)/)
})
