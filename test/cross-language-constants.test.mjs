import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 电脑和手机靠字符串约定对话（动作名、通知类型）。
 * 打错一个字母不会报错，只会静静地"永远不生效"——和 2026-11-12 那个
 * 字符串 == 属于同一类静默失败，所以这里把两边的字面量摆在一起核对。
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const host = read('lib/index.js')
const poller = read('android/app/src/main/java/com/dsh/miniremote/BridgePoller.java')
const bridge = read('lib/bridge.js')

// 电脑侧写的是 name: 'phone_xxx'，手机侧写的是 "phone_xxx".equals(tool)。
const hostNames = (text) => new Set([...text.matchAll(/name: '(phone_[a-z_]+)'/g)].map((m) => m[1]))
const phoneNames = (text) => new Set([...text.matchAll(/"(phone_[a-z_]+)"/g)].map((m) => m[1]))

test('电脑与手机认识同一批手机动作', () => {
  const onHost = hostNames(host)
  const onPhone = phoneNames(poller)
  assert.ok(onHost.size >= 10, `电脑侧动作太少：${onHost.size}`)
  assert.deepEqual(
    [...onPhone].sort(),
    [...onHost].sort(),
    '两边的手机动作名必须完全一致，否则某个动作会静静地永远不生效',
  )
})

test('电脑发出的任务结束通知，手机认的是同一个名字', () => {
  assert.match(bridge, /kind: 'task-ended'/)
  assert.match(poller, /"task-ended"\.equals\(notice\.optString\("kind"\)\)/)
})

test('每个手机工具都真的被注册（不是被挤成别人参数）', () => {
  // 2026-11-12 真事故：插新工具时少了一个 `}))`，于是下一个工具对象变成了
  // defineTool 的第二个参数——不报错、不崩，那个工具直接消失。
  const firmly = [...host.matchAll(/name: '(phone_[a-z_]+)',/g)]
  assert.ok(firmly.length >= 12, `工具数量异常：${firmly.length}`)
  // 坏形状：`},` 后面紧跟 `{` 再紧跟 name，说明被并进了上一个 defineTool。
  assert.doesNotMatch(host, /\},\n\s*\{\n\s*name: 'phone_/)
  // 注册调用数必须不少于工具数，否则有工具没有自己的 register。
  const registers = [...host.matchAll(/tools\.register\(defineTool\(\{/g)].length
  assert.ok(registers >= firmly.length, `注册数 ${registers} 少于工具数 ${firmly.length}`)
})
