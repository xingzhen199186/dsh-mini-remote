/**
 * 导航用的会话元数据缓存。
 *
 * 这里只保存 sessionQuery.listSessions() 返回记录中的 header 和两个可用性标志，
 * 不保存会话正文。用途是让 DSH 重启后导航可以先显示上次已知的工作区关系，
 * 再由后台完整扫描校正。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_MAX = 10_000

function validRecord(row) {
  return Boolean(
    row && typeof row === 'object'
      && row.header && typeof row.header.id === 'string' && row.header.id
      && Number.isFinite(row.header.createdAt),
  )
}

export function createSessionMetaCache({
  file, ttl = DEFAULT_TTL_MS, max = DEFAULT_MAX, debounceMs = 500, now = Date.now,
}) {
  const rows = new Map()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const at = now()
    for (const row of Array.isArray(raw) ? raw : Object.values(raw ?? {})) {
      if (!validRecord(row) || typeof row.at !== 'number' || at - row.at > ttl) continue
      rows.set(row.header.id, { ...row, at: row.at })
    }
  } catch {
    // 第一次运行或缓存损坏都从空缓存开始，不能影响插件启动。
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
      writeFileSync(tmp, JSON.stringify([...rows.values()]))
      renameSync(tmp, file)
    } catch {
      // 缓存写失败只影响下次冷启动，不影响当前导航。
    }
  }
  function schedule() {
    dirty = true
    if (timer) return
    timer = setTimeout(save, debounceMs)
    timer.unref?.()
  }

  return {
    all() {
      const at = now()
      return [...rows.values()]
        .filter((row) => at - row.at <= ttl)
        .map(({ at: _at, ...row }) => row)
    },

    replace(records) {
      rows.clear()
      const at = now()
      for (const record of records ?? []) {
        if (!validRecord(record)) continue
        rows.set(record.header.id, {
          header: record.header,
          live: Boolean(record.live),
          persisted: Boolean(record.persisted),
          at,
        })
      }
      while (rows.size > max) rows.delete(rows.keys().next().value)
      schedule()
    },

    clear() {
      rows.clear()
      schedule()
    },
  }
}
