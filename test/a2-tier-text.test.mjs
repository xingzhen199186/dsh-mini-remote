import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const control = read('android/app/src/main/java/com/dsh/miniremote/ConfirmationControl.java')
const overlay = read('android/app/src/bridge/java/com/dsh/miniremote/ConfirmOverlay.java')
const notifier = read('android/app/src/main/java/com/dsh/miniremote/Notifier.java')

test('档位文字互斥：本任务说“本轮不再询问”，每次说“本次有效”', () => {
  assert.match(control, /本轮不再询问/)
  assert.match(control, /本次有效/)
  // 两句话不能出现在同一个分支里，否则档位又分不出来了。
  const task = control.slice(control.indexOf('String modeText()'), control.indexOf('String actionText()'))
  assert.match(task, /if \(ConfirmationState\.TASK\.equals\(mode\)\) return "本轮不再询问";/)
  assert.match(task, /return "本次有效，下个动作还会问";/)
})

test('屏幕上的卡也印出档位，不只通知里印', () => {
  assert.match(overlay, /tier\.setText\(card\.modeText\(\)\)/)
  assert.doesNotMatch(overlay, /setText\("本轮不再询问"\)/, '文案只该有一个来源')
})

test('通知正文同样带档位说明', () => {
  const body = control.slice(control.indexOf('String bodyText()'), control.indexOf('final class Decision'))
  assert.match(body, /modeText\(\)/)
  assert.match(notifier, /card\.bodyText\(\)/)
})
