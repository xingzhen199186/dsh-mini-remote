/**
 * 一台手机同一时间只让一个会话操作（2026-11-14）。
 *
 * 为什么必须锁：两个会话同时发指令时，点击会互相穿插——A 的"点开设置"
 * 之后 B 的"点发送"落到了设置页上。这不只是乱，是**会点错东西**。
 *
 * 三条规则：
 *   1. 先到先得；别人正在操作就明确告诉它"手机正忙"和排队位置；
 *   2. **人发下一条新指令 = 上一个任务结束**（已定的那条边界），锁随之释放；
 *   3. 持有者长时间没动作（掉线、崩溃、被系统杀掉）要能被接管，否则一台手机
 *      会永久卡在"正忙"。
 *
 * 纯状态机，不碰网络和文件——这样"两个会话抢一台手机"能写成测试。
 */

/** 时间是 0 也算"给了时间"——`Number(now) || Date.now()` 会把 0 当成没给。 */
function at(now) {
  const n = Number(now)
  return Number.isFinite(n) ? n : Date.now()
}

/** 持有者多久没动静算掉线。 */
export const STALE_MS = 3 * 60 * 1000

export function createPhoneLock({ staleMs = STALE_MS } = {}) {
  /** @type {{sessionId:string, taskId:string, since:number, lastAt:number}|null} */
  let holder = null
  /** @type {string[]} */
  let queue = []

  function dropStale(now) {
    if (holder && now - holder.lastAt > staleMs) holder = null
  }

  function promote(now) {
    if (holder) return
    const next = queue.shift()
    if (!next) return
    holder = { sessionId: next, taskId: '', since: now, lastAt: now }
  }

  return {
    /**
     * 申请操作权。
     *
     * @param {string} sessionId 申请的会话
     * @param {{taskId?:string, now:number}} opts
     * @returns {{ok:true}|{ok:false, holder:string, position:number, error:string}}
     */
    acquire(sessionId, { taskId = '', now } = {}) {
      const stamp = at(now)
      dropStale(stamp)
      if (!sessionId) return { ok: true } // 拿不到会话信息时不锁，免得整条能力作废
      if (holder && holder.sessionId === sessionId) {
        holder.lastAt = stamp
        if (taskId) holder.taskId = taskId
        return { ok: true }
      }
      if (!holder) {
        holder = { sessionId, taskId, since: stamp, lastAt: stamp }
        queue = queue.filter((one) => one !== sessionId)
        return { ok: true }
      }
      if (!queue.includes(sessionId)) queue.push(sessionId)
      return {
        ok: false,
        holder: holder.sessionId,
        position: queue.indexOf(sessionId) + 1,
        error: `手机正忙：另一个会话正在操作（持有 ${Math.round((stamp - holder.since) / 1000)} 秒）。`
          + `你在排队第 ${queue.indexOf(sessionId) + 1} 位。等它这一轮结束，或者让人发一条新指令。`,
      }
    },

    /** 动作做完，续一下"还活着"。 */
    touch(sessionId, now = Date.now()) {
      if (holder && holder.sessionId === sessionId) holder.lastAt = at(now)
    },

    /** 主动放掉（会话结束、出错收手时用）。 */
    release(sessionId, now = Date.now()) {
      if (holder && holder.sessionId === sessionId) {
        holder = null
        promote(at(now))
      }
      queue = queue.filter((one) => one !== sessionId)
    },

    /** 人发了一条新指令：上一个任务到此为止，锁全部放掉，排队的第一个顶上。 */
    onHumanMessage(now = Date.now()) {
      holder = null
      promote(at(now))
    },

    /** 看一眼当前状态（自检页和排障用）。 */
    snapshot() {
      return {
        holder: holder ? { sessionId: holder.sessionId, since: holder.since, lastAt: holder.lastAt } : null,
        queue: [...queue],
      }
    },
  }
}
