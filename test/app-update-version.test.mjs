import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 更新比对的分流（2026-11-16）。
 *
 * 用户的原话是担心"开发时版本号不动，改成比版本号会不会用不了"。
 * 所以规则必须是：调试包比内容，正式包比版本号——两边都不能丢。
 */

const server = () => readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')
const activity = () => readFileSync(new URL('../android/app/src/main/java/com/dsh/miniremote/MainActivity.java', import.meta.url), 'utf8')

test('服务端从 APK 里现读版本号，不靠手写记录', () => {
  const text = server()
  assert.match(text, /aapt2/, '要用 aapt2 读真实版本')
  assert.match(text, /dump', 'badging'/, '走 aapt2 dump badging')
  assert.match(text, /versionName: matched\[3\]/, '版本号来自包本身')
  assert.match(text, /debuggable/, '要能看出是不是调试包')
})

test('服务端读不到版本号时如实给 null，不编一个', () => {
  const text = server()
  assert.match(text, /version: badging \? badging\.versionName : null/, '读不到就是 null')
})

test('App 端两种规则都在：调试包比内容、正式包比版本', () => {
  const text = activity()
  assert.match(text, /compare-hash/, '调试包走内容比对')
  assert.match(text, /new-version/, '正式包走版本比对')
  assert.match(text, /same-version-different-content/, '同版本号但内容不同要单独标出来')
  assert.match(text, /FLAG_DEBUGGABLE/, '靠包自身的调试标记判断，不看设置')
})

test('页面按 decide 判断，并提醒"发布前改版本号"', () => {
  const text = activity()
  assert.match(text, /decide==='compare-hash'/, '页面要认 decide')
  assert.match(text, /要发版记得先改版本号/, '同版本不同内容要提醒')
})
