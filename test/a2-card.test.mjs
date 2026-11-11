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

test('A2：浮层只写动作与打码目标，不摆正文和截图', () => {
  // 按钮已经挪到通知（系统绘制），浮层不再有可点区域。
  assert.match(card, /card\.actionText\(\)/)
  assert.match(card, /card\.target/)
  assert.doesNotMatch(card, /args\.optString\("text"/, '卡上不摆输入正文')
  assert.doesNotMatch(card, /base64/i, '卡上不摆截图')
})

test('A2：本任务档多一个「允许本任务」，每次档没有', () => {
  // 「允许本任务」只出现在任务档，且由通知提供（系统绘制按钮，浮层点不动）。
  assert.match(notifier, /ConfirmationState\.TASK\.equals\(card\.mode\)/)
  assert.ok(notifier.includes('允许本任务'))
  assert.ok(card.includes('拒绝') && card.includes('允许'))
  assert.match(control, /只影响本轮任务/)
})

test('A2：锁屏也照常出卡，确认入口是通知不是浮层', () => {
  assert.match(service, /isKeyguardLocked\(\)/)
  // 确认通知由状态机直接发出，不再依赖无障碍服务在场。
  // 通知由状态机在锁外发出（startPrompt），浮层只是展示。
  assert.match(control, /Notifier\.showConfirmCard\(app, created\.card\)/)
  // 通知说要解锁后能看，就必须真的有东西补出来，否则这句承诺是空的。
  assert.match(service, /ConfirmationControl\.currentCard\(\)/)
  assert.match(service, /showPendingCardIfAny\(\)/)
  assert.match(service, /ACTION_USER_PRESENT/)
  const start = notifier.indexOf('static void showConfirmHint')
  const rest = notifier.slice(start + 'static void showConfirmHint'.length)
  const body = rest.slice(0, rest.indexOf('\n    /**'))
  assert.doesNotMatch(body, /card\.|target|标题|package|\.text\b/, '锁屏通知不写动作内容')
  assert.doesNotMatch(service, /wakeUp|disableKeyguard|FLAG_SHOW_WHEN_LOCKED/)
})

test('A2：档位选择器已停用，只留一句说明', () => {
  // 2026-11-11 真机：荣耀上浮层收不到触摸、通知按钮无响应，三档确认整体停用。
  // 选择器藏起来，避免“能选但选了没用”的误导；代码仍在，换机型可恢复。
  assert.ok(activity.includes('本机暂不支持操作前确认（系统限制），已固定为免确认。'))
  assert.doesNotMatch(activity, /miniConfirmTask|miniConfirmEach/)
  assert.match(activity, /id=\\"miniConfirmOff\\"/)
})

test('A2：档位接口仍在，但读取一律按免确认处理', () => {
  // 留着接口是为了以后恢复；现在的实现必须无视已存的值。
  assert.match(control, /static final boolean SUPPORTED = false/)
  assert.match(control, /if \(!SUPPORTED\) return ConfirmationState\.OFF/)
})
