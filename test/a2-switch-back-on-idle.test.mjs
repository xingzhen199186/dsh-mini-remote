import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('切回档位只发生在代理空闲，不在 turn/end 或工具调用之间', () => {
  const index = read('lib/index.js')
  // turn/end 在每一步之后都会发，拿它当"任务做完"会让每步重新问一次。
  const hook = index.slice(index.indexOf("ctx.on('agent/status'"))
  assert.match(hook.slice(0, 1200), /status === 'idle'[\s\S]{0,300}taskEnded/)
  // turn/end 不能再触发切回。
  const turnEnd = index.indexOf("event?.type === 'turn/end'")
  if (turnEnd > 0) {
    assert.doesNotMatch(index.slice(turnEnd, turnEnd + 200), /taskEnded/)
  }
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
