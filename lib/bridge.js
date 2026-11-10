/**
 * 手机桥的"在场"记录（P2 第一步，2026-11-09）。
 *
 * 这一步**只做一件事**：让电脑知道"那台手机上的桥现在开着、在线"。
 * 一个工具都还没有——但这一步必须先立住，否则后面 `phone_*` 工具没有归属。
 *
 * 三条语义，都照 RFC（docs/RFC-安卓客户端与设备桥-V3.1.md 第 6 节）：
 *
 * 1. **武装（armed）是手机那边的事**：用户在手机上打开开关才算数，关掉就立刻失效。
 *    电脑侧只记录、不强行打开。
 * 2. **在线**的定义是"90 秒内来过长轮询"，不是"连过"。手机会一直长轮询，
 *    所以只要它还在问，就算在线；不问超过 90 秒就当作离线。
 * 3. **长轮询**：客户端带着 `wait=1` 来，服务端最多压 25 秒。这样做是为了让
 *    "电脑有话要说"能在眨眼间送到手机，而不是等下一次轮询周期。
 *
 * 这里**不存任何与内容有关的东西**：没有消息队列、没有历史、没有工具参数。
 * 第一步只回答"谁在线、装没武装"。
 */

import { randomUUID } from 'node:crypto'

const ONLINE_WINDOW_MS = 90_000
const MAX_WAIT_MS = 25_000

export function createBridge({ now = () => Date.now() } = {}) {
  /** deviceId -> { armed, lastSeen, protocol, appVersion, tools } */
  const entries = new Map()
  /** deviceId -> 正在等的那个长轮询的 resolve（同一台只留一个：新来的顶掉旧的） */
  const waiting = new Map()
  /** deviceId -> 待手机取走的调用 [{id, tool, args, at}] */
  const queues = new Map()
  /** 调用 id -> 等结果的那个 resolve */
  const pending = new Map()

  // 本次进程的标识：电脑一重启，序号就从 1 重新数；手机靠它区分
  // "这是新一轮的 1" 和 "这是旧命令重放"（2026-11-10 就这么栽过一次）。
  const sessionId = randomUUID()

  function entryOf(deviceId) {
    let entry = entries.get(deviceId)
    if (!entry) {
      entry = { armed: false, lastSeen: 0, protocol: 0, appVersion: '', tools: [], confirmExtended: false }
      entries.set(deviceId, entry)
    }
    return entry
  }

  function takeCalls(deviceId) {
    const entry = entryOf(deviceId)
    const queue = queues.get(deviceId)
    // 撤销授权后连已经排队的动作也不能再发；只清队列，不谎称已交付的动作被撤回。
    if (!entry.armed) {
      if (queue) queues.set(deviceId, [])
      return []
    }
    if (!queue || queue.length === 0) return []
    queues.set(deviceId, [])
    // **过期的不要发**：等的人早走了，执行只会在手机上留下没人要的动作。
    return queue.filter((item) => item.expiresAt > now())
  }

  function canSettle(deviceId, id) {
    const entry = entryOf(deviceId)
    if (!entry.armed) return false
    const call = pending.get(id)
    return Boolean(call && call.deviceId === deviceId && call.expiresAt > now())
  }

  /** 设备被撤销：整份在场记录、队列、在途结果和挂起的长轮询一起作废。 */
  function dropDevice(deviceId) {
    queues.delete(deviceId)
    for (const [id, call] of [...pending]) {
      if (call.deviceId !== deviceId) continue
      pending.delete(id)
      call.resolve({ ok: false, error: '这台设备已经从名册里撤销，调用作废' })
    }
    entries.delete(deviceId)
    const resolve = waiting.get(deviceId)
    if (resolve) {
      waiting.delete(deviceId)
      resolve({ ok: false, armed: false, online: false, calls: [], revoked: true })
    }
  }

  function snapshot(deviceId, take = true) {
    const entry = entryOf(deviceId)
    return {
      ok: true,
      armed: entry.armed,
      online: now() - entry.lastSeen < ONLINE_WINDOW_MS,
      // 第一步还没有工具；这个字段先立住形状，后面 P2 第二步往里填。
      tools: entry.tools,
      protocol: entry.protocol,
      wait: MAX_WAIT_MS,
      // 手机要执行的动作。取走即清空——**不做重投**：重投会让"发通知"变成刷屏。
      calls: take ? takeCalls(deviceId) : [],
    }
  }

  function wake(deviceId) {
    const resolve = waiting.get(deviceId)
    if (!resolve) return
    waiting.delete(deviceId)
    resolve(snapshot(deviceId))
  }

  return {
    /** 手机改武装状态。**只有手机能改**，电脑没有别的入口。 */
    setArmed(deviceId, armed) {
      const entry = entryOf(deviceId)
      entry.armed = armed === true
      if (entry.armed) {
        entry.lastSeen = now()
      } else {
        // 必须在撤权当场清，不能等下一次 poll；否则 disarm → rearm 会复活旧任务。
        queues.set(deviceId, [])
        for (const call of pending.values()) {
          if (call.deviceId === deviceId) {
            call.resolve({ ok: false, error: '手机桥已关闭，等待中的调用已取消（已交付的动作无法由电脑撤回）' })
          }
        }
      }
      wake(deviceId)
      // arm 的 HTTP 响应不是取件通道：调用方不会处理这里藏着的 calls。
      return snapshot(deviceId, false)
    },

    /** 手机上报自己的能力（第一步只有版本与协议号，没有工具）。 */
    hello(deviceId, info = {}) {
      const entry = entryOf(deviceId)
      entry.lastSeen = now()
      if (Number.isFinite(info.protocol)) entry.protocol = info.protocol
      if (typeof info.appVersion === 'string') entry.appVersion = info.appVersion.slice(0, 32)
      // 非默认档才延长调用时限；默认 false 保留今天每个工具原有的 timeout。
      if (typeof info.confirmExtended === 'boolean') entry.confirmExtended = info.confirmExtended
      entry.tools = Array.isArray(info.tools) ? info.tools.slice(0, 32).map((t) => String(t).slice(0, 40)) : []
      // **不要取走待执行的调用**：hello 的返回值只用来确认在场，
      // 它若顺手取走队列，那些动作就被丢在半路（2026-11-09 审视发现）。
      return snapshot(deviceId, false)
    },

    /**
     * 长轮询。waitMs 为 0 时立刻返回（测试与调试用）。
     * 到时间没变化也要回一次——客户端要据此判断"我还连着"。
     */
    poll(deviceId, { waitMs = MAX_WAIT_MS } = {}) {
      const entry = entryOf(deviceId)
      entry.lastSeen = now()
      const bound = Math.max(0, Math.min(MAX_WAIT_MS, Number(waitMs) || 0))
      // 调用可能赶在轮询之前入队；已有任务时必须立即交付，否则会压到调用超时。
      if (bound === 0 || (queues.get(deviceId)?.length ?? 0) > 0) {
        return Promise.resolve(snapshot(deviceId))
      }
      return new Promise((resolve) => {
        // 同一台手机重复进来：旧的那个先放回去，避免请求堆着不放。
        wake(deviceId)
        const timer = setTimeout(() => {
          if (waiting.get(deviceId) === done) waiting.delete(deviceId)
          resolve(snapshot(deviceId))
        }, bound)
        const done = (value) => {
          clearTimeout(timer)
          resolve(value)
        }
        waiting.set(deviceId, done)
      })
    },

    /**
     * 让手机做一件事，并等它回话（P2 第二步）。
     *
     * 超时就当失败——**不重投**。理由：这些动作会真的落在手机上（弹通知、写文件），
     * 重投的代价是重复打扰或重复写入，比"失败一次、让用户再来一遍"更糟。
     */
    call(deviceId, tool, args = {}, timeoutMs = 20_000, meta = {}) {
      const entry = entryOf(deviceId)
      if (!entry.armed || now() - entry.lastSeen >= ONLINE_WINDOW_MS) {
        return Promise.reject(new Error('手机桥没打开或不在线'))
      }
      // 顺序号会在进程重启后复用，旧结果可能因此认领新调用；随机编号消除这个碰撞。
      const id = randomUUID()
      const queue = queues.get(deviceId) ?? []
      // 过期时间：**超时之后这条必须作废**，否则手机会在很久以后才取走并执行一次
      // 早已没人等的动作（发文件、写剪贴板都会真的落在手机上）。
      // 只有手机已经声明非默认确认档时才留 45 秒；默认档连原超时数值都不改。
      const needsConfirmation = entry.confirmExtended && tool !== 'phone_status' && tool !== 'phone_set_clipboard'
      const waitMs = needsConfirmation ? 45_000 : timeoutMs
      const expiresAt = now() + waitMs
      // seq 单调递增、msgId 随机：手机记住已处理的最高序号，比它小的整条丢掉，
      // 同一条也不会被执行两次（2026-11-10，防重放）。序号只在本次进程内有效，
      // 重启后重新计数——真正的防跨重启重放要靠签名，见 docs 里的待办。
      const seq = (entry.lastSeq ?? 0) + 1
      entry.lastSeq = seq
      queue.push({
        id, msgId: randomUUID(), sessionId, seq, tool, args, at: now(), expiresAt,
        taskId: typeof meta.taskId === 'string' ? meta.taskId : '',
      })
      queues.set(deviceId, queue)
      wake(deviceId)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          const left = queues.get(deviceId)
          if (left) {
            queues.set(deviceId, left.filter((item) => item.id !== id))
          }
          reject(new Error('手机没有在预期时间内回话'))
        }, waitMs)
        pending.set(id, { deviceId, expiresAt, resolve: (result) => {
          clearTimeout(timer)
          pending.delete(id)
          if (result && result.ok) {
            resolve(result.result ?? null)
          } else {
            /* 失败时**把手机的原始返回带出来**（2026-11-10）。
             *
             * 原来只写一句"执行失败"，于是手机那头千差万别的原因（没这个控件、
             * 界面变了、手势被系统取消）在电脑这边长得一模一样，排查只能靠猜。
             * 现在优先用手机给的话；连话都没有，就把整段原始返回附在后面。
             */
            const inner = result && typeof result.result === 'object' ? result.result : null
            const said = result?.error
              ?? (typeof result?.result === 'string' ? result.result : '')
              ?? (inner?.error ?? (inner ? JSON.stringify({ ...inner, screen: undefined }).slice(0, 300) : ''))
            const failure = new Error(said || `手机那边执行失败（手机原话：${JSON.stringify(result ?? null).slice(0, 300)}）`)
            // 确认超时/拒绝是结构化事实，不能只留一句模糊错误让模型以为执行过。
            const reason = result?.reason ?? inner?.reason
            const executed = result?.executed ?? inner?.executed
            if (typeof reason === 'string' && reason) failure.reason = reason
            if (typeof executed === 'boolean') failure.executed = executed
            reject(failure)
          }
        } })
      })
    },

    /** 手机报回执行结果。 */
    settle(deviceId, id, result) {
      const waitingCall = pending.get(id)
      if (!waitingCall) return false
      // **只认发起方那台设备**：否则别的设备拿着同一个 id 就能替它回话（2026-11-09 自查）。
      if (waitingCall.deviceId !== deviceId) return false
      // 关闭授权后，手机点旧通知再回执也不能算成功。
      if (waitingCall.expiresAt <= now()) {
        waitingCall.resolve({ ok: false, error: '结果到达时调用已经过期' })
        return false
      }
      if (!canSettle(deviceId, id)) {
        waitingCall.resolve({ ok: false, error: '这台设备当前没有授权，结果不予接受' })
        return false
      }
      waitingCall.resolve(result || { ok: false, error: '没有结果' })
      wake(deviceId)
      return true
    },

    /** 任务编号的进程段：重启后旧任务授权自然失效。 */
    processId() {
      return sessionId
    },

    /** 设备被撤销时由宿主调用：不能让它已经挂上的轮询再交付一批动作。 */
    dropDevice,

    /** 只读：这台设备此刻是否仍被授权。给手机端写剪贴板前再核一次，不碰取件队列。 */
    isArmed(deviceId) {
      return entryOf(deviceId).armed === true
    },

    /** 电脑这边的视角：桥在不在线。设置页要显示的就是它。 */
    status() {
      const rows = [...entries.entries()]
        .map(([deviceId, entry]) => ({
          deviceId,
          armed: entry.armed,
          online: now() - entry.lastSeen < ONLINE_WINDOW_MS,
          lastSeen: entry.lastSeen,
          appVersion: entry.appVersion,
          tools: entry.tools,
        }))
        .sort((a, b) => b.lastSeen - a.lastSeen)
      const online = rows.filter((row) => row.online)
      return {
        online: online.length > 0,
        // 在线但没武装，等于"桥开着但没授权"，界面上要区别对待。
        armed: online.some((row) => row.armed),
        devices: rows.length,
        onlineDevices: online.length,
        rows,
      }
    },

    /** 进程收摊时把还压着的长轮询都放掉，免得测试或重启时挂着不结束。 */
    close() {
      for (const deviceId of [...waiting.keys()]) wake(deviceId)
      entries.clear()
    },
  }
}
