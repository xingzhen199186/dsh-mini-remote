/**
 * 冒烟测试：不依赖正在运行的 DSH，直接验证三块最容易出错的逻辑——
 * 事件提取、HTTP/SSE 服务、页面渲染。
 *
 * 跑法：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { createTurnTracker } from '../lib/events.js'
import { createStore } from '../lib/store.js'
import { createMiniServer } from '../lib/server.js'
import { renderPage, readArt } from '../lib/page.js'
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
  assert.deepEqual(human, { kind: 'user', text: '帮我把 README 更新一下', id: 'm-1' })
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

// ---------------------------------------------------------------------------
// 鲸鱼娘立绘（lib/art/）
// ---------------------------------------------------------------------------

const POSES = [
  'work-1-ready', 'work-2-reading', 'work-3-typing', 'work-4-checking',
  'work-5-thinking', 'work-6-running', 'work-7-waiting',
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

test('七个姿态的立绘一个都不能少', async (t) => {
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

function fakeNav() {
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
