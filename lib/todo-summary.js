/**
 * 待办条的数据（2026-11-14）。
 *
 * 宿主没有一份"当前待办"的现成服务，但**轨迹里有**：模型每次更新清单都调
 * `todo_write`，参数里就是完整的一份。所以「现在有几项、做到第几项」这件事，
 * 从轨迹里倒着找最近一次就能得到——**不新增状态，也就不会和电脑上那份不一致**。
 *
 * 抽成纯函数是为了能单测：这段逻辑一旦错，用户看到的就是一个假的进度条。
 */

/**
 * 从 `todo_write` 的参数里读出清单。
 * @param {object|string} rawArgs
 * @returns {{items:Array<{text:string,status:string}>, total:number, done:number, doing:number, current:string}|null}
 */
export function summarizeTodos(rawArgs) {
  let args = rawArgs
  if (typeof rawArgs === 'string') {
    try { args = JSON.parse(rawArgs) } catch { return null }
  }
  if (!args || typeof args !== 'object') return null
  const list = Array.isArray(args.todos) ? args.todos : null
  if (!list) return null
  const items = []
  for (const one of list) {
    if (!one || typeof one !== 'object') continue
    const text = String(one.content ?? one.text ?? '').trim()
    if (!text) continue
    items.push({ text, status: String(one.status || 'pending') })
  }
  if (!items.length) return null
  const done = items.filter((one) => one.status === 'completed').length
  const doingList = items.filter((one) => one.status === 'in_progress')
  return {
    items,
    total: items.length,
    done,
    doing: doingList.length,
    current: doingList.length ? doingList[0].text : '',
  }
}

/**
 * 倒着扫轨迹，拿最近一次待办清单。
 *
 * 为什么倒着扫：清单只会被「新的那次更新」覆盖，越靠后越新；扫到最后一次就停。
 * @param {Array} turns 轨迹的轮次组（每组 {entries:[…]}）
 */
export function latestTodos(turns) {
  const groups = Array.isArray(turns) ? turns : []
  for (let i = groups.length - 1; i >= 0; i--) {
    const entries = Array.isArray(groups[i]?.entries) ? groups[i].entries : []
    for (let k = entries.length - 1; k >= 0; k--) {
      const one = entries[k]
      if (!one || one.name !== 'todo_write') continue
      const got = summarizeTodos(one.args)
      if (got) return got
    }
  }
  return null
}

/** 一行摘要：`3/7 · 正在：改设置页`。没有待办时返回空串。 */
export function todoLine(summary) {
  if (!summary || !summary.total) return ''
  const head = `${summary.done}/${summary.total}`
  if (summary.done === summary.total) return `${head} · 全部完成`
  if (summary.current) return `${head} · 正在：${summary.current}`
  return `${head} · 还没开始`
}
