/**
 * 界面规格的守卫。
 *
 * 用户 2026-09-27 定了这套视觉规格（"六关键词翻译表"）。它不该是一次性装修：
 * 以后谁再往 page.html 里加样式，都得先过这里。规格只写在注释里是会烂掉的，
 * 写成断言才拦得住——**尤其是"暖金一屏最多两处"这一条**，它最容易在后续开发里
 * 被当成"再强调一下也没关系"，一点点失控。
 *
 * 这里只读源码做静态检查，不开浏览器：page.html 是单文件模板，样式就是文本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../lib/page.html', import.meta.url), 'utf8')
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))

test('设计令牌：圆角只有 2px 一档，强调色是暖金 #c9a55c', () => {
  assert.match(css, /--r:\s*2px/, '卡片圆角必须是 2px')
  assert.match(css, /--gold:\s*#c9a55c/, '暖金必须是 #c9a55c')
  assert.match(css, /--ice:\s*#a9c8e8/, '冰蓝必须是 #a9c8e8')
  assert.ok(!/--accent:/.test(css), '旧的蓝色强调色 --accent 应该清干净了')
  assert.ok(!/--radius:/.test(css), '旧的 --radius 应该清干净了')
})

test('圆角只有 2px / 999px / 50% 三档，没有中间值', () => {
  const bad = []
  for (const m of css.matchAll(/border-radius:\s*([^;]+);/g)) {
    const value = m[1].trim()
    for (const part of value.split(/\s+/)) {
      if (part === '0' || part === '2px' || part === '50%' || part === '999px') continue
      if (part.startsWith('var(--r')) continue // var(--r, 2px) 这种带回落的写法
      bad.push(value)
      break
    }
  }
  assert.deepEqual(bad, [], `圆角出现了规格外的档位：${JSON.stringify(bad)}`)
})

test('动效只剩三个：流式光标、立绘翻帧、上传转圈', () => {
  const names = [...css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]).sort()
  assert.deepEqual(names, ['caret', 'poseFlip', 'spin'],
    '只允许这三个：其余都是"界面在表演"，规格里明令砍掉')
})

test('状态点不再闪动，只留 160ms 的颜色过渡', () => {
  const dot = css.slice(css.indexOf('.dot {'), css.indexOf('.icon-btn'))
  assert.ok(!/animation:/.test(dot), '状态点不该有动画（那圈呼吸闪动是视觉套话）')
  assert.match(dot, /transition:\s*background\s*\.16s/, '状态变化是瞬时的：160ms 颜色过渡')
})

test('暖金只许出现在清单里的这几处（一屏最多两处）', () => {
  // 冻结清单。要加一处，先回答"这一屏是不是已经有两处金了"，再改这里。
  const ALLOWED = [
    '.send',                                          // 主屏：发送键
    '.queue .q-node.cur i',                           // 主屏：当前这一步的点
    '.queue .q-node.cur b',                           // 主屏：当前这一步的序号
    '.pick-here',                                     // 抽屉：选定这个工作区
    '.btn.primary',                                   // 设置：这一屏的主按钮
    '#gate button',                                   // 口令页：唯一的按钮
    '#askCard .qfoot button#askNext',                 // 答题卡：唯一的主按钮
  ]
  const found = []
  for (const chunk of css.split('}')) {
    if (!chunk.includes('var(--gold)')) continue
    const brace = chunk.lastIndexOf('{')
    if (brace < 0) continue
    found.push(chunk.slice(0, brace).trim().split('\n').pop().trim())
  }
  assert.ok(found.length > 0, '一个暖金都没找到，令牌接错了')
  for (const sel of found) {
    assert.ok(ALLOWED.includes(sel),
      `暖金跑到清单外了：「${sel}」——先确认这一屏是不是已经有两处金`)
  }
})

test('顶栏底栏是毛玻璃，且有不支持时的实色回落', () => {
  assert.match(css, /footer\s*\{[^}]*backdrop-filter/, '底栏该是悬浮毛玻璃')
  assert.match(css, /header\s*\{[^}]*backdrop-filter/, '顶栏也一样')
  assert.match(css, /-webkit-backdrop-filter/, 'iOS 上要带 -webkit- 前缀')
  assert.match(css, /@supports not/, '不支持毛玻璃时要退回实色，不能糊成一片')
})

test('工序刻度尺只表达队列，不假装知道 Agent 跑到哪一步', () => {
  const block = css.slice(css.indexOf('.queue .q-scale'), css.indexOf('.queue .q-row'))
  assert.ok(block.length > 0, '找不到刻度尺')
  assert.match(block, /q-node\.cur/, '当前这一步要有自己的样式')
  assert.match(block, /\.16s/, '节点由"待"变"过"是 160ms')
  // 最要紧的一条：界面上不许出现编出来的工序进度。
  assert.ok(!/width:\s*\d+(\.\d+)?%/.test(block), '刻度不该按百分比假装进度')
})
