import { test } from 'node:test'
import assert from 'node:assert/strict'
import { B_AGENT_PRESET, B_AGENT_TOOL_NAMES, apply } from '../lib/b-agent-preset.js'

test('B 端预设只声明四个 b_* 工具，并把守卫插件挂进去', () => {
  assert.equal(B_AGENT_PRESET.id, 'b-agent')
  assert.equal(B_AGENT_PRESET.name, 'B 端执行')
  assert.deepEqual(B_AGENT_PRESET.plugins.map((p) => p.name), ['dsh-mini-remote/b-agent-preset'])
  assert.deepEqual(B_AGENT_TOOL_NAMES, ['b_list', 'b_read', 'b_write', 'b_shell', 'b_glob', 'b_grep', 'b_mkdir', 'b_copy', 'b_move', 'b_delete', 'b_terminal_open', 'b_terminal_send', 'b_terminal_read', 'b_terminal_close', 'b_terminal_list'])
})

test('预设守卫：全局工具裁到 b_*；执行时也拒绝任何非 b_* 工具', () => {
  const calls = {}
  const ctx = {
    effect: (fn) => fn(),
    tools: {
      restrict: (filter) => { calls.restrict = filter; return () => {} },
      guard: (guard) => { calls.guard = guard; return () => {} },
    },
  }
  apply(ctx)
  assert.deepEqual(calls.restrict, { allow: B_AGENT_TOOL_NAMES })
  assert.equal(calls.guard({ name: 'b_read' }), undefined)
  assert.equal(calls.guard({ name: 'b_shell' }), undefined)
  assert.match(calls.guard({ name: 'read' }), /只允许 b_\*/)
  assert.match(calls.guard({ name: 'bash' }), /只允许 b_\*/)
})
