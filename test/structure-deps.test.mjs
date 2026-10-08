/**
 * 盯住「结构依赖清单」和代码一致——**这是它不会悄悄过期的那一半**。
 *
 * 清单（`tools/structure-deps.mjs`）是一份人写的表；人写的表会走样。所以这里加两根铆钉：
 *
 *   ① **清单 → 代码**：每一条的 `codeText` 必须**原样**出现在 `lib/mirror.js` 真正发出去的
 *      那三段产物里。有人改了 `ADAPT_CSS` 却没动清单 → 这里红。
 *   ② **代码 → 清单**：从三段产物里抽出来的标记集合，必须被清单**一条不差**地覆盖。
 *      有人加了新选择器却没登记 → 这里红。
 *
 * 两根铆钉都从**求值出来的产物**上判（`readProducts`），不是对着源码做正则——
 * 源码里的注释提到过一堆类名，正则会把它们当成依赖抽出来（试过，真会）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  MARKERS, PRODUCT_NAMES, readProducts, extractTokens, declaredTokens, productTexts,
  judge, FAULT_PROBE, renderTable, compareVersions, satisfiesRange, parseVersion,
} from '../tools/structure-deps.mjs'

const SOURCE = readFileSync(new URL('../lib/mirror.js', import.meta.url), 'utf8')
const PRODUCTS = readProducts(SOURCE)

test('清单：三段产物都取得到，而且确实是发出去的那一份', () => {
  for (const name of PRODUCT_NAMES) {
    assert.equal(typeof PRODUCTS[name], 'string', `${name} 应该是字符串`)
    assert.ok(PRODUCTS[name].length > 100, `${name} 太短了（${PRODUCTS[name].length} 字），不像产物`)
  }
  // 抽样钉一下：求值出来的必须真的是给浏览器的那一段，不是别的东西。
  assert.match(PRODUCTS.ADAPT_CSS, /<style id="mini-mirror-adapt">[\s\S]*<\/style>/)
  assert.match(PRODUCTS.ADAPT_CSS, /\[data-shortcut-modal="settings"\]\{flex-direction:column !important\}/)
  assert.match(PRODUCTS.STRIP_FOREIGN_ADAPT, /STYLE_OWNERS/)
  assert.match(PRODUCTS.DIAG_SCRIPT, /mirror-diag/)
  // 注释**不许**漏进抽取结果——模板串里那些块注释提到过 `[data-slot="root"]`、
  // `[data-sidebar-collapsed]`，它们不是我们的依赖（是别的插件那条规则里的东西）。
  // 这是「清单里混进根本不存在的标记」那个坑的守卫：当初直接对着源码做正则就中了。
  const tokens = extractTokens(PRODUCTS)
  assert.ok(!tokens.has('attr:data-slot'), '块注释里的 data-slot 漏进抽取结果了')
  assert.ok(!tokens.has('attr:data-sidebar-collapsed'), '块注释里的 data-sidebar-collapsed 漏进抽取结果了')
  assert.ok(!tokens.has('class:…'), '注释里的省略号 `[class*="…"]` 漏进抽取结果了')
})

test('清单：每条的 codeText 都原样出现在产物里（改了代码没改清单 → 红）', () => {
  const texts = productTexts(PRODUCTS)
  const bad = []
  for (const row of MARKERS) {
    if (texts.some((t) => t.includes(row.codeText))) continue
    bad.push(`${row.id}：产物里找不到 ${JSON.stringify(row.codeText)}`)
  }
  assert.deepEqual(bad, [], `这 ${bad.length} 条的铆钉对不上：\n${bad.join('\n')}`)
})

test('清单：从代码里抽出来的标记，一条不差地被清单覆盖（加了依赖没登记 → 红）', () => {
  const found = extractTokens(PRODUCTS)
  const declared = declaredTokens()
  const unlisted = [...found].filter((t) => !declared.has(t)).sort()
  const stale = [...declared].filter((t) => !found.has(t)).sort()
  assert.deepEqual(unlisted, [], `代码里用了、清单里没登记的标记：\n${unlisted.join('\n')}`)
  assert.deepEqual(stale, [], `清单里登记了、代码里已经没有的标记：\n${stale.join('\n')}`)
})

test('清单：每条都写全了（字段、取值、人话）', () => {
  const ids = new Set()
  for (const row of MARKERS) {
    assert.ok(row.id && !ids.has(row.id), `id 重复或缺失：${row.id}`)
    ids.add(row.id)
    assert.ok(row.group && row.marker && row.where && row.why && row.fail, `${row.id} 有字段是空的`)
    assert.ok(['page', 'panel', 'market'].includes(row.scope), `${row.id} 的 scope 不认识：${row.scope}`)
    assert.ok(['present', 'absent'].includes(row.expect), `${row.id} 的 expect 不认识：${row.expect}`)
    assert.ok(['safe', 'danger', 'guard'].includes(row.harm), `${row.id} 的 harm 不认识：${row.harm}`)
    assert.ok(row.probe && row.probe.length > 2, `${row.id} 没有 probe`)
    assert.ok(Array.isArray(row.tokens) && row.tokens.length > 0, `${row.id} 没有声明覆盖哪些标记`)
    assert.ok(row.guard, `${row.id} 没写兜底（有没有形状闸）`)
    // 「失配的后果」必须说人话：要点出「不生效」还是「误伤」这一类判断。
    assert.match(row.fail, /不生效|失配|不该|没了|少|多|藏|透明|空白|看不见|够不着|切不回|缺样式|回来的|出现|挡住|摘不掉/,
      `${row.id} 的 fail 写得太空：${row.fail}`)
  }
  // 「有没有漏」不在这里数条数（数条数只会变成一个要跟着改的数）：
  // 上面那条「代码 → 清单」的覆盖测试才是真守卫——加了依赖没登记，那条就红。
})

test('清单：可能误伤的那几条要显式标出来，而且理由里说清「会动到没量过的东西」', () => {
  const danger = MARKERS.filter((r) => r.harm === 'danger')
  assert.ok(danger.length >= 4, `标成「可能误伤」的只有 ${danger.length} 条，偏少`)
  for (const row of danger) {
    assert.ok(row.guard && row.guard.length > 10, `${row.id} 是可能误伤的，必须写清有没有形状闸`)
  }
  // 用户点名最该盯的那一类：裸选择器（不锁在任何范围里的子串匹配）。
  const bare = MARKERS.filter((r) => r.harm === 'danger' && /没有任何形状闸/.test(r.guard))
  assert.ok(bare.some((r) => r.id === 'region-area'), '「裸的 _regionArea」必须被标成可能误伤')
})

test('清单：markdown 表能渲染出来，组 / 标记 / 后果 都在表里', () => {
  const md = renderTable()
  assert.match(md, /^\| 组 \| 标记 \|/)
  for (const row of MARKERS) {
    assert.ok(md.includes(row.marker.replace(/\|/g, '\\|')), `${row.id} 没进表`)
  }
  assert.ok(md.includes('可能误伤'))
  assert.ok(md.split('\n').length > MARKERS.length, '表的行数比清单条数还少')
})

test('判定：present 查不到 = 没了；absent 查到了 = 不该在的出现了', () => {
  const present = MARKERS.find((r) => r.expect === 'present' && !r.onlyIf)
  const absent = MARKERS.find((r) => r.expect === 'absent' && !r.onlyIf)
  assert.ok(judge(present, { count: 1 }).ok)
  assert.equal(judge(present, { count: 0 }).state, 'missing')
  assert.ok(judge(absent, { count: 0 }).ok)
  assert.equal(judge(absent, { count: 2 }).state, 'unexpected')
  // 自检注入那句话要落在报告里，好让人知道这个红是故意造的。
  assert.match(judge(present, { count: 0, faulted: true }).detail, /自检/)
})

test('判定：要开面板才有的标记，插件没装时是「不适用」，不是失配', () => {
  const conditional = MARKERS.find((r) => r.onlyIf)
  assert.ok(conditional, '清单里应该至少有一条带 onlyIf 的（meow-smooth 那两个标记）')
  const na = judge(conditional, { count: 0, onlyIfCount: 0 })
  assert.equal(na.state, 'not-applicable')
  assert.ok(na.ok, '「不适用」不能算失配——不然天天红')
  // 那个插件装着、标记又出现了，才是真的红。
  assert.equal(judge(conditional, { count: 1, onlyIfCount: 2 }).state, 'unexpected')
})

test('判定：注入故障用的那条选择器，不可能在活页面上命中', () => {
  assert.ok(FAULT_PROBE.startsWith('['))
  const texts = productTexts(PRODUCTS)
  assert.ok(!texts.some((t) => t.includes(FAULT_PROBE)), '注入用的选择器不该出现在我们的产物里')
})

test('版本：预发布号的先后（0.2.0-rc.2 要比 0.1.5-rc.2 新、比 0.3.0 旧）', () => {
  assert.equal(compareVersions('0.2.0-rc.2', '0.1.5-rc.2'), 1)
  assert.equal(compareVersions('0.2.0-rc.2', '0.3.0'), -1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('0.1.5-rc.10', '0.1.5-rc.9'), 1, '预发布号是数字比较，不是字符串')
  assert.equal(parseVersion('不是版本号'), null)
})

test('版本：区间判据只认我们会写的那两种形状，别的老实说不知道', () => {
  assert.equal(satisfiesRange('0.2.0-rc.2', '>=0.1.5-rc.2 <0.3.0'), true)
  assert.equal(satisfiesRange('0.3.0', '>=0.1.5-rc.2 <0.3.0'), false)
  assert.equal(satisfiesRange('0.1.0', '>=0.1.5-rc.2 <0.3.0'), false)
  assert.equal(satisfiesRange('0.1.5-rc.1', '>=0.1.5-rc.2 <0.3.0'), false)
  assert.equal(satisfiesRange('0.1.5-rc.2', '>=0.1.5-rc.2 <0.3.0'), true)
  assert.equal(satisfiesRange('0.2.0', '>=0.1.5-rc.2 <0.3.0'), true,
    '正式版比同一个号的预发布版大')
  assert.equal(satisfiesRange('0.2.0', '^0.2.0'), null, '不认识的形状要说不知道')
})

test('版本：engines.dsh 和 peerDependencies 声明的是同一个区间（③ 修的那处不一致）', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.engines.dsh, pkg.peerDependencies['@deepseek-ai/dsh'],
    'engines.dsh 和 peerDependencies 必须一模一样：两处不一致时，npm 会拿一个、宿主看另一个')
  assert.equal(pkg.version, '0.1.9', '这一轮只动 engines 那一处，版本号不许变')
})
