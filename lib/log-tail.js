/**
 * 只读会话日志的**尾部**若干事件——手机端读历史的「上限」就落在这里。
 *
 * 为什么不能直接用 `sessionQuery.readSession()`：它会把整份日志解出来（还要做两次
 * 全量克隆），而且 0.1.7-rc.2 起 v3 日志要走 v3→v4 迁移，迁移会把这个父会话的
 * **每个直接子会话整份解码**。实测：310 个子会话 / 26MB 的父会话，默认约 4GB 堆
 * 20 秒就 OOM（2026-09-25 事故）。那条路一走，代价就收不回来了。
 *
 * 所以这里自己读，代价只跟**窗口**有关、跟会话总量无关：
 *   ① 只读文件末尾 windowBytes 字节（不动前面）；
 *   ② 在窗口里扫帧头（magic `28 b5 2f fd`），**只解完整的帧**——窗口起点切在半帧中间、
 *      以及末尾正在写的残帧，都自然被跳过；
 *   ③ 窗里一个完整帧都没有（最后一帧比窗口还大）→ **放大窗口重来**（4×，直到上限），
 *      而不是直接认输；
 *   ④ 拼出 JSONL 行→事件；只留最后 maxEvents 条，并**向前对齐到那一轮的 `turn/start`**
 *      （能对齐到就把 `turn/start` 也带上，重放才知道这是一轮的起点；对不齐才从
 *      `user/message` 起）。
 *
 * 拿不到就返回 null——**不猜、不编**。调用方据此决定怎么跟用户说。
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

function sessionsRoot() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
}

/**
 * 找某个会话的日志文件。目录名两种口径都见过：`session-<uuid>` 与裸 `<uuid>`；
 * 文件名按格式版本走（`session.v3.jsonl.zstd` / `v4` / …），所以只认前后缀。
 * @returns {string|null} 绝对路径；找不到返回 null
 */
export function findSessionLog(sessionId) {
  if (!sessionId) return null
  const root = sessionsRoot()
  const bare = sessionId.replace(/^session-/, '')
  try {
    for (const ws of readdirSync(root, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue
      const wsPath = join(root, ws.name)
      let entries
      try {
        entries = readdirSync(wsPath, { withFileTypes: true })
      } catch {
        continue
      }
      for (const d of entries) {
        if (!d.isDirectory()) continue
        if (d.name !== sessionId && d.name !== bare && d.name !== `session-${bare}`) continue
        const dir = join(wsPath, d.name)
        let files
        try {
          files = readdirSync(dir)
        } catch {
          continue
        }
        for (const f of files) {
          if (f.startsWith('session.') && f.endsWith('.jsonl.zstd')) return join(dir, f)
        }
      }
    }
  } catch {
    /* 目录还不在、没权限——都当没有 */
  }
  return null
}

/**
 * 扫出一个 buffer 里**完整**的 zstd 帧区间（不解压内容）。
 *
 * 帧头布局（RFC 8878）：magic(4) → 描述符(1) → 可选字段 → 若干块（每块 3 字节头）。
 * 只按结构走就能知道帧边界；起点/终点切在中间的帧会被丢掉（那正是我们要的：
 * 宁可少一帧，也不拿半截数据去解）。
 *
 * @param {Buffer} buffer
 * @returns {Array<{start:number, end:number}>}
 */
export function frameRanges(buffer) {
  const frames = []
  let offset = 0
  while (offset + 4 < buffer.length) {
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      offset += 1
      continue
    }
    const start = offset
    let cursor = offset + 4
    const descriptor = buffer.readUInt8(cursor)
    cursor += 1
    if ((descriptor & 24) !== 0) {
      offset += 1
      continue
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    cursor += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    let ok = cursor <= buffer.length
    while (ok) {
      if (cursor + 3 > buffer.length) {
        ok = false
        break
      }
      const blockHeader = buffer.readUIntLE(cursor, 3)
      cursor += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        ok = false
        break
      }
      cursor += blockType === 1 ? 1 : blockSize
      if (cursor > buffer.length) {
        ok = false
        break
      }
      if (lastBlock) break
    }
    if (!ok) {
      offset += 1
      continue
    }
    if (checksum) cursor += 4
    if (cursor <= buffer.length) {
      frames.push({ start, end: cursor })
      offset = cursor
    } else {
      offset += 1
    }
  }
  return frames
}

/** 只读文件末尾 count 字节（文件比 count 短就全读）。 */
function readFileTail(file, count) {
  const size = statSync(file).size
  const start = Math.max(0, size - count)
  const length = size - start
  const buffer = Buffer.allocUnsafe(length)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, length, start)
  } finally {
    closeSync(fd)
  }
  return { buffer, whole: start === 0 }
}

/** 读一个窗口并解出里面的完整帧 → 事件。读不了返回 null。 */
function eventsInWindow(file, windowBytes) {
  let tail
  try {
    tail = readFileTail(file, windowBytes)
  } catch {
    return null
  }
  const events = []
  for (const { start, end } of frameRanges(tail.buffer)) {
    let text
    try {
      text = zstdDecompressSync(tail.buffer.subarray(start, end)).toString('utf8')
    } catch {
      // 校验不过的帧跳过：正在写的残帧，或校验位对不上的，都不该拖垮读取。
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        /* 半截行（正在写）跳过 */
      }
    }
  }
  return { events, whole: tail.whole }
}

/**
 * 向前对齐到「那一轮的起点」：先找到保留区里第一条 user 消息，再看它前面是不是
 * `turn/start`——是就把起点挪过去（重放需要它才知道这是一轮的开头）。
 * 对不齐就从那条 user 消息起。
 */
function alignToTurnStart(events) {
  const firstUser = events.findIndex((e) => e?.type === 'user/message')
  if (firstUser <= 0) return firstUser < 0 ? 0 : firstUser
  for (let i = firstUser - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/start') return i
    if (events[i]?.type === 'assistant/message' || events[i]?.type === 'user/message') break
  }
  return firstUser
}

/**
 * 读会话日志的尾部事件。
 *
 * @param {string} sessionId
 * @param {{windowBytes?:number, maxWindowBytes?:number, maxEvents?:number}} [options]
 *   windowBytes：起始窗口（压缩字节，默认 4 MB）
 *   maxWindowBytes：窗口放大上限（默认 64 MB；最后一帧比窗口大时会放大重来）
 *   maxEvents：最多返回多少条事件（默认 2000；0 = 不限）
 * @returns {{events:Array, truncated:boolean}|null} 拿不到日志 / 解不出任何事件 → null
 */
export function readTailEvents(sessionId, options = {}) {
  const maxWindowBytes = options.maxWindowBytes ?? 64 * 1024 * 1024
  const maxEvents = options.maxEvents ?? 2000
  const file = findSessionLog(sessionId)
  if (!file) return null

  let budget = Math.min(options.windowBytes ?? 4 * 1024 * 1024, maxWindowBytes)
  for (;;) {
    const read = eventsInWindow(file, budget)
    if (read === null) return null
    if (read.events.length) {
      const droppedByCount = maxEvents > 0 && read.events.length > maxEvents
      const kept = droppedByCount ? read.events.slice(-maxEvents) : read.events
      const from = alignToTurnStart(kept)
      return {
        events: kept.slice(from),
        // 「不是全部」有三种来路：本来就没从头读、条数被上限砍了、以及为了对齐起点丢了几条。
        truncated: !read.whole || droppedByCount || from > 0,
      }
    }
    // 窗里没有完整帧 —— 多半是「最后一帧比窗口大」。放大窗口重来，到上限才认输。
    if (read.whole || budget >= maxWindowBytes) return null
    budget = Math.min(budget * 4, maxWindowBytes)
  }
}