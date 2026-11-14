import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { summarizeTodos, latestTodos, todoLine } from '../lib/todo-summary.js'

/**
 * 待办条（2026-11-14）。
 *
 * 它显示的进度是**用户唯一能看到的"做到哪了"**，所以错了比没有更糟：
 * 一条假的 3/7 会让人以为事情在推进。
 */

const ARGS = {
  todos: [
    { content: '读文档', status: 'completed' },
    { content: '改设置页', status: 'in_progress' },
    { content: '跑测试', status: 'pending' },
  ],
}

test('数得对：完成几项、进行中哪项', () => {
  const got = summarizeTodos(ARGS)
  assert.equal(got.total, 3)
  assert.equal(got.done, 1)
  assert.equal(got.doing, 1)
  assert.equal(got.current, '改设置页')
})

test('参数是 JSON 字符串时也认（轨迹里存的就是字符串）', () => {
  const got = summarizeTodos(JSON.stringify(ARGS))
  assert.equal(got.total, 3)
})

test('认不出就返回 null，不编一份空的待办', () => {
  assert.equal(summarizeTodos({}), null)
  assert.equal(summarizeTodos('不是JSON'), null)
  assert.equal(summarizeTodos({ todos: [] }), null)
})

test('倒着扫：后面那次更新覆盖前面那次', () => {
  const turns = [
    { entries: [{ name: 'todo_write', args: JSON.stringify({ todos: [{ content: '旧', status: 'pending' }] }) }] },
    { entries: [{ name: 'read', args: '{}' }, { name: 'todo_write', args: JSON.stringify(ARGS) }] },
  ]
  const got = latestTodos(turns)
  assert.equal(got.total, 3, '应该用最后一次那份清单')
})

test('轨迹里没有 todo_write 时返回 null', () => {
  assert.equal(latestTodos([{ entries: [{ name: 'read', args: '{}' }] }]), null)
})

test('一行摘要三种状态都说得清', () => {
  assert.equal(todoLine(summarizeTodos(ARGS)), '1/3 · 正在：改设置页')
  assert.equal(todoLine({ total: 2, done: 2, current: '' }), '2/2 · 全部完成')
  assert.equal(todoLine({ total: 2, done: 0, current: '' }), '0/2 · 还没开始')
  assert.equal(todoLine(null), '')
})

test('接口与页面都接上了：路由、条子、限频刷新', () => {
  const server = readFileSync(new URL('../lib/server.js', import.meta.url), 'utf8')
  assert.match(server, /path === '\/mini\/api\/todos'/)
  assert.match(server, /nav\.todos/)
  const idx = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(idx, /latestTodos\(info\?\.turns\)/)
  const html = readFileSync(new URL('../lib/page.html', import.meta.url), 'utf8')
  assert.match(html, /id="todoBar"/)
  const nav = readFileSync(new URL('../lib/page-nav.js', import.meta.url), 'utf8')
  assert.match(nav, /loadTodos\(\)/)
})
