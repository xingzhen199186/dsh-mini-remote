#!/usr/bin/env node
/**
 * 装 pre-commit 钩子（2026-11-16）。
 *
 * 为什么要有：`.gitignore` 挡不住"已经盯上这个文件、手一滑 git add -f"，
 * 也挡不住别人用别的客户端。钩子是提交前的最后一道门。
 *
 * 钩子本身不进版本库（.git 里的东西本来就不提交），所以用这个脚本生成；
 * `npm install` 时通过 prepare 自动跑一次。
 */

import { writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const hookPath = join('.git', 'hooks', 'pre-commit')
if (!existsSync('.git')) {
  console.error('这里不是 git 仓库，跳过')
  process.exit(0)
}

const content = `#!/bin/sh
# 由 scripts/install-git-hooks.mjs 生成：提交前检查有没有把密钥提交进去。
node scripts/check-staged-keys.mjs || exit 1
`

mkdirSync(join('.git', 'hooks'), { recursive: true })
writeFileSync(hookPath, content)
try {
  chmodSync(hookPath, 0o755)
} catch (err) {
  // Windows 上 chmod 可能不生效，git 自己会按 shell 脚本执行
}
console.error(`已安装提交前检查：${hookPath}`)
