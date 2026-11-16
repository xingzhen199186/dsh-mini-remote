#!/usr/bin/env node
/**
 * 发布签名密钥的加密备份 / 恢复工具（2026-11-16）。
 *
 * 为什么要有：正式的发布密钥不能进版本库，但**也不能只存在一个地方**。
 * 这里把密钥加密成一份可以放进知识库的副本，并提供解回来的办法——
 * 备份没验证过等于没有备份，所以 decrypt 命令本身也要能跑通。
 *
 * 文件格式（DSHENC1）：
 *   "DSHENC1"(7) | iv(12) | tag(16) | 密文
 *   密钥 = scrypt(密码, 固定盐, N=16384/r=8/p=1, 32 字节)；加密 = AES-256-GCM。
 *
 * 用法：
 *   node scripts/signing-key.mjs encrypt <明文密钥> <输出.enc> <密码文件>
 *   node scripts/signing-key.mjs decrypt <输入.enc> <输出密钥> <密码文件>
 *   node scripts/signing-key.mjs inspect <输入.enc>
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

const MAGIC = Buffer.from('DSHENC1')
const SALT = 'dsh-mini-remote-signing-2026'

function derive(password) {
  return scryptSync(password, SALT, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

function encrypt(source, target, passwordFile) {
  const password = readFileSync(passwordFile, 'utf8').trim()
  const plain = readFileSync(source)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', derive(password), iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  const packed = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
  writeFileSync(target, packed)
  console.log(`已加密：${target}（${packed.length} 字节）`)
}

function decrypt(source, target, passwordFile) {
  const password = readFileSync(passwordFile, 'utf8').trim()
  const packed = readFileSync(source)
  if (!packed.subarray(0, 7).equals(MAGIC)) throw new Error('不是本工具生成的备份文件')
  const iv = packed.subarray(7, 19)
  const tag = packed.subarray(19, 35)
  const body = packed.subarray(35)
  const decipher = createDecipheriv('aes-256-gcm', derive(password), iv)
  decipher.setAuthTag(tag)
  writeFileSync(target, Buffer.concat([decipher.update(body), decipher.final()]))
  console.log(`已解出：${target}`)
}

const [action, from, to, passwordFile] = process.argv.slice(2)
if (action === 'encrypt' && from && to && passwordFile) {
  encrypt(from, to, passwordFile)
} else if (action === 'decrypt' && from && to && passwordFile) {
  decrypt(from, to, passwordFile)
} else if (action === 'inspect' && from) {
  const packed = readFileSync(from)
  const ok = packed.subarray(0, 7).equals(MAGIC)
  console.log(`${from}：${ok ? '是本工具的备份' : '无法识别'}，${packed.length} 字节`)
} else {
  console.log('用法：encrypt <明文> <输出.enc> <密码文件> | decrypt <输入.enc> <输出> <密码文件> | inspect <文件>')
  process.exit(1)
}
