import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const control = read('android/app/src/main/java/com/dsh/miniremote/ConfirmationControl.java')
const notifier = read('android/app/src/main/java/com/dsh/miniremote/Notifier.java')
const overlay = read('android/app/src/bridge/java/com/dsh/miniremote/ConfirmOverlay.java')
const activity = read('android/app/src/main/java/com/dsh/miniremote/MainActivity.java')
const receiver = read('android/app/src/main/java/com/dsh/miniremote/ConfirmActionReceiver.java')

test('确认停用：开关只有一处，且四个入口都先看它', () => {
  assert.match(control, /static final boolean SUPPORTED = false/)
  // 读取档位
  assert.match(control, /if \(!SUPPORTED\) return ConfirmationState\.OFF/)
  // 进入等待
  assert.match(control, /if \(!SUPPORTED\) return allow\(\);[\s\S]{0,400}final Context app/)
  // 通知按钮
  assert.match(control, /if \(!SUPPORTED\) return false;[\s\S]{0,200}Pending current/)
  // 通知与浮层
  assert.match(notifier, /if \(!ConfirmationControl\.SUPPORTED\) return false;/)
  assert.match(overlay, /if \(!ConfirmationControl\.SUPPORTED\) return;/)
})

test('确认停用期间不延长电脑侧等待，轮询也不再上报确认需求', () => {
  assert.match(control, /if \(!SUPPORTED\) return false;[\s\S]{0,200}needsExtendedDeadline/)
})

test('设置页不再出现三档按钮，只留说明', () => {
  assert.doesNotMatch(activity, /miniConfirmTask|miniConfirmEach|__miniPickConfirm/)
  assert.ok(activity.includes('本机暂不支持操作前确认（系统限制），已固定为免确认。'))
})

test('卡死路径：广播接收器只做一次非阻塞调用，不等待、不持锁', () => {
  // 主线程进来的路径里不许出现 sleep/join/wait/await 或自己拿锁。
  assert.doesNotMatch(receiver, /Thread\.sleep|\.join\(|\.await\(|synchronized|goAsync\(\)/)
  // 停用期间连解析都不做，第一条就返回。
  assert.match(receiver, /if \(!ConfirmationControl\.SUPPORTED\) \{\s*return;/)
  assert.match(receiver, /ConfirmationControl\.answerCard\(/)
})

test('卡死路径：发通知不在锁内，主线程不会被系统调用拖住', () => {
  const prompt = control.slice(control.indexOf('private static void startPrompt'))
  const body = prompt.slice(0, prompt.indexOf('\n    /**'))
  assert.match(body, /Notifier\.showConfirmCard\(app, created\.card\)/)
  assert.doesNotMatch(body, /synchronized \(LOCK\)/, '发通知必须留在锁外')
  // 锁里只做比对与占位，不碰系统服务。
  const locked = control.slice(control.indexOf('if (pending == null)'), control.indexOf('private static void startPrompt'))
  assert.doesNotMatch(locked, /Notifier\.|showConfirmCard/)
})

test('卡死路径：settle 唤醒不持有锁执行外部动作', () => {
  const settle = control.slice(control.indexOf('private static void settle'))
  const body = settle.slice(0, settle.indexOf('private static Decision allow'))
  // 撤通知与主线程回调都要在同步块之后。
  assert.ok(body.indexOf('}') < body.indexOf('Notifier.cancelConfirmCard'))
})
