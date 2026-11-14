import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 工具参数声明（2026-11-14）。
 *
 * 真事故：给三个坐标工具加可选参数时写了 `required: false`。
 * DSH 的 `defineTool` 直接抛 `parameters.allowOnce.required must be true when present`，
 * 于是**整块手机工具一起消失**——`phone_status`、`phone_tap` 全都"未知工具"，
 * 而 `mini_remote_status` 在另一个注册块里，照常能用。看起来像"插件没加载"，
 * 实际只是四个字写错了。
 *
 * 规矩：可选参数**不写 required**；写了就必须是 true。
 */

const SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

test('工具参数里不许出现 required: false（可选参数就不要写 required）', () => {
  const hits = [...SRC.matchAll(/required:\s*false/g)]
  assert.equal(hits.length, 0, `发现 ${hits.length} 处 required: false：可选参数直接省略 required 即可`)
})

test('三个坐标工具都注册了，可选参数也没写错', () => {
  for (const name of ['phone_tap_at', 'phone_long_press_at', 'phone_swipe_at']) {
    assert.match(SRC, new RegExp(`name: '${name}'`), `${name} 没有注册`)
  }
  // allowOnce 是可选：只许出现 description，不许跟着 required。
  const allowBlock = SRC.slice(SRC.indexOf("name: 'phone_tap_at'"), SRC.indexOf("name: 'phone_long_press_at'"))
  assert.match(allowBlock, /allowOnce: \{ type: 'boolean', description:/)
  assert.doesNotMatch(allowBlock, /allowOnce: \{[^}]*required/)
})
