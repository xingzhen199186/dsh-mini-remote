import test from 'node:test'
import assert from 'node:assert/strict'
import { aimRefusal, toScreenPoint, AIM_MAX_MS, LONG_PRESS_MS } from '../lib/phone-aim.js'

/**
 * 按坐标点屏幕的规矩（2026-11-14）。
 *
 * 这组测试要挡的是三个真实会发生的错：
 *   1. 拿一张十分钟前的截图去点——屏幕上早换了东西；
 *   2. 把接口收到的坐标当成屏幕像素（其实那是压缩过的截图坐标）；
 *   3. 点出画面之外，或者坐标根本不是数字。
 */

const SHOT = { w: 480, h: 1000, pkg: 'com.sina.weibo', at: 1_000_000 }

test('没有截图就不许按坐标点', () => {
  const r = aimRefusal({ shot: null, x: 10, y: 10 })
  assert.match(r, /先调 phone_screenshot/)
})

test('截图过期就拒，并且说清过了多久', () => {
  const r = aimRefusal({ shot: SHOT, x: 10, y: 10, now: SHOT.at + AIM_MAX_MS + 1000 })
  assert.match(r, /秒/)
  assert.match(r, /重新截一张/)
})

test('刚截完的图能点，边界上的点也算在图里', () => {
  assert.equal(aimRefusal({ shot: SHOT, x: 10, y: 10, now: SHOT.at + 1000 }), null)
  assert.equal(aimRefusal({ shot: SHOT, x: 480, y: 1000, now: SHOT.at + 1000 }), null)
})

test('点出画面之外要拒，并报出图的尺寸', () => {
  const r = aimRefusal({ shot: SHOT, x: 481, y: 10, now: SHOT.at + 1000 })
  assert.match(r, /不在截图范围内/)
  assert.match(r, /480×1000/)
})

test('坐标不是数字要拒，不许静默变成 0', () => {
  assert.match(aimRefusal({ shot: SHOT, x: Number.NaN, y: 10, now: SHOT.at }), /必须是数字/)
  assert.match(aimRefusal({ shot: SHOT, x: 10, y: undefined, now: SHOT.at }), /必须是数字/)
})

test('截图坐标要按比例换成屏幕像素：480 宽的图铺在 1080 屏幕上', () => {
  const p = toScreenPoint({ shot: { w: 480, h: 1000 }, screen: { w: 1080, h: 2250 }, x: 240, y: 500 })
  assert.deepEqual(p, { x: 540, y: 1125 })
})

test('比例不对时也不许放大到屏幕外', () => {
  const p = toScreenPoint({ shot: { w: 480, h: 1000 }, screen: { w: 1080, h: 2250 }, x: 480, y: 1000 })
  assert.equal(p.x, 1080)
  assert.equal(p.y, 2250)
})

test('长按时长是个明确的值，别让调用方自己编', () => {
  assert.ok(LONG_PRESS_MS >= 500 && LONG_PRESS_MS <= 1000, `长按时长 ${LONG_PRESS_MS} 不在合理区间`)
})
