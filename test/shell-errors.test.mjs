import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 失败话术的守门测试（2026-11-15）。
 *
 * 三种失败必须各有各的"下一步"，且都不能把英文原文甩给用户：
 * 配对失效 → 重新配对；端口没了 → 开无线调试；握手失败 → 先重开再重配。
 */

const source = readFileSync(new URL('../android/app/src/main/java/com/dsh/miniremote/ShellErrors.java', import.meta.url), 'utf8')

test('三种失败各有明确的下一步', () => {
  assert.match(source, /certificate_unknown[\s\S]*?重新配对/, '配对失效要指向重新配对')
  assert.match(source, /econnrefused[\s\S]*?无线调试/, '端口没了要指向开无线调试')
  assert.match(source, /握手[\s\S]*?重新配对/, '握手失败要先重开、再重配')
})

test('兜底那句话不吓人，也不假装成功', () => {
  assert.match(source, /已改用 Termux 执行/, '兜底要说明改走了 Termux')
})

test('对外文案里不许出现裸英文错误名', () => {
  // 允许出现在判定用的 contains 里，但不许拼进返回给用户的那句话。
  const hints = [...source.matchAll(/return "([^"]+)";/g)].map((m) => m[1])
  assert.ok(hints.length >= 4, '应当有至少四条话术')
  for (const hint of hints) {
    assert.ok(!/econnrefused|certificate_unknown|tls/i.test(hint), `话术里混进了英文错误名：${hint}`)
  }
})
