#!/usr/bin/env node
/**
 * 自连通道的一条命令自检（2026-11-15）。
 *
 * 为什么要有：这条通道今天踩过的坑（帧没走 TLS、公钥字段写错、多发一个 CNXN、
 * 后台任务 0 字节）全是人肉复验才发现的。**把它们固化成脚本，退步就会立刻变红。**
 *
 * 它不直接跑 adb shell 冒充结果——那样正好会把"通道有问题"盖住（上次就是这么漏的）。
 * 做法是：让 App 自己用真实路径跑一遍（ShellBackend → 自连通道 / Termux 兜底），
 * 结果写进 App 私有目录，再读回来断言。
 *
 * 用法：npm run check:adb
 * 需要：手机连着 adb、App 装的是 debug 包（run-as 才能读文件）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const ADB = process.env.ADB ?? 'D:/Android/Sdk/platform-tools/adb.exe'
const PKG = 'com.dsh.miniremote'
const COMPONENT = `${PKG}/.AdbPairingReceiver`
const ACTION = `${PKG}.SELF_TEST`
const RESULT = 'files/adb-channel-check.json'

function adb(...args) {
  const run = spawnSync(ADB, args, { encoding: 'utf8' })
  if (run.error) throw new Error(`adb 起不来：${run.error.message}`)
  return { code: run.status, out: run.stdout ?? '', err: run.stderr ?? '' }
}

function fail(message) {
  console.log(`\n✗ ${message}`)
  process.exit(1)
}

if (!existsSync(ADB)) fail(`找不到 adb：${ADB}（可用环境变量 ADB 指定）`)

const devices = adb('devices').out.split('\n').filter((line) => line.includes('\tdevice'))
if (devices.length === 0) fail('没有在线的手机：先开无线调试，或插上数据线')

// 先删掉上一轮的结果：否则一看到旧文件就返回，验的是上一次的绿（2026-11-15 踩过）。
adb('shell', 'run-as', PKG, 'rm', '-f', RESULT)

console.log('① 让手机自己跑一遍检查……')
const broadcast = adb('shell', 'am', 'broadcast', '-a', ACTION, '-n', COMPONENT)
if (!broadcast.out.includes('Broadcast completed')) {
  fail(`广播没送到：${broadcast.out.trim() || broadcast.err.trim()}`)
}

// 后台任务那一项本身要 4 秒多，给它留够时间。
const waitMs = 12000
const startedAt = Date.now()
let raw = ''
while (Date.now() - startedAt < waitMs) {
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const read = adb('exec-out', 'run-as', PKG, 'cat', RESULT)
  if (read.code === 0 && read.out.trim().startsWith('{')) {
    raw = read.out.trim()
    break
  }
}
if (!raw) fail('没读到结果文件（App 可能被杀了；打开一次 App 再试）')

let parsed
try {
  parsed = JSON.parse(raw)
} catch (err) {
  fail(`结果不是合法 JSON：${raw.slice(0, 200)}`)
}

const checks = Array.isArray(parsed.checks) ? parsed.checks : []
if (checks.length === 0) fail('结果里没有检查项')

let failed = 0
console.log('② 结果：\n')
for (const one of checks) {
  const mark = one.pass ? '✓' : '✗'
  if (!one.pass) failed += 1
  console.log(`  ${mark} ${one.name}`)
  if (one.detail) console.log(`      ${one.detail}`)
}

console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 项没通过`)
  process.exit(1)
}
console.log(`✓ ${checks.length} 项全过（自连通道可用）`)
