import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const service = read('android/app/src/bridge/java/com/dsh/miniremote/BridgeAccessibilityService.java')
const mask = read('android/app/src/main/java/com/dsh/miniremote/SensitiveText.java')
const activity = read('android/app/src/main/java/com/dsh/miniremote/MainActivity.java')

test('A1：observe 的 items 与 texts 都在统一返回边界打码', () => {
  assert.match(service, /return maskObserveForModel\(out\)/)
  assert.match(service, /item\.put\("t", SensitiveText\.mask/)
  assert.match(service, /item\.put\("d", SensitiveText\.mask/)
  assert.match(service, /texts\.put\(i, SensitiveText\.mask/)
  const screenshot = service.slice(service.indexOf('static String shotBase64()'))
  assert.doesNotMatch(screenshot, /SensitiveText\.mask/, '截图仍走原始画面，不做隐式图像处理')
})

test('A1：内部定位表保留原始标签，模型投影不改序号与坐标', () => {
  const saveTargets = service.indexOf('lastTargets.add(')
  const saveLabels = service.indexOf('lastLabels.add(')
  const maskExit = service.indexOf('return maskObserveForModel(out)')
  assert.ok(saveTargets >= 0 && saveLabels > saveTargets && maskExit > saveLabels)
  assert.match(service, /lastTargets\.get\(index\)/)
  assert.match(service, /lastLabels\.get\(index\)/)
  const projectorStart = service.indexOf('private static String maskObserveForModel')
  const projector = service.slice(projectorStart, service.indexOf('\n    /**', projectorStart))
  assert.doesNotMatch(projector, /item\.put\("i"|item\.put\("b"|lastTargets|lastLabels/)
})

test('A1：卡号必须过 Luhn，验证码必须有上下文', () => {
  assert.match(mask, /requireLuhn && !passesLuhn\(digits\)/)
  assert.match(mask, /验证码\|校验码\|动态码/)
  assert.ok(mask.includes('\\\\d{4,8}'))
  assert.ok(mask.includes('1[3-9]\\\\d{9}'))
  assert.ok(mask.includes('\\\\d{17}[\\\\dXx]'))
  assert.match(mask, /c != 'X' && c != 'x'/)
})

test('A1：设置页明确写出文字打码、截图仍是原始画面', () => {
  assert.ok(activity.includes('文字会打码，截图仍是原始画面。'))
  assert.match(activity, /id=\\"miniA11yMask\\"/)
})
