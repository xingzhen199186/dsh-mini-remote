import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSubagentCache } from '../lib/subagent-cache.js'

test('子代理清单缓存能跨启动恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-subagent-'))
  const file = join(dir, 'subagents.json')
  const first = createSubagentCache({ file, debounceMs: 1 })
  first.set('parent', [{ id: 'child', mode: 'continuable', label: '检查' }])
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = createSubagentCache({ file })
  assert.deepEqual(second.get('parent'), [{ id: 'child', mode: 'continuable', label: '检查' }])
})

test('子代理清单缓存能按父会话删除', () => {
  const cache = createSubagentCache({ file: join(tmpdir(), `dsh-subagent-${Date.now()}.json`) })
  cache.set('parent', [{ id: 'child' }])
  cache.delete('parent')
  assert.equal(cache.get('parent'), null)
})
