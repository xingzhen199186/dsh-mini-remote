/**
 * `tools/live-check-rules.mjs`：活体检查里那两段纯判断。
 *
 * 为什么这些判据值得单测：它们**决定活体检查会不会撒谎**。
 * 端口探测错了，下面每一条都是对着空房间喊话，而输出里那两条红看起来像插件坏了；
 * 「危险档位」判据放宽错了，一个丢了危险标记的档位就能在手机上一次点击完成提权，
 * 而屏幕上一切正常。两件事都不该只有「跑一遍看看」这一种验法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ADMIN_PORT_CANDIDATES, HOST_RESERVED_PRESETS, describeAdminPort, pickAdminPort, splitPresets,
} from '../tools/live-check-rules.mjs'

/** 一个假 fetch：按端口给答复，没列进去的端口就当作没人听（fetch 抛错）。 */
function fakeFetch(table, calls = []) {
  return async (url) => {
    calls.push(url)
    const port = Number(new URL(url).port)
    const reply = table[port]
    if (reply === undefined) throw new TypeError('fetch failed')
    return {
      status: reply.status ?? 200,
      json: async () => {
        if (reply.json === undefined) throw new SyntaxError('not json')
        return reply.json
      },
    }
  }
}

const PAIRING = { entries: [{ kind: 'lan', url: 'http://192.168.1.5:3090' }] }

// ---------------------------------------------------------------------------
// 端口探测
// ---------------------------------------------------------------------------

test('探测顺序是先 3080、后 19387', () => {
  assert.deepEqual(ADMIN_PORT_CANDIDATES, [3080, 19387])
})

test('3080 答得上配对信息就用 3080，不再往后试', async () => {
  const calls = []
  const picked = await pickAdminPort({ fetchImpl: fakeFetch({ 3080: { json: PAIRING } }, calls) })
  assert.equal(picked.port, 3080)
  assert.deepEqual(calls.map((u) => new URL(u).port), ['3080'])
  assert.deepEqual(picked.tried, [{ port: 3080, status: 200, pairing: true }])
})

test('3080 没人听时退到 19387——桌面端形态就是这一条', async () => {
  const calls = []
  const picked = await pickAdminPort({
    fetchImpl: fakeFetch({ 19387: { json: PAIRING } }, calls),
  })
  assert.equal(picked.port, 19387, '3080 上没人应答，就该接着试 19387')
  assert.deepEqual(calls.map((u) => new URL(u).port), ['3080', '19387'])
  assert.deepEqual(picked.tried[0], {
    port: 3080, status: 0, pairing: false, error: 'fetch failed',
  })
  assert.equal(picked.tried[1].pairing, true)
})

test('3080 上蹲着别的东西（有应答但不是配对信息）也接着往下试', async () => {
  // 「端口有人听」不等于「这是我们等的那台」。只看前者会把检查接到一个陌生的服务上。
  const calls = []
  const picked = await pickAdminPort({
    fetchImpl: fakeFetch({
      3080: { status: 404, json: { error: 'not found' } },
      19387: { json: PAIRING },
    }, calls),
  })
  assert.equal(picked.port, 19387)
  assert.equal(picked.tried[0].pairing, false, '答上了但不是配对信息，不算数')
  assert.equal(picked.tried[0].status, 404)
})

test('正文不是 JSON 时也算没答上，不炸掉整个检查', async () => {
  const picked = await pickAdminPort({
    fetchImpl: fakeFetch({ 3080: { status: 200 } }), // json() 抛
  })
  assert.equal(picked.port, 0)
  assert.equal(picked.tried.length, 2, '两个都试过才认输')
})

test('一个都答不上时如实报 0，并把每个端口答了什么留下来', async () => {
  const picked = await pickAdminPort({ fetchImpl: fakeFetch({}) })
  assert.equal(picked.port, 0, '探不到就是探不到，不许编一个端口出来')
  assert.deepEqual(picked.tried.map((t) => t.port), [3080, 19387])
  assert.equal(picked.tried.every((t) => t.error === 'fetch failed'), true)
})

test('探测结果写成一句人话：连的是哪个口、试过哪些、为什么是它', () => {
  const ok = describeAdminPort({ port: 19387, tried: [
    { port: 3080, status: 0, pairing: false, error: 'fetch failed' },
    { port: 19387, status: 200, pairing: true },
  ] })
  assert.match(ok, /19387/)
  assert.match(ok, /3080 无人应答/)
  assert.match(ok, /是配对信息/)

  const miss = describeAdminPort({ port: 0, tried: [
    { port: 3080, status: 0, pairing: false, error: 'fetch failed' },
    { port: 19387, status: 0, pairing: false, error: 'fetch failed' },
  ] })
  assert.match(miss, /没探到/, '一个都没答上时要说没探到，不能只说「连不上」')
  assert.match(miss, /19387/)

  // 有应答但不是配对信息的那种，措辞要分得清——它和「没人听」是两回事。
  const wrong = describeAdminPort({ port: 0, tried: [{ port: 3080, status: 404, pairing: false }] })
  assert.match(wrong, /不是配对信息/)
})

// ---------------------------------------------------------------------------
// 危险档位判据
// ---------------------------------------------------------------------------

/** 桌面端形态：三档配置 + 宿主保留档 auto（它的沙箱按协议是完全放开）。 */
const DESKTOP_FORM = [
  { value: 'read-only', dangerous: false },
  { value: 'workspace-write', dangerous: false },
  { value: 'danger-full-access', dangerous: true },
  { value: 'auto', dangerous: true },
]

test('保留档名只有协议里那一个，不是「凡是不认识的都算」', () => {
  assert.deepEqual(HOST_RESERVED_PRESETS, ['auto'])
})

test('桌面端形态：配置档位里危险的是恰好一个，保留档单独算', () => {
  const out = splitPresets(DESKTOP_FORM)
  assert.deepEqual(out.configured.map((o) => o.value),
    ['read-only', 'workspace-write', 'danger-full-access'], 'auto 不该被算进配置档位')
  assert.deepEqual(out.reserved.map((o) => o.value), ['auto'])
  assert.equal(out.danger.length, 1, '两种都算上的话这里会是 2——那是宿主形态，不是标错')
  assert.equal(out.danger[0].value, 'danger-full-access')
  assert.deepEqual(out.reservedMissed, [])
})

test('老形态（三档、没有保留档）判据和从前一样', () => {
  const out = splitPresets(DESKTOP_FORM.slice(0, 3))
  assert.equal(out.danger.length, 1)
  assert.equal(out.danger[0].value, 'danger-full-access')
  assert.deepEqual(out.reserved, [])
  assert.deepEqual(out.reservedMissed, [])
})

test('把「完全权限」的危险标记去掉必须被判错（放宽的是保留档，不是这条）', () => {
  const broken = DESKTOP_FORM.map((o) =>
    (o.value === 'danger-full-access' ? { ...o, dangerous: false } : o))
  assert.equal(splitPresets(broken).danger.length, 0,
    '点一下直接提权、中间那道确认没了——这里必须是 0，检查才会红')
})

test('多标一个危险也算错（比如只读那档被标成危险）', () => {
  const broken = DESKTOP_FORM.map((o) =>
    (o.value === 'read-only' ? { ...o, dangerous: true } : o))
  assert.equal(splitPresets(broken).danger.length, 2, '多标就是确认那一步失效（点哪都要确认）')
})

test('保留档自己丢了危险标记，单独一条判据接住', () => {
  const broken = DESKTOP_FORM.map((o) => (o.value === 'auto' ? { ...o, dangerous: false } : o))
  const out = splitPresets(broken)
  assert.equal(out.danger.length, 1, '配置档位那一条仍然是对的')
  assert.deepEqual(out.reservedMissed.map((o) => o.value), ['auto'],
    '它的沙箱就是完全放开，不标等于放它进来不用二次确认')
})

test('档位盘读不到时如实给空，不抛也不编', () => {
  for (const bad of [undefined, null, '四档', 42, {}]) {
    const out = splitPresets(bad)
    assert.deepEqual(out.configured, [], `${JSON.stringify(bad)} 应该给出空档位盘`)
    assert.deepEqual(out.danger, [])
    assert.deepEqual(out.reservedMissed, [])
  }
})

test('档位项本身缺字段也不会把判据弄炸（真机接口给什么就看什么）', () => {
  const out = splitPresets([{}, { value: 'auto' }, { value: 'read-only', dangerous: true }])
  assert.deepEqual(out.reserved.map((o) => o.value), ['auto'])
  assert.deepEqual(out.danger.map((o) => o.value), ['read-only'])
  assert.deepEqual(out.reservedMissed.map((o) => o.value), ['auto'])
})
