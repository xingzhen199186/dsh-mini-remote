/**
 * 体量守门（2026-10-17）。
 *
 * 这两条守的不是"代码质量"，是**别无声地长大**。
 *
 * 手机页 8,211 行 / 433 KB、发布包 2.1 MB——这两个数本身都不是问题，问题在它们
 * **悄悄**变大的时候没人发现：每次加一点，半年后回头看就不知道为什么改一个气泡要
 * 在八千行里找位置了。
 *
 * ## 阈值怎么定的
 *
 * 页面：当前 8,211 行 × 约 1.06 = 8,700；字节按 433 KB × 约 1.1。拦的是"又长了一千行"
 * 这种，不拦正常改动。真需要长过去的时候改这个数——那一下就是该停下来想一想的时刻。
 * （注意：这里的行数**含空行**。`Measure-Object -Line` 那一类工具不数空行，
 * 用它会把这文件读成 6,246 行，差了两千，口径不一样。）
 *
 * ## 为什么包体要调 `npm pack` 而不是自己遍历目录
 *
 * 2026-10-17 踩过一次：自己按 `files` 白名单遍历工作区，算出 10.78 MB，于是断定
 * "包体太大"——**错了**。`lib/art/.npmignore` 里一行 `out-*` 把过程产物挡在包外，
 * 真实包体只有 2.1 MB。**自己模拟打包规则 = 第二份真相**，迟早和 npm 说的不一样。
 * 所以这里直接问 npm 要数字。
 *
 * ## 为什么不拆页面
 *
 * 它和 service worker 缓存、`__BUILD__` 注入、以及一批"对着页面源码文本匹配"的
 * 活体断言三重耦合。拆它得单独一轮，不该顺手做。先用一条线把它拦住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('手机页体量：不超过 8700 行、480 KB（超了就该重新想结构，不是继续往下堆）', () => {
  const file = join(ROOT, 'lib/page.html')
  // 这个仓库统一 LF（见 .gitattributes），所以按 `\n` 切就是真实行数。
  const lines = readFileSync(file, 'utf8').split('\n').length
  const kb = Math.round(statSync(file).size / 1024)
  assert.ok(lines <= 8700, `lib/page.html 已经 ${lines} 行，越过守门线 8700 了`)
  assert.ok(kb <= 480, `lib/page.html 已经 ${kb} KB，越过守门线 480 KB 了`)
})

test('发布包体量：问 npm 要真实数字，不超过 3 MB（现在约 2.1 MB）', () => {
  // `--dry-run` 不写文件；`--json` 让我们拿到 `unpackedSize`，那是 npm 自己算的。
  let parsed
  try {
    const out = execSync('npm pack --dry-run --json', {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      // npm 在 Windows 上是 npm.cmd，必须走 shell 才找得到。
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    parsed = JSON.parse(out)
  } catch (err) {
    // 拿不到数字时说"没验到"，而不是报一个假的体积。
    assert.fail(`npm pack --dry-run 没跑通，包体这一条这次没验到：${err?.message ?? err}`)
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  assert.ok(entry && Number.isFinite(entry.unpackedSize), 'npm 返回里没有 unpackedSize')

  const mb = Math.round((entry.unpackedSize / (1024 * 1024)) * 100) / 100
  assert.ok(entry.unpackedSize <= 3 * 1024 * 1024,
    `发布包已经 ${mb} MB，越过守门线 3 MB。先看是不是有过程产物混进了 lib/：`
    + 'lib/art/.npmignore 里那条 `out-*` 是唯一一道闸。')
  // 顺手钉一下"包里到底有没有那批过程产物"。体积是会飘的，这条更直接。
  const artFiles = (entry.files ?? []).filter((one) => String(one.path).startsWith('lib/art/'))
  const outFiles = artFiles.filter((one) => /^lib\/art\/out-/.test(String(one.path)))
  assert.equal(outFiles.length, 0,
    `lib/art/ 里混进了过程产物：${outFiles.map((one) => one.path).join('、')}`)
})
