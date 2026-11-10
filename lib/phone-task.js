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
    const sessionId = agent?.session?.id ?? agent?.id
    const isSubagent = agent?.session?.header?.origin === 'subagent'
    const root = isSubagent ? rootBySession.get(sessionId) : sessionId
    const turn = root ? turnByRoot.get(root) : undefined
    if (!root || !Number.isFinite(turn)) return ''
    return `${processId()}:${root}:${turn}`
  }

  return { track, taskIdOf }
}
