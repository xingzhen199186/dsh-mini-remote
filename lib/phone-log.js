import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 手机动作日志（2026-11-14）。
 *
 * 为什么单开一份：坐标动作是"看不见的手"，事后必须能复盘——它想点哪儿、
 * 当时屏幕上是什么、点成了没有、被什么规矩拦下。**拒绝也要记**，
 * 因为"为什么没让点"和"为什么点了"同样重要。
 *
 * 一行一条 JSON，按天分文件，放在 `scratch/phone-log/`（scratch 不进版本库）。
 */

/** 日志目录：默认落在工作区 scratch 下。 */
export function logDir(root = process.cwd()) {
  return join(root, 'scratch', 'phone-log')
}

/** 当天的文件名，例如 `2026-11-14.jsonl`。 */
export function logFile(at = new Date(), root = process.cwd()) {
  const y = at.getFullYear()
  const m = String(at.getMonth() + 1).padStart(2, '0')
  const d = String(at.getDate()).padStart(2, '0')
  return join(logDir(root), `${y}-${m}-${d}.jsonl`)
}

/**
 * 记一条动作。
 *
 * @param {object} entry 动作内容（工具名、坐标、结果、原因等）
 * @param {{root?:string, at?:Date}} [opts]
 * @returns {string} 写进的日志文件路径
 */
export function appendAction(entry, opts = {}) {
  const at = opts.at || new Date()
  const file = logFile(at, opts.root)
  mkdirSync(logDir(opts.root), { recursive: true })
  const line = JSON.stringify({ at: at.toISOString(), ...entry })
  appendFileSync(file, line + '\n', 'utf8')
  return file
}
