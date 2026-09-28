/**
 * 会话标题的落盘缓存。
 *
 * 为什么要有它：一批会话的标题要靠**加载整份会话日志**才折得出来（DSH 的
 * readTitleSnapshots 就是逐个 load），本机 1419 个日志共 1.4 GB 全是 zstd 压缩，
 * 冷读一条实测约 5 秒。lib/tree.js 里那份内存缓存只活到 DSH 这次运行结束——
 * 重启就清零，那 1.4 GB 又得重付一遍。而标题这东西定下来基本不变，读过就该长期记住。
 *
 * 三条边界，一条都不能让插件起不来（这个插件的一贯做法是"少了哪样就关掉哪一块，
 * 不整个倒下"）：
 *   - 文件不在（第一次跑）：当空缓存；
 *   - 文件坏了（半个 JSON、手改坏的）：当空缓存，下次写盘自然把它盖掉；
 *   - 写盘写到一半被打断（断电、两个 DSH 实例并存）：先写临时文件再改名，
 *     盘上要么是旧的那一份、要么是新的那一份，**永远不会是半截**。
 *
 * 存的是一个 sessionId → { title, at } 的平表：手机要的就是"这条会话叫什么"，
 * 别的字段一概不留（会话本身的事实由 DSH 的清单负责，这里只补齐一个缺口）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 标题记多久。
 *
 * 七天：够跨过绝大多数重启（用户不会天天重启 DSH），又不是"永远"——万一哪条会话
 * 后来真的改了标题、而事件流又没让我们看见，过期之后还有机会从日志里重新读一次。
 * 比内存缓存原来那 10 分钟长得多，因为**内存丢了还能重读，落盘丢了就是白读一遍**。
 */
export const TITLE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 盘上最多留多少条。本机 1419 个会话，留一倍余量；一条几十字节，满载也就一百多 KB。
 * 超了按"最久没更新"淘汰——和内存那份同一套规矩，只是盘子更大。
 */
const MAX_ENTRIES = 3000

/**
 * 建一份标题的落盘缓存。读盘是**当场同步做一次**（小文件，不值得为它引入异步），
 * 写盘合并到一次（`debounceMs` 之内反复 set 只写最后那一下）——
 * 展开一个工作区可能一口气补上十几条标题，不合并就是十几次写盘。
 */
export function createTitleCache({
  file, ttl = TITLE_TTL_MS, max = MAX_ENTRIES, debounceMs = 500, now = Date.now,
}) {
  /** sessionId -> { title, at }。顺序 = 最近更新的在后，淘汰时从最早的开始。 */
  const rows = new Map()

  /**
   * 读盘。**任何异常都当"没有缓存"**：文件不在、不是 JSON、结构对不上、
   * 单条字段坏掉——各自跳过，绝不让调用方拿到一个半死的东西。
   */
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw && typeof raw === 'object') {
      const at = now()
      for (const [id, row] of Object.entries(raw)) {
        if (!id || !row || typeof row.title !== 'string') continue
        if (typeof row.at !== 'number' || at - row.at > ttl) continue
        rows.set(id, { title: row.title, at: row.at })
      }
    }
  } catch {
    // 第一次跑没有这个文件；损坏了也走这条。两种情况都是"从空缓存重来"。
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
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(rows)))
      // 改名是原子的：中途死掉也只留下一个 .tmp，正主那份还是完整的。
      renameSync(tmp, file)
    } catch {
      // 写不进去只影响"下次重启还得重读一遍"，不该影响这一次运行。
    }
  }

  function schedule() {
    dirty = true
    if (timer) return
    timer = setTimeout(save, debounceMs)
    // 这个定时器不该拖着进程不让它退出（DSH 关停时也是）。
    if (timer.unref) timer.unref()
  }

  return {
    /** 盘上现有的全部条目（给内存缓存首次灌数据用）。过期的当没记过。 */
    all: () => [...rows].filter(([, row]) => now() - row.at <= ttl),

    /** 取一条。过期的当场丢掉——"没记过"和"记着是空标题"必须分得出来。 */
    get(id) {
      const row = rows.get(id)
      if (!row) return null
      if (now() - row.at > ttl) {
        rows.delete(id)
        return null
      }
      return row.title
    },

    /** 记一条。空标题也记（会话确实没有标题，没理由每次重读一遍）。 */
    set(id, title) {
      if (!id || typeof title !== 'string') return
      rows.delete(id)
      rows.set(id, { title, at: now() })
      while (rows.size > max) rows.delete(rows.keys().next().value)
      schedule()
    },

    /** 立刻写盘。平时走上面那个合并写；测试和收尾时用这个，省得干等。 */
    flush() {
      if (timer) clearTimeout(timer)
      save()
    },
  }
}
