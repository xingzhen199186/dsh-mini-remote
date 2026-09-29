/**
 * 「取景」这一类问题的测试：人是不是正好站在那 122×106 的窗口里。
 *
 * 为什么单独一个文件：数值自洽（background-size = 122 × 帧数、每步位移 = 122）
 * 只保证"图被切成若干格"，不保证"窗口落在格子上、人站在格子中间"。
 * 真机上出现过"人偏在一角、旁边空一块"的观感，所以这里再从两个角度钉住：
 *
 *   一、CSS 的不变式。窗口的三个数是**绝对像素**，图层用 inset:0 正好盖住它，
 *       外层容器不许拉伸它（flex-start 而不是 stretch、flex: 0 0 auto）。
 *       这三条任何一条破了，窗口就不再等于一格。
 *   二、图里每格的像素。用 tools/whale-panel-box.py 量出角色在每格里的留白：
 *       脚要贴着格底、头不许顶到格边、左右留白不能太窄。
 *
 * 第二条要 python + Pillow（仓库里的量图工具一直用它）。本机没有 python 时
 * 这条会明确跳过并说明原因，不会假装通过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const html = readFileSync(new URL('../lib/page.html', import.meta.url), 'utf8')

/** 抠出某条规则的花括号内容。选择器在模板里是唯一的，找不到就直接失败。 */
function rule(selector) {
  const head = `${selector} {`
  const i = html.indexOf(head)
  assert.ok(i > 0, `page.html 里找不到规则「${selector}」，它可能被改名或搬家了`)
  const j = html.indexOf('}', i)
  assert.ok(j > i, `规则「${selector}」没有闭合的花括号`)
  return html.slice(i + head.length, j)
}

const stage = rule('.work-stage')
const pose = rule('.pose')
const row = rule('.work-top')

test('窗口（舞台）的尺寸是绝对像素，就是一格的大小', () => {
  assert.match(stage, /width:\s*122px/, '窗口宽度必须是写死的 122 像素')
  assert.match(stage, /height:\s*106px/, '窗口高度必须是写死的 106 像素')
  for (const bad of ['vh', 'vw', '%', 'auto', 'em']) {
    assert.ok(!new RegExp(`(width|height):[^;]*${bad}`).test(stage),
      `窗口的宽高不能用相对单位「${bad}」——容器一变它就不是一格了`)
  }
  assert.match(stage, /position:\s*relative/, '窗口要有定位上下文，图层才能定位到它左上角')
  assert.match(stage, /flex:\s*0\s+0\s+auto/, '窗口在那一行里不许被压缩或撑大')
})

test('图层正好盖住窗口，而且不重复平铺', () => {
  assert.match(pose, /position:\s*absolute/, '图层必须脱离文档流，才不会把行撑开')
  const inset = (pose.match(/inset:\s*([^;]+)/) || [])[1]
  assert.ok(inset, '图层必须用 inset 铺满窗口，否则它连大小都没有')
  // 必须是四个方向都为 0。写成「inset: 0 auto」这种两值写法时左右是 auto，
  // 绝对定位元素会缩成零宽——浏览器里人直接消失，而只查「有没有 0」是查不出来的。
  assert.match(inset.trim(), /^0(px|em|rem|%)?(\s+0(px|em|rem|%)?){0,3}$/,
    `inset 必须四个方向都是 0，实际是「${inset.trim()}」`)
  assert.match(pose, /background-repeat:\s*no-repeat/, '一旦重复平铺，右边会冒出第二个人')
  assert.match(pose, /background-position:\s*0\s+0/, '起始位置必须在窗口左上角')
})

test('窗口在那一行里居中，而且不许被拉伸、不许被挤到一边', () => {
  assert.match(row, /display:\s*flex/, '这一行是弹性布局')
  assert.match(row, /flex-direction:\s*column/, '立绘在上、气泡在下')
  assert.match(row, /align-items:\s*center/,
    '横向居中。用 flex-start 会让窗口贴左、右边空出一块（用户报的「人偏左」）；'
    + '用 stretch 又把它撑到整行宽，窗口就不等于一格了')
  assert.ok(!/align-items:\s*stretch/.test(row), 'stretch 会把窗口撑开')
  // 「偏左」的根源在这里：只要这一行还给气泡预留宽度（min-width / max-content），
  // 立绘就被钉在行的左端。上下排之后那笔预留必须不存在。
  assert.ok(!/min-width/.test(row), '不能再给气泡预留行宽，否则立绘又被挤到偏左')
  assert.ok(!/max-content/.test(row), '行宽不再跟着气泡的长短走')
  assert.match(stage, /width:\s*122px/, '窗口宽度仍是写死的一格')
})

const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const hasPython = spawnSync(py, ['--version'], { encoding: 'utf8' }).status === 0

test('每格里的人都完整：脚贴格底、头不顶边、左右留得住',
  { skip: hasPython ? false : `本机没有 ${py}，跳过像素级检查` }, () => {
    const tool = fileURLToPath(new URL('../tools/whale-panel-box.py', import.meta.url))
    const r = spawnSync(py, [tool], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    assert.equal(r.status, 0, `量格工具跑不起来：${r.stderr}`)
    const rows = JSON.parse(r.stdout)
    const filled = rows.filter((x) => !x.empty)
    assert.equal(filled.length, 22, `九张立绘应当一共 22 格有内容，量到 ${filled.length} 格`)
    for (const p of filled) {
      const where = `${p.file} 第 ${p.panel + 1} 格`
      const cssOf = (px) => (px * 122 / 380).toFixed(1)
      assert.ok(p.bottom <= 12,
        `${where}：脚离格底 ${p.bottom} 源像素（约 ${cssOf(p.bottom)} CSS 像素），人会显得悬空`)
      assert.ok(p.top <= 24, `${where}：头顶离格顶 ${p.top} 源像素，头发容易被切掉`)
      assert.ok(p.left >= 20 && p.right >= 20,
        `${where}：左右留白 ${p.left}/${p.right} 源像素，人贴到格边了`)
    }
  })
