import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const card = read('android/app/src/bridge/java/com/dsh/miniremote/ConfirmOverlay.java')
const service = read('android/app/src/bridge/java/com/dsh/miniremote/BridgeAccessibilityService.java')
const activity = read('android/app/src/main/java/com/dsh/miniremote/MainActivity.java')
const notifier = read('android/app/src/main/java/com/dsh/miniremote/Notifier.java')
const manifest = read('android/app/src/main/AndroidManifest.xml')

const control = read('android/app/src/main/java/com/dsh/miniremote/ConfirmationControl.java')

test('A2：确认卡走无障碍浮层，不申请悬浮窗权限', () => {
  assert.match(card, /TYPE_ACCESSIBILITY_OVERLAY/)
  assert.doesNotMatch(card, /TYPE_APPLICATION_OVERLAY/)
  assert.doesNotMatch(manifest, /SYSTEM_ALERT_WINDOW/)
})

test('A2：同屏只留一张卡，显示前先撤旧的', () => {
  const show = card.slice(card.indexOf('void show('))
  assert.ok(show.indexOf('dismiss()') < show.indexOf('addView'), '先撤旧卡再摆新卡')
  assert.match(card, /void dismiss\(\)/)
})

test('A2：按钮最小可点高度 48dp，只写动作与打码目标', () => {
  assert.match(card, /setMinHeight\(dp\(48\)\)/)
  assert.match(card, /SensitiveText\.mask|card\.target/)
  assert.doesNotMatch(card, /args\.optString\("text"/, '卡上不摆输入正文')
  assert.doesNotMatch(card, /base64/i, '卡上不摆截图')
})

test('A2：本任务档多一个「允许本任务」，每次档没有', () => {
  assert.match(card, /ConfirmationState\.TASK\.equals\(card\.mode\)/)
  assert.ok(card.includes('允许本任务'))
  assert.ok(card.includes('拒绝') && card.includes('允许'))
  assert.match(control, /只影响本轮任务/)
})

test('A2：锁屏只发不含内容的通知，解锁后补摆仍在等的卡', () => {
  assert.match(service, /isKeyguardLocked\(\)/)
  assert.match(service, /Notifier\.showConfirmHint\(BridgeAccessibilityService\.this\)/)
  // 通知说要解锁后能看，就必须真的有东西补出来，否则这句承诺是空的。
  assert.match(service, /ConfirmationControl\.currentCard\(\)/)
  assert.match(service, /showPendingCardIfAny\(\)/)
  assert.match(service, /ACTION_USER_PRESENT/)
  assert.match(service, /Notifier\.cancelConfirmHint/)
  const start = notifier.indexOf('static void showConfirmHint')
  const rest = notifier.slice(start + 'static void showConfirmHint'.length)
  const body = rest.slice(0, rest.indexOf('\n    /**'))
  assert.doesNotMatch(body, /card\.|target|标题|package|\.text\b/, '锁屏通知不写动作内容')
  assert.doesNotMatch(service, /wakeUp|disableKeyguard|FLAG_SHOW_WHEN_LOCKED/)
})

test('A2：档位入口在屏幕操作展开区，位于按钮之前，收起态不带状态词', () => {
  const body = activity.slice(activity.indexOf('id=\\"miniA11yBody\\"'), activity.indexOf('id=\\"miniA11yGo\\"'))
  assert.ok(body.includes('miniConfirmOff') && body.includes('miniConfirmTask') && body.includes('miniConfirmEach'))
  assert.ok(activity.indexOf('miniConfirmRow') < activity.indexOf('id=\\"miniA11yGo\\"'))
  // 收起态那一行只写“屏幕操作 + 已开启/未开启”，不能塞档位词。
  const head = activity.slice(activity.indexOf('id=\\"miniA11yHead\\"'), activity.indexOf('id=\\"miniA11yBody\\"'))
  assert.doesNotMatch(head, /免确认|每次/)
})

test('A2：设置页切档只写设置，接口读写都通过 MiniProbe', () => {
  assert.match(activity, /public String confirmMode\(\)/)
  assert.match(activity, /public void confirmMode\(String mode\)/)
  assert.match(activity, /ConfirmationControl\.setSelectedMode\(MainActivity\.this, mode\)/)
  assert.match(activity, /MiniProbe\.confirmMode\(\)/)
})
