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
  let nextCallId = 1

  function entryOf(deviceId) {
    let entry = entries.get(deviceId)
    if (!entry) {
      entry = { armed: false, lastSeen: 0, protocol: 0, appVersion: '', tools: [] }
      entries.set(deviceId, entry)
    }
    return entry
  }

  function takeCalls(deviceId) {
    const queue = queues.get(deviceId)
    if (!queue || queue.length === 0) return []
    queues.set(deviceId, [])
    // **过期的不要发**：等的人早走了，执行只会在手机上留下没人要的动作。
    return queue.filter((item) => item.expiresAt > now())
  }

  function snapshot(deviceId) {
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
      calls: takeCalls(deviceId),
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
      if (entry.armed) entry.lastSeen = now()
      wake(deviceId)
      return snapshot(deviceId)
    },

    /** 手机上报自己的能力（第一步只有版本与协议号，没有工具）。 */
    hello(deviceId, info = {}) {
      const entry = entryOf(deviceId)
      entry.lastSeen = now()
      if (Number.isFinite(info.protocol)) entry.protocol = info.protocol
      if (typeof info.appVersion === 'string') entry.appVersion = info.appVersion.slice(0, 32)
      entry.tools = Array.isArray(info.tools) ? info.tools.slice(0, 32).map((t) => String(t).slice(0, 40)) : []
      return snapshot(deviceId)
    },

    /**
     * 长轮询。waitMs 为 0 时立刻返回（测试与调试用）。
     * 到时间没变化也要回一次——客户端要据此判断"我还连着"。
     */
    poll(deviceId, { waitMs = MAX_WAIT_MS } = {}) {
      const entry = entryOf(deviceId)
      entry.lastSeen = now()
      const bound = Math.max(0, Math.min(MAX_WAIT_MS, Number(waitMs) || 0))
      if (bound === 0) return Promise.resolve(snapshot(deviceId))
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
    call(deviceId, tool, args = {}, timeoutMs = 20_000) {
      const entry = entryOf(deviceId)
      if (!entry.armed || now() - entry.lastSeen >= ONLINE_WINDOW_MS) {
        return Promise.reject(new Error('手机桥没打开或不在线'))
      }
      const id = `c${nextCallId++}`
      const queue = queues.get(deviceId) ?? []
      // 过期时间：**超时之后这条必须作废**，否则手机会在很久以后才取走并执行一次
      // 早已没人等的动作（发文件、写剪贴板都会真的落在手机上）。
      queue.push({ id, tool, args, at: now(), expiresAt: now() + timeoutMs })
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
        }, timeoutMs)
        pending.set(id, { deviceId, resolve: (result) => {
          clearTimeout(timer)
          pending.delete(id)
          if (result && result.ok) {
            resolve(result.result ?? null)
          } else {
            reject(new Error(result?.error || '手机那边执行失败'))
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
      waitingCall.resolve(result || { ok: false, error: '没有结果' })
      wake(deviceId)
      return true
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
