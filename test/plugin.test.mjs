/**
 * 集成测试：用假的 ctx 把插件真跑起来，走真实的 HTTP 端口。
 *
 * 这一层测的是「apply() 到底能不能正常加载并工作」——包括事件订阅接对了没有、
 * 指令有没有真的交到 agent.followup()、token 有没有落盘。
 * 不需要正在运行的 DSH。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

// 动态 import 要的是 file:// URL，不是 Windows 路径，所以这里全程保留 URL 形态。
const ROOT_URL = new URL('..', import.meta.url)

/** 先占一个端口拿到号再放掉，用来给被测插件一个确定的监听地址。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/**
 * 造一个「像真 cordis 一样挑剔」的假 ctx。
 *
 * 真机上只有写进插件 inject 的服务名才能当属性直接读，别的服务名一读就抛
 * `cannot get property "x" without inject`（不是给 undefined）。可选或晚到的服务
 * 只能走 ctx.inject(names, cb)（等它就绪）或 ctx.get(name)（拿不到就算了）。这里
 * 照抄这条纪律，好让「写 ctx.webServer」这类在真机必崩的代码在测试里就先挂掉
 * ——它曾经真的从测试底下溜过去了。
 */
function makeCtx(services, directNames) {
  return new Proxy(services, {
    get: (target, prop, receiver) => {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      if (prop === 'get') return (name) => target[name]
      // 假 inject：服务本来就在，直接同步回调（真机上服务缺席时回调压根不跑）
      if (prop === 'inject') {
        return (names, callback) => callback(makeCtx(target, [...directNames, ...names]))
      }
      if (directNames.includes(prop)) return Reflect.get(target, prop, receiver)
      if (prop in target) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

function mockCtx({ attachments } = {}) {
  const handlers = new Map()
  const agents = new Map()
  // 插件会注册不止一个 effect（服务、配对路由各一个），全部收集起来——
  // 只记最后一个会导致服务关不掉、测试进程永远不退出。
  const disposers = []
  const routes = new Map()
  return {
    handlers,
    agents,
    routes,
    stop: () => {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* 清理失败不该盖住真正的测试结果 */ }
      }
    },
    ctx: makeCtx({
      agents: {
        get: (id) => agents.get(id),
        list: () => [...agents.values()],
      },
      webServer: {
        register: (route) => {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
      on: (name, fn) => {
        handlers.set(name, fn)
        return () => handlers.delete(name)
      },
      effect: (fn) => {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
        return () => dispose?.()
      },
      logger: { info: () => {}, warn: () => {} },
      // 只有传了才有：纯 headless 组合下 DSH 没有附件服务，
      // 「没有它的时候怎么办」也是一条要覆盖的路径。
      ...(attachments ? { attachments } : {}),
    }, ['agents', 'logger', 'on', 'effect']),
  }
}

/** 起一个被测插件实例，返回访问它所需的一切。 */
async function bootPlugin({ agents = {}, config = {}, attachments = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mini-home-'))
  process.env.DSH_HOME = home

  const port = await freePort()
  const mock = mockCtx({ attachments })
  const { ctx, handlers, agents: agentMap } = mock
  for (const [id, agent] of Object.entries(agents)) agentMap.set(id, agent)

  // 每次重新 import，避免模块级缓存串味
  const mod = await import(new URL(`lib/index.js?t=${Date.now()}`, ROOT_URL).href)
  mod.apply(ctx, { port, bindAddress: '127.0.0.1', ...config })

  const base = `http://127.0.0.1:${port}`
  const token = readFileSync(join(home, 'dsh-mini-remote', 'token'), 'utf8').trim()

  // 等服务真的起来
  for (let i = 0; i < 100; i += 1) {
    try {
      await fetch(`${base}/mini/api/state?token=${token}`)
      break
    } catch {
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  return {
    home, base, token, handlers, agents: agentMap, ctx, routes: mock.routes,
    stop: () => mock.stop(),
  }
}

const ev = (type, data) => ({ type, seq: 0, time: Date.now(), data })
const text = (t) => [{ type: 'text', text: t }]

test('apply() 能正常加载，并生成 settings.json 与 token', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)

  const dir = join(p.home, 'dsh-mini-remote')
  assert.ok(existsSync(join(dir, 'settings.json')), '首次启动要落一份默认配置出来')
  assert.ok(existsSync(join(dir, 'token')), 'token 要落盘')
  assert.equal(p.token.length, 32, 'token 应为 32 位 hex')
  assert.match(p.token, /^[0-9a-f]{32}$/)

  const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  assert.equal(settings.bindAddress, '127.0.0.1', '默认只绑回环')
  assert.equal(settings.defaultMode, 'minimal', '默认单帧模式')
  assert.equal(settings.notify.channel, 'none')
})

test('订阅到了 session/event 与 agent/status', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)
  assert.ok(p.handlers.has('session/event'), '必须订阅会话事件流')
  assert.ok(p.handlers.has('agent/status'), '必须订阅 agent 状态变化')
})

test('一轮任务跑完，最终回复出现在 /mini/api/latest', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)

  const feed = p.handlers.get('session/event')
  const session = { id: 'sess-1', header: { id: 'sess-1' } }

  feed(session, ev('user/message', { source: { kind: 'user' }, content: text('帮我看下 README') }))
  feed(session, ev('turn/start', { turn: 1 }))
  feed(session, ev('assistant/message', {
    turn: 1, step: 1,
    message: { content: [...text('我先读一下文件。'), { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
  }))
  feed(session, ev('assistant/message', {
    turn: 1, step: 2, message: { content: text('README 的安装部分已更新为 Node 22+。') },
  }))
  feed(session, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))

  const state = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  assert.equal(state.latest.text, 'README 的安装部分已更新为 Node 22+。')
  assert.equal(state.latest.reason, 'completed')
  // 中间过程一个字都不该进 latest
  assert.ok(!state.latest.text.includes('tool-call'))
  assert.ok(!state.latest.text.includes('我先读一下文件'))
})

test('被按停的那一轮：半句话留着，但带着 interrupted 标记', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)

  const feed = p.handlers.get('session/event')
  const session = { id: 'sess-cut', header: { id: 'sess-cut' } }

  feed(session, ev('turn/start', { turn: 1 }))
  // 中止时 DSH 会把「已经吐出来的那一段」作为 assistant/message 落下来，带
  // interrupted: true，而且**没派发的工具调用不在里面**——所以它一个 tool-call
  // 块都没有，isIntermediateStep 会放它过去。这正是要靠标记单独认出来的原因。
  feed(session, ev('assistant/message', {
    turn: 1, step: 1, interrupted: true, message: { content: text('先说结论：这个方案') },
  }))
  feed(session, ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }))

  const state = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  assert.equal(state.latest.text, '先说结论：这个方案', '已经吐出来的内容不该替用户丢掉')
  assert.equal(state.latest.interrupted, true, '必须带上标记，手机才知道这是半句话')
  assert.equal(state.latest.reason, 'aborted')
  // 聊天模式走的是 history，两边都得带上，不然换个模式标记就没了
  assert.equal(state.history.at(-1).interrupted, true, 'history 里那条也要带标记')
})

test('正常跑完的一轮不带 interrupted 标记', async (t) => {
  // 反过来的那一半：标记不能滥发，否则每条回答都挂着「已停止」。
  const p = await bootPlugin()
  t.after(p.stop)

  const feed = p.handlers.get('session/event')
  const session = { id: 'sess-ok', header: { id: 'sess-ok' } }

  feed(session, ev('turn/start', { turn: 1 }))
  feed(session, ev('assistant/message', {
    turn: 1, step: 1, message: { content: text('完整的回答。') },
  }))
  feed(session, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))

  const state = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  assert.equal(state.latest.interrupted, false)
  assert.equal(state.history.at(-1).interrupted, false)
})

test('子 agent 的会话不会污染手机', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)

  const feed = p.handlers.get('session/event')
  feed({ id: 'sub-1', header: { id: 'sub-1', origin: 'subagent' } }, ev('turn/start', { turn: 1 }))
  feed({ id: 'sub-1', header: { id: 'sub-1', origin: 'subagent' } }, ev('assistant/message', {
    turn: 1, step: 1, message: { content: text('子 agent 的中间结论') },
  }))
  feed({ id: 'sub-1', header: { id: 'sub-1', origin: 'subagent' } }, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))

  const state = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  assert.equal(state.latest, null, '子 agent 的输出不该冒到手机上')
})

test('手机发指令 → 真的调用 agent.followup()，消息结构正确', async (t) => {
  const calls = []
  const agent = {
    status: 'idle',
    session: { id: 'sess-9', header: { id: 'sess-9' } },
    followup: (msg) => calls.push(msg),
  }
  const p = await bootPlugin({ agents: { 'sess-9': agent } })
  t.after(p.stop)

  // 先让插件知道这个会话存在
  p.handlers.get('session/event')(agent.session, ev('turn/start', { turn: 1 }))

  const res = await fetch(`${p.base}/mini/api/send?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '把测试跑一遍' }),
  })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)

  assert.equal(calls.length, 1, '应该正好注入一条消息')
  const msg = calls[0]
  assert.equal(msg.role, 'user')
  assert.deepEqual(msg.content, [{ type: 'text', text: '把测试跑一遍' }])
  assert.deepEqual(msg.source, { kind: 'user' })
  assert.equal(typeof msg.id, 'string')
  assert.ok(msg.id.length > 0, '消息必须有 id')
  assert.ok(Object.isFrozen(msg), '消息应冻结，和 createUserMessage 的语义一致')
})

test('手机传上来的文件 → 消息里带一个附件块，引用原样来自附件服务', async (t) => {
  const calls = []
  const agent = {
    status: 'idle',
    session: { id: 'sess-up', header: { id: 'sess-up' } },
    followup: (m) => calls.push(m),
  }
  const saved = []
  const attachments = {
    saveFileStream: async ({ data, name }) => {
      let n = 0
      for await (const c of data) n += c.length
      const ref = { attachmentId: `sha256:${'b'.repeat(64)}`, name: name || 'x', bytes: n }
      saved.push(ref)
      return ref
    },
  }
  const p = await bootPlugin({ agents: { 'sess-up': agent }, attachments })
  t.after(p.stop)
  p.handlers.get('session/event')(agent.session, ev('turn/start', { turn: 1 }))

  const up = await fetch(`${p.base}/mini/api/upload?name=笔记.txt&size=5&token=${p.token}`, {
    method: 'POST',
    body: Buffer.from('hello'),
  })
  assert.equal(up.status, 200)
  const { uploadId } = await up.json()
  assert.ok(uploadId, '要回一张小票')
  assert.equal(saved.length, 1, '字节要真的交给附件服务')

  const res = await fetch(`${p.base}/mini/api/send?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '看一下', uploadIds: [uploadId] }),
  })
  assert.equal(res.status, 200)

  assert.equal(calls.length, 1)
  const msg = calls[0]
  assert.equal(msg.content.length, 2, '一段文字 + 一个附件')
  assert.deepEqual(msg.content[0], { type: 'text', text: '看一下' })
  assert.equal(msg.content[1].type, 'file')
  assert.deepEqual(msg.content[1].attachment, saved[0],
    '引用要原样来自附件服务——自己拼一个会在 DSH 的引用校验上失败')
  assert.ok(Object.isFrozen(msg), '带了附件也照样要冻结')
})

test('小票只能用一次，同一条不能发两遍', async (t) => {
  // 用掉就作废。不然一条指令可以被重放，而它指向的是电脑上真实存在的附件。
  const calls = []
  const agent = {
    status: 'idle',
    session: { id: 'sess-once', header: { id: 'sess-once' } },
    followup: (m) => calls.push(m),
  }
  const attachments = {
    saveFileStream: async () => ({ attachmentId: `sha256:${'c'.repeat(64)}`, name: 'a.txt', bytes: 1 }),
  }
  const p = await bootPlugin({ agents: { 'sess-once': agent }, attachments })
  t.after(p.stop)
  p.handlers.get('session/event')(agent.session, ev('turn/start', { turn: 1 }))

  const up = await fetch(`${p.base}/mini/api/upload?name=a.txt&token=${p.token}`, {
    method: 'POST',
    body: Buffer.from('x'),
  })
  const { uploadId } = await up.json()

  const send = (text) => fetch(`${p.base}/mini/api/send?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, uploadIds: [uploadId] }),
  })
  await send('第一次')
  await send('第二次')

  assert.equal(calls.length, 2)
  assert.equal(calls[0].content.length, 2, '第一次该带上附件')
  assert.equal(calls[1].content.length, 1, '第二次那张小票已经作废，只剩文字')
})

test('认不出来的小票直接丢掉，不猜', async (t) => {
  // 客户端能报什么，得由服务端说了算。否则改一个字符串就能让模型去读电脑上
  // 任意一个已有附件——那是把「线端调用者绝不能引用它没上传过的附件」这条
  // 安全前提整个拆掉。
  const calls = []
  const agent = {
    status: 'idle',
    session: { id: 'sess-fake', header: { id: 'sess-fake' } },
    followup: (m) => calls.push(m),
  }
  const attachments = { saveFileStream: async () => ({ attachmentId: 'sha256:x', name: 'x', bytes: 0 }) }
  const p = await bootPlugin({ agents: { 'sess-fake': agent }, attachments })
  t.after(p.stop)
  p.handlers.get('session/event')(agent.session, ev('turn/start', { turn: 1 }))

  const res = await fetch(`${p.base}/mini/api/send?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '看看这个', uploadIds: ['瞎编的小票', '../../etc/passwd'] }),
  })
  assert.equal(res.status, 200)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].content, [{ type: 'text', text: '看看这个' }],
    '认不出来的小票要当没传过，绝不能变成附件')
})

test('只传文件不写字：消息里只有附件块', async (t) => {
  const calls = []
  const agent = {
    status: 'idle',
    session: { id: 'sess-only', header: { id: 'sess-only' } },
    followup: (m) => calls.push(m),
  }
  const attachments = {
    saveFileStream: async () => ({ attachmentId: `sha256:${'d'.repeat(64)}`, name: '图.png', bytes: 9 }),
  }
  const p = await bootPlugin({ agents: { 'sess-only': agent }, attachments })
  t.after(p.stop)
  p.handlers.get('session/event')(agent.session, ev('turn/start', { turn: 1 }))

  const up = await fetch(`${p.base}/mini/api/upload?name=图.png&token=${p.token}`, {
    method: 'POST',
    body: Buffer.from('123456789'),
  })
  const { uploadId } = await up.json()

  await fetch(`${p.base}/mini/api/send?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '', uploadIds: [uploadId] }),
  })

  assert.equal(calls[0].content.length, 1)
  assert.equal(calls[0].content[0].type, 'file', '没写字就不该塞一个空的文字块进去')

  // 手机上回显的那条要看得见文件——不然气泡是空的，用户以为没发出去。
  const hist = await (await fetch(`${p.base}/mini/api/history?token=${p.token}`)).json()
  const mine = hist.history.filter((m) => m.role === 'user')
  assert.equal(mine.length, 1)
  assert.match(mine[0].text, /图\.png/, '回显里要有文件名')
})

// ---------------------------------------------------------------------------
// 回答流式生成
// ---------------------------------------------------------------------------

/** 读一次快照。流式那几条要反复读，单独拎出来。 */
async function snapOf(p) {
  return (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
}

/** 起一个会话、把它变成手机当前遥控的那个，返回流式事件的入口。 */
async function bootStreaming(t) {
  const agent = {
    status: 'running',
    session: { id: 'sess-stream', header: { id: 'sess-stream' } },
    followup: () => {},
  }
  const p = await bootPlugin({ agents: { 'sess-stream': agent } })
  t.after(p.stop)
  // 用 session/title 登记会话。**不能用 turn/start**——那条事件在 tracker 里没有
  // 对应动作，处理器会直接 return，会话压根不会进 store，于是快照算的是「没有当前
  // 会话」，live 永远是空的。（第一版就是这么写的，挂了三条才查出来。）
  p.handlers.get('session/event')(agent.session, ev('session/title', { title: '测试会话' }))
  const stream = p.handlers.get('agent/assistant-stream')
  assert.ok(stream, '插件要订阅 DSH 的增量事件——那是唯一能拿到流式文本的地方')
  return {
    p,
    agent,
    stream,
    start: () => stream({ agent, frame: { type: 'start' } }),
    delta: (text) => stream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text } } }),
    toolCall: () => stream({ agent, frame: { type: 'chunk', chunk: { type: 'tool-call-delta' } } }),
    end: () => stream({ agent, frame: { type: 'end' } }),
  }
}

test('流式关着：中途一个字都不往手机上推，连超长旁白也不推', async (t) => {
  // 用户 2026-09-22 的裁决：「流式的效果不好，先不做流式了吧，改回一次性把最终回答
  // 抛出来，过程中的自言自语、执行语句就不要在手机端出现了。」
  //
  // 这条测试盯的就是那个「一个字都不推」。**故意拿一段超长的文字来试**——
  // 长度门槛（STREAM_MIN_CHARS = 40）本来就会放它过去，所以它曾经是最容易漏出来的
  // 那种。现在入口整个关掉，门槛高低不再有意义：多长都不该露。
  //
  // 原来这里有六条测试（短旁白不露、够长才露、跨线即露、工具调用撤回、收工清干净、
  // 子 Agent 不推），测的是那条路上的细节。路关掉之后它们必然全红——测的是一段
  // 不再执行的代码。它们的结论没有丢：那条路上的每一个坑都写在 index.js 里
  // STREAMING_ENABLED 和 revealLive 的注释里，要重新打开时照着读。
  const s = await bootStreaming(t)

  s.start()
  s.delta('我先把测试跑一遍，' + '然后检查一下输出是不是符合预期。'.repeat(12))
  await new Promise((r) => setTimeout(r, 1400))
  assert.equal((await snapOf(s.p)).live, '', '超长的一段也不许露——入口整个关着')

  s.delta('这是继续往下写的正文。'.repeat(20))
  await new Promise((r) => setTimeout(r, 1400))
  assert.equal((await snapOf(s.p)).live, '', '写多久都一样，中途什么都不推')

  s.toolCall()
  s.end()
  assert.equal((await snapOf(s.p)).live, '', '收工也不留半句话')

  // 子 Agent 的流本来就不该过来，现在连主 Agent 的也不过来了。
  const sub = { session: { id: 'sess-sub', header: { id: 'sess-sub', origin: 'subagent' } } }
  s.stream({ agent: sub, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '子 Agent 在干活' } } })
  assert.equal((await snapOf(s.p)).live, '', '子 Agent 的流更不该过来')
})

test('手机发出去的指令只记一笔（注入后事件流还会回来一趟）', async (t) => {
  // 用户实机报的：「聊天模式下，发送指令会显示两次」。
  // 两条路都记：onInstruction 记一次，事件流把注入的消息当成用户消息又记一次。
  // 桩让 followup 立刻把 user/message 喂回来。真机上这一步是异步的
  // （dsh-agent-loop 的 wakeDriver 是 Promise 起的），但**时序不影响这条测试**：
  // 重复的来源是「两条路都记」，不是「谁先谁后」。桩把消息的 id 原样带回去，
  // 这一点和真机一致——send() 是把消息对象直接放进 inbox 的，不换 id。
  const calls = []
  const agent = {
    status: 'idle',
    session: { id: 'sess-dup', header: { id: 'sess-dup' } },
    followup: (msg) => {
      calls.push(msg)
      p.handlers.get('session/event')(agent.session, ev('user/message', {
        id: msg.id,
        source: { kind: 'user' },
        content: msg.content,
      }))
    },
  }
  const p = await bootPlugin({ agents: { 'sess-dup': agent } })
  t.after(p.stop)

  p.handlers.get('session/event')(agent.session, ev('turn/start', { turn: 1 }))
  const res = await fetch(`${p.base}/mini/api/send?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '看看日志' }),
  })
  assert.equal((await res.json()).ok, true)
  assert.equal(calls.length, 1)

  const state = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  const mine = state.history.filter((m) => m.role === 'user')
  assert.equal(mine.length, 1, `只该记一笔，实际记了 ${mine.length} 笔`)
  assert.equal(mine[0].text, '看看日志')
})

test('电脑上自己敲的指令照样记一笔（去重不能把这功能一起删掉）', async (t) => {
  const agent = {
    status: 'idle',
    session: { id: 'sess-desk', header: { id: 'sess-desk' } },
    followup: () => {},
  }
  const p = await bootPlugin({ agents: { 'sess-desk': agent } })
  t.after(p.stop)

  p.handlers.get('session/event')(agent.session, ev('turn/start', { turn: 1 }))
  // 电脑上敲的，不是我们注入的，id 对不上任何一条
  p.handlers.get('session/event')(agent.session, ev('user/message', {
    id: 'desktop-typed-1',
    source: { kind: 'user' },
    content: text('在电脑上敲的'),
  }))

  const state = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  const mine = state.history.filter((m) => m.role === 'user')
  assert.equal(mine.length, 1, '电脑上敲的必须留下来')
  assert.equal(mine[0].text, '在电脑上敲的')
})

test('连着发多条，去重不会误伤后面那条', async (t) => {
  const agent = {
    status: 'idle',
    session: { id: 'sess-many', header: { id: 'sess-many' } },
    followup: (msg) => {
      p.handlers.get('session/event')(agent.session, ev('user/message', {
        id: msg.id, source: { kind: 'user' }, content: msg.content,
      }))
    },
  }
  const p = await bootPlugin({ agents: { 'sess-many': agent } })
  t.after(p.stop)

  p.handlers.get('session/event')(agent.session, ev('turn/start', { turn: 1 }))
  for (const text of ['第一条', '第二条', '第三条']) {
    const res = await fetch(`${p.base}/mini/api/send?token=${p.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    assert.equal((await res.json()).ok, true)
    // 一轮跑完才允许发下一条，模拟真实的「跑完了再发」
    p.handlers.get('session/event')(agent.session, ev('turn/end', { turn: 1, reason: 'completed' }))
  }

  const state = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  const mine = state.history.filter((m) => m.role === 'user').map((m) => m.text)
  assert.deepEqual(mine, ['第一条', '第二条', '第三条'], '每条都该正好一笔')
})

test('agent 正在跑的时候，新指令排队而不是被拒绝', async (t) => {
  /**
   * 这条测试原来断言的是**反面**：正在跑就 409、回一句「还在跑」。
   * 2026-09-21 推翻——DSH 自己的 `followup()` 语义就是「排队一个后续轮次」
   * （dsh-agent 类型注释原话："Queue an ordinary follow-up turn and wake the driver"），
   * 跑着的时候照样收，排进 inbox.nextTurn，等当前这一轮结束再跑。
   * 桌面端同一时刻就能接着排，手机端那条挡板比 DSH 本身还严。
   */
  const calls = []
  const agent = {
    status: 'running',
    inbox: { nextTurn: [], nextStep: [], remove: () => false },
    session: { id: 'sess-busy', header: { id: 'sess-busy' } },
    followup: (m) => { calls.push(m) },
  }
  const p = await bootPlugin({ agents: { 'sess-busy': agent } })
  t.after(p.stop)

  p.handlers.get('session/event')(agent.session, ev('turn/start', { turn: 1 }))

  const res = await fetch(`${p.base}/mini/api/send?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '再来一个' }),
  })
  assert.equal(res.status, 200, '跑着的时候也该收下')
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.queued, true, '要告诉手机这条是排队的，界面好给一句话')
  assert.equal(calls.length, 1, '而且真的进了 agent 的收件箱')

  // 排队的那条**先不记账**。记了的话手机上会立刻长出一条指令气泡，
  // 看着像已经发出去了——用户 2026-09-22 实机提的。
  const snap = await fetch(`${p.base}/mini/api/state?token=${p.token}`).then((r) => r.json())
  const mine = (snap.history || []).filter((m) => m.role === 'user')
  assert.equal(mine.length, 0,
    '还没轮到，聊天记录里不该有它——有了就是一条「已发出」的气泡')

  // 轮到自己时由 session/event 那条路补记，而且只记一次
  p.handlers.get('session/event')(agent.session, ev('user/message', {
    id: calls[0].id, content: [{ type: 'text', text: '再来一个' }], source: { kind: 'user' },
  }))
  const after = await fetch(`${p.base}/mini/api/state?token=${p.token}`).then((r) => r.json())
  const now = (after.history || []).filter((m) => m.role === 'user')
  assert.equal(now.length, 1, '轮到它了，这时候才该出现——正好一次')
  assert.equal(now[0].text, '再来一个')
})

test('闲着的时候发，就不该说「排队」', async (t) => {
  const calls = []
  const agent = {
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [], remove: () => false },
    session: { id: 'sess-free', header: { id: 'sess-free' } },
    followup: (m) => { calls.push(m) },
  }
  const p = await bootPlugin({ agents: { 'sess-free': agent } })
  t.after(p.stop)

  const res = await fetch(`${p.base}/mini/api/send?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '开始吧' }),
  })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).queued, false, '马上就跑的，不能说成排队')
  assert.equal(calls.length, 1)

  // 对照：马上跑的那条要当场记账，否则聊天模式里自己的指令会缺一条
  const snap = await fetch(`${p.base}/mini/api/state?token=${p.token}`).then((r) => r.json())
  const mine = (snap.history || []).filter((m) => m.role === 'user')
  assert.equal(mine.length, 1, '真发出去了，当场就该记上')
  assert.equal(mine[0].text, '开始吧')
})

/** 造一条躺在收件箱里的用户消息，形状对着 dsh-llm 的 UserMessage 来。 */
function queuedMsg(id, text) {
  return { id, content: [{ type: 'text', text }] }
}

/**
 * 让某个会话进入 store 的会话表。
 *
 * 快照里的 `queued` 算的是「手机此刻在看的那个会话」，而 store 认会话靠的是
 * 事件流里见过的那些——光发 `turn/start` 是不够的（tracker 在那一句上不返回动作，
 * 于是 touchSession 不会被调到）。得有一条 `user/message` 才算「见过」。
 */
function seeSession(p, agent, id = 'seed-0') {
  p.handlers.get('session/event')(agent.session, ev('user/message', {
    id, content: [{ type: 'text', text: '（先让这个会话被认出来）' }], source: { kind: 'user' },
  }))
}

test('队列里的东西要出现在快照里，手机才看得见', async (t) => {
  // 队列的真相在 agent 的收件箱里，store 只是去问。这条钉的是「问到了、也翻译对了」。
  const agent = {
    status: 'running',
    inbox: {
      nextTurn: [queuedMsg('m1', '顺便把测试也跑一遍')],
      nextStep: [queuedMsg('m2', '先别动那个文件')],
      remove: () => true,
    },
    session: { id: 'sess-q', header: { id: 'sess-q' } },
    followup: () => {},
  }
  const p = await bootPlugin({ agents: { 'sess-q': agent } })
  t.after(p.stop)
  seeSession(p, agent)

  const snap = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  assert.equal(snap.queued.length, 2, '两个边界上的都要列出来')
  assert.equal(snap.queued[0].text, '顺便把测试也跑一遍')
  assert.equal(snap.queued[0].placement, 'next-turn', '排下一轮的和插下一步的要能分开')
  assert.equal(snap.queued[1].placement, 'next-step')
  assert.equal(snap.queued[0].id, 'm1', 'id 要带上：手机上撤掉某一条全靠它')
})

test('队列算的是手机正在看的那个会话，不串台', async (t) => {
  const mine = {
    status: 'running',
    inbox: { nextTurn: [queuedMsg('a1', '我这条')], nextStep: [], remove: () => true },
    session: { id: 'sess-mine', header: { id: 'sess-mine' } },
    followup: () => {},
  }
  const other = {
    status: 'running',
    inbox: { nextTurn: [queuedMsg('b1', '别人那条')], nextStep: [], remove: () => true },
    session: { id: 'sess-other', header: { id: 'sess-other' } },
    followup: () => {},
  }
  const p = await bootPlugin({ agents: { 'sess-mine': mine, 'sess-other': other } })
  t.after(p.stop)
  seeSession(p, mine, 'seed-a')
  seeSession(p, other, 'seed-b')

  // 手机上绑定 mine，快照就该只有 mine 的那一条。
  await fetch(`${p.base}/mini/api/bind?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-mine' }),
  })
  const snap = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  assert.equal(snap.queued.length, 1)
  assert.equal(snap.queued[0].id, 'a1', '不能把电脑上另开会话的队列显示给手机')
})

test('撤一条排队的指令：调 inbox.remove，用的是那条的 id', async (t) => {
  const removed = []
  const agent = {
    status: 'running',
    inbox: { nextTurn: [queuedMsg('m1', '这条不要了')], nextStep: [], remove: (id) => { removed.push(id); return true } },
    session: { id: 'sess-u', header: { id: 'sess-u' } },
    followup: () => {},
  }
  const p = await bootPlugin({ agents: { 'sess-u': agent } })
  t.after(p.stop)
  p.handlers.get('session/event')(agent.session, ev('turn/start', { turn: 1 }))

  const res = await fetch(`${p.base}/mini/api/unqueue?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'm1' }),
  })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)
  assert.deepEqual(removed, ['m1'])
})

test('撤晚了（那条已经开跑了）：如实说撤不回来，不许假装成功', async (t) => {
  /**
   * 这是这个功能最容易骗人的地方：手机上那份队列是上一次推送时的样子，
   * 这中间它完全可能已经轮到自己开始跑了。那时它早就不在收件箱里，
   * remove 返回 false——界面必须如实说，不然用户以为撤掉了，其实它正在跑。
   */
  const agent = {
    status: 'running',
    inbox: { nextTurn: [], nextStep: [], remove: () => false },
    session: { id: 'sess-late', header: { id: 'sess-late' } },
    followup: () => {},
  }
  const p = await bootPlugin({ agents: { 'sess-late': agent } })
  t.after(p.stop)
  p.handlers.get('session/event')(agent.session, ev('turn/start', { turn: 1 }))

  const res = await fetch(`${p.base}/mini/api/unqueue?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'm1' }),
  })
  assert.equal(res.status, 409, '不能返回 200 假装撤掉了')
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /已经.*开始跑|撤不回来/, '要给出人话，不能是空的')
})

test('没说要撤哪一条就是 400，不是 500', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)
  const res = await fetch(`${p.base}/mini/api/unqueue?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(res.status, 400)
})

test('撤队列的接口也要 token，没带就是 401', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)
  const res = await fetch(`${p.base}/mini/api/unqueue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'm1' }),
  })
  assert.equal(res.status, 401)
})

test('手机排队的那条轮到自己时，队列要跟着少一条', async (t) => {
  /**
   * 手机发的指令在 onInstruction 里已经记过一笔，事件回来时要跳过（不然聊天模式
   * 会显示两次）。但**不能只是跳过**：这条事件的意思是「它开始跑了」，
   * 队列里少了一条，得推给手机——不推的话那块「排队中」会一直挂着一条
   * 其实已经在跑的东西。
   */
  const agent = {
    status: 'running',
    inbox: { nextTurn: [queuedMsg('m1', '再来一个')], nextStep: [], remove: () => true },
    session: { id: 'sess-go', header: { id: 'sess-go' } },
    followup: (m) => { agent.inbox.nextTurn = [queuedMsg(m.id, '再来一个')] },
  }
  const p = await bootPlugin({ agents: { 'sess-go': agent } })
  t.after(p.stop)
  p.handlers.get('session/event')(agent.session, ev('turn/start', { turn: 1 }))

  await fetch(`${p.base}/mini/api/send?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '再来一个' }),
  })
  const sentId = agent.inbox.nextTurn[0].id
  const before = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  assert.equal(before.queued.length, 1, '刚发完，它还在队列里')

  // 它轮到、开始跑了：收件箱里没了，事件也回来了。
  agent.inbox.nextTurn = []
  p.handlers.get('session/event')(agent.session, ev('user/message', {
    id: sentId, content: [{ type: 'text', text: '再来一个' }], source: { kind: 'user' },
  }))

  const after = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  assert.equal(after.queued.length, 0, '开始跑了就不该还挂在「排队中」')
})

test('没有可用会话时给出人话提示，而不是崩掉', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)

  const res = await fetch(`${p.base}/mini/api/send?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '你好' }),
  })
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /还没有可遥控的会话/)
})

test('绑定会话后，别的会话的结果不会顶掉手机上的内容', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)
  const feed = p.handlers.get('session/event')

  const a = { id: 'sess-a', header: { id: 'sess-a' } }
  const b = { id: 'sess-b', header: { id: 'sess-b' } }

  // A 先有活动 → 自动绑定 A
  feed(a, ev('turn/start', { turn: 1 }))
  feed(a, ev('assistant/message', { turn: 1, step: 1, message: { content: text('A 的结果') } }))
  feed(a, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))

  let state = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  assert.equal(state.boundSessionId, 'sess-a')
  assert.equal(state.latest.text, 'A 的结果')

  // 电脑上另一个会话 B 也跑完了
  feed(b, ev('turn/start', { turn: 1 }))
  feed(b, ev('assistant/message', { turn: 1, step: 1, message: { content: text('B 的结果') } }))
  feed(b, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))

  state = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  assert.equal(state.latest.text, 'A 的结果', '没绑定的会话不该顶掉单帧模式的内容')
  assert.equal(state.history.at(-1).text, 'A 的结果', '也不该混进历史')
})

test('agent/status 驱动手机上的「运行中」状态', async (t) => {
  const agent = {
    status: 'running',
    session: { id: 'sess-run', header: { id: 'sess-run' } },
    followup: () => {},
  }
  const p = await bootPlugin({ agents: { 'sess-run': agent } })
  t.after(p.stop)

  p.handlers.get('session/event')(agent.session, ev('turn/start', { turn: 1 }))
  p.handlers.get('agent/status')({ agent, status: 'running' })

  const state = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  assert.equal(state.sessions.find((s) => s.id === 'sess-run').running, true)

  p.handlers.get('agent/status')({ agent, status: 'idle' })
  const after = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  assert.equal(after.sessions.find((s) => s.id === 'sess-run').running, false)
})

test('agent/created 让会话选择器不用等到有活动才出现', async (t) => {
  const agent = {
    status: 'idle',
    session: { id: 'sess-new', header: { id: 'sess-new' } },
    followup: () => {},
  }
  const p = await bootPlugin()
  t.after(p.stop)

  p.handlers.get('agent/created')({ agent })

  const state = await (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  assert.ok(state.sessions.some((s) => s.id === 'sess-new'), '新建的会话应该马上可被选择')
})

// ---------------------------------------------------------------------------
// 配对面板
// ---------------------------------------------------------------------------

function fakeReq(remoteAddress, { method = 'GET', body = null } = {}) {
  const listeners = new Map()
  const req = {
    method,
    socket: { remoteAddress },
    on(name, fn) {
      listeners.set(name, fn)
      return req
    },
    destroy() {},
  }
  if (body !== null) {
    // 异步喂进去，模拟真实的请求体是分块到达的
    queueMicrotask(() => {
      listeners.get('data')?.(Buffer.from(body, 'utf8'))
      listeners.get('end')?.()
    })
  }
  return req
}

function fakeRes() {
  const out = { status: 0, headers: null, body: '' }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(body) { out.body = body ?? '' },
  }
}

test('配对路由：本机读得到，别的来源一律挡住', async (t) => {
  const p = await bootPlugin({ config: { bindAddress: 'auto' } })
  t.after(p.stop)

  const route = p.routes.get('/mini-remote/pairing')
  assert.ok(route, '必须把配对路由挂到 DSH 的服务上，设置页才取得到数据')
  assert.equal(route.kind, 'exact')

  // 同一个 Wi-Fi 下的别的设备来读：必须挡住，否则 token 等于白设
  for (const addr of ['192.168.1.50', '100.92.105.99', '::ffff:192.168.1.50']) {
    const denied = fakeRes()
    await route.handler(fakeReq(addr), denied)
    assert.equal(denied.out.status, 403, `${addr} 不该读到配对信息`)
    assert.match(JSON.parse(denied.out.body).error, /只能在这台电脑上看/)
  }

  // 本机自己来读
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const ok = fakeRes()
    await route.handler(fakeReq(addr), ok)
    assert.equal(ok.out.status, 200, `${addr} 应该读得到`)
    const payload = JSON.parse(ok.out.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.token, p.token)
    assert.ok(payload.entries.length > 0, '至少要有一个手机能用的地址')
    for (const entry of payload.entries) {
      assert.ok(entry.url.includes(p.token), '二维码地址里要带 token，扫完才不用手敲密码')
      assert.match(entry.url, /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/mini\?token=/, '地址形状要能被手机直接打开')
      assert.match(entry.qr, /^data:image\/png;base64,/, '二维码要能直接塞进 img src')
      assert.ok(entry.label && entry.hint, '要有给人看的标题和说明')
    }
  }
})

test('只绑本机时，配对面板说清楚是配置问题而不是网络问题', async (t) => {
  // 默认配置就是只绑 127.0.0.1
  const p = await bootPlugin()
  t.after(p.stop)

  const route = p.routes.get('/mini-remote/pairing')
  const res = fakeRes()
  await route.handler(fakeReq('127.0.0.1'), res)

  const payload = JSON.parse(res.out.body)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /bindAddress/, '要告诉用户去改哪个配置项')
})

test('手机服务起不来之前，配对面板给的是「稍等」而不是崩掉', async (t) => {
  const p = await bootPlugin()
  const route = p.routes.get('/mini-remote/pairing')

  // 立刻停掉服务，模拟还没起来的状态
  p.stop()

  const res = fakeRes()
  await route.handler(fakeReq('127.0.0.1'), res)
  assert.ok([503, 200, 500].includes(res.out.status))
  assert.doesNotThrow(() => JSON.parse(res.out.body))
})

// ---------------------------------------------------------------------------
// 公网访问开关
// ---------------------------------------------------------------------------

test('公网开关：只有本机点得动，同一个 Wi-Fi 下的设备被挡住', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)
  const route = p.routes.get('/mini-remote/tunnel')
  assert.ok(route, '开关路由要挂上，否则设置页里点不动')

  const denied = fakeRes()
  await route.handler(fakeReq('192.168.1.50', { method: 'POST', body: '{"enabled":true}' }), denied)
  assert.equal(denied.out.status, 403, '开公网这件事不能让局域网里的别人替你做主')
})

test('公网开关：只接受 POST', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)
  const route = p.routes.get('/mini-remote/tunnel')
  const res = fakeRes()
  await route.handler(fakeReq('127.0.0.1'), res)
  assert.equal(res.out.status, 405)
})

test('公网开关：请求体不是 JSON 时给 400，而不是崩掉', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)
  const route = p.routes.get('/mini-remote/tunnel')
  const res = fakeRes()
  await route.handler(fakeReq('127.0.0.1', { method: 'POST', body: 'not json' }), res)
  assert.equal(res.out.status, 400)
})

test('公网开关：打开后配置落盘，起不来时把原因说清楚', async (t) => {
  // cloudflaredPath 指一个不存在的文件，这样它会停在「找 cloudflared」这一步，
  // 既不联网也不起进程——正好用来验证失败路径。
  const p = await bootPlugin({
    config: {
      bindAddress: 'auto',
      tunnel: { enabled: false, cloudflaredPath: join(tmpdir(), 'no-such-cloudflared.exe') },
    },
  })
  t.after(p.stop)
  const route = p.routes.get('/mini-remote/tunnel')

  const res = fakeRes()
  await route.handler(fakeReq('127.0.0.1', { method: 'POST', body: '{"enabled":true}' }), res)
  const payload = JSON.parse(res.out.body)

  assert.equal(payload.tunnel.enabled, true, '用户点了开关，这个意愿要认')
  assert.equal(payload.tunnel.up, false, 'cloudflared 都找不到，当然没起来')
  assert.match(payload.tunnel.error, /cloudflaredPath/, '失败原因要透到界面上')

  const saved = JSON.parse(readFileSync(join(p.home, 'dsh-mini-remote', 'settings.json'), 'utf8'))
  assert.equal(saved.tunnel.enabled, true, '开关状态要落盘，重启之后还记得')
})

test('公网开关：关掉之后配置落盘，面板里不再有公网那条', async (t) => {
  const p = await bootPlugin({ config: { bindAddress: 'auto', tunnel: { enabled: false } } })
  t.after(p.stop)
  const route = p.routes.get('/mini-remote/tunnel')

  const res = fakeRes()
  await route.handler(fakeReq('127.0.0.1', { method: 'POST', body: '{"enabled":false}' }), res)
  const payload = JSON.parse(res.out.body)

  assert.equal(payload.tunnel.enabled, false)
  assert.equal(payload.tunnel.up, false)
  assert.equal(payload.tunnel.error, null)
  assert.ok(!payload.entries.some((e) => e.kind === 'public'), '关了就不该还留着公网那条')

  const saved = JSON.parse(readFileSync(join(p.home, 'dsh-mini-remote', 'settings.json'), 'utf8'))
  assert.equal(saved.tunnel.enabled, false)
})

// ---------------------------------------------------------------------------
// 密码：看得见 + 能自己设一个
// 2026-09-22 用户报：「手机遥控页面里似乎根本没有密码，也无法自定义密码」。
// 配对接口一直返回着 token，只是设置页从来没渲染它；而自定义密码原先只能手改
// settings.json——对非技术用户等于没有。
// ---------------------------------------------------------------------------

const TOKEN_ROUTE = '/mini-remote/token'

test('改密码：只有本机改得动', async (t) => {
  const p = await bootPlugin({ config: { bindAddress: 'auto' } })
  t.after(p.stop)
  const route = p.routes.get(TOKEN_ROUTE)
  assert.ok(route, '改密码的路由要挂上，否则设置页里改不了')

  const denied = fakeRes()
  await route.handler(fakeReq('192.168.1.50', { method: 'POST', body: '{"token":"a-long-enough-one"}' }), denied)
  assert.equal(denied.out.status, 403, '换密码不能让局域网里的别人替你做主')
})

test('改密码：只接受 POST', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)
  const res = fakeRes()
  await p.routes.get(TOKEN_ROUTE).handler(fakeReq('127.0.0.1'), res)
  assert.equal(res.out.status, 405)
})

test('改密码：太短的当场拒绝，而且不留半截改动', async (t) => {
  const p = await bootPlugin({ config: { bindAddress: 'auto' } })
  t.after(p.stop)
  const before = readFileSync(join(p.home, 'dsh-mini-remote', 'settings.json'), 'utf8')

  const res = fakeRes()
  await p.routes.get(TOKEN_ROUTE).handler(fakeReq('127.0.0.1', { method: 'POST', body: '{"token":"123456"}' }), res)
  assert.equal(res.out.status, 400, '六位数字不该被放行')
  assert.match(JSON.parse(res.out.body).error, /至少要 12 位/)

  const after = readFileSync(join(p.home, 'dsh-mini-remote', 'settings.json'), 'utf8')
  assert.equal(after, before, '拒绝了就不该落盘')
})

test('改密码：会把网址拆坏的字符要拒绝', async (t) => {
  const p = await bootPlugin({ config: { bindAddress: 'auto' } })
  t.after(p.stop)
  // 每一串都够长，所以被拒只能是因为字符本身
  for (const bad of ['goodpassword?x=1', 'goodpassword&y', 'good password', 'goodpassword/z']) {
    const res = fakeRes()
    await p.routes
      .get(TOKEN_ROUTE)
      .handler(fakeReq('127.0.0.1', { method: 'POST', body: JSON.stringify({ token: bad }) }), res)
    assert.equal(res.out.status, 400, `${bad} 不该被放行`)
  }
})

test('改密码：落盘两处，但重启前手机认的还是旧的', async (t) => {
  const p = await bootPlugin({ config: { bindAddress: 'auto' } })
  t.after(p.stop)
  const NEXT = 'wo-ji-de-zhu-de-mi-ma'
  const dir = join(p.home, 'dsh-mini-remote')

  const res = fakeRes()
  await p.routes.get(TOKEN_ROUTE).handler(fakeReq('127.0.0.1', { method: 'POST', body: JSON.stringify({ token: NEXT }) }), res)
  assert.equal(res.out.status, 200)
  const payload = JSON.parse(res.out.body)

  // 落盘，这是「重启之后生效」的全部依据：启动时 loadOrCreateToken 会优先读 settings.token
  assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).token, NEXT)
  assert.equal(readFileSync(join(dir, 'token'), 'utf8').trim(), NEXT, 'token 文件也要跟上，将来清空配置项时读到的该是现在这个')

  // 但此刻真正在用的还是旧的——服务启动时就把 token 读进内存了，改文件不影响正在跑的那个。
  // 面板要是显示成新的，就是骗人：那串现在根本进不来。
  assert.equal(payload.token, p.token, '重启前，面板上显示的必须仍是当前有效的那个')
  assert.equal(payload.pendingToken, NEXT, '新密码要单独带出来，界面才说得清「还没生效」')
  for (const entry of payload.entries) {
    assert.ok(entry.url.includes(p.token), '二维码还是旧密码编的——重启前它们确实还能用')
  }
})

// ---------------- 停止 ----------------

test('手机按停止 → 调用 agent.cancel()，cause 与 keepInbox 和电脑端一致', async (t) => {
  const calls = []
  const agent = {
    status: 'running',
    session: { id: 'sess-stop', header: { id: 'sess-stop' } },
    followup: () => {},
    cancel: (cause, options) => calls.push({ cause, options }),
  }
  const p = await bootPlugin({ agents: { 'sess-stop': agent } })
  t.after(p.stop)

  p.handlers.get('session/event')(agent.session, ev('turn/start', { turn: 1 }))

  const res = await fetch(`${p.base}/mini/api/stop?token=${p.token}`, { method: 'POST' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)

  assert.equal(calls.length, 1, '应该正好请求一次取消')
  // 照抄 DSH 自己的停止按钮（dsh-api-session-controller 的 commands.cancel：
  // `agent.cancel({ kind: 'user' }, { keepInbox: true })`）。
  // keepInbox 尤其不能漏——漏了会把你在电脑上排好的下一条悄悄吃掉，而且是无声的。
  assert.deepEqual(calls[0].cause, { kind: 'user' })
  assert.deepEqual(calls[0].options, { keepInbox: true })
})

test('停止要认准手机正在遥控的那个会话，不碰电脑上另开的', async (t) => {
  const hit = []
  const mk = (id) => ({
    status: 'running',
    session: { id, header: { id } },
    followup: () => {},
    cancel: () => hit.push(id),
  })
  const desk = mk('sess-desk')
  const phone = mk('sess-phone')
  const p = await bootPlugin({ agents: { 'sess-desk': desk, 'sess-phone': phone } })
  t.after(p.stop)

  // 电脑上那个先活跃，然后手机绑到另一个上——和「绑定会话后别的会话不顶掉内容」同一套口径。
  p.handlers.get('session/event')(desk.session, ev('turn/start', { turn: 1 }))
  p.handlers.get('session/event')(phone.session, ev('turn/start', { turn: 1 }))
  await fetch(`${p.base}/mini/api/bind?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-phone' }),
  })

  await fetch(`${p.base}/mini/api/stop?token=${p.token}`, { method: 'POST' })
  assert.deepEqual(hit, ['sess-phone'], '只该停手机正在看的那个')
})

test('子 Agent 停不了，给一句人话', async (t) => {
  const agent = {
    status: 'running',
    session: { id: 'sess-sub', header: { id: 'sess-sub', origin: 'subagent' } },
    followup: () => {},
    cancel: () => { throw new Error('不该被调到') },
  }
  const p = await bootPlugin({ agents: { 'sess-sub': agent } })
  t.after(p.stop)

  // 子 Agent 的会话根本不会进手机（订阅那一层就挡了），所以这里得直接绑上去模拟
  // 一个被构造出来的请求——挡不住的话手机上就能停掉别人的小弟。
  await fetch(`${p.base}/mini/api/bind?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-sub' }),
  })

  const res = await fetch(`${p.base}/mini/api/stop?token=${p.token}`, { method: 'POST' })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /子 Agent/)
})

test('会话已经没了，停止给一句人话而不是崩掉', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)

  const res = await fetch(`${p.base}/mini/api/stop?token=${p.token}`, { method: 'POST' })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.ok(body.error.length > 0, '要有一句能读的话')
})

test('停止接口也要 token，没带就是 401', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)

  const res = await fetch(`${p.base}/mini/api/stop`, { method: 'POST' })
  assert.equal(res.status, 401)
})
