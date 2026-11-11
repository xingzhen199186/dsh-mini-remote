import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('停止浮层只在"正在操作手机"时出现', () => {
  const bridge = read('lib/bridge.js')
  // 判据必须是"有在途调用，或刚操作过且任务还在跑"，不能只是"有任务在跑"。
  assert.match(bridge, /inFlightFor\(deviceId\) > 0/)
  assert.match(bridge, /lastUse\.get\(deviceId\)/)
  assert.match(bridge, /USE_GRACE_MS/)

  const service = read('android/app/src/bridge/java/com/dsh/miniremote/BridgeAccessibilityService.java')
  assert.match(service, /TaskState\.busy/)
  // 原来的三个条件仍在，只是多了一个"正在操作手机"。
  assert.match(service, /BridgeControl\.isArmed\(this\) && !locked && screenOn && !mine && taskOnPhone/)

  const poller = read('android/app/src/main/java/com/dsh/miniremote/BridgePoller.java')
  assert.match(poller, /TaskState\.busy = root\.optBoolean\("busy"/)
})

test('只有动界面/看屏幕的动作才算操作手机', () => {
  const bridge = read('lib/bridge.js')
  const listed = bridge.slice(bridge.indexOf('const TOUCHING_TOOLS'), bridge.indexOf('const notices'))
  for (const tool of ['phone_tap', 'phone_swipe', 'phone_input', 'phone_back', 'phone_open', 'phone_wake', 'phone_observe', 'phone_screenshot']) {
    assert.match(listed, new RegExp(`'${tool}'`), `${tool} 应算操作手机`)
  }
  for (const tool of ['phone_status', 'phone_notify', 'phone_send_file', 'phone_set_clipboard']) {
    assert.doesNotMatch(listed, new RegExp(`'${tool}'`), `${tool} 不该算操作手机`)
  }
})
