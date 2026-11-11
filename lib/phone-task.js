import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 手机确认用的任务编号：电脑进程 + 根会话 + 该根会话的轮次。
 *
 * 抽成纯函数是为了能单独验“子代理继承根任务”，而不是靠读一遍循环去猜。
 * 子代理只读取根的轮次，**不写回**——它自己的 turn 是另一套计数。
 */
export function createPhoneTaskTracker({ processId }) {
  const rootBySession = new Map()
  const turnByRoot = new Map()

  function track(session, event) {
    const sessionId = session?.id
    if (!sessionId) return
    const isSubagent = session.header?.origin === 'subagent'
    const parent = session.header?.parentSession
    const root = isSubagent ? (rootBySession.get(parent) ?? '') : sessionId
    if (root) rootBySession.set(sessionId, root)
    // 只有根会话自己的 turn/start 才算这个任务的轮次。
    if (!isSubagent && event?.type === 'turn/start' && Number.isFinite(event.data?.turn)) {
      turnByRoot.set(sessionId, event.data.turn)
    }
  }

  function taskIdOf(agent) {
    // 依次试三种拿法：session.id / sessionId / 最后的 id。
    const sessionId = agent?.session?.id ?? agent?.sessionId ?? agent?.id
    const isSubagent = agent?.session?.header?.origin === 'subagent'
    let root = isSubagent ? rootBySession.get(sessionId) : sessionId
    let turn = root ? turnByRoot.get(root) : undefined
    /* exec 里经常**什么会话信息都没有**（2026-11-11 诊断文件实证：
     * hasSession:false、sessionId:null、agentId:null）。这时不能返回空——
     * 空 taskId 会让「本任务免确认」退化成「每次都问」。
     * turnByRoot 在 turn/start 时已经把当前会话记下了，**用最新那条**兜底。 */
    if ((!root || !Number.isFinite(turn)) && turnByRoot.size > 0) {
      const latest = [...turnByRoot.entries()][turnByRoot.size - 1]
      root = latest[0]
      turn = latest[1]
    }
    if (!root || !Number.isFinite(turn)) {
      // 落到文件：console.log 在 DSH 里不持久化，排查时读不到。
      try {
        const file = fileURLToPath(new URL('../scratch/task-debug.log', import.meta.url))
        mkdirSync(dirname(file), { recursive: true })
        appendFileSync(file, JSON.stringify({
          at: new Date().toISOString(),
          root, turn,
          hasSession: Boolean(agent?.session),
          sessionId: agent?.sessionId ?? null,
          agentId: agent?.id ?? null,
        }) + '\n')
      } catch { /* 诊断写不进去也不影响调用 */ }
      return ''
    }
    return `${processId()}:${root}:${turn}`
  }

  return { track, taskIdOf }
}
