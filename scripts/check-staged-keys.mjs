#!/usr/bin/env node
/**
 * 拦住"发布密钥进版本库"（2026-11-16）。
 *
 * 两道用法：
 *   - 不带参数：供 git 的 pre-commit 调用，只看**这次要提交的文件**；
 *   - 带 --all：供 `npm run guard:keys` 或测试使用，扫**整个仓库里已被跟踪的文件**。
 *
 * 为什么单独查"已被跟踪"：`.gitignore` 只能挡住新文件，
 * 一个已经被 commit 进去的密钥，之后改多少次 ignore 都还在里面。
 */

import { spawnSync } from 'node:child_process'

const SENSITIVE = /\.(jks|keystore|p12|pfx|bks)$/i
const LOCAL_ONLY_DIRS = [/^keys\//, /^scratch\//]

function git(args) {
  const run = spawnSync('git', args, { encoding: 'utf8' })
  if (run.status !== 0) {
    console.error(`git ${args.join(' ')} 失败：${run.stderr.trim()}`)
    process.exit(2)
  }
  return run.stdout.split('\n').filter(Boolean)
}

const all = process.argv.includes('--all')
const files = all ? git(['ls-files']) : git(['diff', '--cached', '--name-only'])

const bad = files.filter((file) => SENSITIVE.test(file) || LOCAL_ONLY_DIRS.some((dir) => dir.test(file)))

if (bad.length === 0) {
  console.log(all ? '✓ 仓库里没有跟踪任何密钥文件' : '✓ 这次提交里没有密钥文件')
  process.exit(0)
}

console.error('✗ 这些文件不该进版本库：')
for (const file of bad) console.error(`   ${file}`)
console.error('')
console.error('如果是误加入的，先取消跟踪（文件会留在本机）：')
for (const file of bad) console.error(`   git rm --cached "${file}"`)
process.exit(1)
