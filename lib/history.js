/**
 * 把一个会话**已经跑完的历史**重放成手机上要显示的那一串。
 *
 * 为什么需要它：手机能点开**全部**会话（一个工作区里常有上百条），而插件手里那份
 * 记录只有「它在场时看见过的事件」——重启前跑过的、在电脑上开的会话，点进去是空的。
 * 用户 2026-09-25 提的要求是：点开一个会话，就该看到它之前的每一轮。
 *
 * 数据来源是 DSH 自己的会话记录（`sessionQuery.readSession`，见 index.js），
 * 这里只负责把那一串原始事件**重放**成聊天记录。
 *
 * **关键：提取器必须和实时那条路是同一个**（`events.js` 的 `createTurnTracker`）。
 * 两条路各写一套判断的话，「哪条才算最终回答」迟早会走散——一边显示旁白、
 * 一边显示回答，用户看到的就是同一个会话在两个地方长得不一样。
 */
import { createTurnTracker } from './events.js'

/**
 * @param {Array<{type:string, time?:number, data?:any}>} events DSH 的原始事件，**按发生顺序**。
 * @returns {Array<{role:'user'|'assistant', text:string, timestamp:number|null,
 *                  id?:string|null, reason?:string, interrupted?:boolean}>}
 */
export function replayHistory(events) {
  const tracker = createTurnTracker()
  const out = []
  for (const event of events ?? []) {
    // 会话 id 在这里没有意义：一个会话的日志只会喂给一个 tracker，
    // 传个固定值就行，不必把 id 一路带进来。
    const action = tracker.feed('replay', event)
    if (!action) continue
    const timestamp = typeof event?.time === 'number' ? event.time : null
    if (action.kind === 'user') {
      out.push({ role: 'user', text: action.text, id: action.id ?? null, timestamp })
    } else {
      out.push({
        role: 'assistant',
        text: action.text,
        timestamp,
        reason: action.reason,
        interrupted: action.interrupted === true,
      })
    }
  }
  return out
}

/**
 * 从重放出来的记录里取最后一条最终回复，做成单帧模式要的那个形状。
 *
 * 返回 null 表示「这个会话还没有过最终回复」——那时单帧模式该显示空，
 * **不能拿用户自己那句话顶上**，也不能拿旁白顶上。
 */
export function lastReply(entries, sessionId) {
  for (let i = (entries?.length ?? 0) - 1; i >= 0; i--) {
    const m = entries[i]
    if (m.role !== 'assistant') continue
    return {
      text: m.text,
      sessionId,
      title: '',
      timestamp: m.timestamp,
      reason: m.reason,
      interrupted: m.interrupted === true,
    }
  }
  return null
}
