import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const activity = readFileSync(new URL('../android/app/src/main/java/com/dsh/miniremote/MainActivity.java', import.meta.url), 'utf8')

test('三参 install 必须带 @JavascriptInterface，否则网页调不到', () => {
  // 2026-11-11 真机：查询正常却停在「开始下载」不动，
  // 根因是三参 install 漏了注解，JS 根本调不到，下载没启动。
  const threeArg = activity.indexOf('install(String path, double totalBytes, String expectedSha256)')
  assert.ok(threeArg > 0, '三参方法要存在')
  const before = activity.slice(Math.max(0, threeArg - 200), threeArg)
  assert.match(before, /@android\.webkit\.JavascriptInterface/)
})
