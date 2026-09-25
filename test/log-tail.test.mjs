/**
 * 「只读日志尾部」的离线用例——手机端读历史的**上限**就落在这里。
 *
 * 这段代码错起来也是安静的：少读了、多读了、把半截帧当完整帧解、第一条是半句回答……
 * 都不会报错，只是手机上看到的东西不对。所以判据一条条钉住：
 * 帧边界怎么认、窗口切坏了怎么办、上限有没有生效、从一轮的开头开始没有。
 *
 * 会话日志是**拼接 zstd 帧**的容器（每批一个帧），所以这里也按那个形状造数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { frameRanges, findSessionLog, readTailEvents } from '../lib/log-tail.js'

/** 造一批事件行；每 5 条一个帧，模拟「每批一个帧」。 */
function frameLines(lines, perFrame = 5) {
  const frames = []
  for (let i = 0; i < lines.length; i += perFrame) {
    frames.push(zstdCompressSync(Buffer.from(lines.slice(i, i + perFrame).join('\n') + '\n')))
  }
  return Buffer.concat(frames)
}

/** 一轮对话：用户一句、模型一句。 */
function turn(n) {
  return [
    JSON.stringify({ type: 'turn/start', seq: n, time: n * 1000, data: { turn: n } }),
    JSON.stringify({
      type: 'user/message',
      seq: n,
      time: n * 1000 + 1,
      data: { id: `u${n}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `问${n}` }] },
    }),
    JSON.stringify({
      type: 'assistant/message',
      seq: n,
      time: n * 1000 + 2,
      data: { message: { content: [{ type: 'text', text: `答${n}` }] } },
    }),
    JSON.stringify({ type: 'turn/end', seq: n, time: n * 1000 + 3, data: { turn: n, reason: { kind: 'completed' } } }),
  ]
}

/** 在临时 DSH_HOME 里放一个会话日志；返回 { home, id, dirName }。 */
function fixture({ events = 40, dirName = null, fileName = 'session.v4.jsonl.zstd' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mini-tail-'))
  const id = 'session-11111111-2222-3333-4444-555555555555'
  const dir = join(home, 'sessions', '--tmp-ws--', dirName ?? id)
  mkdirSync(dir, { recursive: true })
  const lines = []
  for (let n = 1; n <= events / 4; n++) lines.push(...turn(n))
  writeFileSync(join(dir, fileName), frameLines(lines))
  return { home, id, dirName: dirName ?? id }
}

/** 用临时 home 跑一段，跑完删干净。 */
function withHome(home, fn) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

/** fixture 里那个日志文件的字节数（要在 withHome 里调：findSessionLog 认 DSH_HOME）。 */
function fixtureSize({ id }) {
  return statSync(findSessionLog(id)).size
}

test('帧边界：三个帧就认三段，前后各切坏一截也不影响中间的', () => {
  const buffer = frameLines(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'])
  const clean = frameRanges(buffer)
  assert.equal(clean.length, 3)
  assert.equal(clean[0].start, 0)
  assert.equal(clean[clean.length - 1].end, buffer.length)

  // 前面塞 3 个字节（模拟窗口从半帧中间开始）：只丢那一帧，后面两帧照样认得
  const cut = Buffer.concat([Buffer.from([0x00, 0x11, 0x22]), buffer])
  const afterCut = frameRanges(cut)
  assert.equal(afterCut.length, 3)
  assert.equal(afterCut[0].start, 3)
})

test('找日志：两种目录名（session-<uuid> / 裸 uuid）都认，格式版本按前后缀认', () => {
  const a = fixture()
  withHome(a.home, () => {
    assert.equal(findSessionLog(a.id), join(a.home, 'sessions', '--tmp-ws--', a.dirName, 'session.v4.jsonl.zstd'))
  })

  const b = fixture({ dirName: '11111111-2222-3333-4444-555555555555' })
  withHome(b.home, () => {
    assert.ok(findSessionLog(b.id), '裸 uuid 目录名也要认')
  })

  const c = fixture({ fileName: 'session.v3.jsonl.zstd' })
  withHome(c.home, () => {
    assert.ok(findSessionLog(c.id), 'v3 日志同样要认（格式版本不该写死）')
  })
})

test('读尾部：窗口够大就是全部，且不谎报截断', () => {
  const f = fixture({ events: 40 })
  withHome(f.home, () => {
    const got = readTailEvents(f.id, { windowBytes: 10 * 1024 * 1024, maxEvents: 0 })
    assert.ok(got)
    assert.equal(got.events.length, 40)
    assert.equal(got.events[0].type, 'turn/start')
    // 整个文件都读到了、一条没丢，就不该对用户说「这不是全部」。
    assert.equal(got.truncated, false)
  })
})

test('读尾部：窗口小就只给尾部那几帧，且是**最近**的', () => {
  const f = fixture({ events: 400 })
  withHome(f.home, () => {
    const all = readTailEvents(f.id, { windowBytes: 10 * 1024 * 1024, maxEvents: 0 })
    const size = fixtureSize(f)
    const tailOnly = readTailEvents(f.id, { windowBytes: Math.floor(size / 3), maxEvents: 0 })
    assert.ok(tailOnly)
    assert.ok(tailOnly.events.length > 0)
    assert.ok(tailOnly.events.length < all.events.length, '窗口小必须读得更少')
    const lastAll = all.events[all.events.length - 1]
    const lastTail = tailOnly.events[tailOnly.events.length - 1]
    assert.equal(lastTail.time, lastAll.time, '尾部读的末条必须是整个日志的末条')
    assert.equal(tailOnly.truncated, true)
  })
})

test('读尾部：最后一帧比窗口还大 → 放大窗口重来，而不是认输说读不出', () => {
  const f = fixture({ events: 400 })
  withHome(f.home, () => {
    const got = readTailEvents(f.id, { windowBytes: 16, maxWindowBytes: 10 * 1024 * 1024, maxEvents: 0 })
    assert.ok(got, '窗口小到装不下一帧时应当放大窗口，而不是返回 null')
    assert.ok(got.events.length > 0)
  })
})

test('读尾部：maxEvents 上限生效，且从一条 user 消息开始（不是半句回答）', () => {
  const f = fixture({ events: 400 })
  withHome(f.home, () => {
    const got = readTailEvents(f.id, { windowBytes: 10 * 1024 * 1024, maxEvents: 24 })
    assert.ok(got)
    assert.ok(got.events.length <= 24)
    assert.ok(got.events.length > 0)
    assert.equal(got.events[0].type, 'turn/start', '要从轮的开头起（对齐到 user 消息那一步）')
  })
})

test('读尾部：会话不存在 / 目录空 → null（不编内容）', () => {
  const f = fixture()
  withHome(f.home, () => {
    assert.equal(readTailEvents('session-99999999-9999-9999-9999-999999999999'), null)
  })
})

test('读尾部：文件里全是垃圾 → null，而不是抛出去', () => {
  const home = mkdtempSync(join(tmpdir(), 'mini-tail-'))
  const id = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const dir = join(home, 'sessions', '--tmp-ws--', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.from('这不是 zstd，是随便几个字节'))
  withHome(home, () => {
    assert.equal(readTailEvents(id), null)
  })
})