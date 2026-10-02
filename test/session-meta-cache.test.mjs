import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSessionMetaCache } from '../lib/session-meta-cache.js'

function record(id, createdAt = 1) {
  return { header: { id, createdAt, cwd: 'I:\\project' }, live: false, persisted: true }
}

test('会话元数据缓存能写入并在下一次启动恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-meta-'))
  const file = join(dir, 'session-meta.json')
  const first = createSessionMetaCache({ file, debounceMs: 1 })
  first.replace([record('s1', 10), record('s2', 20)])
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = createSessionMetaCache({ file })
  assert.deepEqual(second.all().map((row) => row.header.id), ['s1', 's2'])
  assert.equal((await readFile(file, 'utf8')).includes('s1'), true)
})

test('过期元数据不会恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-meta-'))
  const file = join(dir, 'session-meta.json')
  const cache = createSessionMetaCache({ file, debounceMs: 1, now: () => 1000, ttl: 10 })
  cache.replace([record('s1')])
  await new Promise((resolve) => setTimeout(resolve, 10))
  const expired = createSessionMetaCache({ file, now: () => 2000, ttl: 10 })
  assert.deepEqual(expired.all(), [])
})
