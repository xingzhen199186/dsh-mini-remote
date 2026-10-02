/** 子代理结构清单缓存：只存 id、父级、类型和名称，不存运行记录或正文。 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const TTL_MS = 7 * 24 * 60 * 60 * 1000

export function createSubagentCache({ file, ttl = TTL_MS, debounceMs = 500, now = Date.now }) {
  const rows = new Map()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const at = now()
    for (const [parentId, row] of Object.entries(raw ?? {})) {
      if (!row || typeof row.at !== 'number' || at - row.at > ttl || !Array.isArray(row.subagents)) continue
      rows.set(parentId, { subagents: row.subagents, at: row.at })
    }
  } catch {
    // 首次启动或缓存损坏时从空缓存开始。
  }

  let timer = null
  let dirty = false
  function save() {
    timer = null
    if (!dirty) return
    dirty = false
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      const raw = {}
      for (const [parentId, row] of rows) raw[parentId] = row
      writeFileSync(tmp, JSON.stringify(raw))
      renameSync(tmp, file)
    } catch {
      // 缓存写失败不影响当前运行。
    }
  }
  function schedule() {
    dirty = true
    if (timer) return
    timer = setTimeout(save, debounceMs)
    timer.unref?.()
  }

  return {
    get(parentId) {
      const row = rows.get(parentId)
      if (!row) return null
      if (now() - row.at > ttl) {
        rows.delete(parentId)
        return null
      }
      return row.subagents.map((item) => ({ ...item }))
    },
    set(parentId, subagents) {
      if (!parentId || !Array.isArray(subagents)) return
      rows.set(parentId, { subagents: subagents.map((item) => ({ ...item })), at: now() })
      schedule()
    },
    delete(parentId) {
      if (rows.delete(parentId)) schedule()
    },
  }
}
