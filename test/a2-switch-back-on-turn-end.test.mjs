import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('切回档位只发生在 turn/end，不在工具调用之间', () => {
  const index = read('lib/index.js')
  // 只允许 turn/end 触发 taskEnded。
  assert.match(index, /event\?\.type === 'turn\/end'[\s\S]{0,120}phoneBridge\.taskEnded/)
  // tool 相关事件不能触发切回。
  assert.doesNotMatch(index, /tool\/call'[\s\S]{0,80}taskEnded/)
})

test('电脑把任务结束放进轮询回应，手机取走即清', () => {
  const bridge = read('lib/bridge.js')
  assert.match(bridge, /notices: take \? takeNotices\(deviceId\) : \[\]/)
  assert.match(bridge, /kind: 'task-ended'/)
  // 取走即清，避免同一条反复触发。
  assert.match(bridge, /notices\.delete\(deviceId\)/)
})

test('手机收到后只在任务编号吻合时切回', () => {
  const control = read('android/app/src/main/java/com/dsh/miniremote/ConfirmationControl.java')
  assert.match(control, /static void onTaskEnded\(String taskId\)/)
  assert.match(control, /!autoOff\.equals\(taskId\)\) return;/)
  assert.match(control, /setSelectedMode\(app, ConfirmationState\.TASK\)/)
})
