import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const control = read('android/app/src/main/java/com/dsh/miniremote/ConfirmationControl.java')
const notifier = read('android/app/src/main/java/com/dsh/miniremote/Notifier.java')
const activity = read('android/app/src/main/java/com/dsh/miniremote/MainActivity.java')

// 2026-11-11：确认链路按 DSH Go 的六条重写后重新开启。
// 这组测试锁住"开关只有一处"与"每条入口都先看它"，免得以后又散成多套判断。

test('确认已启用：开关只有一处，且各入口都先看它', () => {
  assert.match(control, /static final boolean SUPPORTED = true/)
  assert.match(control, /if \(!SUPPORTED\) return ConfirmationState\.OFF/)
  assert.match(control, /if \(!SUPPORTED\) return allow\(\)/)
  assert.match(control, /if \(!SUPPORTED\) return false;/)
  assert.match(notifier, /if \(!ConfirmationControl\.SUPPORTED\) return false;/)
})

test('通知走随机 action + 动态注册的私有接收器', () => {
  // 每道题一个随机 action：旧通知的按钮命中不了新的提问。
  assert.match(notifier, /MINI_CONFIRM\./)
  assert.match(notifier, /UUID\.randomUUID\(\)/)
  assert.match(notifier, /registerReceiver\(receiver, new android\.content\.IntentFilter\(action\)/)
  assert.match(notifier, /RECEIVER_NOT_EXPORTED/)
  // 按钮只能回到自己进程。
  assert.match(notifier, /setPackage\(context\.getPackageName\(\)\)/)
})

test('划掉通知算拒绝，到点由系统撤', () => {
  assert.match(notifier, /setDeleteIntent\(/)
  assert.match(notifier, /setTimeoutAfter\(left\)/)
})

test('发不出去要立刻失败，不空等超时', () => {
  const show = notifier.slice(notifier.indexOf('static boolean showConfirmCard'))
  assert.ok(show.indexOf('canPostConfirm') < show.indexOf('notify('), '先检查可用性再发通知')
})

test('卡死路径：接收器不等待、不持锁，结算在锁外', () => {
  // 动态接收器与旧接收器两处的主线程路径都不许出现阻塞调用。
  const gate = notifier.slice(notifier.indexOf('private static String openGate'))
  const body = gate.slice(0, gate.indexOf('private static void closeGate'))
  assert.doesNotMatch(body, /Thread\.sleep|\.join\(|\.await\(|synchronized|goAsync\(\)/)
  // answerCard：锁内只做比对，settle 在锁外（撤通知是系统调用）。
  const answer = control.slice(control.indexOf('static boolean answerCard'))
  const answerBody = answer.slice(0, answer.indexOf('static void cancelAll'))
  assert.ok(answerBody.indexOf('synchronized (LOCK)') < answerBody.indexOf('settle(target'),
    '结算必须在锁外')
})

test('设置页三档选择器回来了，接的是同一套档位接口', () => {
  assert.match(activity, /data-mode=\\"off\\"/)
  assert.match(activity, /data-mode=\\"task\\"/)
  assert.match(activity, /data-mode=\\"each\\"/)
  assert.match(activity, /MiniProbe\.confirmMode\(this\.getAttribute\('data-mode'\)\)/)
})
