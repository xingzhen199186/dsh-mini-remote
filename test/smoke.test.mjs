/**
 * 冒烟测试：不依赖正在运行的 DSH，直接验证三块最容易出错的逻辑——
 * 事件提取、HTTP/SSE 服务、页面渲染。
 *
 * 跑法：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { createTurnTracker, stepSelfTalk } from '../lib/events.js'
import { createStore } from '../lib/store.js'
import { createMiniServer, miniControl } from '../lib/server.js'
import { renderPage, readArt, readImage } from '../lib/page.js'
import { buildId } from '../lib/build.js'

const ev = (type, data) => ({ type, seq: 0, time: Date.now(), data })
const text = (t) => [{ type: 'text', text: t }]

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mini-'))
  return createStore({ file: join(dir, 'state.json'), maxHistory: 50 })
}

// ---------------------------------------------------------------------------
// 事件提取
// ---------------------------------------------------------------------------

test('只把「人发的」当用户消息，插件注入的合成上下文要丢掉', () => {
  const tracker = createTurnTracker()

  const injected = tracker.feed('s1', ev('user/message', {
    source: { kind: 'plugin', plugin: 'dsh-fs' },
    content: text('文件变更通知：a.txt 被修改'),
  }))
  assert.equal(injected, null, 'source.kind === plugin 的消息不该进手机')

  const human = tracker.feed('s1', ev('user/message', {
    id: 'm-1',
    source: { kind: 'user' },
    content: text('帮我把 README 更新一下'),
  }))
  // id 必须带出来：手机自己发的指令注入后也会以这条事件回来，
  // 调用方要靠它认出「这条我已经记过了」（见下面的去重测试）。
  // turn 也随动作带出（穿插渲染对号用）；这里没喂 turn/start，所以是 null。
  assert.deepEqual(human, { kind: 'user', text: '帮我把 README 更新一下', id: 'm-1', turn: null })
})

test('一轮回答要带出「这一轮是哪条消息起跑的」——那是归属，不是原文', () => {
  // 为什么不能只带原文：同一轮里用户后面再跟一句人话，累计器里那句「这一轮的原话」
  // 就被顶成新那句了。飞书那条路原来是按原文认领发起它的消息的，于是一旦被顶掉，
  // 这一轮的回答就认不到任何消息、静默发不出去（用户看到的正是「答完了，飞书里再没动静」）。
  // 号不会变，所以把它一并交出去。
  const tracker = createTurnTracker()
  tracker.feed('s1', ev('turn/start', { turn: 1 }))
  tracker.feed('s1', ev('user/message', {
    id: 'm-1', source: { kind: 'user' }, content: text('帮我看看'),
  }))
  // 同一轮里又来了一句人话（用户在别处跟了一句）：原话被顶掉，但号还在。
  tracker.feed('s1', ev('user/message', {
    id: 'm-2', source: { kind: 'user' }, content: text('等等，先别动'),
  }))
  tracker.feed('s1', ev('assistant/message', {
    turn: 1, step: 2, message: { content: text('看好了。') },
  }))

  const reply = tracker.feed('s1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(reply.userText, '等等，先别动', '原文确实是最后那句人话（这一条没变）')
  assert.equal(reply.userMessageId, 'm-2', '号跟着原文一起走——两者说的是同一条消息')

  // 另一条：不是人发的消息不参与，原话和号都留着（插件注入的合成上下文铺天盖地）。
  const t2 = createTurnTracker()
  t2.feed('s2', ev('turn/start', { turn: 1 }))
  t2.feed('s2', ev('user/message', { id: 'm-9', source: { kind: 'user' }, content: text('帮我看看') }))
  t2.feed('s2', ev('user/message', {
    id: 'm-10', source: { kind: 'runtime-context' }, content: text('（插件注入的上下文）'),
  }))
  t2.feed('s2', ev('assistant/message', { turn: 1, step: 2, message: { content: text('好了。') } }))
  const r2 = t2.feed('s2', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(r2.userText, '帮我看看', '注入的消息不许顶掉这一轮的原话')
  assert.equal(r2.userMessageId, 'm-9')
})

test('中间步骤的旁白不能当成回答（用户实机报的「显示的是思考过程」）', () => {
  // 这条用例原来断言的是反的：它要求「最后一条没文本时回退到上一条有文本的」。
  // 而那个回退正是病根——模型每次调工具前都会先说一句「我先看下文件」，
  // 那是它自己的旁白，不是给你的回答。用户看到的「思考过程」就是它。
  //
  // 判据：一条助手消息里只要有 tool-call 块，它就是中间步骤。
  // 依据 dsh-llm 的 ToolCallBlock { type: 'tool-call', id, name, arguments }。
  const tracker = createTurnTracker()
  tracker.feed('s1', ev('turn/start', { turn: 1 }))

  tracker.feed('s1', ev('assistant/message', {
    turn: 1, step: 1,
    message: { content: [...text('我先看下文件。'), { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
  }))
  tracker.feed('s1', ev('assistant/message', {
    turn: 1, step: 2,
    message: { content: [{ type: 'tool-call', id: 'c2', name: 'write', arguments: '{}' }] },
  }))

  const reply = tracker.feed('s1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(reply, null, '这一轮压根没产出回答，就不该推任何东西——不能拿旁白顶替')
})

// ---------------------------------------------------------------------------
// 自言自语（2026-09-26）：只给手机上的鲸鱼娘当台词，不进回答区
// ---------------------------------------------------------------------------

const toolCall = { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }

test('自言自语：先念旁白——那本来就是一句说给人听的话', () => {
  const content = [...text('我先看看这个文件。'), toolCall]
  assert.deepEqual(stepSelfTalk(content), { kind: 'narration', text: '我先看看这个文件。' })
})

test('自言自语：思考一个字都不上气泡——中文、英文都不上', () => {
  // 用户 2026-09-27 两次收紧后的口径：先划掉英文思考（摆在中文界面里是噪音），
  // 随后把话说到头——**思考首行整个不要展示**。于是这条路只剩旁白。
  assert.equal(
    stepSelfTalk([{ type: 'reasoning', text: '\n  先看一眼配置。\n然后再改那个参数。\n' }, toolCall]),
    null,
    '中文思考也不念',
  )
  assert.equal(
    stepSelfTalk([{ type: 'reasoning', text: 'The watcher got HTTP 404 — wrong path.' }, toolCall]),
    null,
    '英文思考更不念',
  )
  assert.equal(
    stepSelfTalk([{ type: 'reasoning', text: '跑 npm test：全过了。' }, toolCall]),
    null,
    '夹着英文的思考也不念——挡的是「思考」，不是「英文」',
  )
  // 旁白照念：气泡里出现的每一句，都是特意写给人看的。
  assert.deepEqual(stepSelfTalk([...text('先看一眼配置。'), toolCall]),
    { kind: 'narration', text: '先看一眼配置。' })
})

test('自言自语：回答那一步不算——那是给用户的话，不走气泡', () => {
  assert.equal(stepSelfTalk([...text('都改好了。')]), null, '没有工具调用的那一步就是回答')
  assert.equal(stepSelfTalk([{ type: 'reasoning', text: '收尾了。' }]), null,
    '哪怕它想了最后一句，那也属于回答那一轮，不在执行步骤里')
})

test('自言自语：长旁白一个字都不砍——断句交给手机页面', () => {
  // 用户 2026-09-27 报的：一句长话在手机上被切掉半行。原来这里掐到 80 字 +
  // 省略号，现在整个不掐——「语句完全展现」，长句靠手机侧长高 + 滚动承接。
  const long = '说'.repeat(300)
  const out = stepSelfTalk([...text(long), toolCall])
  assert.equal(out.text, long, '一个字都不许少')
  assert.ok(!out.text.endsWith('…'), '也不许我们自己加省略号')
  // 折叠内部空白照旧：一段话里的换行和缩进不必原样带进气泡。
  assert.equal(
    stepSelfTalk([...text('  先看这个。\n\n  再看那个。  '), toolCall]).text,
    '先看这个。 再看那个。',
  )
})

test('自言自语：夹着工具调用原始标记的旁白不能念出来，而且不退到思考', () => {
  // 那种东西是协议，不是话——2026-09-21 用户在手机上看到过原文。
  // 不能念之后**必须直接闭嘴**：退到思考就等于把草稿端出去了。
  const content = [
    ...text('<parameter name="edit">{"file":"a.js"}</parameter>'),
    { type: 'reasoning', text: '我改用工具来改。' },
    toolCall,
  ]
  assert.equal(stepSelfTalk(content), null)
})

test('自言自语：那时候它什么都没想，就不说话（气泡不出现，而不是空着）', () => {
  assert.equal(stepSelfTalk([toolCall]), null, '既没旁白也没思考')
  assert.equal(stepSelfTalk([{ type: 'reasoning', text: '   \n  ' }, toolCall]), null, '空白不算话')
  assert.equal(stepSelfTalk(null), null)
  assert.equal(stepSelfTalk([...text('   '), toolCall]), null)
})

test('最终回答（不带工具调用那一步）照常推给手机', () => {
  const tracker = createTurnTracker()
  tracker.feed('s1', ev('turn/start', { turn: 1 }))
  // 前面两步都是中间步骤
  tracker.feed('s1', ev('assistant/message', {
    turn: 1, step: 1,
    message: { content: [...text('我先看下文件。'), { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
  }))
  // 最后一步只有文字，没有工具调用——这才是回答
  tracker.feed('s1', ev('assistant/message', {
    turn: 1, step: 2,
    message: { content: text('看完了，文件里那段是缓存的问题。') },
  }))

  const reply = tracker.feed('s1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(reply.kind, 'reply')
  assert.equal(reply.text, '看完了，文件里那段是缓存的问题。')
  assert.equal(reply.reason, 'completed')
})

test('夹着工具调用原始标记的文字不能推给手机', () => {
  // 实机原文（用户 2026-09-21 贴出来的）：
  //   测试确实会红。撤掉临时行。
  //   <parameter name="edit"> <parameter name="file_path">...
  // 那属于协议，不是给人读的话。手机上看到这个只会一脸问号。
  const tracker = createTurnTracker()
  tracker.feed('s1', ev('turn/start', { turn: 1 }))
  tracker.feed('s1', ev('assistant/message', {
    turn: 1, step: 1,
    message: {
      content: text('测试确实会红。撤掉临时行。\n<parameter name="edit">\n<parameter name="file_path">'),
    },
  }))
  assert.equal(
    tracker.feed('s1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } })),
    null,
    '带协议标记的文字不能当成回答推出去',
  )
})

test('正常文字里的尖括号不能被误伤', () => {
  // 判据写窄就是为了这个：用户完全可能正当地跟你讨论一段 XML 或 HTML。
  const tracker = createTurnTracker()
  tracker.feed('s1', ev('turn/start', { turn: 1 }))
  tracker.feed('s1', ev('assistant/message', {
    turn: 1, step: 1,
    message: { content: text('把 <div class="box"> 改成 <span> 就行了。') },
  }))
  const reply = tracker.feed('s1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(reply.text, '把 <div class="box"> 改成 <span> 就行了。')
})

test('中间步骤的旁白不会盖掉已经拿到的回答', () => {
  // 顺序反过来：先出了回答，模型又去调工具（少见但可能），
  // 那也不能用后面的旁白把回答换掉。
  const tracker = createTurnTracker()
  tracker.feed('s1', ev('turn/start', { turn: 1 }))
  tracker.feed('s1', ev('assistant/message', {
    turn: 1, step: 1, message: { content: text('这是回答。') },
  }))
  tracker.feed('s1', ev('assistant/message', {
    turn: 1, step: 2,
    message: { content: [...text('我再确认一下。'), { type: 'tool-call', id: 'c9', name: 'read', arguments: '{}' }] },
  }))

  const reply = tracker.feed('s1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(reply.text, '这是回答。', '旁白不能盖掉回答')
})

test('reasoning（思维链）不能被当成回复正文', () => {
  const tracker = createTurnTracker()
  tracker.feed('s1', ev('turn/start', { turn: 1 }))
  tracker.feed('s1', ev('assistant/message', {
    turn: 1, step: 1,
    message: { content: [{ type: 'reasoning', text: '用户想要的是……' }, ...text('结论：可以。')] },
  }))
  const reply = tracker.feed('s1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(reply.text, '结论：可以。')
})

test('整个 turn 没有任何文本时，不推送空回复', () => {
  const tracker = createTurnTracker()
  tracker.feed('s1', ev('turn/start', { turn: 1 }))
  tracker.feed('s1', ev('assistant/message', {
    turn: 1, step: 1, message: { content: [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }] },
  }))
  assert.equal(tracker.feed('s1', ev('turn/end', { turn: 1, reason: { kind: 'aborted' } })), null)
})

test('上一轮的文本不会泄漏到下一轮', () => {
  const tracker = createTurnTracker()
  tracker.feed('s1', ev('turn/start', { turn: 1 }))
  tracker.feed('s1', ev('assistant/message', { turn: 1, step: 1, message: { content: text('第一轮结果') } }))
  assert.equal(tracker.feed('s1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } })).text, '第一轮结果')

  tracker.feed('s1', ev('turn/start', { turn: 2 }))
  tracker.feed('s1', ev('assistant/message', { turn: 2, step: 1, message: { content: text('第二轮结果') } }))
  assert.equal(tracker.feed('s1', ev('turn/end', { turn: 2, reason: { kind: 'completed' } })).text, '第二轮结果')
})

// ---------------------------------------------------------------------------
// 页面渲染
// ---------------------------------------------------------------------------

test('页面模板的占位符被正确替换', () => {
  const html = renderPage({ defaultMode: 'chat', needsToken: true, build: 'abc123def456' })
  assert.ok(!html.includes('__DEFAULT_MODE__'), '占位符必须被替换掉')
  assert.ok(!html.includes('__NEEDS_TOKEN__'))
  assert.ok(!html.includes('__BUILD__'), '构建指纹也要替换掉，不能留在页面上')
  assert.ok(!html.includes('__MAX_UPLOAD__'), '上传上限也要替换成真实数字')
  assert.ok(html.includes("var DEFAULT_MODE = 'chat';"))
  assert.ok(html.includes('var NEEDS_TOKEN = true;'))
  assert.ok(html.includes("var BUILD = 'abc123def456';"))
  assert.ok(html.includes('<!doctype html>'))
})

test('构建指纹里的可疑字符会被洗掉，不能往 HTML 里注入', () => {
  const html = renderPage({ build: "';alert(1);//" })
  assert.ok(!html.includes('alert(1)'), '不该原样写进页面')
  assert.ok(html.includes("var BUILD = 'alert1';"),
    `应该只剩字母数字，实际是 ${html.match(/var BUILD = '[^']*'/)}`)
})

test('默认模式白名单认「完整」，非法值仍回落单帧', () => {
  assert.ok(renderPage({ defaultMode: 'full' }).includes("var DEFAULT_MODE = 'full';"),
    '「完整」存成默认模式后刷新，不能被降回单帧')
  assert.ok(renderPage({ defaultMode: 'xxx' }).includes("var DEFAULT_MODE = 'minimal';"),
    '非法值必须回落到单帧')
})

// ---------------------------------------------------------------------------
// 鲸鱼娘立绘（lib/art/）
// ---------------------------------------------------------------------------

const POSES = [
  'work-1-ready', 'work-2-reading', 'work-3-typing', 'work-4-checking',
  'work-5-thinking', 'work-6-running', 'work-7-waiting', 'work-8-sprinting',
  // 说话那张（自言自语）不轮播，但它同样得有文件——缺了的话，模型一开口就是空白。
  'work-9-talking',
]

test('立绘要 token 才给看', async (t) => {
  const { server, base } = await startTestServer()
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/art/work-1-ready.webp`)
  assert.equal(res.status, 401, '立绘和别的接口一样，不该对匿名开放')
})

test('立绘取得到，而且是真的 WebP', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/art/work-1-ready.webp?token=${token}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/webp')
  const buf = Buffer.from(await res.arrayBuffer())
  // 只看状态码不够——404 的 JSON 正文也是几百字节，照样是「有内容」。
  assert.equal(buf.subarray(0, 4).toString('latin1'), 'RIFF', '不是 WebP：缺 RIFF')
  assert.equal(buf.subarray(8, 12).toString('latin1'), 'WEBP', '不是 WebP：缺 WEBP')
  assert.ok(buf.length > 5000, `太小了，不像真图：${buf.length} 字节`)
})

test('每个姿态的立绘一个都不能少（含说话那张）', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())
  for (const name of POSES) {
    const res = await fetch(`${base}/mini/art/${name}.webp?token=${token}`)
    assert.equal(res.status, 200, `${name}.webp 取不到，轮播会缺一张`)
  }
})

test('立绘路径穿越和非法文件名一律 404', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())
  for (const bad of [
    '..%2F..%2Fpackage.json',   // 编码过的 ../
    '%2e%2e%2fpackage.json',    // 编码过的 ./
    'page.html',                // 后缀不对
    'work-1-ready.png',         // 后缀不对
    'WORK-1.WEBP',              // 大小写不对
    'nope.webp',                // 形状对但文件不存在
    '',                         // 空名字
  ]) {
    const res = await fetch(`${base}/mini/art/${bad}?token=${token}`)
    assert.equal(res.status, 404, `「${bad}」不该被放行`)
  }
  // 直接问函数也要挡住，别只靠路由那一层
  assert.equal(readArt('../../package.json'), null)
  assert.equal(readArt('page.html'), null)
  // 证明这道闸门不是摆设：不做检查的话，这个相对路径确实能读到工作区的 package.json。
  // 万一哪天目录挪了、这个文件不在了，上面那条穿越测试就失去意义了，得知道。
  const artDir = fileURLToPath(new URL('../lib/art/', import.meta.url))
  assert.ok(existsSync(join(artDir, '../../package.json')),
    '参照文件不存在了，路径穿越测试失去了意义，要重新挑一个靶子')
})

test('正文里直接写路径的图也发得出去，但只发图片类型', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  // 造一张真 PNG 放在项目之外——这正是 ?p= 这条路要解决的场景：图不必先拷进 lib/art。
  const dir = mkdtempSync(join(tmpdir(), 'mini-shot-'))
  const shot = join(dir, 'shot.png')
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64')
  writeFileSync(shot, png)
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const ok = await fetch(`${base}/mini/art/?p=${encodeURIComponent(shot)}&token=${token}`)
  assert.equal(ok.status, 200, '一张真图不该被拒绝')
  assert.equal(ok.headers.get('content-type'), 'image/png')
  assert.equal((await ok.arrayBuffer()).byteLength, png.length)

  // 相对项目根的写法也认（正文里写 dsh-image-gen/a.png、lib/art/x.webp 这种）。
  const rel = await fetch(`${base}/mini/art/?p=${encodeURIComponent('lib/art/work-1-ready.webp')}&token=${token}`)
  assert.equal(rel.status, 200)
  assert.equal(rel.headers.get('content-type'), 'image/webp')

  // 不是图片的一律不发——这条通道不能变成读文件的口子（扩展名是唯一的闸门，所以要真测）。
  for (const bad of ['package.json', 'lib/art/../package.json', 'nope.png', 'lib/art/page.html']) {
    const res = await fetch(`${base}/mini/art/?p=${encodeURIComponent(bad)}&token=${token}`)
    assert.equal(res.status, 404, `「${bad}」不该被发出去`)
  }

  // 没有 token 一样挡住。
  const anon = await fetch(`${base}/mini/art/?p=${encodeURIComponent(shot)}`)
  assert.equal(anon.status, 401)
})

test('正文里写相对路径的图，也要按「那段对话的工作目录」找（2026-09-28 修复）', async (t) => {
  // 病灶：出图那段对话的工作目录是别的项目（实测 I:\DSH\dsh-jev-ultrafast），
  // 回复里写的是 `scratch/preview-0.2.3-settings.png`。相对的是**那个工作目录**，
  // 插件原先只按自己的两个根（仓库根、lib/art）找，于是 404 —— 图在盘上、接口也没坏，
  // 纯粹是没找对地方，手机上就显示成破图。
  const dir = mkdtempSync(join(tmpdir(), 'mini-ws-'))
  const scratch = join(dir, 'scratch')
  mkdirSync(scratch)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64')
  const relName = 'scratch/preview-0.2.3-settings.png'
  writeFileSync(join(scratch, 'preview-0.2.3-settings.png'), png)
  // 工作区根之外也放一张真图：用来验 `..` 逃逸是被真挡住，而不是"恰好找不到"。
  writeFileSync(join(dir, 'outside.png'), png)
  // 工作区里放一个非图片：额外根只放宽「在哪找」，不放宽「能发什么」。
  writeFileSync(join(scratch, 'notes.txt'), '这不是图')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  // ① 没有额外根时必须是 404。先钉住这个前提，免得这条用例哪天"因为别处碰巧有一张同名图"
  //    而假通过。
  const plain = await startTestServer()
  t.after(() => plain.server.close())
  const miss = await fetch(`${plain.base}/mini/art/?p=${encodeURIComponent(relName)}&token=${plain.token}`)
  assert.equal(miss.status, 404, '插件根里没有这张图——这是上面那个病灶的前提')

  // ② 把工作区目录作为额外根之后要发得出去，而且字节数一模一样。
  const roots = [dir]
  const { server, base, token } = await startTestServer({ imageRoots: () => roots })
  t.after(() => server.close())

  const hit = await fetch(`${base}/mini/art/?p=${encodeURIComponent(relName)}&token=${token}`)
  assert.equal(hit.status, 200, '工作目录里的相对路径图应该发得出去')
  assert.equal(hit.headers.get('content-type'), 'image/png')
  assert.equal((await hit.arrayBuffer()).byteLength, png.length)

  // ③ 旧行为不回归：相对项目根／lib/art 的写法，在有额外根时照样认。
  const pluginRoot = await fetch(
    `${base}/mini/art/?p=${encodeURIComponent('lib/art/work-1-ready.webp')}&token=${token}`)
  assert.equal(pluginRoot.status, 200, '多了一个根，插件自己的两个根不能反而失灵')
  assert.equal(pluginRoot.headers.get('content-type'), 'image/webp')

  // ④ `..` 逃逸被拒：工作区根之外那张图不许顺着相对路径翻出去。
  const escape = await fetch(`${base}/mini/art/?p=${encodeURIComponent('../outside.png')}&token=${token}`)
  assert.equal(escape.status, 404, '相对写法里的 .. 不该翻出工作区')

  // ⑤ 额外根里也照样只发图片。
  const txt = await fetch(`${base}/mini/art/?p=${encodeURIComponent('scratch/notes.txt')}&token=${token}`)
  assert.equal(txt.status, 404, '不是图片的一律不发——额外根没放宽这一条')

  // ⑥ 令牌这一道也没松。
  const anon = await fetch(`${base}/mini/art/?p=${encodeURIComponent(relName)}`)
  assert.equal(anon.status, 401)

  // 直接问那个解析函数，别只靠路由那一层。
  assert.equal(readImage(relName, roots)?.buf.length, png.length)
  assert.equal(readImage('../outside.png', roots), null)
  // 没给额外根时，同一个相对路径在读不到（和上面 ① 的 404 是同一件事）。
  assert.equal(readImage(relName), null)
})

test('立绘也算进构建指纹（换了图，手机就该拿到新的）', () => {
  // build.js 如果漏了 art/，指纹会等于「只算 js/html」的那个。
  const hash = createHash('sha256')
  const lib = fileURLToPath(new URL('../lib/', import.meta.url))
  for (const f of readdirSync(lib).filter((f) => f.endsWith('.js') || f.endsWith('.html')).sort()) {
    hash.update(join(lib, f))
    hash.update(readFileSync(join(lib, f)))
  }
  const client = fileURLToPath(new URL('../client/client.js', import.meta.url))
  hash.update(client)
  hash.update(readFileSync(client))
  assert.notEqual(buildId(), hash.digest('hex').slice(0, 12), '指纹里应该已经含了立绘')
})

// ---------------------------------------------------------------------------
// HTTP / SSE 服务
// ---------------------------------------------------------------------------

async function startTestServer(overrides = {}) {
  const store = overrides.store ?? tempStore()
  const token = 'testtoken0123456789abcdef012345'
  const seen = []
  const server = await createMiniServer({
    store,
    config: { port: 0, defaultMode: 'minimal' },
    bindAddresses: ['127.0.0.1'],
    token,
    // 这个桩要还原真实契约：服务只负责把指令转交给插件，
    // 写历史是插件 onInstruction 的职责（见 lib/index.js）。
    onInstruction: overrides.onInstruction ?? (async (text) => {
      seen.push(text)
      store.pushUser({ text, sessionId: 's1' })
      return { ok: true, sessionId: 's1' }
    }),
    // 不给就是「这台电脑没有附件服务」——那也是一条要覆盖的路径。
    onUpload: overrides.onUpload,
    tree: overrides.tree,
    browse: overrides.browse,
    // 正文里相对路径图的额外候选根（真实运行时是「当前已注册工作区的目录」）。
    imageRoots: overrides.imageRoots,
    build: overrides.build,
  })
  return { store, server, token, seen, base: `http://127.0.0.1:${server.port}` }
}

test('配置的端口被占了，就自己往后挪一个，不让用户去配', async (t) => {
  // 撞上端口冲突时，一个非技术用户自己是没有办法的：设置界面里没有改端口的地方，
  // 日志他也不会看，而端口号对他毫无意义。所以服务要自己让开。
  const squatter = createServer(() => {})
  await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve))
  t.after(() => squatter.close())
  const taken = squatter.address().port

  const token = 'testtoken0123456789abcdef012345'
  const server = await createMiniServer({
    store: tempStore(),
    config: { port: taken, defaultMode: 'minimal' },
    bindAddresses: ['127.0.0.1'],
    token,
    onInstruction: async () => ({ ok: true, sessionId: 's1' }),
  })
  t.after(() => server.close())

  assert.notEqual(server.port, taken, '端口被占就要换一个')
  assert.ok(server.port > taken, '是往后挪，不是随便挑一个')
  assert.equal(server.addresses.length, 1, '换了端口也得真的绑上')

  // 光换了个数字不算数——要真的能服务。
  const res = await fetch(`http://127.0.0.1:${server.port}/mini/api/state?token=${token}`)
  assert.equal(res.status, 200, '换完端口要真的能连上')
})

// ---------------------------------------------------------------------------
// 手机上传文件
// ---------------------------------------------------------------------------

test('上传走原始字节，不吃 64 KB 那个请求体上限', async (t) => {
  // 手机拍一张照片就有好几兆，而普通 POST 那条路把请求体限死在 64 KB。
  // 上传端点必须自己直读请求流——复用了那个 readBody 的话，照片永远传不上来，
  // 而且失败得很难看（「请求体过大」，用户完全不知道该怎么办）。
  const got = []
  const { server, base, token } = await startTestServer({
    onUpload: async ({ data, name }) => {
      let n = 0
      for await (const c of data) n += c.length
      got.push({ name, n })
      return { uploadId: 'u1', name: name || 'x', bytes: n }
    },
  })
  t.after(() => server.close())

  const big = Buffer.alloc(200 * 1024, 7) // 200 KB，远超 64 KB
  const res = await fetch(`${base}/mini/api/upload?name=photo.jpg&size=${big.length}&token=${token}`, {
    method: 'POST',
    body: big,
  })
  assert.equal(res.status, 200, '两百 KB 的文件必须能传上来')
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.uploadId, 'u1')
  assert.equal(got.length, 1)
  assert.equal(got[0].n, big.length, '服务端收到的字节数要和发出去的一致')
})

test('上传不带 token 一律 401', async (t) => {
  // 上传是又一个能往电脑里写东西的入口，绝不能开天窗。
  const { server, base } = await startTestServer({ onUpload: async () => ({ uploadId: 'x' }) })
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/api/upload?name=a.txt`, {
    method: 'POST',
    body: Buffer.from('hi'),
  })
  assert.equal(res.status, 401)
})

test('上传超过上限：早点拒绝，别让人白传一场', async (t) => {
  const { server, base, token } = await startTestServer({
    onUpload: async () => ({ uploadId: 'x' }),
  })
  t.after(() => server.close())
  const res = await fetch(
    `${base}/mini/api/upload?name=big.mp4&size=${51 * 1024 * 1024}&token=${token}`,
    { method: 'POST', body: Buffer.from('x') },
  )
  assert.equal(res.status, 413)
  const body = await res.json()
  assert.match(body.error, /太大/, '要说清楚是「太大了」，不是含糊的「出错了」')
  assert.match(body.error, /MB/, '还得说清楚上限是多少')
})

test('电脑上没有附件服务时，如实说传不了', async (t) => {
  // 纯 headless 组合下 DSH 没有附件服务。这时候按钮要能用一句人话解释，
  // 而不是点了没反应——用户会以为是手机坏了。
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/api/upload?name=a.txt&token=${token}`, {
    method: 'POST',
    body: Buffer.from('hi'),
  })
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.match(body.error, /附件服务/, '要说清楚缺的是什么')
})

test('发送时会把附件的小票一起交给插件', async (t) => {
  const seen = []
  const { server, base, token } = await startTestServer({
    onInstruction: async (text, uploadIds) => {
      seen.push({ text, uploadIds })
      return { ok: true, sessionId: 's1' }
    },
  })
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/api/send?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '看一下这个', uploadIds: ['u1', 'u2'] }),
  })
  assert.equal(res.status, 200)
  assert.deepEqual(seen, [{ text: '看一下这个', uploadIds: ['u1', 'u2'] }],
    '小票要原样转给插件，由它去换真正的附件引用')
})

test('只带文件、一个字不写，也算一条合法指令', async (t) => {
  const seen = []
  const { server, base, token } = await startTestServer({
    onInstruction: async (text, uploadIds) => {
      seen.push({ text, uploadIds })
      return { ok: true, sessionId: 's1' }
    },
  })
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/api/send?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '', uploadIds: ['u1'] }),
  })
  assert.equal(res.status, 200, '「这份文件你看一下」本来就是常见用法')
  assert.deepEqual(seen, [{ text: '', uploadIds: ['u1'] }])
})

test('两样都没有才算空', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/api/send?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '', uploadIds: [] }),
  })
  assert.equal(res.status, 400)
})

test('没带 token 的 API 请求一律 401', async (t) => {
  const { server, base } = await startTestServer()
  t.after(() => server.close())

  for (const path of ['/mini/api/state', '/mini/api/latest', '/mini/api/history']) {
    const res = await fetch(base + path)
    assert.equal(res.status, 401, `${path} 应该拒绝匿名访问`)
  }
  const wrong = await fetch(`${base}/mini/api/state?token=nope`)
  assert.equal(wrong.status, 401, '错误的 token 也要拒绝')
})

test('带正确 token 可以读到状态', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/state?token=${token}`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.latest, null)
  assert.deepEqual(body.history, [])
})

// ---------------------------------------------------------------------------
// 左侧导航栏的两个接口
// ---------------------------------------------------------------------------

function fakeNav(createSession) {
  return {
    listWorkspaces: async () => [
      { id: 'w1', title: '极简遥控器', path: 'I:\\极简遥控器\\极简遥控器', count: 3, running: 1 },
    ],
    listSessionsOf: async (workspaceId, limit) =>
      (workspaceId === 'w1'
        ? {
          workspaceId,
          total: 3,
          truncated: false,
          sessions: [
            { id: 's1', title: '改手机页面', createdAt: 200, running: true, live: true },
            { id: 's2', title: '', createdAt: 100, running: false, live: false },
          ],
          askedLimit: limit,
        }
        : null),
    // 默认给一个「建得成」的桩；要测失败路径的用例自己传一个进来。
    createSession: createSession ?? (async (workspaceId) => (
      workspaceId === 'w1'
        ? { ok: true, sessionId: 'session-new', workspaceTitle: '极简遥控器' }
        : { ok: false, reason: 'no-workspace' }
    )),
  }
}

test('工作区列表要 token 才给看', async (t) => {
  const { server, base } = await startTestServer({ tree: fakeNav() })
  t.after(() => server.close())
  assert.equal((await fetch(`${base}/mini/api/workspaces`)).status, 401)
})

test('工作区列表带 token 能读到', async (t) => {
  const { server, base, token } = await startTestServer({ tree: fakeNav() })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/workspaces?token=${token}`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.workspaces.length, 1)
  assert.equal(body.workspaces[0].title, '极简遥控器')
})

test('工作区列表命中缓存，刷新请求才重新整理', async (t) => {
  let calls = 0
  const tree = {
    ...fakeNav(),
    listWorkspaces: async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return [{ id: 'w1', title: '缓存测试', count: 1, running: 0 }]
    },
  }
  const { server, base, token } = await startTestServer({ tree })
  t.after(() => server.close())

  const first = await (await fetch(`${base}/mini/api/workspaces?token=${token}`)).json()
  const second = await (await fetch(`${base}/mini/api/workspaces?token=${token}`)).json()
  const refreshed = await (await fetch(`${base}/mini/api/workspaces?token=${token}&refresh=1`)).json()
  assert.equal(first.workspaces[0].title, '缓存测试')
  assert.equal(second.workspaces[0].title, '缓存测试')
  assert.equal(refreshed.workspaces[0].title, '缓存测试')
  assert.equal(calls, 2)
})

test('导航缓存可由会话生命周期主动失效', async (t) => {
  let calls = 0
  const tree = {
    ...fakeNav(),
    listWorkspaces: async () => {
      calls += 1
      return [{ id: 'w1', title: '生命周期', count: 1, running: 0 }]
    },
  }
  const { server, base, token } = await startTestServer({ tree })
  t.after(() => server.close())
  await fetch(`${base}/mini/api/workspaces?token=${token}`)
  server.invalidateNavigation()
  await fetch(`${base}/mini/api/workspaces?token=${token}`)
  assert.equal(calls, 2)
})

test('展开工作区能拿到它的会话', async (t) => {
  const { server, base, token } = await startTestServer({ tree: fakeNav() })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.sessions.length, 2)
  assert.equal(body.total, 3)
})

test('不存在的返回 404，不是空列表', async (t) => {
  const { server, base, token } = await startTestServer({ tree: fakeNav() })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/workspaces/nope/sessions?token=${token}`)
  assert.equal(res.status, 404)
})

test('limit 参数会传下去，并且封顶 100（防止手机拉爆）', async (t) => {
  const { server, base, token } = await startTestServer({ tree: fakeNav() })
  t.after(() => server.close())

  const one = await (await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}&limit=5`)).json()
  assert.equal(one.askedLimit, 5)

  const huge = await (await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}&limit=99999`)).json()
  assert.equal(huge.askedLimit, 100, '要封顶')

  const junk = await (await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}&limit=abc`)).json()
  assert.equal(junk.askedLimit, undefined, '乱填就用默认值')
})

test('没传 tree 时接口也能应答（headless 组合里就是空的）', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/workspaces?token=${token}`)
  assert.equal(res.status, 200)
  assert.deepEqual((await res.json()).workspaces, [])
})

// ---------------------------------------------------------------------------
// 在已有工作区里新建会话
// ---------------------------------------------------------------------------

test('新建会话要 token，没 token 连试都不让试', async (t) => {
  const { server, base } = await startTestServer({ tree: fakeNav() })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/workspaces/w1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(res.status, 401)
})

test('建完一个会话：返回 id，并且手机已经绑在它上面了', async (t) => {
  const { server, base, token } = await startTestServer({ tree: fakeNav() })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 'session-new')
  assert.equal(body.workspaceTitle, '极简遥控器')
  // 这两条是「建完就切过去」的证据：服务端自己 bind 了，不用手机再补一次请求。
  // 少了它就会出现「建好了但手机还停在旧会话上」这种半截状态。
  assert.equal(body.boundSessionId, 'session-new')
  assert.equal(body.state.boundSessionId, 'session-new')
})

test('建会话把工作区 id 原样传下去，不带歪', async (t) => {
  const seen = []
  const nav = fakeNav(async (workspaceId) => {
    seen.push(workspaceId)
    return { ok: true, sessionId: 's-x', workspaceTitle: '极简遥控器' }
  })
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.deepEqual(seen, ['w1'])
})

test('工作区不存在时回 404，不是 500', async (t) => {
  const { server, base, token } = await startTestServer({ tree: fakeNav() })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/workspaces/nope/sessions?token=${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(res.status, 404)
})

test('DSH 没这个能力时回 503，并且说的是「没能力」而不是笼统的失败了', async (t) => {
  const nav = fakeNav(async () => ({ ok: false, reason: 'no-controller' }))
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(res.status, 503)
  assert.match((await res.json()).error, /没提供/)
})

test('建失败时回 500，并把 DSH 的原话带出来', async (t) => {
  const nav = fakeNav(async () => ({ ok: false, reason: 'failed', error: '磁盘满了' }))
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(res.status, 500)
  assert.match((await res.json()).error, /磁盘满了/)
})

test('没传 tree 时建会话回 503，不是崩掉', async (t) => {
  // headless 组合里没有 sessionController，导航栏本来就是空的。
  // 这里要保证「点了 ＋ 没反应」不会变成一个 500。
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(res.status, 503)
})

test('同一条路径上 GET 还是列表，没被 POST 抢掉', async (t) => {
  const { server, base, token } = await startTestServer({ tree: fakeNav() })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}`)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).sessions.length, 2, 'GET 该照旧给会话列表')
})

// ---------------------------------------------------------------------------
// 目录浏览 + 登记工作区
// ---------------------------------------------------------------------------

/** 假的浏览服务。测试不该真去读盘，真读盘那部分在 browse.test.mjs 里用真目录测。 */
function fakeBrowse(overrides = {}) {
  return {
    listRoots: async ({ recent } = {}) => ({
      home: 'C:\\Users\\测试', drives: ['C:\\', 'I:\\'], recent: recent ?? [], askedRecent: recent,
    }),
    listDirectory: async (p) => (p === 'I:\\没有这个'
      ? { ok: false, reason: 'unreadable', error: 'ENOENT' }
      : {
        ok: true,
        path: p,
        ancestors: [{ name: 'I:\\', path: 'I:\\' }, { name: '项目', path: p }],
        dirs: [{ name: '子目录', path: p + '\\子目录' }],
        total: 1,
        truncated: false,
      }),
    makeDirectory: async (p, name) => (name === '已存在'
      ? { ok: false, reason: 'exists' }
      : name === '带/斜杠'
        ? { ok: false, reason: 'bad-name' }
        : { ok: true, path: p + '\\' + name }),
    ...overrides,
  }
}

test('常用位置要 token 才给看', async (t) => {
  const { server, base } = await startTestServer({ browse: fakeBrowse() })
  t.after(() => server.close())
  assert.equal((await fetch(`${base}/mini/api/browse/roots`)).status, 401)
})

test('常用位置里有主目录、盘符和最近用过的目录', async (t) => {
  const { server, base, token } = await startTestServer({
    browse: fakeBrowse(),
    tree: fakeNav(),
  })
  t.after(() => server.close())

  const body = await (await fetch(`${base}/mini/api/browse/roots?token=${token}`)).json()
  assert.equal(body.ok, true)
  assert.equal(body.home, 'C:\\Users\\测试')
  assert.deepEqual(body.drives, ['C:\\', 'I:\\'])
  // 「最近用过的目录」应该来自已登记的工作区路径，而不是另记一份状态。
  assert.deepEqual(body.recent, ['I:\\极简遥控器\\极简遥控器'])
})

test('列目录：只给目录，每一项都带完整路径', async (t) => {
  const { server, base, token } = await startTestServer({ browse: fakeBrowse() })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/browse?path=${encodeURIComponent('I:\\项目')}&token=${token}`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.path, 'I:\\项目')
  assert.equal(body.dirs[0].name, '子目录')
  assert.equal(body.dirs[0].path, 'I:\\项目\\子目录')
  assert.ok(Array.isArray(body.ancestors), '面包屑要一起给，手机不用自己拆路径')
})

test('列目录不带 path 时回 400，不是默默给个根目录', async (t) => {
  const { server, base, token } = await startTestServer({ browse: fakeBrowse() })
  t.after(() => server.close())
  assert.equal((await fetch(`${base}/mini/api/browse?token=${token}`)).status, 400)
})

test('目录读不到时回 404，说的是读不到而不是空目录', async (t) => {
  const { server, base, token } = await startTestServer({ browse: fakeBrowse() })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/browse?path=${encodeURIComponent('I:\\没有这个')}&token=${token}`)
  assert.equal(res.status, 404)
  assert.match((await res.json()).error, /读不到/)
})

test('没传 browse 时列目录回 503，不是崩掉', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/api/browse?path=${encodeURIComponent('I:\\a')}&token=${token}`)
  assert.equal(res.status, 503, '「没这个能力」统一 503，别混进 500')
})

test('新建文件夹：成功时回完整路径', async (t) => {
  const { server, base, token } = await startTestServer({ browse: fakeBrowse() })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/browse/mkdir?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'I:\\项目', name: '新文件夹' }),
  })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).path, 'I:\\项目\\新文件夹')
})

test('新建文件夹：名字不合法回 400，同名回 409（两种要分得开）', async (t) => {
  const { server, base, token } = await startTestServer({ browse: fakeBrowse() })
  t.after(() => server.close())

  const post = (name) => fetch(`${base}/mini/api/browse/mkdir?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'I:\\项目', name }),
  })
  assert.equal((await post('带/斜杠')).status, 400)
  assert.equal((await post('已存在')).status, 409)
})

test('新建文件夹要 token', async (t) => {
  const { server, base } = await startTestServer({ browse: fakeBrowse() })
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/api/browse/mkdir`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'I:\\项目', name: 'x' }),
  })
  assert.equal(res.status, 401)
})

test('登记工作区：新建的如实说 created=true，并把最新列表一起带回来', async (t) => {
  const seen = []
  const nav = {
    ...fakeNav(),
    createWorkspace: async (path) => {
      seen.push(path)
      return { ok: true, created: true, workspace: { id: 'w9', path, title: '新项目' } }
    },
  }
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/workspaces?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'I:\\新项目' }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.created, true)
  assert.equal(body.workspace.title, '新项目')
  assert.deepEqual(seen, ['I:\\新项目'], '路径要原样传下去')
  // 列表一起给：手机拿到就能直接画，不会出现「建好了但列表里还没有」。
  assert.equal(body.workspaces.length, 1)
})

test('登记工作区：本来就有的如实说 created=false', async (t) => {
  const nav = {
    ...fakeNav(),
    createWorkspace: async (path) => ({
      ok: true, created: false, workspace: { id: 'w1', path, title: '老项目' },
    }),
  }
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const body = await (await fetch(`${base}/mini/api/workspaces?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'I:\\老项目' }),
  })).json()
  assert.equal(body.created, false, '要让界面说得出「这个本来就在」')
})

test('登记工作区：路径不存在时回 400 并带上 DSH 的原话', async (t) => {
  const nav = {
    ...fakeNav(),
    createWorkspace: async () => ({ ok: false, reason: 'failed', error: '不是一个目录' }),
  }
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/workspaces?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'I:\\没有这个' }),
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /不是一个目录/)
})

// ---------------------------------------------------------------------------
// 权限档位
// ---------------------------------------------------------------------------

/** 假的档位服务那一侧。档位名故意起得跟默认表不一样，钉住「运行时不写死」。 */
function permNav(overrides = {}) {
  return {
    ...fakeNav(),
    permissions: async () => ({
      ok: true,
      currentValue: '只看',
      options: [
        { value: '只看', name: '仅可查看', description: 'Agent 只能读', dangerous: false },
        { value: '改文件', name: '工作区内修改', description: '在工作区里改', dangerous: false },
        { value: '全开', name: '完全权限', description: '哪儿都能改', dangerous: true },
      ],
    }),
    setPermission: async () => ({ ok: true, name: '改文件' }),
    ...overrides,
  }
}

test('权限档位要 token 才给看', async (t) => {
  const { server, base } = await startTestServer({ tree: permNav() })
  t.after(() => server.close())
  assert.equal((await fetch(`${base}/mini/api/permissions`)).status, 401)
})

test('读档位盘：名字和标签一路带过来，哪个危险也标好了', async (t) => {
  const { server, base, token } = await startTestServer({ tree: permNav() })
  t.after(() => server.close())

  const body = await (await fetch(`${base}/mini/api/permissions?token=${token}`)).json()
  assert.equal(body.ok, true)
  assert.equal(body.currentValue, '只看')
  assert.deepEqual(body.options.map((o) => o.name), ['仅可查看', '工作区内修改', '完全权限'])
  assert.equal(body.options.at(-1).dangerous, true, '哪个要确认，服务端就标好给手机，手机不猜')
  assert.ok(!body.boundSessionId, '没绑定会话时这个字段就该是空的（假值），不能编一个出来')
})

test('拿不到档位服务时如实说没这个能力，手机据此整块不显示', async (t) => {
  const nav = {
    ...fakeNav(),
    permissions: async () => ({ ok: false, reason: 'no-service' }),
  }
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/permissions?token=${token}`)
  assert.equal(res.status, 200, '这不是错误，是「这台电脑没这个能力」')
  assert.equal((await res.json()).ok, false)
})

test('没传 tree 时读档位也不崩', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/api/permissions?token=${token}`)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, false)
})

test('切档位：作用在**当前绑定的那个会话**上', async (t) => {
  const seen = []
  const nav = permNav({
    setPermission: async (sessionId, name) => { seen.push([sessionId, name]); return { ok: true, name } },
  })
  const { server, store, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  store.bind('session-绑定的')
  const res = await fetch(`${base}/mini/api/permissions?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '改文件' }),
  })
  assert.equal(res.status, 200)
  assert.deepEqual(seen, [['session-绑定的', '改文件']], '要拿绑定会话去切，不是随便一个')
})

test('切完把最新状态一起回来，手机不用再问一趟', async (t) => {
  const nav = permNav()
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const body = await (await fetch(`${base}/mini/api/permissions?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '改文件' }),
  })).json()
  assert.equal(body.ok, true)
  assert.equal(body.name, '改文件')
  assert.ok(Array.isArray(body.options), '切完的整盘要一起给，手机据此更新高亮')
})

test('切档位：表里没有的名字回 400，带了也不透传', async (t) => {
  const seen = []
  const nav = permNav({
    setPermission: async (sessionId, name) => {
      seen.push(name)
      // 真服务里「表里没有」就是这个结果。
      if (name !== '改文件' && name !== '全开') return { ok: false, reason: 'unknown-preset' }
      return { ok: true, name }
    },
  })
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/permissions?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '瞎写的档位' }),
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /没有这个权限档位/)

  // 名字不是字符串时也别炸，空串交给下游判断。
  const res2 = await fetch(`${base}/mini/api/permissions?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 42 }),
  })
  assert.equal(res2.status, 400)
  assert.deepEqual(seen, ['瞎写的档位', ''], '数字要被收成空串，不能原样透传')
})

test('没绑定会话时切档位回 409，说的是「先挑个会话」', async (t) => {
  const nav = permNav({
    setPermission: async () => ({ ok: false, reason: 'no-session' }),
  })
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/permissions?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '改文件' }),
  })
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /先挑一个会话/)
})

test('切档位失败时把原因带出来，不装作切好了', async (t) => {
  const nav = permNav({
    setPermission: async () => ({ ok: false, reason: 'failed', error: '这个会话动不了' }),
  })
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/permissions?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '改文件' }),
  })
  assert.equal(res.status, 500)
  assert.match((await res.json()).error, /这个会话动不了/)
})

test('切档位也要 token —— 这是唯一一个能改电脑权限的接口', async (t) => {
  const { server, base } = await startTestServer({ tree: permNav() })
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/api/permissions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '全开' }),
  })
  assert.equal(res.status, 401)
})

test('登记工作区：没给路径时回 400，不去麻烦工作区服务', async (t) => {
  // 路由里有一条 bad-path 分支。它只有在真的收到空路径时才走到——
  // 之前没有测试碰过它，所以把它删掉测试照样全绿（反向验证逮到的）。
  const seen = []
  const nav = {
    ...fakeNav(),
    createWorkspace: async (path) => {
      seen.push(path)
      if (!path) return { ok: false, reason: 'bad-path' }
      return { ok: true, created: true, workspace: { id: 'w9', path, title: '甲' } }
    },
  }
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/workspaces?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /没给路径/)
  assert.deepEqual(seen, [''], '空路径要原样交给下游判断，别在这儿编一句')
})

test('登记工作区：没传 tree 时回 503，不是崩掉', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/api/workspaces?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'I:\\a' }),
  })
  assert.equal(res.status, 503)
})

test('工作区列表要带上「空工作区也列出来」这个开关', async (t) => {
  // 不带的话，手机刚建好的空工作区会被滤掉——接口回 created=true，
  // 列表里却找不到，用户只会以为没建成（闸门脚本逮到过）。
  const seen = []
  const nav = {
    ...fakeNav(),
    listWorkspaces: async (runningIds, force, includeEmpty) => {
      seen.push(includeEmpty)
      return []
    },
  }
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  await fetch(`${base}/mini/api/workspaces?token=${token}`)
  assert.deepEqual(seen, [true], '平时列列表也要带上这个开关')
})

test('登记工作区后返回的那份列表也要带这个开关', async (t) => {
  const seen = []
  const nav = {
    ...fakeNav(),
    listWorkspaces: async (runningIds, force, includeEmpty) => {
      seen.push(includeEmpty)
      return []
    },
    createWorkspace: async (path) => ({
      ok: true, created: true, workspace: { id: 'w9', path, title: '新' },
    }),
  }
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  await fetch(`${base}/mini/api/workspaces?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'I:\\新' }),
  })
  assert.deepEqual(seen, [true], '建完立刻回的那份列表尤其要带上——不然新工作区当场消失')
})

test('密码试错 5 次就被挡一分钟，连对的密码也进不来', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  // 不带密码的匿名请求不算试错，先确认它不消耗额度
  for (let i = 0; i < 8; i += 1) {
    const res = await fetch(`${base}/mini/api/state`)
    assert.equal(res.status, 401, '匿名请求应该一直是 401，不该被算成试错')
  }

  // 前 4 次错密码是普通 401
  for (let i = 1; i <= 4; i += 1) {
    const res = await fetch(`${base}/mini/api/state?token=wrong${i}`)
    assert.equal(res.status, 401, `第 ${i} 次错密码应该是 401`)
  }

  // 第 5 次触发封禁，之后一律 429
  const fifth = await fetch(`${base}/mini/api/state?token=wrong5`)
  assert.equal(fifth.status, 401)

  const blocked = await fetch(`${base}/mini/api/state?token=wrong6`)
  assert.equal(blocked.status, 429, '第 6 次应该被挡住')
  assert.match((await blocked.json()).error, /次数太多/)

  // 封禁期间连正确的密码也不放行——否则限速形同虚设
  const withRight = await fetch(`${base}/mini/api/state?token=${token}`)
  assert.equal(withRight.status, 429, '被挡的来源拿对密码也该等')
})

test('token 走 header 也能通过（手机端的用法）', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/state`, { headers: { 'X-Mini-Token': token } })
  assert.equal(res.status, 200)
})

test('POST /send 会把指令交给插件，并写进历史', async (t) => {
  const { server, base, token, seen, store } = await startTestServer()
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/send?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '跑一下测试' }),
  })
  assert.equal(res.status, 200)
  assert.deepEqual(seen, ['跑一下测试'])
  assert.equal((await res.json()).ok, true)
  assert.equal(store.historyOf('s1').at(-1).text, '跑一下测试')
})

test('空指令被拒绝', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/send?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  })
  assert.equal(res.status, 400)
})

test('agent 忙的时候返回 409，手机端据此提示用户', async (t) => {
  const { server, base, token } = await startTestServer({
    onInstruction: async () => ({ ok: false, error: '上一个任务还在跑' }),
  })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/send?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '再来一次' }),
  })
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /还在跑/)
})

test('SSE 流：连上先收到 state，之后能收到广播的 reply', async (t) => {
  const { server, base, token, store } = await startTestServer()
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/stream?token=${token}`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  async function nextChunk() {
    const { value, done } = await reader.read()
    if (done) return false
    buffer += decoder.decode(value, { stream: true })
    return true
  }

  // 首帧必须是 state（手机刷新后不用再单独拉一次）
  while (!buffer.includes('event: state')) {
    if (!(await nextChunk())) break
  }
  assert.ok(buffer.includes('event: state'), '连上应该立刻补一次全量状态')

  // 模拟 agent 产出最终回复
  buffer = ''
  store.pushReply({ text: '全部通过 ✅', sessionId: 's1', reason: 'completed' })
  server.broadcast('reply', { text: '全部通过 ✅', sessionId: 's1', timestamp: Date.now() })

  while (!buffer.includes('event: reply')) {
    if (!(await nextChunk())) break
  }
  assert.ok(buffer.includes('event: reply'))
  assert.ok(buffer.includes('全部通过'), '回复正文要原样送到手机')

  await reader.cancel()
})

// ---------------------------------------------------------------------------
// 「完整」模式的执行轨迹
//
// 传输这一层要钉住三件事：
//   ① 轨迹**不塞进快照**（`/mini/api/state`）——它只走 `event: trajectory` 这条新帧，
//      而且只发给声明了「完整」模式的那几条连接。实测轨迹正文是回答正文的 90.7 倍
//      （单轮最高约 946KB），而快照是**每条广播都发整份**的：塞进去等于每一次工具调用
//      都推几百 KB，公网隧道下尤其不可接受。
//   ② 切回聊天模式就要停推——订阅按**连接**记，开/关都得点到具体那一条，
//      认不出那条连接时**如实说没订上**，不许静默成功（那是最难查的一种失败）。
//   ③ GET /mini/api/trajectory 是重连、切模式、换会话时的补齐口。
// ---------------------------------------------------------------------------

/**
 * 和上面那个 openStream 同一套，只是能带查询串（`clientId` / `full=1`）。
 *
 * **自己起一个一直跑着的收帧循环**，不按需去读：按需读那种写法每等一次超时都会把一个
 * `reader.read()` 悬在半空（`Promise.race` 里输掉的那个），它随后收到的那一片数据会被
 * 悄悄丢掉——「这一帧到没到」这种判据就会假红假绿。一个循环独占 reader，谁都不跟它抢。
 */
async function openStreamWith(base, token, query) {
  const res = await fetch(`${base}/mini/api/stream?token=${token}${query}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const stream = { status: res.status, buffer: '', reader }
  ;(async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      stream.buffer += decoder.decode(value, { stream: true })
    }
  })().catch(() => {})
  stream.raw = () => stream.buffer
  stream.read = async (needle, ms = 5000) => {
    const deadline = Date.now() + ms
    while (!stream.buffer.includes(needle) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return stream.buffer
  }
  stream.close = () => reader.cancel()
  await stream.read(': connected\n\n')
  return stream
}

/** 数一数某条帧收了几回（「一条都没收到」这种判据靠它）。 */
function countFrames(buffer, event) {
  return buffer.split(`event: ${event}\n`).length - 1
}

/**
 * 读一小会儿把这段时间里到达的帧都吸进来，再判「收没收到」。
 *
 * 等一个**永远不会出现**的标记，是为了等满这段时间；只看「我还没读」等于什么都没证明
 * ——帧就躺在 socket 里，缓冲区里当然没有。
 */
async function drain(stream, ms = 300) {
  await stream.read('这个标记永远不会出现', ms)
  return stream.raw()
}

function trajectoryEntry(id, output, turn = 1) {
  return {
    id, turn, step: 1, kind: 'think', name: null, args: null, summary: null,
    output, state: 'ok', error: null, truncated: null, timestamp: 1,
  }
}

test('轨迹只推给声明了「完整」模式的那条连接，切回聊天模式就停', async (t) => {
  const { server, base, token, store } = await startTestServer()
  t.after(() => server.close())
  store.bind('s1')

  // 两条连接都用上面那个一直收帧的写法：要证明「这条一条都没收到」，就得真的在读。
  const chat = await openStreamWith(base, token, '')
  const full = await openStreamWith(base, token, '&full=1&clientId=phone-1')
  await chat.read('event: state')
  await full.read('event: state')

  server.broadcastTrajectory({
    sessionId: 's1', seq: 1, turn: 1, state: 'running', reason: null,
    add: [trajectoryEntry('a', '先看看现在是什么版本')], update: [],
  })
  const got = await full.read('event: trajectory')
  assert.ok(got.includes('event: trajectory'), '声明了完整模式的那条要收得到')
  const frame = frameOf(got, 'trajectory')
  assert.equal(frame.add[0].output, '先看看现在是什么版本')
  assert.equal(frame.seq, 1, '帧里带着序号，客户端靠它认出漏帧')
  assert.ok(frame.epoch, '帧里带着这一代服务的编号——重连后靠它认出服务重启过')
  assert.equal(frame.sessionId, 's1')

  // 给两条流一点时间：要证明的是「这条收到了、那条没收到」，不能靠「还没读到」就算数。
  assert.equal(countFrames(await drain(chat), 'trajectory'), 0, '聊天模式一个字节都不该为轨迹付钱')

  // 切回聊天模式：订阅关掉，这条连接不再收（**别人不受影响**）
  const off = await fetch(`${base}/mini/api/trajectory/subscribe?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'phone-1', on: false }),
  })
  assert.equal(off.status, 200)
  const offBody = await off.json()
  assert.equal(offBody.ok, true)
  assert.equal(offBody.subscribed, false)
  assert.equal(offBody.connections, 1, '点到的就是这一条连接')

  server.broadcastTrajectory({
    sessionId: 's1', seq: 2, turn: 1, state: 'running', reason: null,
    add: [trajectoryEntry('b', '关掉之后这条不该到')], update: [],
  })
  assert.equal(countFrames(await drain(full), 'trajectory'), 1, '关掉之后不再推')

  // 再打开：又能收
  const on = await fetch(`${base}/mini/api/trajectory/subscribe?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'phone-1', on: true }),
  })
  assert.equal((await on.json()).subscribed, true)
  server.broadcastTrajectory({
    sessionId: 's1', seq: 3, turn: 1, state: 'running', reason: null,
    add: [trajectoryEntry('c', '打开之后又收得到')], update: [],
  })
  // 等**新那一条**到，不能只等帧名——缓冲里本来就有上一帧，那等于没等。
  await full.read('打开之后又收得到')
  assert.equal(countFrames(full.raw(), 'trajectory'), 2, '打开之后又收得到')

  // 认不出的请求：不当成功
  const empty = await fetch(`${base}/mini/api/trajectory/subscribe?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: true }),
  })
  assert.equal(empty.status, 400, 'clientId 不能空——订阅是按连接记的')
  const ghost = await fetch(`${base}/mini/api/trajectory/subscribe?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: '没人认领', on: true }),
  })
  assert.equal(ghost.status, 404, '认不出这条连接就如实说没订上，让手机重连一次')

  await chat.close()
  await full.close()
})

test('轨迹接口：一组一组地给，能按轮取，没有会话时不是错', async (t) => {
  const { server, base, token, store } = await startTestServer()
  t.after(() => server.close())
  store.bind('s1')
  store.applyTrajectory('s1', { turn: 1, entries: [trajectoryEntry('a', '想了')], updates: [], state: 'running' })
  store.applyTrajectory('s1', { turn: 1, entries: [trajectoryEntry('b', '又想了')], updates: [], state: 'done' })
  store.applyTrajectory('s1', { turn: 2, entries: [trajectoryEntry('c', '新一轮', 2)], updates: [], state: 'running' })

  const body = await (await fetch(`${base}/mini/api/trajectory?token=${token}`)).json()
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 's1')
  assert.equal(body.seq, 3, '和增量帧共用同一个序号计数器')
  assert.ok(body.epoch)
  assert.equal(body.loading, false, '手里有亲眼看见的那份，就不说「正在读」')
  assert.equal(body.truncated, false)
  assert.equal(body.note, null)
  assert.deepEqual(body.turns.map((g) => [g.turn, g.state, g.entries.length]),
    [[1, 'done', 2], [2, 'running', 1]], '一组一轮，轮状态和条目都对着')

  const only = await (await fetch(`${base}/mini/api/trajectory?token=${token}&sessionId=s1&turn=2`)).json()
  assert.deepEqual(only.turns.map((g) => g.turn), [2], '按轮取只给那一轮')
  assert.equal(only.turn, 2)

  const bad = await fetch(`${base}/mini/api/trajectory?token=${token}&sessionId=s1&turn=abc`)
  assert.equal(bad.status, 400, 'turn 不是数字是请求本身坏了')

  // 谁都没绑过：给一组空的，不是 400——「还没有会话」不是错。
  const fresh = await startTestServer()
  t.after(() => fresh.server.close())
  const none = await (await fetch(`${fresh.base}/mini/api/trajectory?token=${fresh.token}`)).json()
  assert.equal(none.sessionId, null)
  assert.deepEqual(none.turns, [])
})

test('轨迹不在快照里——一次都别想混进 /mini/api/state', async (t) => {
  const { server, base, token, store } = await startTestServer()
  t.after(() => server.close())
  store.bind('s1')
  store.applyTrajectory('s1', {
    turn: 1, entries: [trajectoryEntry('a', '轨迹里那句话')], updates: [], state: 'running',
  })

  const snap = await (await fetch(`${base}/mini/api/state?token=${token}`)).json()
  assert.ok(!JSON.stringify(snap).includes('轨迹里那句话'), '快照里一个字都不许有轨迹')
  assert.equal(snap.trajectory, undefined)

  // 没丢：它只是走了另一条路（真机上由 event: trajectory 那条帧增量推）
  const traj = await (await fetch(`${base}/mini/api/trajectory?token=${token}`)).json()
  assert.equal(traj.turns[0].entries[0].output, '轨迹里那句话')
})

test('展开工作区时，标题补齐通过 SSE 单独推送', async (t) => {
  const tree = {
    ...fakeNav(),
    listSessionsOf: async (workspaceId, limit, force, onTitle) => {
      onTitle?.({ workspaceId, sessionId: 's1', title: '刚读到的标题' })
      return { workspaceId, total: 1, truncated: false, pending: 0, sessions: [
        { id: 's1', title: '刚读到的标题', createdAt: 1, running: false, live: false },
      ] }
    },
  }
  const { server, base, token } = await startTestServer({ tree })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/stream?token=${token}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  async function readUntil(needle) {
    while (!buffer.includes(needle)) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
    }
  }
  await readUntil('event: state')
  buffer = ''
  const sessions = await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}`)
  assert.equal(sessions.status, 200)
  await readUntil('event: navigation-title')
  assert.match(buffer, /"workspaceId":"w1"/)
  assert.match(buffer, /"sessionId":"s1"/)
  assert.match(buffer, /刚读到的标题/)
  await reader.cancel()
})

test('提问推给手机：断线重连上来也能收到那道还在等的题', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  // 题目先来。此刻手机上没有人连着，这一次广播发出去没人收——而题目只在推的时候发一次。
  const pending = server.askPhone(
    [{ id: 'q1', question: '选哪个方案？', options: [{ label: 'A' }, { label: 'B' }] }],
    'sess-1',
  )
  pending.catch(() => {})

  // 手机这会儿才连上来（页面重连、锁屏醒来都长这样）。
  const res = await fetch(`${base}/mini/api/stream?token=${token}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // **等待必须有上限**：补发要是坏了，这个流上不会有下一个字节，没时限就不是「失败」
  // 而是「永远挂着」——测试挂起比测试变红难查得多。所以每读一次最多等 500 毫秒，
  // 到 5 秒还没等到就往下走，让下面那条断言去报红。
  const deadline = Date.now() + 5000
  while (!buffer.includes('event: question') && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ])
    if (chunk === 'timeout') continue
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
  }
  assert.match(buffer, /event: question/, '连上来之后要把还在等的那道题补给它')
  assert.match(buffer, /选哪个方案/, '题目正文要原样带上，不能只补一个空壳')

  await reader.cancel()
})

test('手机上的答案发回来：接住了交给电脑，答晚了如实回 409', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  const post = (body) => fetch(`${base}/mini/api/answer?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  // ① 题还在等：接住，并把答案原样交给电脑（插件等的就是这个对象）。
  const pending = server.askPhone([{ id: 'q1', question: '选哪个方案？' }], 'sess-1')
  const res = await post({ id: 'q1', answers: [{ id: 'q1', selected: ['B'] }] })
  assert.equal(res.status, 200)
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['B'] }] })

  // ② 答晚了（这题已经交回电脑）：如实回 409，不能回 200 装作收下——
  // 手机那一端就是靠这个 409 才能告诉用户「去电脑上答」，而不是静悄悄。
  const late = await post({ id: 'q1', answers: [{ id: 'q1', selected: ['B'] }] })
  assert.equal(late.status, 409)
  assert.match((await late.json()).error, /已经结束/)
})

test('绑定会话后状态里能读到', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/bind?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-abc' }),
  })
  assert.equal(res.status, 200)
  const state = await (await fetch(`${base}/mini/api/state?token=${token}`)).json()
  assert.equal(state.boundSessionId, 'session-abc')
})

// ---------------------------------------------------------------------------
// 「交回答案」这条接缝：手机页走 HTTP，飞书走 miniControl 上那两个函数
//
// 两条路**共用同一份清单、同一个 settle**，所以「谁先答谁生效、另一个自动失效」
// 不是另写的一套规矩。这里钉的就是这件事——一边答了，另一边必须拿到 expired。
// ---------------------------------------------------------------------------

test('答题接缝：飞书那两个函数和手机页那两条路由进的是同一份清单', async (t) => {
  const { server } = await startTestServer()
  t.after(() => server.close())

  const taken = []
  const pending = server.askPhone([{ id: 'q1', question: '选哪个方案？' }], 's1', {
    onPending: (id) => taken.push(id),
  })
  assert.equal(taken.length, 1, '题一挂上就要把编号交出去——飞书那条路靠它对号入座')

  // 手机页那条路先到（同一个 settle）：飞书随后交回来就该拿到 expired（对应 409），
  // 而不是把这道题答第二遍。
  assert.deepEqual(miniControl.answerQuestion(taken[0], { answers: [] }), { ok: true })
  assert.deepEqual(await pending, { answers: [] })
  assert.deepEqual(miniControl.answerQuestion(taken[0], { answers: [] }), { ok: false, error: 'expired' },
    '已经答过的题，第二个来的人拿到 expired——这正是「另一个自动失效」')
})

test('答题接缝：格式不对说 bad（对应 400），过期的题优先说 expired（对应 409）', async (t) => {
  const { server } = await startTestServer()
  t.after(() => server.close())

  const pending = server.askPhone([{ id: 'q1', question: '选哪个方案？' }], 's1')
  pending.catch(() => {})
  assert.deepEqual(miniControl.answerQuestion('q1', { answers: '不是数组' }), { ok: false, error: 'bad' })
  assert.deepEqual(miniControl.answerQuestion('q-没有这个', { answers: [] }), { ok: false, error: 'expired' })
  miniControl.answerQuestion('q1', { answers: [] })
  await pending
})

test('答题接缝：回「取消」= 不答，题原样还给电脑（和手机锁屏时同一条路）', async (t) => {
  const { server } = await startTestServer()
  t.after(() => server.close())

  const pending = server.askPhone([{ id: 'q1', question: '选哪个方案？' }], 's1')
  assert.deepEqual(miniControl.answerQuestion('q1', { cancel: true }), { ok: true })
  assert.equal(await pending, null, 'null 就是「没人答」，调用方据此 next() 还给电脑')
})

test('审批接缝：同一个 settle，取消也是还给电脑', async (t) => {
  const { server } = await startTestServer()
  t.after(() => server.close())

  const allow = miniControl.askApproval({ toolName: 'shell' }, 's1', 'rm -rf build')
  assert.deepEqual(miniControl.decideApproval('a1', { decision: 'allowed-once' }), { ok: true })
  assert.equal(await allow, 'allowed-once')
  assert.deepEqual(miniControl.decideApproval('a1', { decision: 'rejected' }), { ok: false, error: 'expired' })
  assert.deepEqual(miniControl.decideApproval('a1', { decision: '随便' }), { ok: false, error: 'expired' })

  const deny = miniControl.askApproval({ toolName: 'shell' }, 's1', 'rm -rf build')
  assert.deepEqual(miniControl.decideApproval('a2', { decision: '随便' }), { ok: false, error: 'bad' })
  assert.deepEqual(miniControl.decideApproval('a2', { cancel: true }), { ok: true })
  assert.equal(await deny, null)
})

test('超时判据：手机全断了，但飞书那边还挂着这道题，就不能收摊还给电脑', async (t) => {
  const { server } = await startTestServer()
  t.after(() => server.close())

  // 手机不在（测试里是空壳 hasPhone）——原来这里 2 秒后就会 settle(null) 还给电脑。
  // 现在多问一句「还有别人在等吗」：飞书说还在等，题就不许被收走。
  let waiting = true
  const pending = server.askPhone([{ id: 'q1', question: '选哪个方案？' }], 's1', {
    keepAlive: () => waiting,
  })
  const early = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve('还在等'), 2300)),
  ])
  assert.equal(early, '还在等', '飞书还挂着题，就不该按「手机没了」那条判据收摊')

  // 飞书那边也接不上了（发不出去、或者被关掉）：立刻按老规矩还给电脑。
  waiting = false
  const late = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve('还在等'), 3000)),
  ])
  assert.equal(late, null, '两边都没人等了，必须还给电脑——不能把提问卡死在这里')
})

test('超时判据：keepAlive 抛错一律当「没人在等」，不能把提问卡死', async (t) => {
  const { server } = await startTestServer()
  t.after(() => server.close())

  const pending = server.askPhone([{ id: 'q1', question: '选哪个方案？' }], 's1', {
    keepAlive: () => { throw new Error('飞书那边炸了') },
  })
  const verdict = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve('还在等'), 3000)),
  ])
  assert.equal(verdict, null, '宁可还给电脑，也不能让一道题卡死在这儿')
})

test('答题接缝：手机页收到的那条 question 帧一个字都没变', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  const questions = [{ id: 'q1', question: '选哪个方案？', options: [{ label: 'A' }, { label: 'B' }] }]
  const pending = server.askPhone(questions, 'sess-1', { onPending: () => {} })
  pending.catch(() => {})

  const res = await fetch(`${base}/mini/api/stream?token=${token}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 5000
  while (!buffer.includes('event: question') && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ])
    if (chunk === 'timeout') continue
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
  }
  const frame = buffer.split('\n').find((line) => line.startsWith('data: ') && line.includes('选哪个方案'))
  assert.ok(frame, '还要有这条数据行')
  assert.deepEqual(JSON.parse(frame.slice('data: '.length)), { id: 'q1', agentId: 'sess-1', questions },
    '飞书那条路接上之后，手机页收到的这一帧必须逐字不变')
  await reader.cancel()
  miniControl.answerQuestion('q1', { answers: [] })
})

// ---------------------------------------------------------------------------
// 别处答掉了：手机页那张卡片要**自己收起来**，不能干挂着
//
// 现象（2026-10-02 真机）：飞书和手机页同时看着同一道题，他在飞书里回了序号，
// 手机上那张选择卡片留在原地一动不动——他不知道这道题已经有人答了。
// 语义一个没动（谁先答谁生效、后到的拿 expired），这里只是**把结果说出去**。
// ---------------------------------------------------------------------------

/**
 * 挂一个 SSE 监听。
 *
 * **`read(needle)` 等的是整帧出现**（needle 要自己带上收尾的空行），而且
 * `openStream` 会先等 `: connected` 那一声——它是「手机已经挂上来了」的确认。
 * 不等就往下走，下面那条动作可能在「还没有任何连接」的时候广播，帧没人收到，用例会假红。
 */
async function openStream(base, token) {
  const res = await fetch(`${base}/mini/api/stream?token=${token}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const read = async (needle, ms = 5000) => {
    const deadline = Date.now() + ms
    while (!buffer.includes(needle) && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 300)),
      ])
      if (chunk === 'timeout') continue
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
    }
    return buffer
  }
  // 初始那一帧是 `: connected\n\n`（注释帧），**带上收尾的空行再等**——只等
  // ": connected" 会在一分片就命中，后面什么都没读到就往下走了。
  await read(': connected\n\n')
  return { read, close: () => reader.cancel(), raw: () => buffer }
}

/** 从一段 SSE 原文里挑出指定事件的那条 data 行并解出来。 */
function frameOf(buffer, event) {
  const line = buffer.split('\n\n')
    .find((block) => block.includes(`event: ${event}\n`))
  if (!line) return null
  const data = line.split('\n').find((one) => one.startsWith('data: '))
  return data ? JSON.parse(data.slice('data: '.length)) : null
}

test('别处答掉了：手机页会收到一条 question-done，并知道是飞书答的', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  const pending = server.askPhone([{ id: 'q1', question: '选哪个方案？' }], 'sess-1', { onPending: () => {} })
  // 先把监听挂稳（openStream 会等它确认连上），再让飞书那边交回来。
  const stream = await openStream(base, token)
  // 飞书那边交回来的（第三个参数就是「谁答的」，见 answerQuestion）。
  assert.deepEqual(miniControl.answerQuestion('q1', { answers: [] }, 'feishu'), { ok: true })
  await pending

  const buffer = await stream.read('event: question-done')
  assert.ok(buffer.includes('event: question-done'), '要有这条状态帧，手机页才知道该把卡片收起来')
  assert.deepEqual(frameOf(buffer, 'question-done'), { id: 'q1', source: 'feishu' },
    '谁答的由插件如实说——手机页靠它写「已在飞书答过」，猜不得')
  await stream.close()
})

test('别处答掉了：审批也一样，而且同一道题只通知一次', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  const allow = miniControl.askApproval({ toolName: 'shell' }, 'sess-1', 'rm -rf build')
  const stream = await openStream(base, token)
  assert.deepEqual(miniControl.decideApproval('a1', { decision: 'allowed-once' }, 'feishu'), { ok: true })
  assert.equal(await allow, 'allowed-once')
  // 第二个来的人拿到 expired——老语义一个字没动，**而且不该再推一条状态**（不许重复打扰）。
  assert.deepEqual(miniControl.decideApproval('a1', { decision: 'rejected' }, 'feishu'), { ok: false, error: 'expired' })

  const buffer = await stream.read('event: approval-done')
  const times = buffer.split('event: approval-done').length - 1
  assert.equal(times, 1, '同一道题对同一侧只提示一次')
  assert.deepEqual(frameOf(buffer, 'approval-done'), { id: 'a1', source: 'feishu' })
  await stream.close()
})

test('手机自己答的：帧里说的是 phone，不是 feishu', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  const pending = server.askPhone([{ id: 'q1', question: '选哪个方案？' }], 'sess-1', { onPending: () => {} })
  const stream = await openStream(base, token)
  const res = await fetch(`${base}/mini/api/answer?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'q1', answers: [] }),
  })
  assert.equal(res.status, 200)
  await pending
  const buffer = await stream.read('event: question-done')
  assert.deepEqual(frameOf(buffer, 'question-done'), { id: 'q1', source: 'phone' },
    '手机自己答的要说 phone——不然手机页会对自己说「已在飞书答过」')
  await stream.close()
})

test('未带 token 打开页面时给的是填 token 的入口页，而不是内容页', async (t) => {
  const { server, base } = await startTestServer()
  t.after(() => server.close())

  const res = await fetch(`${base}/mini`)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(html.includes('var NEEDS_TOKEN = true;'), '匿名访问应进入 token 闸门')
  assert.ok(html.includes('需要访问令牌'))
})

test('用 ?token= 打开页面后种下 cookie，后续请求不再需要带 token', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  const res = await fetch(`${base}/mini?token=${token}`)
  assert.equal(res.status, 200)
  const setCookie = res.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /dsh_mini_token=/)
  assert.ok((await res.text()).includes('var NEEDS_TOKEN = false;'))

  const cookie = setCookie.split(';')[0]
  const state = await fetch(`${base}/mini/api/state`, { headers: { Cookie: cookie } })
  assert.equal(state.status, 200, 'cookie 应该能免掉后续的 token 参数')
})

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

test('latest 只保留最新一条，历史按上限截断', () => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
    maxHistory: 3,
  })
  store.pushReply({ text: '第一条', sessionId: 's1', reason: 'completed' })
  store.pushReply({ text: '第二条', sessionId: 's1', reason: 'completed' })
  assert.equal(store.latestOf('s1').text, '第二条', '单帧模式的数据源永远只有最新一条')
  assert.equal(store.historyOf('s1').length, 2)

  store.pushUser({ text: 'u1', sessionId: 's1' })
  store.pushUser({ text: 'u2', sessionId: 's1' })
  assert.equal(store.historyOf('s1').length, 3, '历史应该按 maxHistory 截断')
  assert.equal(store.historyOf('s1')[0].text, '第二条')
})

// ---------------------------------------------------------------------------
// 显示内容必须按会话分开（用户实机报过两次，同一个病根）
// ---------------------------------------------------------------------------

test('切到别的会话，看到的是那个会话的回复，不是上一个的', () => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  store.touchSession('a')
  store.touchSession('b')
  store.pushReply({ text: '甲的答案', sessionId: 'a', reason: 'completed' })

  store.bind('a')
  assert.equal(store.snapshot().latest.text, '甲的答案')

  // 用户报的现象：切到乙，单帧模式里还是甲的答案
  store.bind('b')
  assert.equal(store.snapshot().latest, null, '乙还没回复过，就该是空的')
  assert.ok(!JSON.stringify(store.snapshot()).includes('甲的答案'), '乙的视图里不该出现甲的内容')
})

test('乙回复过之后，切回甲仍然是甲自己那条', () => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  store.touchSession('a')
  store.touchSession('b')
  store.pushReply({ text: '甲的答案', sessionId: 'a', reason: 'completed' })
  store.pushReply({ text: '乙的答案', sessionId: 'b', reason: 'completed' })

  store.bind('a')
  assert.equal(store.snapshot().latest.text, '甲的答案')
  store.bind('b')
  assert.equal(store.snapshot().latest.text, '乙的答案')
})

test('聊天记录也按会话分开', () => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  store.touchSession('a')
  store.touchSession('b')
  store.pushUser({ text: '问甲', sessionId: 'a' })
  store.pushReply({ text: '答甲', sessionId: 'a', reason: 'completed' })
  store.pushUser({ text: '问乙', sessionId: 'b' })

  store.bind('a')
  assert.deepEqual(store.snapshot().history.map((m) => m.text), ['问甲', '答甲'])
  store.bind('b')
  assert.deepEqual(store.snapshot().history.map((m) => m.text), ['问乙'],
    '乙的记录里不能混进甲的消息')
})

test('没绑定任何会话时，latest 跟着最近活跃的那个会话', () => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  store.touchSession('a')
  store.pushReply({ text: '甲的答案', sessionId: 'a', reason: 'completed' })
  assert.equal(store.snapshot().latest.text, '甲的答案')
})

test('会话数据不会无限堆积，只留最近若干个', () => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
    maxSessions: 3,
  })
  for (let i = 0; i < 6; i++) {
    store.touchSession(`s${i}`)
    store.pushReply({ text: `第${i}条`, sessionId: `s${i}`, reason: 'completed' })
  }
  const kept = Object.keys(store.state.latestBySession)
  assert.equal(kept.length, 3, `只该留 3 个，实际留了 ${kept.length} 个`)
  assert.ok(kept.includes('s5') && kept.includes('s4'), '留下的必须是最新的那几个')
  assert.ok(!kept.includes('s0'), '最旧的应该被丢掉')
})

test('被丢掉数据的会话切过去是空的，不是别人的内容', () => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
    maxSessions: 1,
  })
  store.touchSession('old')
  store.pushReply({ text: '旧的答案', sessionId: 'old', reason: 'completed' })
  store.touchSession('new')
  store.pushReply({ text: '新的答案', sessionId: 'new', reason: 'completed' })

  store.bind('old')
  assert.equal(store.snapshot().latest, null, '宁可空着，也不能显示别的会话的内容')
})

test('旧格式的存档能按 sessionId 归位', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mini-'))
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify({
    latest: { text: '老格式的答案', sessionId: 'a', timestamp: 1 },
    history: [
      { role: 'assistant', text: '老格式的答案', sessionId: 'a', timestamp: 1 },
      { role: 'user', text: '老格式的提问', sessionId: 'a', timestamp: 2 },
    ],
    boundSessionId: 'a',
  }))
  const store = createStore({ file })
  assert.equal(store.latestOf('a').text, '老格式的答案')
  assert.equal(store.historyOf('a').length, 2)
})

test('前台在线时 isForeground 为真，超时后转假', () => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
    maxHistory: 10,
  })
  assert.equal(store.isForeground(), false, '一次心跳都没有时应视为不在线')
  store.markSeen('foreground')
  assert.equal(store.isForeground(), true)
  store.markSeen('background')
  assert.equal(store.isForeground(), false, '切到后台就不该再发页面内提醒')
})

// ---------------------------------------------------------------------------
// 「正在执行」必须跟着会话走
// ---------------------------------------------------------------------------

test('快照里的 running 说的是当前绑定那个会话', () => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  store.touchSession('a', { title: '甲' })
  store.touchSession('b', { title: '乙' })
  store.setRunning('a', true)

  store.bind('a')
  assert.equal(store.snapshot().running, true, '绑的是正在跑的那个')

  // 这就是用户报的现象：切到闲着的会话，手机上还显示「正在执行」
  store.bind('b')
  assert.equal(store.snapshot().running, false, '切到闲着的会话就不该再显示正在执行')
})

test('绑定的会话自己跑完时，快照跟着变', () => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  store.touchSession('a')
  store.bind('a')
  store.setRunning('a', true)
  assert.equal(store.snapshot().running, true)
  store.setRunning('a', false)
  assert.equal(store.snapshot().running, false)
})

test('没绑定时，running 跟着最近活跃的那个会话', () => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  store.touchSession('old')
  store.setRunning('old', true)
  assert.equal(store.snapshot().running, true)

  // 新会话活跃起来，默认目标就换成它了，而它是闲着的
  store.touchSession('new')
  assert.equal(store.snapshot().running, false, '目标会话换了，running 也要跟着换')
})

test('一个会话都没有时 running 是 false，不是 undefined', () => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  assert.equal(store.snapshot().running, false)
})

test('绑到一个从没听说过的会话时 running 是 false，不抛错', () => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  store.bind('查无此会话')
  assert.equal(store.snapshot().running, false)
})

test('同一毫秒里碰到两个会话，最近活跃的是后碰的那个', () => {
  // lastActivity 是毫秒，同毫秒会相等；而 Map 的迭代顺序是插入顺序，
  // 用时间戳比较的话先插入的会赢——「最近活跃」就判错了，手机可能串会话。
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  store.touchSession('先来的')
  store.touchSession('后来的')
  assert.equal(store.mostRecentSession().id, '后来的')

  store.touchSession('先来的')  // 再碰一次，它又变成最近的
  assert.equal(store.mostRecentSession().id, '先来的')
})

test('没有会话时 mostRecentSession 返回 null', () => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  assert.equal(store.mostRecentSession(), null)
})

// ---------------------------------------------------------------------------
// 构建指纹：确认应答我们的是不是这份代码
// ---------------------------------------------------------------------------

test('指纹接口报出传进来的那个值', async (t) => {
  const { server, base, token } = await startTestServer({ build: 'abc123def456' })
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/api/version?token=${token}`)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).build, 'abc123def456')
})

test('没传指纹时报 unknown，而不是 undefined', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/api/version?token=${token}`)
  assert.equal((await res.json()).build, 'unknown')
})

test('指纹接口顺带报出「这一刻能不能建会话」', async (t) => {
  // 这是新建会话那个功能的运行时证据：不用动手点，一条命令就能问。
  const { server, base, token } = await startTestServer({
    build: 'abc123def456',
    tree: { ...fakeNav(), canCreateSession: () => true },
  })
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/api/version?token=${token}`)
  const body = await res.json()
  assert.equal(body.build, 'abc123def456')
  assert.equal(body.canCreateSession, true)
})

test('没传 tree（headless）时如实报 false，不是缺字段', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())
  const body = await (await fetch(`${base}/mini/api/version?token=${token}`)).json()
  assert.equal(body.canCreateSession, false, '要有个明确的 false，界面才好判断')
})

test('探测本身抛错时回 false，不把指纹接口带崩', async (t) => {
  const { server, base, token } = await startTestServer({
    tree: {
      ...fakeNav(),
      canCreateSession: () => { throw new Error('服务半死') },
    },
  })
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/api/version?token=${token}`)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).canCreateSession, false)
})

test('指纹接口也要 token', async (t) => {
  const { server, base } = await startTestServer({ build: 'abc123def456' })
  t.after(() => server.close())
  const res = await fetch(`${base}/mini/api/version`)
  assert.equal(res.status, 401)
})

test('buildId 是 12 位十六进制，且同一份代码算出来一样', async () => {
  const { buildId } = await import('../lib/build.js')
  const a = buildId()
  const b = buildId()
  assert.match(a, /^[0-9a-f]{12}$/)
  assert.equal(a, b, '同一份代码两次算出来必须一致，否则没法用来比对')
})

test('切会话之后，接口报的 running 换成新会话的（用户报的那个 bug）', async (t) => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  store.touchSession('a', { title: '在跑的' })
  store.touchSession('b', { title: '闲着的' })
  store.setRunning('a', true)
  store.bind('a')

  const { server, base, token } = await startTestServer({ store })
  t.after(() => server.close())

  const before = await (await fetch(`${base}/mini/api/state?token=${token}`)).json()
  assert.equal(before.running, true, '绑的是在跑的那个')

  const res = await fetch(`${base}/mini/api/bind?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'b' }),
  })
  assert.equal(res.status, 200)

  const after = await (await fetch(`${base}/mini/api/state?token=${token}`)).json()
  assert.equal(after.boundSessionId, 'b')
  assert.equal(after.running, false, '切到闲着的会话，running 必须跟着变')
})

test('SSE 一连上就补的全量状态里带着正确的 running', async (t) => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  store.touchSession('a')
  store.setRunning('a', true)
  store.bind('a')

  const { server, base, token } = await startTestServer({ store })
  t.after(() => server.close())

  // 刷新页面时手机就是靠这一帧把状态补回来的，里面没有 running 的话，
  // 任务正在跑却会显示「已连接」。
  const res = await fetch(`${base}/mini/api/stream?token=${token}`)
  const reader = res.body.getReader()
  const { value } = await reader.read()
  const text = new TextDecoder().decode(value)
  const m = /event: state\ndata: (.+)\n/.exec(text)
  assert.ok(m, `第一帧就该是 state，实际拿到：${text.slice(0, 120)}`)
  assert.equal(JSON.parse(m[1]).running, true)
  await reader.cancel()
})

test('切换会话的接口把切换后的快照一起返回（手机不用干等 SSE）', async (t) => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  store.touchSession('a')
  store.touchSession('b')
  store.pushReply({ text: '甲的答案', sessionId: 'a', reason: 'completed' })
  store.bind('a')

  const { server, base, token } = await startTestServer({ store })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/bind?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'b' }),
  })
  const body = await res.json()
  assert.equal(body.boundSessionId, 'b')
  assert.ok(body.state, '响应里要带上快照')
  assert.equal(body.state.latest, null, '乙没回复过，快照里就该是空的')
  assert.ok(!JSON.stringify(body.state).includes('甲的答案'),
    '乙的快照里不能出现甲的内容')
})

test('/mini/api/latest 给的是当前会话的那一条', async (t) => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  store.touchSession('a')
  store.touchSession('b')
  store.pushReply({ text: '甲的答案', sessionId: 'a', reason: 'completed' })
  store.pushReply({ text: '乙的答案', sessionId: 'b', reason: 'completed' })
  store.bind('a')

  const { server, base, token } = await startTestServer({ store })
  t.after(() => server.close())

  const got = async () => (await fetch(`${base}/mini/api/latest?token=${token}`)).json()
  assert.equal((await got()).latest.text, '甲的答案')
  store.bind('b')
  assert.equal((await got()).latest.text, '乙的答案')
})

test('/mini/api/history 也按会话分开', async (t) => {
  const store = createStore({
    file: join(mkdtempSync(join(tmpdir(), 'dsh-mini-')), 'state.json'),
  })
  store.touchSession('a')
  store.touchSession('b')
  store.pushUser({ text: '问甲', sessionId: 'a' })
  store.pushUser({ text: '问乙', sessionId: 'b' })
  store.bind('b')

  const { server, base, token } = await startTestServer({ store })
  t.after(() => server.close())

  const body = await (await fetch(`${base}/mini/api/history?token=${token}`)).json()
  assert.deepEqual(body.history.map((m) => m.text), ['问乙'])
})

// ---------------------------------------------------------------------------
// 子智能体（2026-10-03）
//
// 这一层只钉**接口契约**：父会话 id 从哪儿来、失败用什么状态码、能力缺位怎么说话。
// 「这些调用能不能真的驱动 DSH」由 lib/index.js 那一段负责，那一层在真机上验。
// ---------------------------------------------------------------------------

/**
 * 一个只会吐子智能体的假 nav。每一次调用都记一笔，好断言**参数是从哪来的**。
 * 这几条用例的重点全在参数来源上——同一个功能，参数取错地方就是权限漏洞。
 */
function fakeSubagentNav(overrides = {}) {
  const calls = []
  return {
    calls,
    nav: {
      subagents: async (sessionId) => {
        calls.push(['list', sessionId])
        return overrides.list
          ? overrides.list(sessionId)
          : {
            ok: true,
            boundSessionId: sessionId,
            subagents: [
              {
                id: 'session-a1', parentId: sessionId, depth: 1, mode: 'continuable',
                label: '查重复依赖', running: true, tokens: 1234, durationMs: 65000,
                lastTurnCompleted: null,
              },
              {
                id: 'session-b2', parentId: sessionId, depth: 1, mode: 'one-shot',
                label: '', running: false, tokens: null, durationMs: null,
                lastTurnCompleted: true,
              },
            ],
          }
      },
      subagentTranscript: async (childId, sessionId) => {
        calls.push(['transcript', childId, sessionId])
        return overrides.transcript
          ? overrides.transcript(childId, sessionId)
          : {
            ok: true, mode: 'continuable', running: true, reclaimed: false,
            entries: [
              { role: 'user', text: '看看有没有重复依赖', timestamp: 1 },
              { role: 'assistant', text: '有两条重复，已经删掉一条。', timestamp: 2 },
            ],
            truncated: false, note: null,
          }
      },
      stopSubagent: async (childId, sessionId, mode) => {
        calls.push(['stop', childId, sessionId, mode])
        return overrides.stop
          ? overrides.stop(childId, sessionId, mode)
          : { ok: true }
      },
      askSubagent: async (childId, sessionId, mode, textContent) => {
        calls.push(['ask', childId, sessionId, mode, textContent])
        return overrides.ask
          ? overrides.ask(childId, sessionId, mode, textContent)
          : { ok: true, messageId: 'm-1' }
      },
    },
  }
}

test('子智能体清单取的是「手机绑着的那个会话」名下的，不是全局的', async (t) => {
  const store = tempStore()
  store.bind('session-parent')
  const { nav, calls } = fakeSubagentNav()
  const { server, base, token } = await startTestServer({ store, tree: nav })
  t.after(() => server.close())

  const body = await (await fetch(`${base}/mini/api/subagents?token=${token}`)).json()

  assert.equal(body.ok, true)
  assert.deepEqual(calls, [['list', 'session-parent']],
    '父会话 id 必须取自服务端绑定的那个——手机上遥控的是你正看着的会话')
  assert.deepEqual(body.subagents.map((s) => s.mode), ['continuable', 'one-shot'])
  assert.deepEqual(body.subagents.map((s) => s.running), [true, false])
  // 读不到的数就如实是 null，页面才写得出「—」。写成 0 会被读成「一次都没跑过」。
  assert.equal(body.subagents[1].tokens, null)
  assert.equal(body.subagents[1].durationMs, null)
})

test('子智能体清单在短时间内命中缓存，不重复读取 DSH', async (t) => {
  const store = tempStore()
  store.bind('session-parent')
  const { nav, calls } = fakeSubagentNav()
  const { server, base, token } = await startTestServer({ store, tree: nav })
  t.after(() => server.close())

  await fetch(`${base}/mini/api/subagents?token=${token}`)
  await fetch(`${base}/mini/api/subagents?token=${token}`)
  assert.deepEqual(calls, [['list', 'session-parent']], '短时间重复打开不应再次读取子智能体清单')
})

test('运行记录：也要按服务端绑定的会话去要，不能拿手机传的当凭据', async (t) => {
  const store = tempStore()
  store.bind('session-parent')
  const { nav, calls } = fakeSubagentNav()
  const { server, base, token } = await startTestServer({ store, tree: nav })
  t.after(() => server.close())

  const body = await (await fetch(
    `${base}/mini/api/subagent?id=${encodeURIComponent('session-a1')}&token=${token}`,
  )).json()

  assert.equal(body.ok, true)
  assert.deepEqual(calls, [['transcript', 'session-a1', 'session-parent']])
  assert.deepEqual(body.entries.map((e) => e.role), ['user', 'assistant'])
  assert.equal(body.mode, 'continuable')
})

test('读不到记录时如实说读不到，不是给一份空记录', async (t) => {
  // 「它没干过活」和「记录读不出来」是两件事，用户看到的话不该混成一句。
  const store = tempStore()
  store.bind('sp')
  const { server, base, token } = await startTestServer({
    store,
    tree: fakeSubagentNav({
      transcript: async () => ({ ok: false, error: '读不到它的记录：日志坏了' }),
    }).nav,
  })
  t.after(() => server.close())

  const body = await (await fetch(`${base}/mini/api/subagent?id=x&token=${token}`)).json()
  assert.equal(body.ok, false)
  assert.match(body.error, /读不到它的记录/)
})

test('停：父会话 id 由服务端自己填，请求体里塞什么都不认', async (t) => {
  // 权限凭据是「谁的父会话」。让手机自己填，就等于谁都能停掉别人的子智能体。
  const store = tempStore()
  store.bind('session-parent')
  const { nav, calls } = fakeSubagentNav()
  const { server, base, token } = await startTestServer({ store, tree: nav })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/subagent/stop?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'session-a1', mode: 'continuable', parentId: '别处的会话' }),
  })

  assert.equal(res.status, 200)
  assert.deepEqual(calls, [['stop', 'session-a1', 'session-parent', 'continuable']],
    '那个 parentId 必须被丢掉，用的是服务端绑定的会话')
})

test('停失败时把理由原样带回来，而且回 409 不是 500', async (t) => {
  // 409 是「你的请求没毛病，但这件事现在做不了」。用 500 会让页面当成故障去重试。
  const store = tempStore()
  store.bind('sp')
  const { server, base, token } = await startTestServer({
    store,
    tree: fakeSubagentNav({
      stop: async () => ({ ok: false, error: '这是一次性子智能体，跑完就结束，没有可停的轮次。' }),
    }).nav,
  })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/subagent/stop?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'x', mode: 'one-shot' }),
  })

  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /一次性子智能体/)
})

test('跟子智能体说话：话和模式原样传下去', async (t) => {
  const store = tempStore()
  store.bind('session-parent')
  const { nav, calls } = fakeSubagentNav()
  const { server, base, token } = await startTestServer({ store, tree: nav })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/subagent/ask?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'session-a1', mode: 'continuable', text: '  顺手把测试也补上  ' }),
  })

  assert.equal(res.status, 200)
  assert.deepEqual(calls, [['ask', 'session-a1', 'session-parent', 'continuable', '顺手把测试也补上']],
    '两端空白要去掉，中间那段要原样留着')
})

test('跟子智能体说话：空话在门口就挡掉，不递下去', async (t) => {
  const store = tempStore()
  store.bind('sp')
  const { nav, calls } = fakeSubagentNav()
  const { server, base, token } = await startTestServer({ store, tree: nav })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/subagent/ask?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'session-a1', mode: 'continuable', text: '   ' }),
  })

  assert.equal(res.status, 400)
  assert.deepEqual(calls, [])
})

test('子智能体那几条接口一律要 token', async (t) => {
  const store = tempStore()
  store.bind('sp')
  const { nav } = fakeSubagentNav()
  const { server, base } = await startTestServer({ store, tree: nav })
  t.after(() => server.close())

  const gets = ['/mini/api/subagents', '/mini/api/subagent?id=x']
  for (const path of gets) {
    assert.equal((await fetch(`${base}${path}`)).status, 401, `${path} 没挡住`)
  }
  for (const path of ['/mini/api/subagent/stop', '/mini/api/subagent/ask']) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'x', mode: 'continuable', text: '喂' }),
    })
    assert.equal(res.status, 401, `${path} 没挡住`)
  }
})

test('没传 tree 时子智能体接口如实说「没这个能力」，不是假装空清单', async (t) => {
  // 假装空清单会让人以为「这个会话真的没派过子智能体」——那是另一句话。
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  const body = await (await fetch(`${base}/mini/api/subagents?token=${token}`)).json()
  assert.equal(body.ok, false)
  assert.match(body.error, /没提供子智能体/)

  const res = await fetch(`${base}/mini/api/subagent/stop?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'x', mode: 'continuable' }),
  })
  assert.equal(res.status, 409, '能力缺位也是「做不了」，不是 500')
})

test('子智能体完工的通知进聊天记录，是第三种条目', async (t) => {
  // 它既不是用户说的话，也不是模型的回答，而是「这个会话派出去的一件事有结果了」。
  // 混进用户气泡就变成「我说过这句话」，混进回答又会被读成模型的话，两种都是假的。
  const store = tempStore()
  store.touchSession('s1')
  store.pushNotice({
    sessionId: 's1',
    text: 'Background subagent session-child finished.\n\nIts closing message:\n\n做完了',
    summary: 'Background subagent session-child finished.',
    senderSessionId: 'session-child',
    timestamp: 1234,
  })
  store.bind('s1')

  const { server, base, token } = await startTestServer({ store })
  t.after(() => server.close())

  const body = await (await fetch(`${base}/mini/api/history?token=${token}`)).json()
  assert.equal(body.history.length, 1)
  assert.equal(body.history[0].role, 'notice')
  assert.equal(body.history[0].senderSessionId, 'session-child')
  // 时间戳用事件自己的 `time`：硬盘重放出来那份用的是同一个钟，两边才合成得成一条。
  assert.equal(body.history[0].timestamp, 1234)
  // **通知不占「最新一条回复」那个位置**：单帧模式显示的是模型的回答。
  // 通知占了那儿，用户会以为模型说了这串英文。
  assert.equal(store.snapshot().latest, null)
})

// ---------------------------------------------------------------------------
// 会话条目的执行功能（2026-10-09）：重命名 / 置顶 / 归档 + 列表口径
// ---------------------------------------------------------------------------
//
// 这一块的口径全部照着 DSH 0.2.0-rc.2 里 PC 侧栏的原文来，所以测试里也把那几句
// 原文抄在断言旁边——将来谁要改这些数，得先回去看官方是不是也改了。

/**
 * 一个带"执行动作"的假树。
 *
 * 五个动作各记一笔到 `calls` 里，**不碰任何真东西**：这一层要验的是
 * 「服务端把请求翻译成了哪一次调用、又把官方的拒绝翻译成了什么」。
 */
function actionNav(options = {}) {
  const calls = []
  const sessions = options.sessions ?? [
    { id: 's-run', title: '在跑的那个', createdAt: 500, running: true },
    { id: 's-new', title: '比较新的', createdAt: 400, running: false },
    { id: 's-old', title: '比较旧的', createdAt: 100, running: false },
  ]
  return {
    calls,
    nav: {
      listWorkspaces: async () => [{ id: 'w1', title: '甲', count: sessions.length, running: 0 }],
      listSessionsOf: async () => ({
        workspaceId: 'w1', total: sessions.length, truncated: options.truncated === true, sessions,
      }),
      sessionFlags: () => options.flags ?? { ok: true, archived: [], pinned: [] },
      sessionSummaries: async () => options.summaries ?? { ok: true, byId: new Map() },
      pendingInteractions: () => options.pending ?? {},
      renameSession: async (id, title) => {
        calls.push(['rename', id, title])
        return options.renameResult ?? { ok: true, title: String(title).trim() }
      },
      pinSession: async (id) => {
        calls.push(['pin', id])
        return options.pinResult ?? { ok: true, archived: [], pinned: [id] }
      },
      unpinSession: async (id) => {
        calls.push(['unpin', id])
        return options.pinResult ?? { ok: true, archived: [], pinned: [] }
      },
      archiveSession: async (id, stop) => {
        calls.push(['archive', id, stop === true])
        return options.archiveResult ?? { ok: true, archived: [id], pinned: [] }
      },
      unarchiveSession: async (id) => {
        calls.push(['unarchive', id])
        return options.archiveResult ?? { ok: true, archived: [], pinned: [] }
      },
    },
  }
}

async function post(base, path, token, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

test('列表口径：已归档默认不列，带 archived=1 才列出来（并带上标记）', async (t) => {
  // 官方默认项就是「隐藏已归档」。改前手机把归档的当普通会话列出来了——
  // 用户看的是一份"少了/多了几条都说不清"的列表。
  const { nav } = actionNav({
    flags: { ok: true, archived: ['s-old'], pinned: [] },
  })
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const hidden = await (await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}`)).json()
  assert.deepEqual(hidden.sessions.map((s) => s.id), ['s-run', 's-new'], '默认不该有已归档那条')
  assert.equal(hidden.hiddenArchived, 1, '要如实说筛掉了 1 条已归档')

  const shown = await (await fetch(
    `${base}/mini/api/workspaces/w1/sessions?token=${token}&archived=1`,
  )).json()
  assert.deepEqual(shown.sessions.map((s) => s.id), ['s-run', 's-new', 's-old'])
  assert.equal(shown.sessions.find((s) => s.id === 's-old').archived, true, '列出来了就要标出来')
  assert.equal(shown.hiddenArchived, 0)
})

test('列表口径：空白会话不列，当前绑定的那一个例外', async (t) => {
  // 官方原话：「当前选中的空白**新会话**在首条提示词落地前也作为额外行」。
  // 少了这句例外，用户刚在手机上建的那个会话会当场消失。
  const blank = new Map([['s-new', { sessionId: 's-new', blank: true }]])
  const { nav } = actionNav({ summaries: { ok: true, byId: blank } })
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const bound = await (await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}`)).json()
  assert.deepEqual(bound.sessions.map((s) => s.id), ['s-run', 's-old'], '空白那条不列')
  assert.equal(bound.hiddenBlank, 1)
  assert.equal(bound.blankKnown, true)

  const store = tempStore()
  store.bind('s-new')
  const other = await startTestServer({ store, tree: nav })
  t.after(() => other.server.close())
  const mine = await (await fetch(
    `${other.base}/mini/api/workspaces/w1/sessions?token=${other.token}`,
  )).json()
  assert.deepEqual(mine.sessions.map((s) => s.id), ['s-run', 's-new', 's-old'],
    '当前绑定的那条空白会话要留着——哪怕它排在后面')
})

test('列表口径：空白判据拿不到时一条都不隐藏（不拿猜测当事实）', async (t) => {
  // 「标题为空」不等于「空白会话」：一条只是标题没读出来的老会话会被当成空白当场消失。
  // 拿不到官方的 blank 就退回原来的行为，并且如实说不知道。
  const { nav } = actionNav({ summaries: { ok: false, byId: new Map() } })
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const body = await (await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}`)).json()
  assert.equal(body.sessions.length, 3, '一条都不该被隐藏')
  assert.equal(body.hiddenBlank, 0)
  assert.equal(body.blankKnown, false, '要如实说这条判据没拿到')
})

test('列表口径：打开「显示已归档」时，已归档的**空白**会话也要列出来', async (t) => {
  // 这条是实测逼出来的：本机 3 条已归档里有 1 条没有标题。要是空白那条判据也压在
  // 已归档行上，那个开关就等于白按——而归档提示里那句「之后可以在『显示已归档』里
  // 把它找回来」会变成假话。
  const blank = new Map([['s-old', { sessionId: 's-old', blank: true }]])
  const { nav } = actionNav({
    summaries: { ok: true, byId: blank },
    flags: { ok: true, archived: ['s-old'], pinned: [] },
  })
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}&archived=1`)
  const body = await res.json()
  assert.deepEqual(body.sessions.map((s) => s.id), ['s-run', 's-new', 's-old'],
    '已归档的那条哪怕没有标题也要列出来')
  assert.equal(body.sessions.find((s) => s.id === 's-old').archived, true)
  assert.equal(body.hiddenBlank, 0, '它不是被空白那条判据藏起来的')
})

test('列表口径：置顶排在最前，且按官方的置顶顺序（最近置顶的在前）', async (t) => {  // 官方置顶集合的返回顺序就是「most recently pinned first」，界面照它排。
  // 自己按创建时间重排，会把用户刚置顶的那一条排到第二位——那是明的错的。
  const { nav } = actionNav({ flags: { ok: true, archived: [], pinned: ['s-old', 's-run'] } })
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const body = await (await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}`)).json()
  assert.deepEqual(body.sessions.map((s) => s.id), ['s-old', 's-run', 's-new'])
  assert.deepEqual(body.sessions.filter((s) => s.pinned).map((s) => s.id), ['s-old', 's-run'])
})

test('列表口径：谁在等人也要带出去（三类各自一样）', async (t) => {
  const { nav } = actionNav({
    pending: { 's-run': 'approval', 's-new': 'plan', 's-old': 'question' },
  })
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const body = await (await fetch(`${base}/mini/api/workspaces/w1/sessions?token=${token}`)).json()
  const byId = Object.fromEntries(body.sessions.map((s) => [s.id, s.pending]))
  assert.deepEqual(byId, { 's-run': 'approval', 's-new': 'plan', 's-old': 'question' })
})

test('重命名：标题原样递下去，服务端接受的那一份带回来', async (t) => {
  const { nav, calls } = actionNav({ renameResult: { ok: true, title: '改过的名字' } })
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await post(base, '/mini/api/session/rename?token=' + token, token,
    { sessionId: 's-new', title: '  改过的名字  ' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.title, '改过的名字', '界面要显示官方接受的那一份')
  assert.deepEqual(calls, [['rename', 's-new', '  改过的名字  ']],
    '两端空白由官方那一层归一化，我们不在半路替它 trim')
})

test('重命名：空标题在服务端就挡掉，不递下去', async (t) => {
  const { nav, calls } = actionNav()
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await post(base, '/mini/api/session/rename?token=' + token, token,
    { sessionId: 's-new', title: '   ' })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).reason, 'blank')
  assert.deepEqual(calls, [], '空标题不该走到官方那一层（那边会抛，还白跑一趟）')
})

test('重命名：拿不到能力时如实说没这个能力（503），不是 500', async (t) => {
  const { nav } = actionNav({ renameResult: { ok: false, reason: 'no-service' } })
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await post(base, '/mini/api/session/rename?token=' + token, token,
    { sessionId: 's', title: '名字' })
  assert.equal(res.status, 503)
  assert.match((await res.json()).error, /没提供改标题的能力/)
})

test('置顶 / 取消置顶：走对那一个方法，并把新的集合带回来', async (t) => {
  const { nav, calls } = actionNav()
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const on = await post(base, '/mini/api/session/pin?token=' + token, token,
    { sessionId: 's-new', pinned: true })
  assert.deepEqual((await on.json()).pinnedSessionIds, ['s-new'])

  const off = await post(base, '/mini/api/session/pin?token=' + token, token,
    { sessionId: 's-new', pinned: false })
  assert.deepEqual((await off.json()).pinnedSessionIds, [])

  assert.deepEqual(calls, [['pin', 's-new'], ['unpin', 's-new']])
})

test('置顶：已归档的会被官方拒，翻译成一句人话（409）', async (t) => {
  const { nav } = actionNav({ pinResult: { ok: false, reason: 'archived' } })
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await post(base, '/mini/api/session/pin?token=' + token, token,
    { sessionId: 's-new', pinned: true })
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /已归档的会话不能置顶/)
})

test('归档：还有工作在跑时拒一次，但把「会停掉什么」原样带回来', async (t) => {
  // 官方原话：「Host 拒绝普通归档并列出这些工作，侧栏随即打开『停止并归档』对话框」。
  // 所以这一条**不是错误**，是两段式流程的第一段——必须把 activity 交上去。
  const { nav, calls } = actionNav({
    archiveResult: {
      ok: false,
      reason: 'active',
      activity: [
        { kind: 'turn', count: 1, items: [{ id: 't1', label: '正在写手机页' }] },
        { kind: 'subagent', count: 1, items: [{ id: 'a1', label: '' }] },
      ],
    },
  })
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await post(base, '/mini/api/session/archive?token=' + token, token,
    { sessionId: 's-run' })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.reason, 'active')
  assert.equal(body.activity.length, 2)
  assert.equal(body.activity[0].kind, 'turn')
  assert.equal(body.activity[0].items[0].label, '正在写手机页')
  assert.deepEqual(calls, [['archive', 's-run', false]],
    '第一段不带 stopActivity——不能因为"可能被拒"就先斩后奏')
})

test('归档：确认之后带 stopActivity 再来一次', async (t) => {
  const { nav, calls } = actionNav()
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await post(base, '/mini/api/session/archive?token=' + token, token,
    { sessionId: 's-run', stop: true })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.archived, true)
  assert.equal(body.stopped, true)
  assert.deepEqual(body.archivedSessionIds, ['s-run'])
  assert.deepEqual(calls, [['archive', 's-run', true]])
})

test('取消归档：把新的归档集合带回来', async (t) => {
  const { nav, calls } = actionNav({ archiveResult: { ok: true, archived: [], pinned: [] } })
  const { server, base, token } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  const res = await post(base, '/mini/api/session/unarchive?token=' + token, token,
    { sessionId: 's-old' })
  assert.equal(res.status, 200)
  assert.deepEqual((await res.json()).archivedSessionIds, [])
  assert.deepEqual(calls, [['unarchive', 's-old']])
})

test('会话执行那几条接口一律要 token', async (t) => {
  const { nav } = actionNav()
  const { server, base } = await startTestServer({ tree: nav })
  t.after(() => server.close())

  for (const path of [
    '/mini/api/session/rename', '/mini/api/session/pin',
    '/mini/api/session/archive', '/mini/api/session/unarchive',
  ]) {
    const res = await post(base, path, 'x', { sessionId: 's' })
    assert.equal(res.status, 401, `${path} 没挡住`)
  }
})

test('没传 tree 时执行类接口如实说「没这个能力」，不是假装成功', async (t) => {
  const { server, base, token } = await startTestServer()
  t.after(() => server.close())

  const rename = await post(base, '/mini/api/session/rename?token=' + token, token,
    { sessionId: 's', title: '名字' })
  assert.equal(rename.status, 503)
  assert.match((await rename.json()).error, /没提供改标题的能力/)

  const arc = await post(base, '/mini/api/session/archive?token=' + token, token,
    { sessionId: 's' })
  assert.equal(arc.status, 503)
  assert.match((await arc.json()).error, /没提供工作区服务/)
})
