/**
 * 权限档位。
 *
 * 这个模块最要紧的一条判据是「哪个档位需要额外确认」。**不能靠档位名猜**——
 * 名字是这台机器的配置，可以被改；`sandbox` 旋钮的取值才是 DSH 的协议常量。
 * 下面第 4、5 条就是钉这个的：名字叫得再吓人不算数，名字完全不相干的也可能
 * 是最危险的那个。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CUSTOM_PRESET, FULL_ACCESS_MODE, PRESET_LABELS,
  available, labelOf, listPresets, setPreset,
} from '../lib/permissions.js'

const SESSION = { id: 'session-1' }

/** 假服务：三种档位，照这台机器截图上的样子。 */
function serviceOf({ names, specs = {}, current = 'workspace-write', optionThrows = [], resolveThrows = [], setThrows } = {}) {
  return {
    names: names ?? ['read-only', 'workspace-write', 'danger-full-access'],
    currentCalls: [],
    setCalls: [],
    current(session) {
      this.currentCalls.push(session)
      return current
    },
    optionOf(name) {
      if (optionThrows.includes(name)) throw new Error('没有这个选项')
      return { value: name, name: specs[name]?.label ?? name, description: specs[name]?.description }
    },
    resolve(name) {
      if (resolveThrows.includes(name)) throw new Error('表里没有')
      return { sandbox: specs[name]?.sandbox ?? 'workspace-write', approval: 'never' }
    },
    set(session, name) {
      this.setCalls.push([session, name])
      if (setThrows) throw new Error(setThrows)
    },
  }
}

// ---------------------------------------------------------------------------

test('服务拿不到时如实报没这个能力', () => {
  for (const bad of [null, undefined, {}, { names: '三个' }]) {
    assert.equal(available(bad), false, `${JSON.stringify(bad)} 应该算拿不到`)
    assert.equal(listPresets({ service: bad, session: SESSION }).reason, 'no-service')
    assert.equal(setPreset({ service: bad, session: SESSION, name: 'x' }).reason, 'no-service')
  }
})

test('拿不到会话对象时不去调服务', () => {
  const service = serviceOf()
  assert.equal(listPresets({ service, session: null }).reason, 'no-session')
  assert.equal(setPreset({ service, session: null, name: 'workspace-write' }).reason, 'no-session')
  assert.deepEqual(service.currentCalls, [], '没有会话就不该去问它现在在哪一档')
  assert.deepEqual(service.setCalls, [], '没有会话就更不该去切')
})

test('档位名和标签是读出来的，顺序照服务给的来', () => {
  const service = serviceOf({
    specs: {
      'read-only': { label: '仅可查看' },
      'workspace-write': { label: '工作区内修改' },
      'danger-full-access': { label: '完全权限' },
    },
  })
  const out = listPresets({ service, session: SESSION })
  assert.equal(out.ok, true)
  assert.deepEqual(out.options.map((o) => o.value), ['read-only', 'workspace-write', 'danger-full-access'])
  assert.deepEqual(out.options.map((o) => o.name), ['仅可查看', '工作区内修改', '完全权限'])
  assert.equal(out.currentValue, 'workspace-write')
})

test('危险档位的判据是沙箱模式，不是档位名', () => {
  // 名字叫 danger-full-access，沙箱却不是完全放开 —— 不该算危险。
  const service = serviceOf({
    names: ['danger-full-access'],
    specs: { 'danger-full-access': { label: '名字很吓人' , sandbox: 'workspace-write' } },
    current: 'danger-full-access',
  })
  assert.equal(listPresets({ service, session: SESSION }).options[0].dangerous, false,
    '名字吓人不算数，要看旋钮')
})

test('名字完全不相干的档位也可能最危险', () => {
  // 这台机器的配置可以把最放开那一档叫别的名字。
  const service = serviceOf({
    names: ['随便叫'],
    specs: { '随便叫': { label: '随便叫', sandbox: FULL_ACCESS_MODE } },
    current: '随便叫',
  })
  assert.equal(listPresets({ service, session: SESSION }).options[0].dangerous, true,
    '沙箱是完全放开，就该要确认——不管它叫什么')
})

test('resolve 抛错的档位当作不危险，不把整盘弄没', () => {
  const service = serviceOf({ resolveThrows: ['坏的'] , names: ['坏的', '好的'] })
  const out = listPresets({ service, session: SESSION })
  assert.equal(out.options.length, 2, '一个读不到，另外那个还得在')
  assert.equal(out.options.find((o) => o.value === '坏的').dangerous, false)
})

test('optionOf 抛错的档位跳过这一个，别的照给', () => {
  const service = serviceOf({ names: ['甲', '乙'], optionThrows: ['甲'] })
  const out = listPresets({ service, session: SESSION })
  assert.deepEqual(out.options.map((o) => o.value), ['乙'])
})

test('current 抛错时档位盘照样给得出来，只是不知道现在在哪一档', () => {
  const service = serviceOf()
  service.current = () => { throw new Error('读不到') }
  const out = listPresets({ service, session: SESSION })
  assert.equal(out.ok, true)
  assert.equal(out.options.length, 3)
  assert.equal(out.currentValue, '', '不知道就说不知道，别编一个')
})

test('custom 只在它真的生效时补一格，而且永远不是切换目标', () => {
  const service = serviceOf({ current: CUSTOM_PRESET })
  const out = listPresets({ service, session: SESSION })
  assert.equal(out.currentValue, CUSTOM_PRESET)
  assert.equal(out.options.filter((o) => o.value === CUSTOM_PRESET).length, 1)
  assert.equal(out.options.at(-1).value, CUSTOM_PRESET, 'custom 排在最后')
  assert.equal(out.options.at(-1).dangerous, false)

  const normal = listPresets({ service: serviceOf({ current: 'workspace-write' }), session: SESSION })
  assert.equal(normal.options.some((o) => o.value === CUSTOM_PRESET), false,
    '不是 custom 就不该多出那一格')
})

// ---------------------------------------------------------------------------
// 中文标签
//
// 背景：`optionOf()` 只在配置里定义过 name 时才给标签，本机没定义，它回的是
// 键名。三个中文在 DSH 网页界面那侧，服务里没有，所以得我们自己映射。
// ---------------------------------------------------------------------------

test('三个档位翻成中文', () => {
  assert.equal(labelOf('read-only'), '仅可查看')
  assert.equal(labelOf('workspace-write'), '工作区内修改')
  assert.equal(labelOf('danger-full-access'), '完全权限')
})

test('表里没有的档位退回原始标识符，不留空也不写「未知」', () => {
  // DSH 哪天加个新档位，界面上会显示它的标识符——不好看，但那是个真名字。
  for (const name of ['brand-new-preset', 'custom', '']) {
    assert.equal(labelOf(name), name, `${JSON.stringify(name)} 应该原样退回`)
  }
})

test('配置里自己起了名字就听配置的，不被通用表盖掉', () => {
  // 这台机器的主人在配置里写了「只读模式」，那是他的意思。
  assert.equal(labelOf('read-only', '只读模式'), '只读模式')
  // 但服务在没配名字时会退回键名——那种情况不算「配置起了名字」，该用我们的映射。
  assert.equal(labelOf('read-only', 'read-only'), '仅可查看')
  assert.equal(labelOf('read-only', ''), '仅可查看')
  assert.equal(labelOf('read-only', undefined), '仅可查看')
})

test('档位盘里带出来的就是中文', () => {
  const service = serviceOf()   // 假服务照本机实际行为：name 回键名
  const out = listPresets({ service, session: SESSION })
  assert.deepEqual(out.options.map((o) => o.name), ['仅可查看', '工作区内修改', '完全权限'])
  // 值仍然是标识符——切的时候要用它，不能拿中文去切。
  assert.deepEqual(out.options.map((o) => o.value), ['read-only', 'workspace-write', 'danger-full-access'])
})

test('配置起了名字时档位盘用配置的名字', () => {
  const service = serviceOf({
    specs: { 'read-only': { label: '只读模式' } },
    names: ['read-only'],
    current: 'read-only',
  })
  assert.equal(listPresets({ service, session: SESSION }).options[0].name, '只读模式')
})

test('服务没给说明时 description 是空串，不是 undefined 也不是硬编的话', () => {
  // 空串在页面那边是假值，于是那一行退回显示「当前：<档位名>」，
  // 而不是渲染出一个空行、也不是我编的一句可能不准的说明。
  const service = serviceOf()
  const out = listPresets({ service, session: SESSION })
  for (const o of out.options) {
    assert.equal(typeof o.description, 'string', 'description 得是字符串')
    assert.equal(o.description, '', '服务没给就如实是空的')
  }
})

test('映射表本身只认这三个稳定的标识符', () => {
  assert.deepEqual(Object.keys(PRESET_LABELS).sort(),
    ['danger-full-access', 'read-only', 'workspace-write'])
})

// ---------------------------------------------------------------------------
// 切换
// ---------------------------------------------------------------------------

test('切档位：把会话对象和服务端认的名字一起交给 set', () => {
  const service = serviceOf()
  const out = setPreset({ service, session: SESSION, name: 'read-only' })
  assert.equal(out.ok, true)
  assert.equal(out.name, 'read-only')
  assert.deepEqual(service.setCalls, [[SESSION, 'read-only']], '收的是会话对象，不是 id')
})

test('表里没有的档位名一律挡掉，绝不透传', () => {
  // 手机是网络对面来的输入。set() 对未知名字是抛错，透传的话一个拼错的名字
  // 会变成一条 500，而用户看到的是一句看不懂的话。
  const service = serviceOf()
  const bad = ['', '   ', 'DANGER-FULL-ACCESS', 'danger-full-access ', 'custom', null, undefined, 42, {}]
  for (const name of bad) {
    const out = setPreset({ service, session: SESSION, name })
    assert.equal(out.ok, false, `${JSON.stringify(name)} 不该切成功`)
    assert.equal(out.reason, 'unknown-preset')
  }
  assert.deepEqual(service.setCalls, [], '一个都不该到 set 那儿')
  // 大小写敏感这一条要单独说清楚：服务端 names 里是什么就得是什么。
  assert.equal(setPreset({ service, session: SESSION, name: CUSTOM_PRESET }).reason, 'unknown-preset',
    'custom 不是切换目标，它只用来显示')
})

test('set 抛错时如实带出原因，不装作切好了', () => {
  const service = serviceOf({ setThrows: '这个会话动不了' })
  const out = setPreset({ service, session: SESSION, name: 'read-only' })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'failed')
  assert.match(out.error, /这个会话动不了/)
})
