import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const poller = read('android/app/src/main/java/com/dsh/miniremote/BridgePoller.java')
const log = read('android/app/src/main/java/com/dsh/miniremote/ActionLog.java')

test('C1：超时只停当前任务，不撤桥', () => {
  assert.match(poller, /IDLE_TIMEOUT_MS = 10L \* 60 \* 1000/)
  assert.match(poller, /TASK_LAST_ACTION/)
  // phone_status 不参与超时判定，桥保持可用。
  assert.match(poller, /!"phone_status"\.equals\(tool\)/)
})

test('D1：记录最多 50 条，标签先打码，不记正文', () => {
  assert.match(log, /MAX = 50/)
  assert.match(log, /SensitiveText\.mask/)
  // 原子写入：先临时文件再改名，写一半被杀也不留半个 JSON。
  assert.match(log, /FILE \+ "\.tmp"/)
  assert.match(log, /renameTo/)
})

test('D1：每个动作结束都落一条记录', () => {
  assert.match(poller, /ActionLog\.record\(context, activeTool, activeTarget, ok\)/)
})
