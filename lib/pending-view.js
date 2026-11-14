/**
 * 「通知上能直接点选项」的题目形状（2026-11-14）。
 *
 * 通知栏只放得下几个按钮，也读不了长文本；所以只有**单题 + 2~3 个选项**才把选项
 * 带出去，其余形状照旧只说"打开应用作答"。这里定这条口径，服务端照着发。
 */

/** 通知上最多画几个按钮。 */
export const MAX_NOTICE_OPTIONS = 3

/**
 * @param {Array<{id?:string, options?:Array<{label?:string}>}>} questions
 * @returns {{questionId:string, options:string[]}}
 */
export function noticeOptions(questions) {
  const list = Array.isArray(questions) ? questions : []
  if (list.length !== 1) return { questionId: '', options: [] }
  const one = list[0] || {}
  const raw = Array.isArray(one.options) ? one.options : []
  const labels = raw
    .map((o) => String(o?.label ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_NOTICE_OPTIONS)
  // 两个以上才有"选"的意义；一个选项的题在通知上点了等于没得选。
  if (labels.length < 2) return { questionId: '', options: [] }
  return { questionId: String(one.id ?? ''), options: labels }
}
