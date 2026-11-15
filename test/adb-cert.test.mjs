import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 自签证书的 DER 拼法（2026-11-15）。
 *
 * 这一处错一次就是"生成钥匙失败（内部错误）"，而**手机上看不到原因**——
 * 上一版就是这么栽的：算法标识多套了一层 SEQUENCE，解析器要 OID 却拿到 SEQUENCE。
 * 所以把它拿到电脑上用 JDK 真跑一遍：能解析、能通过有效期检查，才算对。
 *
 * 本机没有 JDK 时跳过（不把测试环境绑死）。
 */

function findJdk() {
  const home = process.env.JAVA_HOME
  const candidates = []
  if (home) candidates.push(home)
  for (const root of ['C:/Program Files/Eclipse Adoptium', 'C:/Program Files/Java', 'C:/Program Files/Microsoft']) {
    if (!existsSync(root)) continue
    for (const name of ['jdk-21.0.12.101-hotspot', 'jdk-17.0.20.101-hotspot']) {
      candidates.push(join(root, name))
    }
  }
  // PATH 上的也算
  candidates.push('')
  for (const one of candidates) {
    const javac = one ? join(one, 'bin', 'javac.exe') : 'javac'
    const probe = spawnSync(javac, ['-version'], { encoding: 'utf8' })
    if (probe.status === 0) {
      const java = one ? join(one, 'bin', 'java.exe') : 'java'
      return { javac, java }
    }
  }
  return null
}

const jdk = findJdk()

test('自签证书：拼出来的 DER 能被 JDK 解析并通过有效期检查', { skip: jdk === null && '本机没有 javac' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'adb-cert-'))
  try {
    writeFileSync(join(dir, 'DerTest.java'), readFileSync(new URL('./fixtures/adb-cert/DerTest.java', import.meta.url)))
    const compile = spawnSync(jdk.javac, ['-encoding', 'UTF-8', 'DerTest.java'], { cwd: dir, encoding: 'utf8' })
    assert.equal(compile.status, 0, '编译失败：' + (compile.stderr || compile.stdout))
    const run = spawnSync(jdk.java, ['DerTest'], { cwd: dir, encoding: 'utf8' })
    assert.equal(run.status, 0, '运行失败：' + (run.stderr || run.stdout))
    assert.match(run.stdout, /OK/, '证书要能生成并解析')
    assert.match(run.stdout, /CN=dsh-everywhere/, '主题要对')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
