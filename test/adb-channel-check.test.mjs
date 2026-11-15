import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 「一条命令自检」自身的守门测试（2026-11-15）。
 *
 * 这个脚本的价值全在"验的是真实通道"——如果哪天有人图省事改成直接跑 adb shell，
 * 它就会重新变成"看起来绿、其实没验到"，所以这里把几条要点钉住。
 */

const script = () => readFileSync(new URL('../scripts/adb-channel-check.mjs', import.meta.url), 'utf8')
const check = () => readFileSync(new URL('../android/app/src/main/java/com/dsh/miniremote/AdbChannelCheck.java', import.meta.url), 'utf8')
const receiver = () => readFileSync(new URL('../android/app/src/main/java/com/dsh/miniremote/AdbPairingReceiver.java', import.meta.url), 'utf8')

test('自检脚本走的是 App 自己的路径，不是拿 adb shell 冒充', () => {
  const text = script()
  assert.match(text, /am', 'broadcast'/, '要靠广播让 App 自己跑')
  assert.match(text, /SELF_TEST|adb-channel-check/, '读的是 App 写回来的结果文件')
  assert.ok(!/adb', 'shell', 'whoami'|shell whoami/.test(text), '不许直接 adb shell 跑命令来凑绿')
})

test('App 侧的自检覆盖了五类：身份、中文、管道、后台任务、退回', () => {
  const text = check()
  for (const keyword of ['whoami', '中文测试', 'tr a-z A-Z', 'startJob', 'jobOutput', 'stopJob', 'termux']) {
    assert.ok(text.includes(keyword), `缺少检查项：${keyword}`)
  }
  // 退回那一项**不许再碰配对标记**：曾经"临时摘掉再恢复"，一次异常就把用户真实状态弄丢了。
  assert.match(text, /execForcedTermux/, '用不碰标记的强制兜底入口')
  assert.ok(!/putBoolean\("paired"/.test(text), '自检不许改配对标记')
})

test('广播入口带权限保护，普通 App 调不动', () => {
  assert.match(receiver(), /ACTION_SELF_TEST/)
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
  assert.match(manifest, /android:permission="android\.permission\.DUMP"/, '只给 adb 身份用')
})

test('脚本会先删上一轮结果，避免验到上一次的绿', () => {
  const text = script()
  assert.match(text, /rm', '-f', RESULT|rm -f/, '触发前必须清掉旧结果文件')
})

test('退回 Termux 那一项验的是"选择"而不是 Termux 的健康', () => {
  const text = check()
  assert.match(text, /choseFallback|改走 termux/, '要断言是否选择了退回')
  assert.match(text, /Termux 回话|回话=/, 'Termux 醒没醒要如实写出来，不能含混')
})
