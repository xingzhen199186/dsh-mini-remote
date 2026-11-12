import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const service0 = () => readFileSync(new URL('../android/app/src/bridge/java/com/dsh/miniremote/BridgeAccessibilityService.java', import.meta.url), 'utf8')
const service = service0()

test('序号过期时先自动刷新，而不是直接拒绝', () => {
  // 2026-11-11 真机：每次确认要等几十秒，恰好超过 30 秒保鲜期，
  // 于是"读得到、点不了"。过期应当自动 observe 刷新，而不是把错误丢回去。
  const body = service.slice(service.indexOf('static String tapIndex'))
  const stale = body.indexOf('> 30_000')
  const refresh = body.indexOf('observe();', stale)
  assert.ok(stale > 0 && refresh > stale, '过期分支里要有自动 observe')
  // 直接那句"请先看一眼屏幕"不应再是过期后的第一反应。
  const segment = body.slice(stale, refresh)
  assert.doesNotMatch(segment, /请先看一眼屏幕/)
})

test('坐标不可信时改用节点动作点击', () => {
  const service = service0()
  // 2026-11-12 浙政钉：底部标签报 y=3034，屏幕只有 2800 高，按坐标点落到屏幕外。
  assert.match(service, /private static boolean usable\(android\.graphics\.Rect rect\)/)
  assert.match(service, /if \(!usable\(rect\)\)/)
  assert.match(service, /private static String clickNode\(int index\)/)
  // 仍然保留按坐标点这条主路。
  assert.match(service, /String result = tap\(rect\.centerX\(\), rect\.centerY\(\)\)/)
})
