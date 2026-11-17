/**
 * 按坐标点屏幕之前的几条规矩（2026-11-14）。
 *
 * 为什么要单独一份：坐标点按是全套能力里**最容易出事**的一条——它不看控件，
 * 点在哪儿就是哪儿。所以规矩要能被单测覆盖，而不是散在工具里靠肉眼检查。
 *
 * 这里的检查都在**电脑这侧**做，只回答"这张图还能不能用、这个点在图里吗"。
 * "这一屏是不是银行/支付/密码"由手机这侧判（`blockReason`），因为只有它读得到
 * 当前界面——两边判据故意不重复，避免两份清单各自漂移。
 */

/** 截图的有效期：超过这个时间，模型看到的可能已经不是这一屏了。 */
export const AIM_MAX_MS = 30_000

/** 长按多久算长按。短了系统当普通点击，长了容易误触其它手势。 */
export const LONG_PRESS_MS = 700

/**
 * 判断"能不能按坐标点"。
 *
 * @param {object} p
 * @param {{w:number,h:number,pkg:string,at:number}|null} p.shot 最近一次截图的记录
 * @param {number} p.x 截图坐标系里的横坐标（模型看图看到的那个尺寸）
 * @param {number} p.y 截图坐标系里的纵坐标
 * @param {number} [p.now] 当前时间，测试里注入
 * @returns {string|null} 不能点的原因；能点返回 null
 */
export function aimRefusal({ shot, x, y, now = Date.now() }) {
  if (!shot || !shot.at) return '还没截过图。先调 phone_screenshot 看一眼，再按图里的位置点。'
  const age = now - shot.at
  if (age > AIM_MAX_MS) {
    return `那张截图已经过去 ${Math.round(age / 1000)} 秒，屏幕可能变了。重新截一张再点。`
  }
  if (age < -5000) return '截图时间和服务器对不上，重新截一张再点。'
  if (!Number.isFinite(x) || !Number.isFinite(y)) return '坐标必须是数字。'
  const w = Number(shot.w) || 0
  const h = Number(shot.h) || 0
  if (w <= 0 || h <= 0) return '截图尺寸没记下来，重新截一张。'
  if (x < 0 || y < 0 || x > w || y > h) {
    return `这个点 (${x}, ${y}) 不在截图范围内（图是 ${w}×${h}）。按图里的位置给坐标。`
  }
  return null
}

/** 把截图坐标换算成屏幕像素。截图被压过，比例必须现算，不能写死。 */
export function toScreenPoint({ shot, screen, x, y }) {
  const kx = (Number(screen.w) || 0) / (Number(shot.w) || 1)
  const ky = (Number(screen.h) || 0) / (Number(shot.h) || 1)
  return { x: Math.round(x * kx), y: Math.round(y * ky) }
}

// ---------------------------------------------------------------------------
// 敏感界面：两张清单、两级处理（2026-11-14）
//
// 为什么要分两级：**「不许看」和「不许替你点」不是一回事**。
// 银行页面连读都不该读；而安装确认、卸载确认这种页面，读出来没问题，
// 问题是**替用户点了就等于替他做了不可逆的决定**。
// ---------------------------------------------------------------------------

/** 隐私类默认值：连读都不读。包名可只写前缀，如 `com.icbc`。 */
export const DEFAULT_PRIVACY = `com.icbc
com.ccb
com.abchina
com.bankcomm
com.cmbchina
com.unionpay
com.eg.android.AlipayGphone.payment
com.tencent.mm.plugin.wallet
com.tenpay
com.chase
com.paypal`

/** 不可逆与提权类默认值：可以读，但不许替用户点。 */
export const DEFAULT_NO_TAP = `com.android.packageinstaller
com.google.android.packageinstaller
com.android.permissioncontroller
com.android.settings
com.android.systemui.permission
com.android.incallui
com.android.dialer
com.android.mms`

/** 隐私类关键词：出现在屏幕文字里就按隐私处理。 */
export const DEFAULT_PRIVACY_WORDS = `支付密码
支付
付款
转账
提现
验证码
短信验证
银行卡号
身份证号
指纹
面容`

/**
 * 不可逆类关键词：屏幕文字里出现就不许替用户点。
 *
 * **必须写得窄**。2026-11-14 真机教训：一开始把「删除」「清除」「安装」单列，
 * 结果计算器的退格键文字是「删除」，一次正常的点数字被拦下来——**误伤比漏拦更容易
 * 让这个功能变成废铁**。所以这里只留"看到就知道是不可逆操作"的说法。
 */
export const DEFAULT_NO_TAP_WORDS = `卸载
删除应用
删除全部
删除此
确认删除
清除数据
清除全部
格式化
恢复出厂
退出登录
解绑
无线调试
配对码
安装应用
允许
授权
发送短信
拨打`

/** 一句话里出现这些，才算"人同意这一次"。 */
const ALLOW_WORDS = /放行|允许点|确认点|就点它|点击这个位置/

/** 把配置里的多行文本拆成清单：按行/逗号分，去掉空行，包名统一小写。 */
export function parseList(text) {
  return String(text || '')
    .split(/[\n,，]+/)
    .map((one) => one.trim())
    .filter(Boolean)
    .map((one) => one.toLowerCase())
}

function matchesPackage(pkg, list) {
  const name = String(pkg || '').toLowerCase()
  if (!name) return null
  return list.find((one) => name === one || name.startsWith(one + '.') || name.startsWith(one)) || null
}

/**
 * 这一屏能不能按坐标点。
 *
 * @param {{pkg:string, texts:string[], privacy?:string[], noTap?:string[], privacyWords?:string[], noTapWords?:string[]}} p
 * @returns {null|{tier:'privacy'|'irreversible', why:string}}
 */
export function classifyScreen(p) {
  const privacy = (p.privacy ?? parseList(DEFAULT_PRIVACY)).map((x) => x.toLowerCase())
  const noTap = (p.noTap ?? parseList(DEFAULT_NO_TAP)).map((x) => x.toLowerCase())
  const privacyWords = p.privacyWords ?? parseList(DEFAULT_PRIVACY_WORDS)
  const noTapWords = p.noTapWords ?? parseList(DEFAULT_NO_TAP_WORDS)
  const texts = (p.texts || []).map((t) => String(t || '')).filter(Boolean)
  const joined = texts.join('\n')

  const byPkg = matchesPackage(p.pkg, privacy)
  if (byPkg) return { tier: 'privacy', why: `这个 App（${p.pkg}）属于隐私类界面` }
  const word = privacyWords.find((w) => joined.includes(w))
  if (word) return { tier: 'privacy', why: `屏幕上出现了「${word}」` }

  const noTapPkg = matchesPackage(p.pkg, noTap)
  if (noTapPkg) return { tier: 'irreversible', why: `这个界面（${p.pkg}）上不能替你点` }
  const danger = noTapWords.find((w) => joined.includes(w))
  if (danger) return { tier: 'irreversible', why: `屏幕上出现了「${danger}」，这类操作要你亲自点` }
  return null
}

/**
 * 「始终免确认」时，不可逆界面是否跳过逐次放行。
 *
 * 只跳过 `irreversible`（设置、安装/卸载确认、权限弹窗等）；`privacy`
 * （银行、支付、密码、验证码）永远不能跳过——那一层不是流程摩擦，而是
 * 不该让模型替用户做决定。
 *
 * @param {{tier:'privacy'|'irreversible', confirmMode:string}} p
 */
export function skipsSensitiveGate({ tier, confirmMode }) {
  return tier === 'irreversible' && confirmMode === 'off'
}

/**
 * 「本次放行」配不配生效。
 *
 * 规则：只有**人**在这条指令里说了放行，且这条指令还没被用掉过，才许一次。
 * 模型自己说"放行"不算——它没有权限给自己开门。
 *
 * @param {{userText:string, userMessageId:string, consumedId:string, requested:boolean}} p
 * @returns {{ok:true}|{ok:false, error:string}}
 */
export function allowOnceCheck({ userText, userMessageId, consumedId, requested }) {
  if (!requested) {
    return { ok: false, error: '按规则不替你点。要这次生效，请让用户回一句「放行」（只这一次）。' }
  }
  const text = String(userText || '')
  if (!ALLOW_WORDS.test(text)) {
    return { ok: false, error: '这是敏感界面。要让这次点击生效，请让用户回一句「放行」（只在这一次有效）。' }
  }
  if (userMessageId && consumedId && userMessageId === consumedId) {
    return { ok: false, error: '这次指令已经放行过一次了。要再点，让用户再回一句「放行」。' }
  }
  return { ok: true }
}
