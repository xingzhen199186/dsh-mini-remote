/**
 * 构建指纹：只跟「代码内容」有关，跟「代码放在哪儿」无关。
 *
 * 为什么值得一条专门的测试：插件平时是被 DSH 通过一条**目录链接**加载的
 * （`profiles/web/node_modules/dsh-mini-remote` → 工作副本），`import.meta.url`
 * 拿到的于是是链接那条路径。指纹一旦把绝对路径也算进去，同一份代码经链接和经真实
 * 路径就是两个数，`live-check` 里那条「现在应答我的是不是这份代码」会永远报红。
 * 2026-09-27 真踩了：改完样式之后，进程报的是旧值、本地算的是新值，两边对不上。
 *
 * 做法：搭**两个最小插件副本**（真的 build.js + 几个占位源文件），内容一模一样、
 * 只是路径不同，两边的指纹必须相等；再把其中一个改一个字，必须不相等。
 *
 * 别改成 `cpSync` 整棵 lib —— 在本机这个 harness 里那会让 Node 硬崩
 * （退出码 0xC0000409，stdout/stderr 一个字都没有），原因未查明，别去踩。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BUILD_SRC = readFileSync(join(ROOT, 'lib', 'build.js'), 'utf8')

/** 一个能被加载的最小插件；两个副本只有路径不同，内容逐字节相同。 */
function fakePlugin() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mini-fp-'))
  mkdirSync(join(dir, 'lib', 'art'), { recursive: true })
  mkdirSync(join(dir, 'client'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
  writeFileSync(join(dir, 'lib', 'build.js'), BUILD_SRC)
  writeFileSync(join(dir, 'lib', 'index.js'), 'export const a = 1\n')
  writeFileSync(join(dir, 'lib', 'page.html'), '<p>同一份内容</p>')
  writeFileSync(join(dir, 'lib', 'art', 'pose.webp'), 'not-really-a-webp')
  writeFileSync(join(dir, 'client', 'client.js'), '// client\n')
  return dir
}

async function idAt(dir) {
  const mod = await import(pathToFileURL(join(dir, 'lib', 'build.js')).href)
  return mod.buildId()
}

function cleanup(...dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
}

test('同一份代码换个位置，指纹不变', async () => {
  const a = fakePlugin()
  const b = fakePlugin()
  try {
    assert.equal(await idAt(a), await idAt(b))
  } finally {
    cleanup(a, b)
  }
})

test('内容变了指纹就变（免得上面那条靠"永远返回同一个数"蒙过去）', async () => {
  const a = fakePlugin()
  const b = fakePlugin()
  try {
    const before = await idAt(a)
    writeFileSync(join(b, 'lib', 'page.html'), '<p>改了一个字</p>')
    assert.notEqual(await idAt(b), before)
  } finally {
    cleanup(a, b)
  }
})
