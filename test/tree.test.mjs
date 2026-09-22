/**
 * 工作区 → 会话 这棵树。
 *
 * 这里用的假服务照着真实返回结构造：workspaceRegistry.list() 同步返回
 * { id, path, title, sessionIds }；sessionQuery.listSessions() 异步返回
 * { header: { id, createdAt, cwd, origin }, live, persisted }。两个都**没有标题**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { listWorkspaces, listSessionsOf } from '../lib/tree.js'

function ws(id, path, title, sessionIds) {
  return { id, path, title, sessionIds }
}

function rec(id, createdAt, extra = {}) {
  return { header: { id, createdAt, ...extra }, live: false, persisted: true }
}

function registryOf(...workspaces) {
  return { list: () => workspaces }
}

function queryOf(records, titles = {}) {
  return {
    listSessions: async () => records,
    // 照真实形状造：readTitleSnapshots 给的 value.title 是一个「标题快照」对象，
    // **不是字符串**（见 dsh-session-title 的 titleSnapshotFromState）。
    // 这里如果图省事写成字符串，[object Object] 那个 bug 就会再溜过去一次。
    readTitleSnapshots: async (ids) =>
      ids.map((id) => ({
        sessionId: id,
        status: 'fulfilled',
        value: titles[id]
          ? {
            session: { id },
            title: {
              title: titles[id],
              messageSeqs: [],
              source: { kind: 'generated' },
              eventSeq: 1,
              updatedAt: 1,
            },
          }
          : {},
      })),
  }
}

test('按工作区分组，顺序就是 registry 给的顺序', async () => {
  const registry = registryOf(
    ws('w1', 'I:\\a', '甲', ['s1']),
    ws('w2', 'I:\\b', '乙', ['s2']),
  )
  const query = queryOf([rec('s1', 100), rec('s2', 200)])
  const out = await listWorkspaces({ registry, query })
  assert.deepEqual(out.map((w) => w.title), ['甲', '乙'])
  assert.deepEqual(out.map((w) => w.count), [1, 1])
})

test('没有会话的工作区不占地方', async () => {
  const registry = registryOf(ws('w1', 'I:\\a', '空', []), ws('w2', 'I:\\b', '有', ['s1']))
  const out = await listWorkspaces({ registry, query: queryOf([rec('s1', 1)]) })
  assert.deepEqual(out.map((w) => w.title), ['有'])
})

test('子 agent 的会话不进手机', async () => {
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ['s1', 'sub1']))
  const query = queryOf([rec('s1', 1), rec('sub1', 2, { origin: 'subagent' })])
  const out = await listWorkspaces({ registry, query })
  assert.equal(out[0].count, 1, '只该剩一个')
})

test('工作区标题为空时退到目录名，而不是显示 UUID', async () => {
  const registry = registryOf(ws('w1', 'I:\\极简遥控器\\极简遥控器', '', ['s1']))
  const out = await listWorkspaces({ registry, query: queryOf([rec('s1', 1)]) })
  assert.equal(out[0].title, '极简遥控器')
})

test('runningIds 用来数「有几个在跑」', async () => {
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ['s1', 's2', 's3']))
  const query = queryOf([rec('s1', 1), rec('s2', 2), rec('s3', 3)])
  const out = await listWorkspaces({ registry, query, runningIds: new Set(['s1', 's3']) })
  assert.equal(out[0].running, 2)
})

test('没有那两个服务时返回空，不报错（headless 组合就是这样）', async () => {
  assert.deepEqual(await listWorkspaces({}), [])
  assert.equal(await listSessionsOf({ workspaceId: 'w1' }), null)
})

test('registry.list() 抛错也不影响遥控（服务没启动时会抛）', async () => {
  const registry = { list: () => { throw new Error('workspace registry is not started yet') } }
  assert.deepEqual(await listWorkspaces({ registry, query: queryOf([]) }), [])
})

test('query.listSessions() 抛错时也不炸', async () => {
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ['s1']))
  const query = { listSessions: async () => { throw new Error('boom') } }
  assert.deepEqual(await listWorkspaces({ registry, query }), [])
})

test('会话按创建时间倒序，新的在前', async () => {
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ['old', 'new', 'mid']))
  const query = queryOf([rec('old', 100), rec('new', 300), rec('mid', 200)])
  const out = await listSessionsOf({ registry, query, workspaceId: 'w1' })
  assert.deepEqual(out.sessions.map((s) => s.id), ['new', 'mid', 'old'])
})

test('限量，并且如实说明被截断了', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `s${i}`)
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ids))
  const query = queryOf(ids.map((id, i) => rec(id, i)))
  const out = await listSessionsOf({ registry, query, workspaceId: 'w1', limit: 5 })
  assert.equal(out.sessions.length, 5)
  assert.equal(out.total, 30)
  assert.equal(out.truncated, true)
  assert.deepEqual(out.sessions.map((s) => s.id), ['s29', 's28', 's27', 's26', 's25'])
})

test('没截断时 truncated 为 false', async () => {
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ['s1']))
  const out = await listSessionsOf({ registry, query: queryOf([rec('s1', 1)]), workspaceId: 'w1' })
  assert.equal(out.truncated, false)
})

test('内存里已知的标题优先，不去读日志', async () => {
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ['s1']))
  let asked = null
  const query = {
    listSessions: async () => [rec('s1', 1)],
    readTitleSnapshots: async (ids) => { asked = ids; return [] },
  }
  const out = await listSessionsOf({
    registry, query, workspaceId: 'w1',
    knownTitles: new Map([['s1', '已知标题']]),
  })
  assert.equal(out.sessions[0].title, '已知标题')
  assert.equal(asked, null, '已知的就不该再去读日志（应该一次都没调用）')
})

test('冷会话的标题去读日志补齐', async () => {
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ['s1', 's2']))
  const query = queryOf([rec('s1', 1), rec('s2', 2)], { s2: '读出来的标题' })
  const out = await listSessionsOf({
    registry, query, workspaceId: 'w1',
    knownTitles: new Map([['s1', '内存里的']]),
  })
  const byId = Object.fromEntries(out.sessions.map((s) => [s.id, s.title]))
  assert.equal(byId.s1, '内存里的')
  assert.equal(byId.s2, '读出来的标题')
})

test('标题快照对象要抠出 .title，不能把整个对象丢给界面', async () => {
  // 真机上就是这么坏的：readTitleSnapshots 给的是快照对象，直接塞进界面
  // 会显示 [object Object]。
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ['s1']))
  const query = {
    listSessions: async () => [rec('s1', 1)],
    readTitleSnapshots: async () => [{
      sessionId: 's1',
      status: 'fulfilled',
      value: {
        session: { id: 's1' },
        title: { title: '真正的标题', messageSeqs: [], source: {}, eventSeq: 1, updatedAt: 1 },
      },
    }],
  }
  const out = await listSessionsOf({ registry, query, workspaceId: 'w1' })
  assert.equal(out.sessions[0].title, '真正的标题')
  assert.ok(!String(out.sessions[0].title).includes('[object'), '不能是 [object Object]')
})

test('快照里没有 title 字段时给空串，不给出一个对象', async () => {
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ['s1']))
  const query = {
    listSessions: async () => [rec('s1', 1)],
    readTitleSnapshots: async () => [{
      sessionId: 's1',
      status: 'fulfilled',
      value: { session: { id: 's1' }, title: { messageSeqs: [], eventSeq: 1 } },
    }],
  }
  const out = await listSessionsOf({ registry, query, workspaceId: 'w1' })
  assert.equal(out.sessions[0].title, '')
})

test('直接给字符串的接口也能收（readTitle 就是这种形状）', async () => {
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ['s1']))
  const query = {
    listSessions: async () => [rec('s1', 1)],
    readTitleSnapshots: async () => [
      { sessionId: 's1', status: 'fulfilled', value: { title: '直接是字符串' } },
    ],
  }
  const out = await listSessionsOf({ registry, query, workspaceId: 'w1' })
  assert.equal(out.sessions[0].title, '直接是字符串')
})

test('有一条读失败时不影响其它条', async () => {
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ['s1', 's2']))
  const query = {
    listSessions: async () => [rec('s1', 1), rec('s2', 2)],
    readTitleSnapshots: async () => [
      { sessionId: 's1', status: 'rejected', reason: '日志坏了' },
      { sessionId: 's2', status: 'fulfilled', value: { title: { title: '好的那条' } } },
    ],
  }
  const out = await listSessionsOf({ registry, query, workspaceId: 'w1' })
  const byId = Object.fromEntries(out.sessions.map((s) => [s.id, s.title]))
  assert.equal(byId.s1, '')
  assert.equal(byId.s2, '好的那条')
})

test('读日志失败时退回空标题，界面会显示日期，不影响切换', async () => {
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ['s1']))
  const query = {
    listSessions: async () => [rec('s1', 1)],
    readTitleSnapshots: async () => { throw new Error('日志读不动') },
  }
  const out = await listSessionsOf({ registry, query, workspaceId: 'w1' })
  assert.equal(out.sessions[0].title, '')
  assert.equal(out.sessions[0].id, 's1', '标题拿不到，会话本身还是要给出来')
})

test('running 从 agents 拿，不是从 live 拿', async () => {
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ['s1', 's2']))
  // s1 挂在内存里但空闲；s2 只在磁盘上
  const query = {
    listSessions: async () => [
      { header: { id: 's1', createdAt: 1 }, live: true, persisted: true },
      { header: { id: 's2', createdAt: 2 }, live: false, persisted: true },
    ],
  }
  const agents = { get: (id) => (id === 's1' ? { status: 'idle' } : undefined) }
  const out = await listSessionsOf({ registry, query, agents, workspaceId: 'w1' })
  assert.equal(out.sessions.find((s) => s.id === 's1').running, false, 'live 不等于 running')
  assert.equal(out.sessions.find((s) => s.id === 's1').live, true)
  assert.equal(out.sessions.find((s) => s.id === 's2').running, false)
})

test('agents 报 running 时如实反映', async () => {
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ['s1']))
  const query = queryOf([rec('s1', 1)])
  const agents = { get: () => ({ status: 'running' }) }
  const out = await listSessionsOf({ registry, query, agents, workspaceId: 'w1' })
  assert.equal(out.sessions[0].running, true)
})

test('工作区不存在时返回 null（服务端据此回 404）', async () => {
  const registry = registryOf(ws('w1', 'I:\\a', '甲', ['s1']))
  assert.equal(await listSessionsOf({ registry, query: queryOf([]), workspaceId: 'nope' }), null)
})
