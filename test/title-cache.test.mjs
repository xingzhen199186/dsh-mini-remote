/**
 * 会话标题的落盘缓存。
 *
 * 它存在的理由：读一条标题要加载整份会话日志（本机 1419 个文件共 1.4 GB，全部 zstd，
 * 冷读一条约 5 秒），而 DSH 一重启内存缓存就清零。所以这里验的都是"边界"——
 * 文件不在、文件坏了、写不进去、过期、满了——每一条都不许把插件带崩。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createTitleCache, TITLE_TTL_MS } from '../lib/title-cache.js'

/** 每个用例一个全新的临时目录，免得互相看见对方的文件。 */
function tempFile(name = 'titles.json') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-titles-'))
  return { dir, file: join(dir, name) }
}

test('标题记七天（够跨过重启，又不是永远）', () => {
  assert.equal(TITLE_TTL_MS, 7 * 24 * 60 * 60 * 1000)
})

test('第一次跑：文件不在也能用，当空缓存', () => {
  const { file } = tempFile()
  const cache = createTitleCache({ file })
  assert.deepEqual(cache.all(), [])
  assert.equal(cache.get('s1'), null)
  cache.set('s1', '甲')
  assert.equal(cache.get('s1'), '甲')
})

test('落盘之后读回来：DSH 重启不必再读一遍日志', () => {
  const { file } = tempFile()
  const first = createTitleCache({ file })
  first.set('s1', '甲')
  first.set('s2', '')          // 空标题也记
  first.flush()
  assert.ok(existsSync(file), 'flush 之后盘上要有这个文件')

  // 换一个实例 = 模拟重启：内存清零，只认盘上那份
  const second = createTitleCache({ file })
  assert.equal(second.get('s1'), '甲')
  assert.equal(second.get('s2'), '', '空标题是"确实没有"，和"没读过"必须分得开')
  assert.equal(second.get('s3'), null, '没记过的仍然是 null')
})

test('文件坏了当空缓存重来，绝不抛出去', () => {
  const { file } = tempFile()
  writeFileSync(file, '{"s1": {"title": "半截')   // 断电留下的半个 JSON
  const cache = createTitleCache({ file })
  assert.deepEqual(cache.all(), [], '坏了就当没缓存')

  // 而且下一次写盘要能把它盖成好的
  cache.set('s9', '好的')
  cache.flush()
  assert.equal(createTitleCache({ file }).get('s9'), '好的')
})

test('文件是合法 JSON 但形状不对：坏的那些跳过，好的照收', () => {
  const { file } = tempFile()
  writeFileSync(file, JSON.stringify({
    s1: { title: '好的', at: Date.now() },
    s2: 42,                                  // 不是对象
    s3: { title: 5, at: Date.now() },        // title 不是字符串
    s4: { title: '没有时间戳' },              // 缺 at，不知道过期没有
  }))
  const cache = createTitleCache({ file })
  assert.equal(cache.get('s1'), '好的')
  assert.equal(cache.get('s2'), null)
  assert.equal(cache.get('s3'), null)
  assert.equal(cache.get('s4'), null, '不知道什么时候记的，宁可不认')
})

test('过期的条目当没记过（重新读一次总比记着一个旧标题强）', () => {
  const { file } = tempFile()
  let now = 1_000_000
  const cache = createTitleCache({ file, ttl: 1000, now: () => now })
  cache.set('s1', '甲')
  assert.equal(cache.get('s1'), '甲')
  now += 5000
  assert.equal(cache.get('s1'), null, '过期了就该重来')

  // 同一条过期的记录，换一个实例读盘时也要被滤掉
  cache.flush()
  const reloaded = createTitleCache({ file, ttl: 1000, now: () => now })
  assert.deepEqual(reloaded.all(), [])
})

test('条目满了淘汰最久没更新的那条', () => {
  const { file } = tempFile()
  const cache = createTitleCache({ file, max: 3 })
  for (const id of ['a', 'b', 'c', 'd']) cache.set(id, id)
  assert.deepEqual(cache.all().map(([id]) => id), ['b', 'c', 'd'])
  assert.equal(cache.get('a'), null)

  // 已经记着的再 set 一次 = 它变成"最新"，不该被淘汰
  cache.set('b', 'b2')
  cache.set('e', 'e')
  assert.equal(cache.get('b'), 'b2', '重新记过的算最近更新')
  assert.equal(cache.get('c'), null, '该轮到 c 了')
})

test('写盘写不进去时不影响这一次运行，也不留半截文件', () => {
  // 数据目录被人占成了一个文件（或没权限）——落盘这条路断掉，插件照常跑。
  const { dir } = tempFile()
  const blocked = join(dir, 'not-a-dir')
  writeFileSync(blocked, 'x')
  const file = join(blocked, 'titles.json')

  const cache = createTitleCache({ file })
  cache.set('s1', '甲')
  cache.flush()                       // 不抛
  assert.equal(cache.get('s1'), '甲', '内存里这一份照常可用')
  assert.ok(!existsSync(file), '写不进去就是写不进去，不该装作写成了')
})

test('两个实例先后写同一个文件：盘上永远是完整的那一份', () => {
  // 写盘是"先写临时文件再改名"：任何一刻去看那个文件，要么是旧的那整份、要么是新的整份。
  const { file } = tempFile()
  const a = createTitleCache({ file })
  a.set('s1', '甲')
  a.flush()

  const b = createTitleCache({ file })   // b 读到的就是 a 写的那份
  b.set('s2', '乙')
  b.flush()

  const final = createTitleCache({ file })
  assert.equal(final.get('s1'), '甲', '后来那个实例没把先前那条抹掉')
  assert.equal(final.get('s2'), '乙')
  assert.ok(!existsSync(file + '.tmp'), '临时文件要改掉，不能留在盘上')
})

test('合并写：debounce 之内的多次 set 只落一次盘', async () => {
  const { file } = tempFile()
  const cache = createTitleCache({ file, debounceMs: 5 })
  cache.set('s1', '甲')
  cache.set('s2', '乙')
  assert.ok(!existsSync(file), '还没到点，不该已经在写')
  await new Promise((r) => setTimeout(r, 30))
  const back = createTitleCache({ file })
  assert.equal(back.get('s1'), '甲')
  assert.equal(back.get('s2'), '乙')
})

test('set 收到坏参数时当没发生，不写进缓存', () => {
  const { file } = tempFile()
  const cache = createTitleCache({ file })
  cache.set('', '没有 id')
  cache.set('s1', 42)
  cache.set(null, 'x')
  assert.deepEqual(cache.all(), [])
})
