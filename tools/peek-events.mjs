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
 *   node tools/peek-events.mjs                 # 最近改动的那个会话
 *   node tools/peek-events.mjs <sessionId>     # 指定会话
 *   node tools/peek-events.mjs <sessionId> 8   # 看最后 8 条助手消息
 *
 * 只读：解压到内存里看一眼，不写任何文件。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')

/** 在 sessions 目录下递归找某个会话的日志文件。 */
function findLog(sessionId) {
  const found = []
  for (const wsDir of readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!wsDir.isDirectory()) continue
    const wsPath = join(SESSIONS, wsDir.name)
    let entries
    try {
      entries = readdirSync(wsPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (sessionId && e.name !== sessionId) continue
      const log = join(wsPath, e.name, 'session.v3.jsonl.zstd')
      try {
        found.push({ path: log, mtime: statSync(log).mtimeMs, id: e.name })
      } catch {
        /* 没有这个文件就跳过 */
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return found[0] ?? null
}

const wantId = process.argv[2] || null
const limit = Number(process.argv[3]) || 5

const target = findLog(wantId)
if (!target) {
  console.error(wantId ? `没找到会话 ${wantId} 的日志。` : '一个会话日志都没找到。')
  process.exit(1)
}

const lines = zstdDecompressSync(readFileSync(target.path)).toString('utf8').split('\n')
const events = []
for (const line of lines) {
  if (!line.trim()) continue
  try {
    events.push(JSON.parse(line))
  } catch {
    /* 半截行（正在写）忽略 */
  }
}

console.log(`会话 ${target.id}`)
console.log(`日志 ${target.path}`)
console.log(`共 ${events.length} 条事件\n`)

/** 把 content 里每个块的 type 列出来——这就是要核实的事实。 */
function blockTypes(content) {
  if (!Array.isArray(content)) return '(不是数组)'
  return content.map((b) => b?.type ?? '?').join(' + ') || '(空)'
}

const assistant = events.filter((e) => e.type === 'assistant/message')
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
