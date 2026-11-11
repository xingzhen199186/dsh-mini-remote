import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('任务边界是人发新指令，不是 turn/end 或代理空闲', () => {
  const index = read('lib/index.js')
  // user/message 且 source.kind === 'user' 才通知手机切回。
  assert.match(index, /event\?\.type === 'user\/message' && event\.data\?\.source\?\.kind === 'user'/)
  assert.match(index, /phoneBridge\.taskEnded\(session\.id\)/)
  // 那两条"每步都发"的事件不能再触发切回。
  const turnEnd = index.indexOf("event?.type === 'turn/end'")
  if (turnEnd > 0) assert.doesNotMatch(index.slice(turnEnd, turnEnd + 220), /taskEnded/)
  const statusHook = index.slice(index.indexOf("ctx.on('agent/status'"))
  assert.doesNotMatch(statusHook.slice(0, 800), /phoneBridge\.taskEnded/)
})

test('电脑把任务结束放进轮询回应，手机取走即清', () => {
  const bridge = read('lib/bridge.js')
  assert.match(bridge, /notices: take \? takeNotices\(deviceId\) : \[\]/)
  assert.match(bridge, /kind: 'task-ended', sessionId/)
  assert.match(bridge, /notices\.delete\(deviceId\)/)
})

test('手机按会话切回，不按轮次（轮次每步都变）', () => {
  const control = read('android/app/src/main/java/com/dsh/miniremote/ConfirmationControl.java')
  assert.match(control, /sessionOfTask\(current\.card\.taskId\)/)
  assert.match(control, /autoOff\.equals\(sessionId\)/)
  assert.match(control, /setSelectedMode\(app, ConfirmationState\.TASK\)/)
})

test('档位是字符串，必须用 equals 比较（== 只会比对象）', () => {
  const control = read('android/app/src/main/java/com/dsh/miniremote/ConfirmationControl.java')
  // 2026-11-11 根因：`card.mode == ConfirmationState.TASK` 永远为假，
  // 于是"允许"只放行一次，每步都弹卡。
  assert.doesNotMatch(control, /\bmode == ConfirmationState\./)
  assert.doesNotMatch(control, /card\.mode == ConfirmationState\./)
  assert.match(control, /ConfirmationState\.TASK\.equals\(current\.card\.mode\)/)
})
