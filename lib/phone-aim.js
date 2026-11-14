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
