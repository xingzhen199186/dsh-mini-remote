import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

/**
 * 发布密钥的守门测试（2026-11-16）。
 *
 * 密钥本身当然不在仓库里；这里保证的是"它进不来"：
 * 忽略规则、提交前检查、全仓库扫描三件都到位。
 */

test('.gitignore 挡住了各类密钥文件', () => {
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')
  for (const pattern of ['*.jks', '*.keystore', '*.p12', '*.pfx']) {
    assert.ok(ignore.includes(pattern), `缺少忽略规则：${pattern}`)
  }
  assert.match(ignore, /^keys\/$/m, '本机密钥目录要忽略')
})

test('提交前检查存在且能跑', () => {
  assert.ok(existsSync(new URL('../scripts/check-staged-keys.mjs', import.meta.url)))
  assert.ok(existsSync(new URL('../scripts/install-git-hooks.mjs', import.meta.url)))
  const run = spawnSync(process.execPath, ['scripts/check-staged-keys.mjs', '--all'], { encoding: 'utf8' })
  assert.equal(run.status, 0, `全仓库扫描应当通过：${run.stderr}`)
})

test('加密备份工具能识别自己的文件格式', () => {
  const source = readFileSync(new URL('../scripts/signing-key.mjs', import.meta.url), 'utf8')
  assert.match(source, /DSHENC1/, '要有格式标记，避免把别的东西当备份')
  assert.match(source, /aes-256-gcm/, '备份要真加密')
  assert.match(source, /scryptSync/, '密码要用慢哈希派生')
})
