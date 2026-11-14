import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { noticeOptions, MAX_NOTICE_OPTIONS } from '../lib/pending-view.js'

/**
 * 从通知直接回答提问（2026-11-14）。
 *
 * 通知栏放不下复杂的东西，所以**什么形状能上通知**必须有明确口径：
 * 单题、两个以上选项、最多三个。不符合的照旧"打开应用作答"。
 */

test('单题两个选项：能画成按钮', () => {
  const got = noticeOptions([{ id: 'q1', options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }] }])
  assert.equal(got.questionId, 'q1')
  assert.deepEqual(got.options, ['甲', '乙', '丙'])
})

test('两个以上的题不硬塞：通知里表达不了"第二题"', () => {
  const got = noticeOptions([
    { id: 'q1', options: [{ label: '甲' }, { label: '乙' }] },
    { id: 'q2', options: [{ label: '丙' }, { label: '丁' }] },
  ])
  assert.deepEqual(got, { questionId: '', options: [] })
})

test('只有一个选项等于没得选，也退回打开应用', () => {
  const got = noticeOptions([{ id: 'q1', options: [{ label: '只有一个' }] }])
  assert.deepEqual(got, { questionId: '', options: [] })
})

test('没有选项的题（自由作答）照样退回打开应用', () => {
  assert.deepEqual(noticeOptions([{ id: 'q1' }]), { questionId: '', options: [] })
  assert.deepEqual(noticeOptions([]), { questionId: '', options: [] })
})

test('选项超过三个只取前三个：通知上点不清那么多', () => {
  const many = [1, 2, 3, 4, 5].map((n) => ({ label: '选项' + n }))
  const got = noticeOptions([{ id: 'q', options: many }])
  assert.equal(got.options.length, MAX_NOTICE_OPTIONS)
})

test('四段链路都接上了：清单带选项、通知带按钮、接收器回传', () => {
  const server = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')
  assert.match(server, /noticeOptions\(entry\.questions\)/)
  const notifier = readFileSync(new URL('../android/app/src/main/java/com/dsh/miniremote/Notifier.java', import.meta.url), 'utf8')
  assert.match(notifier, /static void showQuestion\(/)
  assert.match(notifier, /answerIntent\(/)
  const svc = readFileSync(new URL('../android/app/src/main/java/com/dsh/miniremote/MiniForegroundService.java', import.meta.url), 'utf8')
  assert.match(svc, /Notifier\.showQuestion\(/)
  const receiver = readFileSync(new URL('../android/app/src/main/java/com/dsh/miniremote/QuestionReceiver.java', import.meta.url), 'utf8')
  assert.match(receiver, /\/mini\/api\/answer/)
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
  assert.match(manifest, /QuestionReceiver/)
})
