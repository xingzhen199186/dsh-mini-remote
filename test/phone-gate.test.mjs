import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 会动手机的工具必须过同一道闸（2026-11-14 真机抓到的）。
 *
 * `phone_open` 曾经自己写了一份"取桥 → 调用"的实现，绕过 callPhone 里的任务锁：
 * 另一个会话照样能把 App 打开，而锁看起来工作正常。最坏的一类 bug——**看起来有保护**。
 *
 * 这条测试扫源码：每个 LOCKED 工具的实现里，必须要么走 callPhone，要么自己调 lockGate。
 */

const SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const LOCKED = ['phone_tap', 'phone_swipe', 'phone_input', 'phone_back', 'phone_open', 'phone_wake']

/** 抠出某个工具的实现块：从 `name: 'x'` 到下一个 `name: 'phone_` 或文件尾。 */
function blockOf(name) {
  const start = SRC.indexOf(`name: '${name}'`)
  assert.ok(start > 0, `源码里找不到工具 ${name}`)
  const next = SRC.indexOf("name: 'phone_", start + 10)
  return SRC.slice(start, next > 0 ? next : start + 4000)
}

test('这些工具确实在 LOCKED 名单里', () => {
  const set = SRC.slice(SRC.indexOf('const LOCKED_TOOLS'), SRC.indexOf('const LOCKED_TOOLS') + 300)
  for (const name of LOCKED) assert.match(set, new RegExp(`'${name}'`))
})

for (const name of LOCKED) {
  test(`${name} 会经过任务锁，不许自己另开一条路`, () => {
    const block = blockOf(name)
    const viaCallPhone = block.includes(`callPhone('${name}'`)
    const inlineGate = block.includes('lockGate(')
    assert.ok(viaCallPhone || inlineGate,
      `${name} 既没走 callPhone 也没有 lockGate——它绕过了任务锁`)
    // 自己调桥的工具（比如 phone_tap），闸必须出现在调桥**之前**——
    // 放在后面等于没锁。
    if (!viaCallPhone && block.includes('phoneBridge.call(')) {
      const gateAt = block.indexOf('lockGate(')
      const callAt = block.indexOf('phoneBridge.call(')
      assert.ok(gateAt >= 0 && gateAt < callAt,
        `${name} 的锁在调用之后才出现，等于没锁`)
    }
  })
}

test('返回手势关设置页时，不许按文字找「关闭」（会点中手机桥开关）', () => {
  const src = readFileSync(new URL('../android/app/src/main/java/com/dsh/miniremote/MainActivity.java', import.meta.url), 'utf8')
  const back = src.slice(src.indexOf('window.miniCloseTop=function()'))
  const settingsAt = back.indexOf("getElementById('settings')")
  assert.ok(settingsAt > 0, '返回脚本里应该有设置页那一段')
  const after = back.slice(settingsAt, settingsAt + 400)
  assert.match(after, /btnSettingsClose/, '设置页必须先点它自己的关闭按钮')
  assert.ok(!/closeByText\(settings\)/.test(after), '不许再按文字找「关闭」')
  // **顺序也算行为**：设置页那段必须排在"在最上层里找关闭按钮"之前，
  // 否则那段通用逻辑会先点中设置页里的手机桥开关（桥开着时写着「关闭」）。
  const genericAt = back.indexOf('var best=null')
  assert.ok(genericAt > 0, '返回脚本里应该有通用层那段')
  assert.ok(settingsAt < genericAt, '设置页要排在通用循环之前，否则返回会点中手机桥开关')
})

test('自连 ADB 第一步：自检页会报告扫到的无线调试口', () => {
  const discover = readFileSync(new URL('../android/app/src/main/java/com/dsh/miniremote/AdbDiscover.java', import.meta.url), 'utf8')
  assert.match(discover, /_adb-tls-pairing\._tcp/, '认的是系统广播的那个服务名')
  assert.match(discover, /_adb-tls-connect\._tcp/)
  assert.match(discover, /discoverServices\(/, '要真的去扫，不是写死端口')
  const selfCheck = readFileSync(new URL('../android/app/src/main/java/com/dsh/miniremote/SelfCheck.java', import.meta.url), 'utf8')
  assert.match(selfCheck, /AdbDiscover\.describe\(\)/, '自检页要把结果说出来')
})

test('展开箭头是画出来的 SVG，不是字体里的字符（字符高低不可控）', () => {
  const src = readFileSync(new URL('../android/app/src/main/java/com/dsh/miniremote/MainActivity.java', import.meta.url), 'utf8')
  // 认这支箭头的 path：它是 SVG 的特征，换回字符就找不到了。
  assert.match(src, /M9 5l7 7-7 7/, '箭头要用 SVG 画')
  assert.ok(!/textContent=open\?/.test(src), '不许再靠换字符表示展开状态')
  assert.match(src, /#miniA11yChev\{[^}]*display:flex/, '箭头那一格要用 flex 居中')
  assert.match(src, /aria-expanded/, '展开状态挂在 aria-expanded 上，CSS 据此旋转')
})
