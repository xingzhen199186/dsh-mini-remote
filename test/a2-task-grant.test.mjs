import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const control = read('android/app/src/main/java/com/dsh/miniremote/ConfirmationControl.java')
const poller = read('android/app/src/main/java/com/dsh/miniremote/BridgePoller.java')
const bridgeControl = read('android/app/src/main/java/com/dsh/miniremote/BridgeControl.java')

test('轮询换代只终止在等的卡，不许清掉本轮已允许', () => {
  assert.match(control, /static void cancelPending\(\)/)
  const pending = control.slice(control.indexOf('static void cancelPending()'), control.indexOf('static void cancelAll('))
  assert.doesNotMatch(pending, /state\.clear\(\)/, '换代不该抹掉任务授权')
  // 轮询停止走 cancelPending，而不是 cancelAll。
  assert.match(poller, /ConfirmationControl\.cancelPending\(\)/)
  assert.doesNotMatch(poller, /ConfirmationControl\.cancelAll\(/)
})

test('整个手机桥关掉时才清任务授权', () => {
  assert.match(bridgeControl, /ConfirmationControl\.cancelAll\(app\)/)
  const all = control.slice(control.indexOf('static void cancelAll('))
  const body = all.slice(0, all.indexOf('\n    static '))
  assert.match(body, /state\.clear\(\)/)
  assert.match(body, /forgetGrant\(/)
})

test('本轮授权落盘，进程被杀也能续上；换一轮自动作废', () => {
  assert.match(control, /GRANT_TASK/)
  assert.match(control, /rememberGrant\(target\.app, target\.card\.taskId\)/)
  assert.match(control, /String storedGrant = storedGrant\(app\)/)
  assert.match(control, /taskId\.equals\(storedGrant\)/)
  // 编号变了就把盘上那条清掉，避免"上一轮的允许"跨轮生效。
  assert.match(control, /!storedGrant\.equals\(taskId\) && !taskId\.isEmpty\(\)/)
})
