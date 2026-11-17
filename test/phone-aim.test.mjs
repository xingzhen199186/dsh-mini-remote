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

// ---------------------------------------------------------------------------
// 敏感界面与「本次放行」（2026-11-14）
// ---------------------------------------------------------------------------

import { classifyScreen, allowOnceCheck, parseList, skipsSensitiveGate } from '../lib/phone-aim.js'

test('微信里聊天放行，付款码那一层拦住', () => {
  const chat = classifyScreen({ pkg: 'com.tencent.mm', texts: ['张三', '晚上吃啥'] })
  assert.equal(chat, null)
  const pay = classifyScreen({ pkg: 'com.tencent.mm', texts: ['付款码', '向商家付款'] })
  assert.equal(pay.tier, 'privacy')
  assert.match(pay.why, /付款/)
})

test('银行 App 按包名前缀认，认不出来也算命中的前缀', () => {
  const r = classifyScreen({ pkg: 'com.icbc.mobile', texts: ['余额'] })
  assert.equal(r.tier, 'privacy')
  assert.match(r.why, /隐私/)
})

test('安装、卸载这类只拦"点"，不是隐私', () => {
  const r = classifyScreen({ pkg: 'com.android.packageinstaller', texts: ['要安装此应用吗？', '安装'] })
  assert.equal(r.tier, 'irreversible')
  assert.match(r.why, /不能替你点/)
})

test('清单清空时不误伤普通界面', () => {
  const r = classifyScreen({ pkg: 'com.sina.weibo', texts: ['首页', '推荐'], privacy: [], noTap: [], privacyWords: [], noTapWords: [] })
  assert.equal(r, null)
})

test('放行只有人说才算数，模型自己说不算', () => {
  const denied = allowOnceCheck({ userText: '帮我把它点掉', userMessageId: 'm1', consumedId: '', requested: true })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /让用户回一句/)
  const ok = allowOnceCheck({ userText: '放行，点吧', userMessageId: 'm1', consumedId: '', requested: true })
  assert.equal(ok.ok, true)
})

test('一次指令只放行一次，第二次要重新说', () => {
  const used = allowOnceCheck({ userText: '放行', userMessageId: 'm1', consumedId: 'm1', requested: true })
  assert.equal(used.ok, false)
  assert.match(used.error, /已经放行过一次/)
  const next = allowOnceCheck({ userText: '放行', userMessageId: 'm2', consumedId: 'm1', requested: true })
  assert.equal(next.ok, true)
})

test('始终免确认只跳过不可逆界面，不跳过隐私界面', () => {
  assert.equal(skipsSensitiveGate({ tier: 'irreversible', confirmMode: 'off' }), true)
  assert.equal(skipsSensitiveGate({ tier: 'irreversible', confirmMode: 'task' }), false)
  assert.equal(skipsSensitiveGate({ tier: 'irreversible', confirmMode: 'each' }), false)
  assert.equal(skipsSensitiveGate({ tier: 'privacy', confirmMode: 'off' }), false,
    '支付、银行、密码界面不能因为免确认就交给模型点')
})

test('清单解析：按行和逗号都认，包名统一小写', () => {
  assert.deepEqual(parseList('Com.ICBC\n\n com.cmb,com.abc'), ['com.icbc', 'com.cmb', 'com.abc'])
})

test('计算器的退格键叫「删除」，不许因此拦住点数字', () => {
  // 2026-11-14 真机：点计算器上的数字被拒，理由是屏幕上有「删除」。
  const r = classifyScreen({ pkg: 'com.hihonor.calculator', texts: ['C', '删除', '7', '8', '9', '+', '='] })
  assert.equal(r, null, '计算器的退格键不该算不可逆操作')
})

test('真不可逆的说法仍然拦住', () => {
  for (const word of ['卸载', '格式化', '恢复出厂', '清除数据', '退出登录', '安装应用', '无线调试']) {
    const r = classifyScreen({ pkg: 'com.example.any', texts: [word] })
    assert.ok(r && r.tier === 'irreversible', `「${word}」应该被拦住`)
  }
})
