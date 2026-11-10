import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const service = read('android/app/src/bridge/java/com/dsh/miniremote/BridgeAccessibilityService.java')
const overlay = read('android/app/src/bridge/java/com/dsh/miniremote/StopOverlay.java')
const control = read('android/app/src/main/java/com/dsh/miniremote/BridgeControl.java')
const activity = read('android/app/src/main/java/com/dsh/miniremote/MainActivity.java')
const poller = read('android/app/src/main/java/com/dsh/miniremote/BridgePoller.java')
const foreground = read('android/app/src/main/java/com/dsh/miniremote/MiniForegroundService.java')

test('B1：停止胶囊走无障碍浮层，不需要悬浮窗权限', () => {
  assert.match(overlay, /TYPE_ACCESSIBILITY_OVERLAY/)
  assert.doesNotMatch(overlay, /TYPE_APPLICATION_OVERLAY/)
  for (const file of ['android/app/src/main/AndroidManifest.xml', 'android/app/src/bridge/AndroidManifest.xml']) {
    assert.doesNotMatch(read(file), /SYSTEM_ALERT_WINDOW/)
  }
})

test('B1：胶囊只有停止动作，点击区至少 48dp，支持拖动和松手贴边', () => {
  assert.match(overlay, /setText\("停止"\)/)
  assert.match(overlay, /setMinHeight\(dp\(48\)\)/)
  assert.match(overlay, /MotionEvent\.ACTION_MOVE/)
  assert.match(overlay, /MotionEvent\.ACTION_UP/)
  assert.match(overlay, /snapToEdge\(\)/)
})

test('B1：撤权、锁屏、服务中断与销毁都汇入同一套浮层同步/清理', () => {
  assert.match(service, /onServiceConnected[\s\S]*?syncStopOverlay\(\)/)
  assert.match(service, /onUnbind[\s\S]*?discardStopOverlay\(\)/)
  assert.match(service, /onDestroy[\s\S]*?discardStopOverlay\(\)/)
  assert.match(service, /onInterrupt[\s\S]*?stopOverlay\.dismiss\(\)/)
  assert.match(service, /isKeyguardLocked\(\)/)
  assert.match(service, /BridgeControl\.isArmed\(this\)/)
  assert.match(service, /ACTION_SCREEN_ON/)
  assert.match(service, /ACTION_SCREEN_OFF/)
  assert.match(service, /ACTION_USER_PRESENT/)
  assert.match(service, /TYPE_WINDOWS_CHANGED/)
  assert.match(service, /onInterrupt[\s\S]*?postDelayed\(syncOverlayTask, 500\)/)
  assert.match(service, /discardStopOverlay[\s\S]*?unregisterReceiver\(screenReceiver\)/)
})

test('B1：设置页和胶囊共用 BridgeControl，不保留第二条武装请求', () => {
  assert.match(activity, /BridgeControl\.setArmed\(MainActivity\.this, armed, base, cred/)
  assert.match(service, /BridgeControl\.setArmed\(this, false, null, null, null\)/)
  assert.doesNotMatch(activity, /Net\.postJson\(base \+ "\/mini\/api\/bridge\/arm"/)
  assert.match(control, /Net\.postJson\(route\[0\] \+ "\/mini\/api\/bridge\/arm"/)
})

test('B1：本机撤权与停止全部轮询先于任何网络通知', () => {
  const local = control.indexOf('writeLocalArmed(app, armed)')
  const stop = control.indexOf('activeRoutes = BridgePoller.stopAll()')
  const network = control.indexOf('ARM_REQUESTS.execute(() ->')
  assert.ok(local >= 0 && stop > local && network > stop)
  assert.match(control, /newSingleThreadExecutor\(\)/, '武装请求必须按操作顺序送达')
  assert.match(poller, /static java\.util\.List<String\[\]> stopAll\(\)/)
  assert.match(poller, /poller\.stop\(\)/)
})

test('B1：离线停止不回弹；只有开启失败才把本机状态改为关闭', () => {
  assert.match(control, /if \(armed\) \{\s*writeLocalArmed\(app, false\);\s*BridgePoller\.stopAll\(\);\s*\}/)
  assert.doesNotMatch(control, /停止失败[\s\S]{0,120}writeLocalArmed\(app, true\)/)
  assert.match(control, /停止失败则保持本机已经停止/)
})

test('B1：读取授权与启动轮询共用临界区，旧线程不能补发武装', () => {
  assert.match(control, /syncPoller[\s\S]*?synchronized \(LOCK\)/)
  assert.match(activity, /BridgeControl\.syncPoller\(this, bridgePoller, loadedBase/)
  assert.match(foreground, /BridgeControl\.syncPoller\(this, bridgePoller, baseUrl, credential\)/)
  assert.match(poller, /rearmIfNeeded[\s\S]*?!BridgeControl\.isArmed\(context\)/)
  assert.match(poller, /private void rearmIfNeeded[\s\S]*?BridgeControl\.rearm\(context, baseUrl, credential\)/)
  assert.match(control, /static void rearm[\s\S]*?ARM_REQUESTS\.execute/)
  assert.doesNotMatch(poller, /private void rearmIfNeeded[\s\S]*?Net\.postJson/)
})
