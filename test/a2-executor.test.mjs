import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const poller = read('android/app/src/main/java/com/dsh/miniremote/BridgePoller.java')

const between = (text, from, to) => {
  const start = text.indexOf(from)
  if (start < 0) return ''
  const end = text.indexOf(to, start + from.length)
  return text.slice(start, end < 0 ? text.length : end)
}

test('轮询与执行分离：轮询线程只排队，不执行动作、不等确认', () => {
  const handle = between(poller, 'private void handleCalls(', 'private void executeCall(')
  assert.match(handle, /pool\.execute\(\(\) -> executeCall\(call, token\)\)/)
  // 轮询线程里一旦出现确认请求或具体工具分支，就说明它又被拖回去执行了。
  assert.doesNotMatch(handle, /ConfirmationControl\.request/)
  assert.doesNotMatch(handle, /"phone_notify"\.equals|"phone_tap"\.equals/)
})

test('执行线程是单线程，保证动作串行与最多一张卡', () => {
  assert.match(poller, /Executors\.newSingleThreadExecutor/)
  assert.match(poller, /"mini-bridge-action"/)
})

test('停止会打断等确认的动作并收掉执行线程', () => {
  const stop = between(poller, 'private void stopLocked()', 'boolean isOnline()')
  assert.match(stop, /ConfirmationControl\.cancelPending\(\)/)
  assert.match(stop, /pool\.shutdownNow\(\)/)
})

test('动作线程不碰心跳、重连与补报武装', () => {
  const call = between(poller, 'private void executeCall(', '确认卡只拿目标标签')
  assert.doesNotMatch(call, /rearmIfNeeded|refreshBaseUrlFromPrefs|firstPoll|nextBackoff|sleepQuietly/)
})

test('结果由动作线程自己发，不依赖轮询线程还活着', () => {
  const report = between(poller, 'private void reportRaw(', '连不上几次之后')
  assert.match(report, /new Thread\(/)
  assert.match(report, /\/mini\/api\/bridge\/result/)
})

test('确认等待能被随时叫停，不必等满 90 秒', () => {
  const control = read('android/app/src/main/java/com/dsh/miniremote/ConfirmationControl.java')
  assert.match(control, /interface Abort/)
  assert.match(control, /abort\.aborted\(\)/)
  assert.match(control, /created\.done\.await\(Math\.min\(200L/)
  // 动作线程把“这一代还在不在”作为叫停条件传进去。
  assert.match(poller, /\(\) -> !running \|\| generation != token/)
})
