/**
 * 看一眼**真机**的会话事件长什么样。
 *
 * 为什么需要它：手机端要判断「哪条助手消息才是最终回答」，靠的是消息内容里
 * 有没有 `tool-call` 块。这个判据是从类型定义（dsh-llm/lib/types/types.d.ts）
 * 读出来的——**读出来的是约定，不是事实**。约定和实际对不上的时候，
 * 单元测试是绿的（因为桩也是照着约定造的），真机上却不对。
 * 这个工具就是用来把「约定」换成「事实」的。
 *
 * 用法：
 *   node tools/peek-events.mjs                    # 最近改动过的那个会话
 *   node tools/peek-events.mjs <sessionId>        # 指定会话
 *   node tools/peek-events.mjs <sessionId> 8      # 看最后 8 条助手消息
 *   node tools/peek-events.mjs <sessionId> 8 32   # 尾部窗口 32MB（默认 16MB）
 *
 * 读法**直接复用插件自己那套**（lib/log-tail.js），不另写一份：
 *   - 会话日志是**多帧** zstd 容器（一次追加写一帧），单次 `zstdDecompressSync`
 *     只解得出第一帧——2026-09-25 之前这个工具就是这么错的：26MB 的日志只读出
 *     196 字节，看着像「这个会话没内容」。
 *   - 文件名要按格式版本走（v3 / v4 / …）。写死 `session.v3.jsonl.zstd` 的话，
 *     v4 的会话根本找不到。
 *
 * 只读：只读日志尾部一个窗口，不写任何文件。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readTailEvents, findSessionLog } from '../lib/log-tail.js'

/** 最近改动过的那个会话 id（没给 id 时的默认目标）。 */
function newestSessionId() {
  const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
  let best = null
  for (const ws of readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsPath = join(root, ws.name)
    let dirs
    try {
      dirs = readdirSync(wsPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      let files
      try {
        files = readdirSync(join(wsPath, d.name))
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.startsWith('session.') || !f.endsWith('.jsonl.zstd')) continue
        const mtime = statSync(join(wsPath, d.name, f)).mtimeMs
        if (!best || mtime > best.mtime) best = { mtime, id: d.name }
      }
    }
  }
  return best?.id ?? null
}

const sessionId = process.argv[2] || newestSessionId()
const limit = Number(process.argv[3]) || 5
const windowMb = Number(process.argv[4]) || 16

if (!sessionId) {
  console.error('一个会话日志都没找到。')
  process.exit(1)
}

const file = findSessionLog(sessionId)
const tail = readTailEvents(sessionId, {
  windowBytes: windowMb * 1024 * 1024,
  maxEvents: 20000,
})

console.log(`会话 ${sessionId}`)
console.log(`日志 ${file ?? '(没找到)'}`)
if (!tail) {
  console.log(`尾部窗口 ${windowMb}MB 里一个完整帧都没解出来——没有可看的事件。`)
  process.exit(1)
}

console.log(`尾部窗口 ${windowMb}MB 解出 ${tail.events.length} 条事件（`
  + (tail.truncated ? '不是全部，只到最近这一段' : '窗口把整份日志都盖住了，这就是全部')
  + '）\n')

/** 把 content 里每个块的 type 列出来——这就是要核实的事实。 */
function blockTypes(content) {
  if (!Array.isArray(content)) return '(不是数组)'
  return content.map((b) => b?.type ?? '?').join(' + ') || '(空)'
}

const assistant = tail.events.filter((e) => e.type === 'assistant/message')
console.log(`助手消息共 ${assistant.length} 条，看最后 ${Math.min(limit, assistant.length)} 条：\n`)

for (const e of assistant.slice(-limit)) {
  const msg = e.data?.message
  const types = blockTypes(msg?.content)
  const text = (msg?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
    .slice(0, 90)
    .replace(/\n/g, ' ')
  const isMid = (msg?.content ?? []).some((b) => b?.type === 'tool-call')
  console.log(`seq=${e.seq} turn=${e.data?.turn} step=${e.data?.step}`)
  console.log(`  块类型    : ${types}`)
  console.log(`  判定      : ${isMid ? '中间步骤（有 tool-call）→ 不推给手机' : '候选回答（无 tool-call）'}`)
  console.log(`  文字      : ${text || '(无 text 块)'}`)
  if (text.includes('<parameter')) console.log('  ⚠ 文字里夹着工具调用原始标记')
  console.log()
}
