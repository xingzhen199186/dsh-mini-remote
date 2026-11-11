import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('自动切回已停用：允许一次之后一直不问', () => {
  const index = read('lib/index.js')
  // turn/end 与 agent 空闲都会在每个工具步之间触发，拿它们当"任务做完"
  // 会让"允许一次"每步重新武装成弹卡。现在两条都不再通知手机。
  const turnEnd = index.indexOf("event?.type === 'turn/end'")
  if (turnEnd > 0) assert.doesNotMatch(index.slice(turnEnd, turnEnd + 200), /taskEnded/)
  const statusHook = index.slice(index.indexOf("ctx.on('agent/status'"))
  assert.doesNotMatch(statusHook.slice(0, 800), /phoneBridge\.taskEnded/)
})

test('电脑把任务结束放进轮询回应，手机取走即清', () => {
  const bridge = read('lib/bridge.js')
  assert.match(bridge, /notices: take \? takeNotices\(deviceId\) : \[\]/)
  assert.match(bridge, /kind: 'task-ended'/)
  assert.match(bridge, /notices\.delete\(deviceId\)/)
})

test('手机收到后只在任务编号吻合时切回', () => {
  const control = read('android/app/src/main/java/com/dsh/miniremote/ConfirmationControl.java')
  assert.match(control, /static void onTaskEnded\(String taskId\)/)
  assert.match(control, /!autoOff\.equals\(taskId\)\) return;/)
  assert.match(control, /setSelectedMode\(app, ConfirmationState\.TASK\)/)
})

test('浮层与通知的"允许"都给整轮授权', () => {
  const overlay = read('android/app/src/bridge/java/com/dsh/miniremote/ConfirmOverlay.java')
  // 本任务档的"允许"必须传 grantTask=true。
  const task = overlay.slice(overlay.indexOf('ConfirmationState.TASK.equals(card.mode)'))
  assert.match(task.slice(0, 400), /answerCard\(card\.id, true, true\)/)
})
