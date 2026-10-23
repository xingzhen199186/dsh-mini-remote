import { test } from 'node:test'
import assert from 'node:assert/strict'
import { B_AGENT_BLOCKED_TOOLS, B_AGENT_PRESET, apply } from '../lib/b-agent-preset.js'

test('B 端预设声明混合策略：B 工具 + A 非物理工具，本地物理工具列入禁止名单', () => {
  assert.equal(B_AGENT_PRESET.id, 'b-agent')
  assert.equal(B_AGENT_PRESET.name, 'B 端执行')
  assert.deepEqual(B_AGENT_PRESET.plugins.map((p) => p.name), ['dsh-mini-remote/b-agent-preset', 'dsh-mini-remote/b-agent-schedule'])
  for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'terminal_open', 'subagent', 'subagent_fork', 'subagent_claude_code', 'ralph', 'task_board_run']) {
    assert.ok(B_AGENT_BLOCKED_TOOLS.includes(name), `${name} 应该被禁止`)
  }
  for (const name of ['b_read', 'b_shell', 'b_subagent', 'web_call', 'browser_call', 'generate_image', 'session_search', 'schedule_create', 'ask_advisors', 'run_code']) {
    assert.equal(B_AGENT_BLOCKED_TOOLS.includes(name), false, `${name} 不该被禁止`)
  }
})

test('预设守卫：只移除当前存在的本地工具；b_* 和 A 非物理工具保留', () => {
  const calls = {}
  const ctx = {
    effect: (fn) => fn(),
    tools: {
      schemas: () => [
        { name: 'read' }, { name: 'bash' }, { name: 'b_read' },
        { name: 'web_call' }, { name: 'schedule_create' }, { name: 'ask_advisors' },
      ],
      restrict: (filter) => { calls.restrict = filter; return () => {} },
      guard: (guard) => { calls.guard = guard; return () => {} },
    },
  }
  apply(ctx)
  assert.deepEqual(calls.restrict, { deny: ['read', 'bash'] })
  assert.equal(calls.guard({ name: 'b_read' }), undefined)
  assert.equal(calls.guard({ name: 'web_call' }), undefined)
  assert.equal(calls.guard({ name: 'schedule_create' }), undefined)
  assert.match(calls.guard({ name: 'read' }), /移除了 A 本地文件和命令工具/)
  assert.match(calls.guard({ name: 'bash' }), /移除了 A 本地文件和命令工具/)
})
