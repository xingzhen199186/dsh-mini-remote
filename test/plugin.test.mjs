/**
 * 集成测试：用假的 ctx 把插件真跑起来，走真实的 HTTP 端口。
 *
 * 这一层测的是「apply() 到底能不能正常加载并工作」——包括事件订阅接对了没有、
 * 指令有没有真的交到 agent.followup()、token 有没有落盘。
 * 不需要正在运行的 DSH。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { zstdCompressSync } from 'node:zlib'
// 提问钩子要用的两个能力放在这里（模块级单例）——钩子的测试会临时替换它们，
// 用完立刻还回去，免得串到别的用例上。
import { miniControl } from '../lib/server.js'

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

function mockCtx({ attachments, sessionQuery, commands, sessionController, subagents, sessionProjections, sessions, agentPresets, workspaceRegistry, pluginManager, loader, pluginPackages, settings } = {}) {
  const handlers = new Map()
  // `ctx.on` 的第三个参数（注册选项）也要留下来：提问钩子靠 `prepend` 才能排到
  // 电脑浏览器前面，而漏掉它**不报错、只是永远轮不到**。这种错只能靠断言钉住。
  const handlerOptions = new Map()
  const agents = new Map()
  // 插件会注册不止一个 effect（服务、配对路由各一个），全部收集起来——
  // 只记最后一个会导致服务关不掉、测试进程永远不退出。
  const disposers = []
  const routes = new Map()
  return {
    handlers,
    handlerOptions,
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
      on: (name, fn, options) => {
        handlers.set(name, fn)
        handlerOptions.set(name, options)
        return () => { handlers.delete(name); handlerOptions.delete(name) }
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
      // 同上：会话记录服务（真机上是 DSH 自己的 DSH 会话记录）。插件要拿它
      // 读一个会话**完整**的历史，所以测试也得能把它摆出来、也能让它缺席。
      ...(sessionQuery ? { sessionQuery } : {}),
      // 同上：斜杠指令账本（DSH 的 `ctx.commands`）。**可缺席**也是一条要覆盖的路径：
      // DSH 明说无界面的组合不提供这个面，那时候手机上打 `/` 必须如实说没有指令，
      // 而不是显示一个空名单。
      ...(commands ? { commands } : {}),
      // 同上：会话控制器（真机上是 DSH 的 sessionController，管"叫醒睡着的会话"）。
      // 它可缺席也是一条要覆盖的路径：没有它的时候只能如实说叫不醒。
      ...(sessionController ? { sessionController } : {}),
      // 子智能体那三件：编排服务（列表/停/继续）、投影注册表（耗时/用量）、
      // 会话存储（拿 Session 对象）。**三个都可缺席**也是要覆盖的路径：
      // 缺席时要如实说「这台电脑没提供」，而不是给一份空清单。
      ...(subagents ? { subagents } : {}),
      ...(sessionProjections ? { sessionProjections } : {}),
      ...(sessions ? { sessions } : {}),
      // 同上：Agent 模式注册表（2026-10-04，新建会话时手机上也要能选模式）。
      // **可缺席**也是要覆盖的路径：没有它的时候手机直接建默认模式，不摆没得选的选择题。
      ...(agentPresets ? { agentPresets } : {}),
      // 工作区注册表：建会话要拿它核对「有没有这个工作区」（tree.createSessionIn）。
      ...(workspaceRegistry ? { workspaceRegistry } : {}),
      // 插件那三件（2026-10-04 手机端「插件」页面）：
      //   pluginManager  —— npm 包清单（官方可装的 + 第三方）；
      //   loader         —— Cordis Loader 的实时条目表，**内置插件**的真相在这儿；
      //   pluginPackages —— 显示用的本地化标题/说明。
      // 三个都可缺席：缺席时那两块各自如实说读不到，不拿空清单充数。
      ...(pluginManager ? { pluginManager } : {}),
      ...(loader ? { loader } : {}),
      ...(pluginPackages ? { pluginPackages } : {}),
      // 设置文档：问「这台部署 served 了哪些设置命名空间」——官方那几张设置卡片
      // 就是按它决定出不出现（DSH 那边是 configForms.whileServed）。可缺席。
      ...(settings ? { settings } : {}),
    }, ['agents', 'logger', 'on', 'effect']),
  }
}

/** 起一个被测插件实例，返回访问它所需的一切。 */
async function bootPlugin({ agents = {}, config = {}, attachments = null, sessionQuery = null, commands = null, stored = null, sessionController = null, subagents = null, sessionProjections = null, sessions = null, agentPresets = null, workspaceRegistry = null, pluginManager = null, loader = null, pluginPackages = null, settings = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mini-home-'))
  process.env.DSH_HOME = home

  // 有些用例要验"用户自己那份 settings.json 还生不生效"，就得在 apply 之前把它摆好。
  if (stored) {
    mkdirSync(join(home, 'dsh-mini-remote'), { recursive: true })
    writeFileSync(join(home, 'dsh-mini-remote', 'settings.json'), `${JSON.stringify(stored, null, 2)}\n`)
  }

  const port = await freePort()
  const mock = mockCtx({ attachments, sessionQuery, commands, sessionController, subagents, sessionProjections, sessions, agentPresets, workspaceRegistry, pluginManager, loader, pluginPackages, settings })
  const { ctx, handlers, handlerOptions, agents: agentMap } = mock
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
    home, base, token, handlers, handlerOptions, agents: agentMap, ctx, routes: mock.routes,
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

/**
 * 飞书那行「会话：…」标记（lib/lark.js 的 sessionTagLine）**只能**加在飞书那条路上。
 * 这一条就是那句话的证据：名字先让它进缓存（标记本来取得到），再跑完一轮，
 * 手机页拿到的文本必须和加这个功能之前**一字不差**。
 */
test('给飞书加「会话：」标记之后，手机页拿到的回答一个字都没变', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)

  const feed = p.handlers.get('session/event')
  const session = { id: 'sess-tag', header: { id: 'sess-tag' } }
  const answer = 'README 的安装部分已更新为 Node 22+。'

  // 前提：这条会话确实有名字，而且名字进了标题缓存——**飞书那行标记取的就是这一份**
  // （见 lib/index.js 的 titleOfSession）。落盘是合并写的（500 毫秒一次），等它一下再读。
  feed(session, ev('session/title', { title: '改登录按钮' }))
  await new Promise((resolve) => setTimeout(resolve, 600))
  const cache = JSON.parse(readFileSync(join(p.home, 'dsh-mini-remote', 'titles.json'), 'utf8'))
  assert.equal(cache['sess-tag']?.title, '改登录按钮',
    '前提没立住：这条会话的名字没进标题缓存，下面那两条断言就证明不了什么')
  const named = await snapOf(p)
  assert.ok(named.sessions.some((s) => s.id === 'sess-tag' && s.title === '改登录按钮'),
    '手机上显示的名字也该是它')

  feed(session, ev('user/message', { source: { kind: 'user' }, content: text('帮我看下 README') }))
  feed(session, ev('turn/start', { turn: 1 }))
  feed(session, ev('assistant/message', { turn: 1, step: 1, message: { content: text(answer) } }))
  feed(session, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))

  const state = await snapOf(p)
  assert.equal(state.latest.text, answer, '手机页单帧那份文本一个字符都不许变')
  assert.ok(!state.latest.text.includes('会话：'), '标记只走飞书那条路，不许溢到手机页')
  assert.ok(!state.latest.text.includes('改登录按钮'), '会话名字也不许混进回答正文')
  const assistant = (state.history ?? []).filter((m) => m.role === 'assistant')
  assert.equal(assistant[assistant.length - 1]?.text, answer, '聊天记录那份也一样')
})

/**
 * 自言自语（2026-09-26）：只走鲸鱼娘的气泡，不碰回答区、不进历史。
 */
test('中间步骤的自言自语会进快照，但回答区一个字都不变', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)

  const feed = p.handlers.get('session/event')
  const session = { id: 'sess-talk', header: { id: 'sess-talk' } }

  // 手机先绑到这个会话上（现实里也是先有一条指令）
  feed(session, ev('user/message', { source: { kind: 'user' }, content: text('看下这个项目') }))
  feed(session, ev('turn/start', { turn: 1 }))
  // 中间步骤：说一句给人听的旁白，然后就去调工具
  feed(session, ev('assistant/message', {
    turn: 1, step: 1,
    message: {
      content: [
        ...text('先看一眼目录结构。'),
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
      ],
    },
  }))

  const talk = await snapOf(p)
  assert.equal(talk.thought.text, '先看一眼目录结构。', '旁白进气泡')
  assert.ok(talk.thought.at > 0, '要带一个身份（at），手机靠它认「这句念过了」')
  // **回答区一个字都不能变**：这才是 2026-09-22 那条裁决守的东西
  assert.equal(talk.latest, null, '自言自语不是回答')
  assert.equal(talk.history.filter((m) => m.role === 'assistant').length, 0,
    '也不进历史——历史有上限，思考会把它挤爆')
  assert.equal(talk.live, '', '更不能冒充「正在流出来的回答」')

  // 再来一步：只想了、没写旁白 → 气泡**保持上一句**，思考不上手机
  // （2026-09-27 用户裁掉的就是这条退路：思考首行整个不展示）
  feed(session, ev('assistant/message', {
    turn: 1, step: 2,
    message: {
      content: [
        { type: 'reasoning', text: '先看一眼目录结构。\n然后再决定改哪儿。' },
        { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
      ],
    },
  }))
  const still = await snapOf(p)
  assert.equal(still.thought.text, '先看一眼目录结构。', '没旁白就不动气泡，留着上一句')
  assert.equal(still.thought.at, talk.thought.at, '身份也没变——没有偷偷重播，更没有换成思考')

  feed(session, ev('assistant/message', {
    turn: 1, step: 3, message: { content: text('都改好了。') },
  }))
  feed(session, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))

  const done = await snapOf(p)
  assert.equal(done.latest.text, '都改好了。', '最后那一步才是回答')
  assert.equal(done.thought, null, '一轮结束台词就作废——不然下一轮开口还挂着上一句')
})

/**
 * 「别的会话」和「子代理」这两条，判据不是「快照里的 thought 是不是空」——那样写
 * 是**摆设**：把守卫删掉它照样绿（反向验证抓到过，见 2026-09-26 那次）。
 * 真正会出事的后果是**手机看的会话被拽走**：手机还没绑定时，「手机在看哪个会话」
 * 取的是最近活跃的那个，别人一自言自语，屏幕上就换成别人的内容了。
 */
test('自言自语：别的会话在想什么，不许把手机的视线拽走', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)

  const feed = p.handlers.get('session/event')
  const mine = { id: 'sess-mine', header: { id: 'sess-mine' } }
  const other = { id: 'sess-other', header: { id: 'sess-other' } }
  const talkEvent = ev('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      content: [
        ...text('这是别的会话在说的话。'),
        { type: 'reasoning', text: '这是别的会话在想的事。' },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
      ],
    },
  })

  // 手机连着、但还没绑（没发过指令）。这时候「手机在看哪个会话」取的是最近活跃的
  // 那个——电脑上随便一个动静都会把它顶上去，所以这里让 mine 先落在前面。
  feed(mine, ev('session/title', { title: 'mine 的会话' }))
  assert.equal((await snapOf(p)).sessions[0].id, 'sess-mine', '前提：手机此刻看的是 mine')

  feed(other, talkEvent)
  const snap = await snapOf(p)
  assert.equal(snap.sessions[0].id, 'sess-mine',
    '别人的自言自语把「最近活跃」顶成了 other，手机看的会话就被悄悄换掉了')
  assert.equal(snap.thought, null, '别人的台词也不该出现')

  feed(mine, talkEvent)
  assert.equal((await snapOf(p)).thought.text, '这是别的会话在说的话。', '自己这个会话的才推')
})

test('自言自语：子代理在想什么，一个字都不推', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)

  const feed = p.handlers.get('session/event')
  const sub = { id: 'sub-1', header: { id: 'sub-1', origin: 'subagent' } }

  // 故意让手机盯着的就是那个分身：把指令直接发给它。
  // （挡它的那道理在**收事件的入口**，所以它连绑都绑不上；这里必须走这条路，
  //   否则「targetSessionId 不等于它」会把结果盖成绿的——那又是摆设了。）
  feed(sub, ev('user/message', { source: { kind: 'user' }, content: text('你去干活') }))

  feed(sub, ev('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      content: [
        ...text('我是派出去的小弟，我在说话。'),
        { type: 'reasoning', text: '我是派出去的小弟，我在想。' },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
      ],
    },
  }))

  const snap = await snapOf(p)
  assert.equal(snap.thought, null, '子代理的思考不该跑到手机上')
  assert.equal(snap.latest, null, '它也不该在手机上凭空长出一轮回复')
  assert.equal(snap.history.length, 0, '它那道墙挡的是**所有**事件，不只是自言自语')
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

test('手机上发指令：会话在睡着时要先叫醒，不能回「已经结束了」', async (t) => {
  const calls = []
  const slept = {
    status: 'idle',
    session: { id: 'sess-sleep', header: { id: 'sess-sleep' } },
    followup: (msg) => calls.push(msg),
  }
  const asked = []
  const sessionController = { resolveAgent: async (id) => { asked.push(id); return { agent: slept } } }
  // **注册表里故意不放它**——这就是"睡着"的样子（真机上：一个工作区上百个会话，活的只有三两个）
  const p = await bootPlugin({ agents: {}, sessionController })
  t.after(p.stop)

  // 照实机的样子来：用户是在手机导航里**挑**了一个会话（挑中的那个正在睡着），
  // 不是靠事件流碰巧认识它——睡着的会话本来就不会产生任何事件。
  const bind = await fetch(`${p.base}/mini/api/bind?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-sleep' }),
  })
  assert.ok(bind.status < 400, '绑定要成功：' + bind.status + ' ' + (await bind.text()))

  const res = await fetch(`${p.base}/mini/api/send?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '叫醒它' }),
  })
  const body = await res.json()
  // 断言里带上服务端那句话：只说"409 !== 200"查不出为什么（本轮就这么瞎跑过一轮）
  assert.equal(res.status, 200, '睡着的会话必须能发进去，服务端说：' + JSON.stringify(body))
  assert.equal(body.ok, true)
  assert.deepEqual(asked, ['sess-sleep'], '应该去叫醒它，而且叫的正是这个会话')
  assert.equal(calls.length, 1, '叫醒之后要把这条指令交给它')
})

test('叫不醒和真没了是两回事，两句话必须分开说', async (t) => {
  // 把"暂时叫不醒"也说成"已经结束了"，等于把用户支去重选一个其实还在的会话。
  const cases = [
    { name: '真没了', controller: { resolveAgent: async () => ({ error: { code: 'session/not-found' } }) }, expect: /不在了/ },
    { name: '被电脑那边占着', controller: { resolveAgent: async () => ({ error: { code: 'session/agent-busy' } }) }, expect: /占着/ },
    { name: '连控制器都没有', controller: null, expect: /叫不醒/ },
  ]
  for (const c of cases) {
    const slept = { status: 'idle', session: { id: 'sess-dead', header: { id: 'sess-dead' } }, followup: () => {} }
    const p = await bootPlugin({ agents: {}, sessionController: c.controller })
    // 用 t.after 而不是在末尾手写 p.stop()：断言一挂，手写的那行就轮不到，
    // 监听端口一直开着，测试进程会卡在等事件循环排空——本轮为此白等了两轮各十分钟。
    t.after(p.stop)
    const bind = await fetch(`${p.base}/mini/api/bind?token=${p.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-dead' }),
    })
    assert.ok(bind.status < 400, '绑定要成功：' + bind.status)
    const res = await fetch(`${p.base}/mini/api/send?token=${p.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '发得出去吗' }),
    })
    const body = await res.json()
    assert.equal(res.status, 409, c.name)
    assert.match(body.error, c.expect, c.name)
  }
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

// ---------------------------------------------------------------------------
// 手机上答题：接管电脑那边的提问（`user-questions/request`）
//
// 这是插件里最安静的一段——接错了不报错，只是电脑照常弹窗、手机永远收不到问题。
// 而它又是「手机能答题」这条功能的唯一入口，所以「接不接」的几种情形都钉在这里。
//
// 三个要点都是踩出来或想清楚了才这么写的，测试也就照着这三点钉：
//   ① 必须 `{ prepend: true }`——那条瀑布遇到第一个愿意接的人就停，电脑浏览器
//      （经 `dsh-api-remotes`）本来就在接，排在它后面就永远轮不到本插件；
//   ② 必须是**普通函数**，不能是 async——「接不接」要在同步那一瞬间定下来，
//      先 await 再 `return next()` 会**静默失效**，一句错都不报；
//   ③ 任何一条不接的路，都要原样让给电脑。
// ---------------------------------------------------------------------------

/** 起一个插件、绑好一个会话，把提问钩子连着两个能力一起交给用例。 */
async function bootQuestionHook({ phone = true, answer = null, rejects = false } = {}) {
  const p = await bootPlugin()
  const sessionId = 'sess-question'
  await fetch(`${p.base}/mini/api/bind?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })

  const saved = { hasPhone: miniControl.hasPhone, askPhone: miniControl.askPhone }
  let asked = 0
  /** 交到那条接缝上的原样参数（第 3 个是 onPending / keepAlive 那一格）。 */
  const calls = []
  miniControl.hasPhone = () => phone
  miniControl.askPhone = (...args) => {
    asked += 1
    calls.push(args)
    // 接管的失败是**异步**的：真实的 askPhone 一上来就同步返回一个 Promise，
    // 等待过程中手机全断了才会出结果。所以这里用 reject 来走那条 catch。
    if (rejects) return Promise.reject(new Error('模拟：接管出错了'))
    return Promise.resolve(answer)
  }

  return {
    p,
    sessionId,
    calls,
    askedCount: () => asked,
    hook: p.handlers.get('user-questions/request'),
    restore: () => {
      miniControl.hasPhone = saved.hasPhone
      miniControl.askPhone = saved.askPhone
      p.stop()
    },
  }
}

/** 电脑那边递给钩子的那个请求，以及「让给下一个人」的回执。 */
const askRequest = (agentId) => ({
  agent: { id: agentId },
  questions: [{ id: 'q1', question: '选哪个方案？', options: [{ label: 'A' }, { label: 'B' }] }],
})

test('提问钩子：插到队首注册，而且是普通函数（不能是 async）', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)

  const hook = p.handlers.get('user-questions/request')
  assert.ok(hook, '必须挂上这个钩子，否则手机永远收不到提问')
  assert.equal(
    p.handlerOptions.get('user-questions/request')?.prepend,
    true,
    '不插队就永远轮不到——电脑浏览器本来就接在这个瀑布上',
  )
  assert.notEqual(
    hook.constructor.name,
    'AsyncFunction',
    'async 函数里「让路」交不回派发链条，而且不报错',
  )
})

test('提问钩子：手机在，就把答案原样交回电脑', async (t) => {
  const answer = { answers: [{ id: 'q1', selected: ['B'] }] }
  const h = await bootQuestionHook({ answer })
  t.after(h.restore)

  const next = () => { throw new Error('手机在的时候不该让给电脑') }
  const got = await h.hook(askRequest(h.sessionId), next)
  assert.deepEqual(got, answer, '交回去的必须是手机上答的那份')
  assert.equal(h.askedCount(), 1)
})

test('提问钩子：手机不在，原样让给电脑', async (t) => {
  const h = await bootQuestionHook({ phone: false, answer: { answers: [] } })
  t.after(h.restore)

  let handed = 0
  const next = () => { handed += 1; return '电脑来答' }
  const got = await h.hook(askRequest(h.sessionId), next)
  assert.equal(got, '电脑来答')
  assert.equal(handed, 1)
  assert.equal(h.askedCount(), 0, '手机不在时不该把问题推出去')
})

test('提问钩子：问的不是手机上绑着的那个会话，让路', async (t) => {
  const h = await bootQuestionHook({ answer: { answers: [] } })
  t.after(h.restore)

  let handed = 0
  const next = () => { handed += 1; return '电脑来答' }
  const got = await h.hook(askRequest('sess-别的会话'), next)
  assert.equal(got, '电脑来答')
  assert.equal(handed, 1)
  assert.equal(h.askedCount(), 0, '别的会话的提问不归手机管')
})

test('提问钩子：没有题目也让路（不能拿一个空提问去问手机）', async (t) => {
  const h = await bootQuestionHook({ answer: { answers: [] } })
  t.after(h.restore)

  let handed = 0
  const next = () => { handed += 1; return '电脑来答' }
  const got = await h.hook({ agent: { id: h.sessionId }, questions: [] }, next)
  assert.equal(got, '电脑来答')
  assert.equal(handed, 1)
  assert.equal(h.askedCount(), 0)
})

test('提问钩子：接管出错了，也要把问题还给电脑（不能吞掉）', async (t) => {
  const h = await bootQuestionHook({ rejects: true })
  t.after(h.restore)

  let handed = 0
  const next = () => { handed += 1; return '电脑来答' }
  const got = await h.hook(askRequest(h.sessionId), next)
  assert.equal(got, '电脑来答', '出了错也不能把提问吞掉，否则电脑上什么都不弹')
  assert.equal(handed, 1)
})

test('提问钩子：手机上答不出来（返回空），把问题还给电脑', async (t) => {
  const h = await bootQuestionHook({ answer: null })
  t.after(h.restore)

  let handed = 0
  const next = () => { handed += 1; return '电脑来答' }
  const got = await h.hook(askRequest(h.sessionId), next)
  assert.equal(got, '电脑来答', '手机中途没了要还给电脑，不能两头都答不上')
  assert.equal(handed, 1)
})

// ---------------------------------------------------------------------------
// 会话中途等用户拍板（第一层）：插件主体交到那条接缝上的东西
//
// 真正的清单、settle、「谁先答谁生效」都在 lib/server.js（那边另有一组用例钉着）。
// 这里只钉插件主体这半边：交出去的那份参数里有 onPending 和 keepAlive，
// 而且**飞书没开的时候 keepAlive 一律是 false**——也就是老行为一个字不变。
// ---------------------------------------------------------------------------

test('提问钩子：把 onPending / keepAlive 一并交给那条接缝；飞书没开时 keepAlive 恒假', async (t) => {
  const h = await bootQuestionHook({ answer: { answers: [] } })
  t.after(h.restore)

  await h.hook(askRequest(h.sessionId), () => { throw new Error('不该让路') })
  assert.equal(h.calls.length, 1)
  const opts = h.calls[0][2]
  assert.equal(typeof opts?.onPending, 'function', '飞书那边靠它拿到题号，才能对号入座')
  assert.equal(typeof opts?.keepAlive, 'function', '手机全断了要不要收摊，多了这一个判据')
  assert.equal(opts.keepAlive(), false, '飞书没开：和以前一样，手机不在就把题还给电脑')

  // onPending 交出来的题号要原样转给飞书那边（这里飞书没开，只是不能抛）。
  opts.onPending('q7')
  assert.equal(opts.keepAlive(), false)
})

// ---------------------------------------------------------------------------
// 命令确认（审批）也推到手机上
// ---------------------------------------------------------------------------

/** 起一个插件、绑好会话，把审批钩子连着两个能力一起交给用例。 */
async function bootApprovalHook({ phone = true, outcome = null, rejects = false } = {}) {
  const p = await bootPlugin()
  const sessionId = 'sess-approval'
  await fetch(`${p.base}/mini/api/bind?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })

  const saved = { hasPhone: miniControl.hasPhone, askApproval: miniControl.askApproval }
  const calls = []
  miniControl.hasPhone = () => phone
  miniControl.askApproval = (...args) => {
    calls.push(args)
    if (rejects) return Promise.reject(new Error('模拟：接管审批出错了'))
    return Promise.resolve(outcome)
  }

  return {
    p,
    sessionId,
    calls,
    hook: p.handlers.get('approval/request'),
    restore: () => {
      miniControl.hasPhone = saved.hasPhone
      miniControl.askApproval = saved.askApproval
      p.stop()
    },
  }
}

test('审批钩子：插到队首、普通函数，手机在就把结论原样交回电脑', async (t) => {
  const h = await bootApprovalHook({ outcome: 'allowed-once' })
  t.after(h.restore)

  assert.ok(h.hook, '必须挂上这个钩子，否则手机永远收不到审批')
  assert.equal(h.p.handlerOptions.get('approval/request')?.prepend, true, '不插队就永远轮不到')
  assert.notEqual(h.hook.constructor.name, 'AsyncFunction', 'async 函数里「让路」交不回派发链条')

  const got = await h.hook({ agent: { id: h.sessionId }, toolName: 'shell', callId: 'c1' }, () => {
    throw new Error('手机在的时候不该让给电脑')
  })
  assert.equal(got, 'allowed-once')
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0][2], '', '取不到命令原文时就交空串，手机那张卡上会明说没取到')
  assert.equal(typeof h.calls[0][3]?.onPending, 'function')
  assert.equal(h.calls[0][3].keepAlive(), false, '飞书没开：和以前一样')
})

test('审批钩子：手机不在、飞书也没开，原样让给电脑', async (t) => {
  const h = await bootApprovalHook({ phone: false, outcome: 'allowed-once' })
  t.after(h.restore)

  let handed = 0
  const got = await h.hook({ agent: { id: h.sessionId }, toolName: 'shell' }, () => { handed += 1; return '电脑来批' })
  assert.equal(got, '电脑来批')
  assert.equal(handed, 1)
  assert.equal(h.calls.length, 0, '两边都不在时不该把审批推出去')
})

test('审批钩子：问的不是手机上绑的那个会话，让路（连推都不推）', async (t) => {
  const h = await bootApprovalHook({ outcome: 'allowed-once' })
  t.after(h.restore)

  let handed = 0
  const got = await h.hook({ agent: { id: 'sess-别的' }, toolName: 'shell' }, () => { handed += 1; return '电脑来批' })
  assert.equal(got, '电脑来批')
  assert.equal(handed, 1)
  assert.equal(h.calls.length, 0)
})

test('审批钩子：接管出错了、或者手机上没拍成，都要还给电脑（不能吞掉）', async (t) => {
  const broken = await bootApprovalHook({ rejects: true })
  const empty = await bootApprovalHook({ outcome: null })
  t.after(broken.restore)
  t.after(empty.restore)

  for (const h of [broken, empty]) {
    let handed = 0
    const got = await h.hook({ agent: { id: h.sessionId }, toolName: 'shell' }, () => { handed += 1; return '电脑来批' })
    assert.equal(got, '电脑来批', '出了错也不能把审批吞掉，否则电脑上什么都不弹')
    assert.equal(handed, 1)
  }
})

// ---------------------------------------------------------------------------
// 点开一个会话，就该看到它**完整**的历史（2026-09-25 用户提的要求）
//
// 这一组的判据是「从 HTTP 那一头看出去的事实」：绑一个插件从没见过的会话，
// 然后看快照里的 history / latest 到底是什么。中间用假的会话记录服务顶替
// DSH 自己的记录（真机上是 DSH 从内存或日志里给出来的那一串原始事件）。
// ---------------------------------------------------------------------------

/** 一段会话记录：[[问, 答], ...] → 一串会话事件，时间从 start 开始递增。 */
function logOf(pairs, start = 1_700_000_000_000) {
  const events = []
  let clock = start
  const at = () => (clock += 1000)
  for (const [ask, answer] of pairs) {
    events.push(
      { ...ev('turn/start', { turn: 1 }), time: at() },
      { ...ev('user/message', { source: { kind: 'user' }, content: text(ask) }), time: at() },
      { ...ev('assistant/message', { message: { content: text(answer) } }), time: at() },
      { ...ev('turn/end', { turn: 1, reason: { kind: 'completed' } }), time: at() },
    )
  }
  return events
}

/**
 * 假的会话记录服务。`logs` 里没有的会话会抛——真机上老日志格式对不上就是这样，
 * 「读不出来怎么办」也得是一条走过的路。
 */
function fakeQuery(logs) {
  const calls = []
  let gate = null
  return {
    calls,
    /** 把下一次读挂住，用来观察「正在读」那一刻手机看到的是什么。 */
    holdNext() {
      let open
      const promise = new Promise((r) => { open = r })
      gate = { promise, open }
      return gate
    },
    async readSession(id) {
      calls.push(id)
      const held = gate
      gate = null
      if (held) await held.promise
      const events = logs[id]
      if (!events) throw new Error('没有这个会话的记录')
      return { session: { id }, events }
    },
  }
}

async function bindSession(p, sessionId) {
  const res = await fetch(`${p.base}/mini/api/bind?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
  return res.json()
}

/**
 * 把一串事件写成**盘上的会话日志**（拼接 zstd 帧，跟真机一个形状：每批一个帧）。
 *
 * 为什么测试需要它：切一个没选中的会话，读历史有两条路——盘上有日志就走自己那条窗口读
 * （lib/log-tail.js），盘上没有才回退内核那条。前面那些用例用的是假会话记录服务，
 * 等于只在测回退那条；有了这个函数才测得到日常那条。
 */
function writeSessionLog(home, sessionId, events) {
  const dir = join(home, 'sessions', '--tmp-ws--', sessionId)
  mkdirSync(dir, { recursive: true })
  const frames = []
  for (let i = 0; i < events.length; i += 5) {
    frames.push(zstdCompressSync(Buffer.from(
      events.slice(i, i + 5).map((e) => JSON.stringify(e)).join('\n') + '\n',
    )))
  }
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
}

/** 等快照满足条件：读记录是后台动作，读完才广播新快照。 */
async function waitSnap(p, ok, what) {
  for (let i = 0; i < 100; i += 1) {
    const snap = await snapOf(p)
    if (ok(snap)) return snap
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('等不到：' + what)
}

test('点开一个没看过的会话：聊天模式能看到它之前的每一轮', async (t) => {
  const query = fakeQuery({
    'sess-old': logOf([['第一问', '第一答'], ['第二问', '第二答']]),
  })
  const p = await bootPlugin({ sessionQuery: query })
  t.after(p.stop)

  // 绑定之前，这个会话插件一次都没见过——历史是空的（这就是用户报的那个现象）
  const before = await snapOf(p)
  assert.deepEqual(before.history, [])

  await bindSession(p, 'sess-old')
  const snap = await waitSnap(p, (s) => s.history.length === 4, '四轮历史读回来')

  assert.deepEqual(snap.history.map((m) => `${m.role}:${m.text}`), [
    'user:第一问', 'assistant:第一答', 'user:第二问', 'assistant:第二答',
  ], '用户指令和最终回复都要在，而且要按发生的顺序排')
  assert.equal(snap.boundSessionId, 'sess-old')
})

test('点开一个没看过的会话：单帧模式显示最后一条最终回复', async (t) => {
  const query = fakeQuery({
    'sess-old': logOf([['第一问', '第一答'], ['第二问', '第二答']]),
  })
  const p = await bootPlugin({ sessionQuery: query })
  t.after(p.stop)

  await bindSession(p, 'sess-old')
  const snap = await waitSnap(p, (s) => s.latest, '最后一条回复读回来')

  assert.equal(snap.latest.text, '第二答', '单帧模式要的是最后那一条，不是最前面那条')
  assert.ok(snap.latest.timestamp > 0, '时间戳要带出来，手机上显示的是这个会话发生的时间')
})

test('点开一个睡着的会话：日志在盘上就自己读，不去惊动内核那条整份读', async (t) => {
  // 假会话记录服务里一条日志都没有 → 只要它被叫到就会抛。所以 query.calls 为 0
  // 这件事本身，就是「没有走内核 readSession」的证据。
  const query = fakeQuery({})
  const p = await bootPlugin({ sessionQuery: query })
  t.after(p.stop)

  writeSessionLog(p.home, 'sess-cold', logOf([['第一问', '第一答'], ['第二问', '第二答']]))
  const res = await bindSession(p, 'sess-cold')

  // 自己读那条是同步的（解压 + 重放，微秒到百毫秒级），所以 bind 的响应里就该带着历史，
  // 不必再等一趟 SSE——这也是「手机上点一下就该看到」的一部分。
  assert.deepEqual(res.state.history.map((m) => `${m.role}:${m.text}`), [
    'user:第一问', 'assistant:第一答', 'user:第二问', 'assistant:第二答',
  ], '盘上有日志就该把它读出来，内容一条不少')
  assert.equal(query.calls.length, 0,
    '盘上有日志时不许走内核那条整份读：实测它要先把全部会话列两遍（1.7–3.6 秒）')
  assert.equal(res.state.historyLoading, false, '读完了就该是「读完了」，不能还挂在「正在读」')
})

test('小会话只是被条数上限截断时，不许对用户说「这个会话很大」', async (t) => {
  const pairs = []
  for (let i = 1; i <= 205; i += 1) pairs.push([`问${i}`, `答${i}`])
  const p = await bootPlugin({ sessionQuery: fakeQuery({}) })
  t.after(p.stop)

  writeSessionLog(p.home, 'sess-long', logOf(pairs))
  await bindSession(p, 'sess-long')
  const snap = await waitSnap(p, (s) => s.history.length === 200, '截到上限那 200 条')

  assert.equal(snap.historyTruncated, true, '少了就是少了，要如实说')
  assert.ok(snap.historyNote.includes('读取上限'), '要告诉用户为什么不是全部')
  assert.ok(!snap.historyNote.includes('很大'),
    '窗口盖住了整份日志、只是条数到上限——这时候说「这个会话很大」是假话')
})

test('读记录的这一会儿，要告诉手机「正在读」，不能让它显示成空会话', async (t) => {
  const query = fakeQuery({ 'sess-old': logOf([['问', '答']]) })
  const held = query.holdNext()
  const p = await bootPlugin({ sessionQuery: query })
  t.after(p.stop)

  const res = await bindSession(p, 'sess-old')
  assert.equal(res.state.historyLoading, true,
    '读的时候得说实话：不然手机上会显示「还没有对话记录」，看起来这个会话是空的')

  held.open()
  const snap = await waitSnap(p, (s) => s.history.length === 2, '读完')
  assert.equal(snap.historyLoading, false, '读完了就该把「正在读」收掉')
})

test('读记录：同一个会话不会反复读（否则点一下就翻一次盘）', async (t) => {
  const query = fakeQuery({ 'sess-old': logOf([['问', '答']]) })
  const p = await bootPlugin({ sessionQuery: query })
  t.after(p.stop)

  await bindSession(p, 'sess-old')
  await waitSnap(p, (s) => s.history.length === 2, '第一次读完')
  // 再绑一次，并且在中间多问几次状态（手机刷新、SSE 重连都会问）
  await snapOf(p)
  await snapOf(p)
  await bindSession(p, 'sess-old')
  await new Promise((r) => setTimeout(r, 50))

  assert.equal(query.calls.length, 1, '一分钟内同一个会话只读一次，读完就记着')
})

test('记录读不出来（老日志对不上）：退回手里那份，不编，也不卡在「正在读」', async (t) => {
  // logs 里没有这个会话 → 假服务会抛，对应真机上老日志读不出来的情况
  const query = fakeQuery({})
  const p = await bootPlugin({ sessionQuery: query })
  t.after(p.stop)

  const res = await bindSession(p, 'sess-broken')
  assert.equal(res.ok, true, '读不出来不能影响绑定本身')
  assert.equal(res.state.historyLoading, true, '刚绑定那一刻确实在读')

  const snap = await waitSnap(p, (s) => s.historyLoading === false, '读完（哪怕失败）')
  assert.deepEqual(snap.history, [], '没有就是没有，不能编一段出来')
  assert.equal(snap.latest, null)
})

test('合成：记录里那份 + 刚发生还没落进日志的那一条，接在后面', async (t) => {
  // 记录里那份的旧时间戳（2023），下面灌进去的「活的那一轮」时间戳是现在
  const query = fakeQuery({ 'sess-m': logOf([['老问题', '老回答']]) })
  const p = await bootPlugin({ sessionQuery: query })
  t.after(p.stop)

  const session = { id: 'sess-m', header: { id: 'sess-m' } }
  const handle = p.handlers.get('session/event')
  // 这批事件的时间戳得是**现在**：它代表「刚发生、日志里还没有」。
  // 原来这里和上面那份用同一个默认起点（2023），只靠 Date.now() 让它显得新；
  // 时间戳改成取自事件之后，这个「新」必须写在夹具里，否则它就真是 2023 的事了。
  for (const e of logOf([['刚问的', '刚答的']], Date.now())) handle(session, e)

  await bindSession(p, 'sess-m')
  const snap = await waitSnap(p, (s) => s.history.length >= 2, '读回来')

  assert.deepEqual(snap.history.map((m) => m.text).slice(-2), ['刚问的', '刚答的'],
    '刚发生的那一轮要接在记录的后面——不然手机上会少了眼前这一幕')
  assert.equal(snap.latest.text, '刚答的')
})

test('合成：记录里已经有的那几条，不会因为手里也记着就显示两遍', async (t) => {
  // 记录里那几条的时间戳在「现在」之后（模拟日志已经写进去了），
  // 手里这份虽然也记着同样的事，但时间不比它新，就不该再接一遍
  const query = fakeQuery({ 'sess-dup': logOf([['问', '答']], Date.now() + 60_000) })
  const p = await bootPlugin({ sessionQuery: query })
  t.after(p.stop)

  const session = { id: 'sess-dup', header: { id: 'sess-dup' } }
  const handle = p.handlers.get('session/event')
  for (const e of logOf([['问', '答']])) handle(session, e)

  await bindSession(p, 'sess-dup')
  const snap = await waitSnap(p, (s) => s.history.length >= 1, '读回来')

  assert.deepEqual(snap.history.map((m) => m.text), ['问', '答'],
    '同一轮只能出现一次——接重了用户会以为自己问了两次')
})

test('合成：手里那份和记录里那份，用的是同一个钟——差一毫秒就会显示两遍', async (t) => {
  // 2026-09-27 用户实机报的：一条指令在手机上显示两遍。
  // 根源不是记了两笔，而是**两边各记一笔、时间戳差 1 毫秒**，合成就把同一条
  // 当成了新的一条接在后面。硬件上实测的差是 .358 与 .359。
  //
  // 这条测试模拟的是最普通的一幕：插件**亲眼看见**了这一轮（session/event），
  // 硬盘里也已经有了同一轮（读记录重放）。两边是同一批事件，时间戳就该一模一样。
  const events = logOf([['问', '答']])
  const query = fakeQuery({ 'sess-clock': events })
  const p = await bootPlugin({ sessionQuery: query })
  t.after(p.stop)

  const session = { id: 'sess-clock', header: { id: 'sess-clock' } }
  const handle = p.handlers.get('session/event')
  for (const e of events) handle(session, e)

  await bindSession(p, 'sess-clock')
  const snap = await waitSnap(p, (s) => s.history.length >= 2, '读回来')

  assert.deepEqual(snap.history.map((m) => m.text), ['问', '答'],
    '同一轮只能出现一次——手里那份要是用了比记录晚的时间戳，就会再接一遍')
})

test('实时：聊天记录每条都带轮号（完整模式要把轨迹穿插进对话，靠它对号）', async (t) => {
  const events = logOf([['问', '答']])
  const query = fakeQuery({ 'sess-turn': events })
  const p = await bootPlugin({ sessionQuery: query })
  t.after(p.stop)

  const session = { id: 'sess-turn', header: { id: 'sess-turn' } }
  const handle = p.handlers.get('session/event')
  for (const e of events) handle(session, e)

  await bindSession(p, 'sess-turn')
  const snap = await waitSnap(p, (s) => s.history.length >= 2, '读回来')

  assert.deepEqual(snap.history.map((m) => [m.role, m.turn]), [['user', 1], ['assistant', 1]],
    '用户指令和回答都得知道自己是第几轮的，否则轨迹块插不回原位')
})

test('没有会话记录服务时（headless 组合）：行为跟以前一样，不出错', async (t) => {
  const p = await bootPlugin() // 不传 sessionQuery
  t.after(p.stop)

  const res = await bindSession(p, 'sess-noservice')
  assert.equal(res.ok, true)
  assert.deepEqual(res.state.history, [])
  assert.equal(res.state.historyLoading, false)
})

// ---------------------------------------------------------------------------
// 斜杠指令：手机上打 `/` 能列出并执行 DSH 的指令
// ---------------------------------------------------------------------------

/**
 * 假的指令账本，形状照抄 DSH 的 `ctx.commands`（list / find / execute）。
 * 记下每一次执行——「整行原文原样交给 DSH」是这里最要紧的一条断言。
 */
function fakeCommands(descriptors) {
  const calls = []
  return {
    calls,
    list: () => descriptors,
    find: (_agent, name) => descriptors.find((d) => d.name === name),
    execute: async (agent, line, attachments, signal) => {
      calls.push({ agent, line, attachments, signal })
      return { commandId: 'c1', result: { kind: 'success', text: '好了' } }
    },
  }
}

/** 一个「还活着」的 agent：指令面只认活着的会话。 */
const liveAgent = (id) => ({ id, status: 'idle', session: { header: { id } } })

const getCommands = async (p) => (await fetch(`${p.base}/mini/api/commands?token=${p.token}`)).json()
const postCommand = async (p, line) => {
  const res = await fetch(`${p.base}/mini/api/command?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line }),
  })
  return { status: res.status, body: await res.json() }
}

test('指令名单：问的是 DSH 自己的账本，手机不另维护一份', async (t) => {
  const commands = fakeCommands([
    { name: 'goal', description: 'Set a goal', input: { hint: 'want to achieve', attachments: true } },
    { name: 'compact', description: 'Compact the context' },
  ])
  const p = await bootPlugin({ agents: { 'sess-c': liveAgent('sess-c') }, commands })
  t.after(p.stop)

  await bindSession(p, 'sess-c')
  const body = await getCommands(p)
  assert.equal(body.ok, true)
  assert.deepEqual(body.commands.map((c) => c.name), ['compact', 'goal'])
  assert.equal(body.commands[1].hint, 'want to achieve')
  assert.equal(body.commands[1].attachments, true)
})

test('指令名单：会话没在跑就说清楚，不能回一个空名单', async (t) => {
  // 空名单的意思是「一条指令都没有」——而这里是「拿不到」，用户该做的是把会话跑起来。
  const p = await bootPlugin({ commands: fakeCommands([{ name: 'compact', description: 'x' }]) })
  t.after(p.stop)

  await bindSession(p, 'sess-sleeping')
  const body = await getCommands(p)
  assert.equal(body.ok, false)
  assert.match(body.error, /没在跑/)
  assert.equal(body.commands, undefined, '拿不到就不给名单，别让手机显示成「没有指令」')
})

test('指令名单：这台电脑没有指令服务时（headless 组合）如实说没有', async (t) => {
  const p = await bootPlugin({ agents: { 'sess-c': liveAgent('sess-c') } }) // 不传 commands
  t.after(p.stop)

  await bindSession(p, 'sess-c')
  const body = await getCommands(p)
  assert.equal(body.ok, false)
  assert.match(body.error, /没提供指令/)
})

test('执行指令：整行原文原样交给 DSH，一个附件都不带', async (t) => {
  const commands = fakeCommands([{ name: 'goal', description: 'x', input: { hint: 'y' } }])
  const p = await bootPlugin({ agents: { 'sess-c': liveAgent('sess-c') }, commands })
  t.after(p.stop)

  await bindSession(p, 'sess-c')
  const { status, body } = await postCommand(p, '/goal 拿到三个客户')
  assert.equal(status, 200)
  assert.equal(body.ok, true)

  assert.equal(commands.calls.length, 1)
  // 参数不许我们代拆：DSH 的契约里 rawInput 含分隔空白，由指令自己解释。
  assert.equal(commands.calls[0].line, '/goal 拿到三个客户')
  assert.deepEqual(commands.calls[0].attachments, [],
    '手机上传的小票和指令要的不是同一套东西，宁可一个都不传，也不能拿错东西顶上')
  assert.ok(commands.calls[0].signal, '得给 DSH 一个可中止的信号')
})

test('执行指令：不等它跑完就回话（结果走事件流）', async (t) => {
  // 像 /compact 那种要跑十几秒的指令，如果这条请求等它跑完，手机上就是「点了没反应」。
  const never = { list: () => [{ name: 'compact', description: 'x' }], find: () => ({ name: 'compact' }), execute: () => new Promise(() => {}) }
  const p = await bootPlugin({ agents: { 'sess-c': liveAgent('sess-c') }, commands: never })
  t.after(p.stop)

  await bindSession(p, 'sess-c')
  const { status, body } = await postCommand(p, '/compact')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
})

test('执行指令：没有这条指令就拒绝，绝不退回去当普通消息发给模型', async (t) => {
  const commands = fakeCommands([{ name: 'compact', description: 'x' }])
  const p = await bootPlugin({ agents: { 'sess-c': liveAgent('sess-c') }, commands })
  t.after(p.stop)

  await bindSession(p, 'sess-c')
  const { status, body } = await postCommand(p, '/xyz')
  assert.equal(status, 409)
  assert.equal(body.ok, false)
  assert.equal(body.error, '没有 /xyz 这条指令。')
  assert.equal(commands.calls.length, 0, '认不出来就不该执行任何东西')
})

test('执行指令：形状不对时说语法，不说「没这条指令」', async (t) => {
  const commands = fakeCommands([])
  const p = await bootPlugin({ agents: { 'sess-c': liveAgent('sess-c') }, commands })
  t.after(p.stop)

  await bindSession(p, 'sess-c')
  // DSH 的名字必须以小写字母开头：`/9x` 连指令都不是，和「没这条指令」是两回事。
  const { body } = await postCommand(p, '/9x')
  assert.equal(body.ok, false)
  assert.match(body.error, /小写字母/)
  assert.equal(commands.calls.length, 0)
})

test('执行指令：会话没在跑时拒绝，别拿着旧会话去跑', async (t) => {
  const commands = fakeCommands([{ name: 'compact', description: 'x' }])
  const p = await bootPlugin({ commands })
  t.after(p.stop)

  await bindSession(p, 'sess-sleeping')
  const { status, body } = await postCommand(p, '/compact')
  assert.equal(status, 409)
  assert.match(body.error, /没在跑/)
  assert.equal(commands.calls.length, 0)
})

test('指令事件：手机上新长出一条「指令」行，不是用户的气泡', async (t) => {
  const p = await bootPlugin({ agents: { 'sess-c': liveAgent('sess-c') } })
  t.after(p.stop)
  await bindSession(p, 'sess-c')

  const session = { id: 'sess-c', header: { id: 'sess-c' } }
  const handle = p.handlers.get('session/event')
  handle(session, ev('command/run', { commandId: 'c1', name: 'compact', args: '' }))

  const snap = await waitSnap(p, (s) => s.history.some((m) => m.role === 'command'), '指令行出现')
  const row = snap.history.at(-1)
  assert.equal(row.role, 'command', '指令不是用户说的话，也不是模型的回答，是第三种')
  assert.equal(row.name, 'compact')
  assert.equal(row.kind, 'running')
  assert.equal(snap.history.filter((m) => m.role === 'user').length, 0,
    '指令绝不能长成一条用户气泡——手机上那会分不清「这句是谁说的」')
  assert.equal(snap.latest, null, '指令不是「最终回复」，单帧模式不该拿它顶上')
})

test('合成：同一条指令，硬盘那份还写着「执行中」，手里那份已经拿到结果', async (t) => {
  // 读日志的那一瞬间 /compact 确实还在跑（它要跑十几秒，而一分钟重读一次日志，
  // 撞上的机会不小），所以硬盘那份只有 command/run。手里这份后来收到了收尾。
  // 关键是两条的时间戳**一样**（同一条 run 事件）——只按时间戳接尾的话，
  // 手里那条接不上去，手机上会一直挂着「执行中」直到下一次重读。
  const at = 1_700_000_000_000 + 5000
  const runEvent = {
    type: 'command/run', seq: 0, time: at,
    data: { commandId: 'c1', name: 'compact', args: '' },
  }
  const query = fakeQuery({ 'sess-cmd': [...logOf([['问', '答']]), runEvent] })
  const p = await bootPlugin({ agents: { 'sess-cmd': liveAgent('sess-cmd') }, sessionQuery: query })
  t.after(p.stop)

  const session = { id: 'sess-cmd', header: { id: 'sess-cmd' } }
  const handle = p.handlers.get('session/event')
  handle(session, runEvent)
  handle(session, {
    type: 'command/done', seq: 0, time: at + 5000,
    data: { commandId: 'c1', kind: 'success', text: '压好了' },
  })

  await bindSession(p, 'sess-cmd')
  // 等到硬盘那份真的读回来了（「答」只可能来自日志），才能断言合成结果。
  const snap = await waitSnap(p, (s) => s.history.some((m) => m.text === '答'), '读回来')

  const cmds = snap.history.filter((m) => m.role === 'command')
  assert.equal(cmds.length, 1, '同一条指令不能出现两行')
  assert.equal(cmds[0].kind, 'success', '手里那份已经收尾了，不能还挂着硬盘里那个「执行中」')
  assert.equal(cmds[0].text, '压好了')
  assert.equal(cmds[0].timestamp, at, '时间戳还是那条事件自己的，不是收尾那一刻')
})

test('指令事件：收尾只改那一条，单帧模式显示的还是模型那句回答', async (t) => {
  const p = await bootPlugin({ agents: { 'sess-c': liveAgent('sess-c') } })
  t.after(p.stop)
  await bindSession(p, 'sess-c')

  const session = { id: 'sess-c', header: { id: 'sess-c' } }
  const handle = p.handlers.get('session/event')
  // 先跑完一轮真实的对话，单帧模式里就有了一句回答。
  for (const e of logOf([['问一句', '答完了']])) handle(session, e)
  await waitSnap(p, (s) => s.latest?.text === '答完了', '回答落地')

  handle(session, ev('command/run', { commandId: 'c9', name: 'compact', args: '' }))
  await waitSnap(p, (s) => s.history.some((m) => m.role === 'command'), '指令行出现')
  handle(session, ev('command/done', { commandId: 'c9', kind: 'error', text: '压不动' }))

  const snap = await waitSnap(p, (s) => s.history.at(-1)?.kind === 'error', '收尾')
  assert.equal(snap.history.filter((m) => m.role === 'command').length, 1, '收尾是改那一条，不是再加一条')
  assert.equal(snap.history.at(-1).text, '压不动')
  assert.equal(snap.latest.text, '答完了', '指令跑完不该顶掉单帧模式里模型那句回答')
})

// ---------------------------------------------------------------------------
// 清单里的版本声明：DSH 的兼容门槛只读 peerDependencies（2026-09-27 补）
// ---------------------------------------------------------------------------

test('版本要求要写在门槛真正会读的那一格：peerDependencies', () => {
  // DSH 0.1.7 起，profile 导入插件**之前**会拿插件 manifest 里 `@deepseek-ai/dsh` /
  // `@deepseek-ai/dsh-*` 的 peerDependencies 去比运行时版本；对不上就在导入前拦下、
  // 给那一行标 disabled、打印一句诊断，Harness 照常启动。
  //
  // 它**不看 `engines.dsh`**（官方 README 原话：These checks use peer declarations,
  // not `engines.dsh`）。我们原来只写了 engines.dsh——等于这道程序对我们完全不设限：
  // 版本真错位时没人拦、也没有那句诊断，只会安静地加载不起来。
  //
  // engines.dsh 保留：npm 之外的市场/巡检工具读它做适配展示，两处一起写才完整。
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const peer = pkg.peerDependencies?.['@deepseek-ai/dsh']
  assert.equal(typeof peer, 'string', '要在 peerDependencies 里声明 @deepseek-ai/dsh')
  assert.ok(peer.trim() !== '' && peer !== '*', '范围不能空着或用通配——那等于没声明')
  assert.ok(peer.includes('0.1.5-rc.2'), '下界要和 engines.dsh 一致（我们承诺的兼容起点）')
  assert.equal(pkg.engines?.dsh, '>=0.1.5-rc.2', 'engines.dsh 保留，给市场显示用')
  assert.ok(!pkg.dependencies?.['@deepseek-ai/dsh'],
    '@deepseek-ai/* 绝不能进 dependencies：旧副本会遮蔽宿主')
  // schemastery 是唯一一个 import 了运行时值的 @deepseek-ai/* 包（用来声明 Config），
  // 它也只许走 peer：由宿主提供，进了 dependencies 就会出现第二份副本。
  assert.ok(pkg.peerDependencies?.['@deepseek-ai/schemastery'],
    'schemastery 要声明在 peerDependencies 里')
  assert.ok(!pkg.dependencies?.['@deepseek-ai/schemastery'],
    'schemastery 不能进 dependencies：会出现第二份副本')
})

// ---------------------------------------------------------------------------
// 标准化的配置声明（DSH 0.1.7 起：标了 volatile 的字段改了不用重载插件）
// ---------------------------------------------------------------------------

test('旧版 schemastery 上没有 volatile() 时，插件也要照样起得来', async () => {
  const mod = await import(new URL(`lib/index.js?t=${Date.now()}`, ROOT_URL).href)
  const z = (await import('@deepseek-ai/schemastery')).default

  // 3.18.1／3.18.2 的 schema 上根本没有 volatile 这个方法；而且 DSH 0.1.5 声明的
  // 依赖范围 `^3.18.2` 是可以落到那一版上的，直接调用会在加载插件的那一刻抛异常，
  // 整个插件起不来——这个插件一贯是"少了哪样就关掉哪一块"，不能栽在一句标注上。
  const old = { meta: {}, description: () => old }
  assert.equal(mod.markVolatile(old), old, '没有 volatile() 就原样返回，绝不能抛异常')

  // 有这个方法时要真的标上（本机装的就是有它的版本）
  assert.equal(mod.markVolatile(z.string()).meta?.volatile, true, '有 volatile() 时要真的标上')
})

test('声明成 volatile 的字段只有那两个：能兑现的才标', async () => {
  const mod = await import(new URL(`lib/index.js?t=${Date.now()}`, ROOT_URL).href)
  const dict = mod.Config?.dict
  assert.ok(dict, '插件要导出 Config：标准那条编辑通道和 profile 补丁都按它来')

  const volatile = Object.entries(dict).filter(([, s]) => s?.meta?.volatile).map(([k]) => k).sort()
  assert.deepEqual(volatile, ['defaultMode', 'notify'],
    '多标一个是谎话（DSH 就不再重载，而我们手里还是旧值），少标一个就白白多重载一次')

  assert.deepEqual(Object.keys(dict).sort(),
    ['bindAddress', 'defaultMode', 'feishu', 'maxHistory', 'notify', 'port', 'token', 'tunnel'],
    '每个设置都该在声明里露面，否则标准通道看不见它')
  // 飞书那一块**故意不标 volatile**：它的长连接是拿 appId/appSecret 建的，改了凭据
  // 就得把连接整个换掉，"就地改一个值"兑现不了。上面那条 volatile 清单因此不该有它。

  // 只查标量字段：`z.object()` 这种整组字段天生带一个空对象默认值，而空对象合进
  // deepMerge 等于没变（无害）；真正会盖住用户设置的是标量字段上的默认值。
  for (const key of ['port', 'bindAddress', 'token', 'maxHistory', 'defaultMode']) {
    assert.equal(dict[key].meta?.default, undefined,
      `${key} 不许写 .default()：schema 默认值会被 Loader 落进 config，` +
      '盖住用户存在 settings.json 里的值（内置默认值只写在 DEFAULTS 一处）')
  }
})

test('volatile 字段是现读的：引用一变就生效，且标准配置没写时仍用我们自己那份', async (t) => {
  // undefined = 标准 config 没显式写这个字段（schema 里没写 .default()，所以没写就是 undefined）
  let mode
  // 真机上 config 里的 volatile 字段是"引用"（`.get()` 取值），不是普通值——这里照着搭。
  const p = await bootPlugin({
    stored: { defaultMode: 'chat' },              // 用户自己那份 settings.json
    config: { defaultMode: { get: () => mode } }, // profile 补丁给的那份（这里是引用）
  })
  t.after(() => p.stop())

  const page = async () => (await fetch(`${p.base}/?token=${p.token}`)).text()

  assert.match(await page(), /var DEFAULT_MODE = 'chat';/,
    '标准 config 没显式写（get() 给 undefined）时，settings.json 那份照旧生效')
  mode = 'minimal'
  assert.match(await page(), /var DEFAULT_MODE = 'minimal';/,
    '引用一变，下一页就是新值——说明是在用的时候现读，不是加载时抄了一份')

  // notify 走的是同一个循环（liveConfig 按 Config 里标了 volatile 的字段统一接线），
  // 所以上面这一条就够证明这套接线是活的；换成整组对象也走同一条路。
})

test('上下文用量：窗口来自 request/context，分子把缓存读缓存写一起算上', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)

  const feed = p.handlers.get('session/event')
  const session = { id: 'sess-ctx', header: { id: 'sess-ctx' } }
  const readState = async () => (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  const ctxOf = (state, id) => (state.sessions || []).find((s) => s.id === id)?.context ?? null

  // 只报了窗口、还没跑过任何一步：用量还不知道，此时**不能**凭空给一个数
  feed(session, ev('request/context', { provider: 'deepseek', model: 'm', contextWindow: 200000 }))
  assert.equal(ctxOf(await readState(), 'sess-ctx'), null, '只知道窗口时宁可空着，也不编')

  // 走一步：usage 的三块计数互不重叠，加起来才是这次请求的输入
  feed(session, ev('assistant/message', {
    turn: 1, step: 1,
    usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 40000, cacheWriteTokens: 2000 },
    message: { content: text('好') },
  }))
  assert.deepEqual(ctxOf(await readState(), 'sess-ctx'), { used: 43000, window: 200000 },
    '缓存读、缓存写要一起算——少加一块，量出来的用量会偏小，越长的一轮偏得越多')

  // 没走过 request/context 的会话没有分母，就不该有数
  const other = { id: 'sess-nowin', header: { id: 'sess-nowin' } }
  feed(other, ev('assistant/message', { turn: 1, step: 1, usage: { inputTokens: 500 }, message: { content: text('喂') } }))
  assert.equal(ctxOf(await readState(), 'sess-nowin'), null, '缺分母就别写，宁可空着')
})

test('上下文用量：插件起来晚了，分母要从会话自己折叠的那份补上', async (t) => {
  // 用户 2026-09-28 报「手机上看不到上下文用量」。根因不在页面上：`request/context`
  // 这条事件一个会话**只写一次**（DSH 只在路由变了时才写，本机实测两千多步的会话
  // 也只有一条），就在会话第一次发请求那一刻。插件要是晚一步起来，那条早进日志了，
  // 光等事件的分母永远是空的 → 分子分母凑不齐 → 页面上那句就永远不出现。
  //
  // 所以分母还有第二条来源：`session.requestContext()`（DSH 把日志里最后那条
  // request/context 折叠在会话对象上，重启也在）。这条用例就是钉住它：
  // **一条 request/context 都不发**，照样要有数。
  const p = await bootPlugin()
  t.after(p.stop)

  const feed = p.handlers.get('session/event')
  const readState = async () => (await fetch(`${p.base}/mini/api/state?token=${p.token}`)).json()
  const ctxOf = (state, id) => (state.sessions || []).find((s) => s.id === id)?.context ?? null

  const late = {
    id: 'sess-late',
    header: { id: 'sess-late' },
    requestContext: () => ({ provider: 'deepseek', model: 'm', contextWindow: 200000 }),
  }
  feed(late, ev('assistant/message', {
    turn: 1, step: 1,
    usage: { inputTokens: 1000, cacheReadTokens: 40000, cacheWriteTokens: 2000 },
    message: { content: text('好') },
  }))
  assert.deepEqual(ctxOf(await readState(), 'sess-late'), { used: 43000, window: 200000 },
    '没等到 request/context 也要有数：分母问会话自己要，且缓存读写一起算')

  // 会话对象上没有这条折叠（老接口、假会话）时，仍旧不许编。
  const noFold = { id: 'sess-nofold', header: { id: 'sess-nofold' }, requestContext: () => undefined }
  feed(noFold, ev('assistant/message', { turn: 1, step: 1, usage: { inputTokens: 500 }, message: { content: text('喂') } }))
  assert.equal(ctxOf(await readState(), 'sess-nofold'), null, '折叠里没有窗口就还是没有，别拿别的数顶上')
})

test('上下文用量：内存里没有就问日志要一份（插件起来晚了也有数可看）', async (t) => {
  // 上一条修的是「会话正在跑」时的那条路。这一条修的是「会话还没跑、手机已经在看」：
  // /mini/api/models 是手机每 15 秒问一次的接口，插件刚起来时内存里空着，
  // 得能从 DSH 的会话记录里翻出**同样真实**的一份（最后一条 request/context 是分母，
  // 最后一次 usage 是分子），否则用户看到的还是空。
  const logs = {
    'sess-sleep': [
      { ...ev('request/context', { provider: 'deepseek', model: 'm', contextWindow: 262144 }), seq: 1 },
      { ...ev('user/message', { source: { kind: 'user' }, content: text('干活') }), seq: 2 },
      { ...ev('assistant/message', {
        turn: 1, step: 1,
        usage: { inputTokens: 2000, cacheReadTokens: 60000 },
        message: { content: text('好') },
      }), seq: 3 },
    ],
    'sess-half': [
      // 只有 usage、没有窗口：缺一半 → 一个字都不给
      { ...ev('assistant/message', { turn: 1, step: 1, usage: { inputTokens: 800 }, message: { content: text('喂') } }), seq: 1 },
    ],
  }
  const sessionController = { modelCatalog: async () => ({ groups: [] }) }
  const p = await bootPlugin({ sessionQuery: fakeQuery(logs), sessionController })
  t.after(p.stop)

  const models = async () => (await fetch(`${p.base}/mini/api/models?token=${p.token}`)).json()

  await bindSession(p, 'sess-sleep')
  assert.deepEqual((await models()).context, { used: 62000, window: 262144 },
    '日志里两半都齐就该给出来——这就是手机上要显示的那个数')

  await bindSession(p, 'sess-half')
  assert.equal((await models()).context, null, '只有分子没有分母时仍旧空着，不拿别的数凑')
})

// ---------------------------------------------------------------------------
// 飞书那一块：设置页上的路由
// ---------------------------------------------------------------------------
// 这一版做的是「飞书里发消息 → 会话 → 回答回飞书」，入站出站的规矩在
// test/lark.test.mjs 里钉着。这里钉的是**它怎么接到设置页上**：谁改得动、
// 凭据不往外送、填错了要说清是哪一环。真连飞书需要用户自己的凭据，这里只走
// 「填错形状」那条路——它在加载 SDK 之前就停住了，不会碰网络。

const FEISHU_ROUTE = '/mini-remote/feishu'
/** 形状正确但不存在的 appId：用来验证「形状不对」和「连不上」是两件事。 */
const FEISHU_APP_ID = 'cli_0123456789abcdef'

test('飞书配置：只有本机改得动，而且只接受 POST', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)
  const route = p.routes.get(FEISHU_ROUTE)
  assert.ok(route, '这一块要挂上路由，否则设置页里改不了')

  const denied = fakeRes()
  await route.handler(fakeReq('192.168.1.50', { method: 'POST', body: '{}' }), denied)
  assert.equal(denied.out.status, 403, '那是一对凭据，不能让局域网里的别人替你做主')

  const wrong = fakeRes()
  await route.handler(fakeReq('127.0.0.1'), wrong)
  assert.equal(wrong.out.status, 405)

  const bad = fakeRes()
  await route.handler(fakeReq('127.0.0.1', { method: 'POST', body: 'not json' }), bad)
  assert.equal(bad.out.status, 400, '请求体不是 JSON 要给 400，而不是崩掉')
})

test('飞书配置：appSecret 不回显，留空保存 = 不动原来那份', async (t) => {
  const p = await bootPlugin({
    config: { feishu: { enabled: false, appId: FEISHU_APP_ID, appSecret: 'sec-do-not-leak', openIds: 'ou_me' } },
  })
  t.after(p.stop)

  // 面板上不能出现那串凭据本身，只能说「有一份」。
  const read = fakeRes()
  await p.routes.get('/mini-remote/pairing').handler(fakeReq('127.0.0.1'), read)
  assert.ok(!read.out.body.includes('sec-do-not-leak'), 'appSecret 绝不能进浏览器')
  assert.equal(JSON.parse(read.out.body).feishu.hasSecret, true, '但要告诉界面「已经有一份了」')

  // 界面上那个框天生是空的，所以「留空」只能解释成「不改动原来那份」。
  const save = fakeRes()
  await p.routes.get(FEISHU_ROUTE).handler(fakeReq('127.0.0.1', {
    method: 'POST',
    body: JSON.stringify({ enabled: false, appId: FEISHU_APP_ID, openIds: 'ou_me\nou_other', chatIds: '' }),
  }), save)
  const saved = JSON.parse(readFileSync(join(p.home, 'dsh-mini-remote', 'settings.json'), 'utf8'))
  assert.equal(saved.feishu.appSecret, 'sec-do-not-leak', '留空不该把凭据清掉')
  assert.equal(saved.feishu.openIds, 'ou_me\nou_other', '名单要落盘')
  assert.equal(JSON.parse(save.out.body).feishu.hasSecret, true)
})

test('飞书配置：appId 形状不对时把原因透到面板上，而不是静默失败', async (t) => {
  // 实测：SDK 的 start() 不抛错，appId 正则不匹配时只打一行日志就返回——
  // 用户看到的现象是「开关开着、什么都没发生」。所以形状这一关要自己把话说清楚。
  const p = await bootPlugin({
    config: { feishu: { enabled: true, appId: 'cli_bad', appSecret: 's', openIds: 'ou_me' } },
  })
  t.after(p.stop)

  const res = fakeRes()
  await p.routes.get(FEISHU_ROUTE).handler(fakeReq('127.0.0.1', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, appId: 'cli_bad', openIds: 'ou_me', chatIds: '' }),
  }), res)

  const payload = JSON.parse(res.out.body)
  assert.equal(payload.feishu.enabled, true, '用户点了开关，这个意愿要认')
  assert.equal(payload.feishu.running, false, '形状都不对，连接当然没挂上')
  assert.match(payload.feishu.error, /appId/, '要指名道姓说是哪一环出的问题')
})

test('飞书配置：关着的时候不建连接，面板上也看得见「没开」', async (t) => {
  const p = await bootPlugin({ config: { feishu: { enabled: false, appId: FEISHU_APP_ID, appSecret: 's' } } })
  t.after(p.stop)
  const read = fakeRes()
  await p.routes.get('/mini-remote/pairing').handler(fakeReq('127.0.0.1'), read)
  const feishu = JSON.parse(read.out.body).feishu
  assert.equal(feishu.enabled, false)
  assert.equal(feishu.running, false, '默认关：不许自己偷偷连出去')
  assert.equal(feishu.error, null)
  assert.equal(feishu.openIds, '', '名单空着——默认谁都不认')
  assert.equal(feishu.chatIds, '')
})

// ---------------------------------------------------------------------------
// 子智能体（2026-10-03）
//
// smoke.test.mjs 那一层把 nav 换成了桩，只验接口契约。这一层**把插件真跑起来**，
// 直接打它自己的端口，覆盖 lib/index.js 里那一段：数字从哪来、什么该拦在门外、
// 什么必须如实说读不到。两个层次各管一段，缺一边就有盲区。
// ---------------------------------------------------------------------------

/** 打插件自己的端口，带上 token。返回 [状态码, 解析后的 body]。 */
async function apiCall(p, path, { method = 'GET', body = null } = {}) {
  // path 里可能已经带了查询串（`/mini/api/subagent?id=…`），那就用 & 接。
  // 再写一个 ? 的话，token 会被当成前一个参数值的一部分，请求就成了 401。
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`${p.base}${path}${sep}token=${p.token}`, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  return [res.status, await res.json()]
}

test('子智能体：数读不到就留空，不写成 0——「没跑过」和「读不到」是两句话', async (t) => {
  // 真机上老早跑完、进程里已经不在的子智能体就是拿不到会话对象。那时候两个数
  // 都该是 null，页面上写「—」。写成 0 会被读成「一次都没跑过」。
  const p = await bootPlugin({
    agents: { s1: {} },
    // sessions / sessionProjections 都**不给**——走的正是「读不到」那条路。
    subagents: {
      listDescendants: async () => [
        { id: 'session-a', parentId: 's1', depth: 1, mode: 'continuable', label: '查重复依赖', activity: 'running' },
        { id: 'session-b', parentId: 's1', depth: 1, mode: 'one-shot', label: '', activity: 'idle' },
      ],
    },
  })
  t.after(p.stop)
  await bindSession(p, 's1')

  const [status, body] = await apiCall(p, '/mini/api/subagents')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.subagents.map((s) => s.tokens), [null, null], '读不到就是 null，不是 0')
  assert.deepEqual(body.subagents.map((s) => s.durationMs), [null, null])
  assert.deepEqual(body.subagents.map((s) => s.running), [true, false])
  assert.deepEqual(body.subagents.map((s) => s.mode), ['continuable', 'one-shot'])
  assert.equal(body.subagents[0].label, '查重复依赖')
  assert.equal(body.boundSessionId, 's1')
})

test('子智能体：会话在、投影也在，但那个数没算出来时，照样留空', async (t) => {
  // 「投影在」不等于「这两个数就有」。一个刚起来、还没跑完第一轮的子智能体就是
  // 这样：拿得到会话对象，投影里却还是空的。这时候写 0 就是凭空编一个数。
  const p = await bootPlugin({
    agents: { s1: {} },
    subagents: {
      listDescendants: async () => [
        { id: 'session-a', parentId: 's1', depth: 1, mode: 'continuable', activity: 'running' },
      ],
    },
    sessions: { get: (id) => ({ id }) },
    sessionProjections: { snapshot: () => ({ values: {} }) },
  })
  t.after(p.stop)
  await bindSession(p, 's1')

  const [, body] = await apiCall(p, '/mini/api/subagents')
  assert.equal(body.subagents[0].tokens, null, '投影里没有这一项，就是「还不知道」，不是 0')
  assert.equal(body.subagents[0].durationMs, null, '耗时同理：没掷过就是没掷过')
  assert.equal(body.subagents[0].lastTurnCompleted, null, '不知道最后跑成没成，不该猜成成功')
})

test('子智能体：耗时和用量从投影里取，四个桶互不重叠地相加', async (t) => {
  const asked = []
  const p = await bootPlugin({
    agents: { s1: {} },
    subagents: {
      listDescendants: async () => [
        { id: 'session-a', parentId: 's1', depth: 1, mode: 'continuable', label: '查依赖', activity: 'running' },
      ],
    },
    sessions: { get: (id) => (id === 'session-a' ? { id } : undefined) },
    sessionProjections: {
      snapshot: (session, keys) => {
        asked.push([session.id, keys])
        return {
          values: {
            // 跑完的两轮 5000 + 还开着那一轮（4000 − 1000）= 8000
            subagentTiming: { settledMs: 5000, active: { since: 1000, through: 4000 }, lastTurnCompleted: true },
            tokenUsage: {
              uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 7,
            },
          },
        }
      },
    },
  })
  t.after(p.stop)
  await bindSession(p, 's1')

  const stream = await fetch(`${p.base}/mini/api/stream?token=${p.token}`)
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  async function readUntil(name) {
    while (!buffer.includes('event: ' + name)) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
    }
    const match = new RegExp('event: ' + name + '\\ndata: ([^\\n]+)').exec(buffer)
    return match ? JSON.parse(match[1]) : null
  }
  await readUntil('state')
  const [, body] = await apiCall(p, '/mini/api/subagents')
  assert.equal(body.subagents[0].tokens, null, '首屏先返回清单，指标不应阻塞')
  const metrics = await readUntil('subagent-metrics')
  assert.equal(metrics.childId, 'session-a', '指标事件要对应子智能体')
  assert.equal(metrics.tokens, 427, '四个桶互不重叠，直接相加')
  assert.equal(metrics.durationMs, 8000, '跑完那段 + 还开着那一轮')
  assert.equal(metrics.lastTurnCompleted, true, '绿点和灰点靠它分')
  // 只要这两个投影——多要一个就是白算一遍。
  assert.deepEqual(asked, [['session-a', ['subagentTiming', 'tokenUsage']]])
  await reader.cancel()
})

test('子智能体：读投影时抛错也只当「读不到」，不把整份清单搭进去', async (t) => {
  const p = await bootPlugin({
    agents: { s1: {} },
    subagents: {
      listDescendants: async () => [
        { id: 'session-a', parentId: 's1', depth: 1, mode: 'one-shot', activity: 'idle' },
      ],
    },
    sessions: { get: (id) => ({ id }) },
    sessionProjections: { snapshot: () => { throw new Error('投影坏了') } },
  })
  t.after(p.stop)
  await bindSession(p, 's1')

  const [, body] = await apiCall(p, '/mini/api/subagents')
  assert.equal(body.ok, true, '一个数读不出来，不该把整份清单搭进去')
  assert.equal(body.subagents.length, 1)
  assert.equal(body.subagents[0].tokens, null)
})

test('子智能体：有一支目录读不动时如实转达，不当作没有', async (t) => {
  // 吞掉的表现是「明明有子代理，却一个都不显示」，用户完全不知道发生了什么。
  const p = await bootPlugin({
    agents: { s1: {} },
    subagents: {
      listDescendants: async () => [
        { kind: 'diagnostic', id: 'session-bad', reason: 'corrupt' },
        { id: 'session-a', parentId: 's1', depth: 1, mode: 'one-shot', activity: 'idle' },
      ],
    },
  })
  t.after(p.stop)
  await bindSession(p, 's1')

  const [, body] = await apiCall(p, '/mini/api/subagents')
  assert.equal(body.subagents.length, 2, '诊断那一行也要占一个位置')
  assert.deepEqual(body.subagents[0], { id: 'session-bad', diagnostic: 'corrupt' })
  assert.equal(body.subagents[1].mode, 'one-shot')
})

test('子智能体：没绑会话时如实说，不去 DSH 那儿空问一趟', async (t) => {
  let asked = 0
  const p = await bootPlugin({
    agents: { s1: {} },
    subagents: { listDescendants: async () => { asked += 1; return [] } },
  })
  t.after(p.stop)

  const [, body] = await apiCall(p, '/mini/api/subagents')
  assert.equal(body.ok, false)
  assert.match(body.error, /还没有绑定会话/)
  assert.equal(asked, 0, '没绑会话就没有「谁的子智能体」可问')
})

test('子智能体：一次性的没有可停的轮次——这句人话由插件说，且不往 DSH 递', async (t) => {
  const calls = []
  const p = await bootPlugin({
    agents: { s1: {} },
    subagents: {
      listDescendants: async () => [
        { id: 'session-b', parentId: 's1', depth: 1, mode: 'one-shot', activity: 'idle' },
      ],
      interruptByParent: async (...args) => { calls.push(args) },
    },
  })
  t.after(p.stop)
  await bindSession(p, 's1')

  const [status, body] = await apiCall(p, '/mini/api/subagent/stop', {
    method: 'POST', body: { id: 'session-b', mode: 'one-shot' },
  })
  assert.equal(status, 409)
  assert.equal(body.error, '这是一次性子智能体，跑完就结束，没有可停的轮次。')
  assert.deepEqual(calls, [], '一次性的根本不该递下去')
})

test('子智能体：停可续接的那一道，三个凭据原样递给 DSH', async (t) => {
  const calls = []
  const p = await bootPlugin({
    agents: { s1: {} },
    subagents: {
      listDescendants: async () => [
        { id: 'session-a', parentId: 's1', depth: 1, mode: 'continuable', activity: 'running' },
      ],
      interruptByParent: async (...args) => { calls.push(args) },
    },
  })
  t.after(p.stop)
  await bindSession(p, 's1')

  const [status, body] = await apiCall(p, '/mini/api/subagent/stop', {
    method: 'POST', body: { id: 'session-a', mode: 'continuable' },
  })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(calls, [['session-a', 's1', 'continuable']])
  // 递进去不等于停稳——「等它的状态翻过来」由页面负责，插件不假装已经完成。
  assert.equal(body.stopped, undefined)
})

test('子智能体：读记录先确认它挂在当前会话名下——地址不能当权限', async (t) => {
  const q = fakeQuery({ 'session-a': [] })
  const p = await bootPlugin({
    agents: { s1: {} },
    subagents: {
      listDescendants: async () => [
        { id: 'session-a', parentId: 's1', depth: 1, mode: 'continuable', activity: 'running' },
      ],
    },
    sessionQuery: q,
  })
  t.after(p.stop)
  await bindSession(p, 's1')

  const [, body] = await apiCall(p, '/mini/api/subagent?id=session-别人的')
  assert.equal(body.ok, false)
  assert.match(body.error, /不在当前会话名下/)
  // 绑会话本身会读一次 `s1`（那是它该读的），但那个**别人的 id** 一个字节都不该被读。
  assert.ok(!q.calls.includes('session-别人的'), '没通过这一关，不该去读它')
})

test('子智能体：它自己的记录走的是和主会话同一个重放器', async (t) => {
  const logs = {
    'session-a': [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'user/message', seq: 1, time: 2,
        data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '看看有没有重复依赖' }] },
      },
      {
        type: 'assistant/message', seq: 2, time: 3,
        data: { message: { content: [{ type: 'text', text: '有两条重复，已经删掉一条。' }] } },
      },
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  }
  const p = await bootPlugin({
    agents: { s1: {} },
    subagents: {
      listDescendants: async () => [
        { id: 'session-a', parentId: 's1', depth: 1, mode: 'continuable', activity: 'idle' },
      ],
    },
    sessionQuery: fakeQuery(logs),
  })
  t.after(p.stop)
  await bindSession(p, 's1')

  const [, body] = await apiCall(p, '/mini/api/subagent?id=session-a')
  assert.equal(body.ok, true)
  assert.deepEqual(body.entries.map((e) => [e.role, e.text]),
    [['user', '看看有没有重复依赖'], ['assistant', '有两条重复，已经删掉一条。']])
  assert.equal(body.mode, 'continuable')
  assert.equal(body.running, false)
  assert.equal(body.reclaimed, false)
})

test('子智能体：记录已被回收时如实说「没有记录」，不冒充「它没干过活」', async (t) => {
  const p = await bootPlugin({
    agents: { s1: {} },
    subagents: {
      listDescendants: async () => [
        { id: 'session-a', parentId: 's1', depth: 1, mode: 'one-shot', activity: 'idle' },
      ],
    },
    sessionQuery: fakeQuery({ 'session-a': [] }),
  })
  t.after(p.stop)
  await bindSession(p, 's1')

  const [, body] = await apiCall(p, '/mini/api/subagent?id=session-a')
  assert.equal(body.ok, true, '这是「读到了：没有」，不是「读不到」')
  assert.equal(body.reclaimed, true)
  assert.deepEqual(body.entries, [])
})

test('子智能体：继续说一句，请求原样递给 DSH', async (t) => {
  const seen = []
  const p = await bootPlugin({
    agents: { s1: {} },
    subagents: {
      listDescendants: async () => [
        { id: 'session-a', parentId: 's1', depth: 1, mode: 'continuable', activity: 'idle' },
      ],
      prompt: async (request) => { seen.push(request); return { messageId: 'm-9' } },
    },
  })
  t.after(p.stop)
  await bindSession(p, 's1')

  const [status, body] = await apiCall(p, '/mini/api/subagent/ask', {
    method: 'POST', body: { id: 'session-a', mode: 'continuable', text: '顺手把测试也补上' },
  })
  assert.equal(status, 200)
  assert.equal(body.messageId, 'm-9')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].parentSessionId, 's1')
  assert.equal(seen[0].childSessionId, 'session-a')
  assert.equal(seen[0].mode, 'continuable')
  // 排队而不是插队：和手机对主会话的做法一致——正在跑的时候不打断。
  assert.equal(seen[0].delivery, 'queue')
  assert.deepEqual(seen[0].content, [{ type: 'text', text: '顺手把测试也补上' }])
  // requestId 是这条消息的身份，**每次都得是新铸的**：复用会被判成重复投递。
  assert.ok(typeof seen[0].requestId === 'string' && seen[0].requestId.length > 0)
})

test('子智能体：一次性的接不了话，人话由插件说', async (t) => {
  const p = await bootPlugin({
    agents: { s1: {} },
    subagents: {
      listDescendants: async () => [
        { id: 'session-b', parentId: 's1', depth: 1, mode: 'one-shot', activity: 'idle' },
      ],
      prompt: async () => { throw new Error('不该走到这儿') },
    },
  })
  t.after(p.stop)
  await bindSession(p, 's1')

  const [status, body] = await apiCall(p, '/mini/api/subagent/ask', {
    method: 'POST', body: { id: 'session-b', mode: 'one-shot', text: '还在吗' },
  })
  assert.equal(status, 409)
  assert.equal(body.error, '这是一次性子智能体，跑完就结束了，接不了话。')
})

test('子智能体：父会话不在线时，DSH 的代号翻成一句人话', async (t) => {
  // 用户看到的不该是 PARENT_UNAVAILABLE 这种代号，也不该是一串英文堆栈。
  const p = await bootPlugin({
    agents: { s1: {} },
    subagents: {
      listDescendants: async () => [
        { id: 'session-a', parentId: 's1', depth: 1, mode: 'continuable', activity: 'idle' },
      ],
      prompt: async () => {
        const err = new Error('parent agent is gone')
        err.code = 'PARENT_UNAVAILABLE'
        throw err
      },
    },
  })
  t.after(p.stop)
  await bindSession(p, 's1')

  const [status, body] = await apiCall(p, '/mini/api/subagent/ask', {
    method: 'POST', body: { id: 'session-a', mode: 'continuable', text: '在吗' },
  })
  assert.equal(status, 409)
  assert.equal(body.error, '它在的那个会话不在线了，这条发不过去。')
})

test('子智能体：并发满了、认不出的代号，也都要说得出人话', async (t) => {
  const mk = async (code) => {
    const p = await bootPlugin({
      agents: { s1: {} },
      subagents: {
        listDescendants: async () => [
          { id: 'session-a', parentId: 's1', depth: 1, mode: 'continuable', activity: 'idle' },
        ],
        prompt: async () => {
          const err = new Error(`boom ${code}`)
          err.code = code
          throw err
        },
      },
    })
    await bindSession(p, 's1')
    const out = await apiCall(p, '/mini/api/subagent/ask', {
      method: 'POST', body: { id: 'session-a', mode: 'continuable', text: '在吗' },
    })
    p.stop()
    return out
  }

  assert.deepEqual(await mk('ACTIVATION_LIMIT_REACHED'),
    [409, { ok: false, error: '同时能跑的子智能体已经到上限了，等一个跑完再试。' }])
  assert.deepEqual(await mk('NOT_RESUMABLE'),
    [409, { ok: false, error: '这道子智能体没有对话可以接，只能看它跑过什么。' }])
  // 认不出的代号**不吞也不编**：把人话和原始信息一起带出去。
  const [, unknown] = await mk('SOMETHING_NEW')
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /这句话没送出去/)
  assert.match(unknown.error, /SOMETHING_NEW/)
})

test('子智能体：这台电脑没有这个能力时，如实说没有，不是给空清单', async (t) => {
  // 「没有能力」和「这个会话真的没派过子智能体」是两句不同的话。
  const p = await bootPlugin({ agents: { s1: {} } })
  t.after(p.stop)
  await bindSession(p, 's1')

  const [, list] = await apiCall(p, '/mini/api/subagents')
  assert.equal(list.ok, false)
  assert.match(list.error, /没提供子智能体/)

  const [stopStatus, stop] = await apiCall(p, '/mini/api/subagent/stop', {
    method: 'POST', body: { id: 'session-a', mode: 'continuable' },
  })
  assert.equal(stopStatus, 409, '能力缺位也是「做不了」，不是 500')
  assert.match(stop.error, /没提供/)
})

// ---------------------------------------------------------------------------
// 执行轨迹（「完整」模式）：把过程搬到手机
//
// 判据和上面一样，是「从 HTTP 那一头看出去的事实」：真插件、真服务、真 SSE。四件事：
//   ① 声明了完整模式的那条连接收得到**增量**（新加的那几条 + 改了的那几笔），
//      别的连接一个字节都不收；
//   ② 过程**不进回答区、不进聊天记录、不进快照**——这一条是这次改动最要紧的边界；
//   ③ 只推手机正在遥控的那个会话；别的会话的过程照样攒着，切过去用接口拉；
//   ④ 关掉一个睡着的会话，日志里的过程要能重放出来。
// ---------------------------------------------------------------------------

/** 连一条能带查询串的 SSE 流，攒下每一帧的**名字和解析后的 data**。 */
async function openTraceStream(url) {
  const res = await fetch(url)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const stream = { status: res.status, frames: [], reader }
  let buffer = ''
  ;(async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let i
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, i + 2)
        buffer = buffer.slice(i + 2)
        const m = /^event: ([^\n]+)\ndata: ([^\n]*)/.exec(raw)
        if (m) stream.frames.push({ name: m[1], data: JSON.parse(m[2]) })
      }
    }
  })().catch(() => {})
  return stream
}

/** 等到攒够 n 条某名字的帧（或超时）。 */
async function waitFrames(stream, name, n, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (stream.frames.filter((f) => f.name === name).length < n) {
    if (Date.now() > deadline) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return stream.frames.filter((f) => f.name === name).map((f) => f.data)
}

test('执行轨迹：「完整」模式收到的是增量，聊天模式一个字节都不收', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)
  await bindSession(p, 'sess-1')
  const feed = p.handlers.get('session/event')
  const session = { id: 'sess-1', header: { id: 'sess-1' } }

  const chat = await openTraceStream(`${p.base}/mini/api/stream?token=${p.token}&clientId=chat`)
  const full = await openTraceStream(`${p.base}/mini/api/stream?token=${p.token}&full=1&clientId=phone`)
  await waitFrames(chat, 'state', 1)
  await waitFrames(full, 'state', 1)

  feed(session, ev('turn/start', { turn: 1 }))
  feed(session, ev('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      content: [
        { type: 'reasoning', text: '先看看现在是什么版本' },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"README.md"}' },
      ],
    },
  }))
  feed(session, ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"README.md"}' }))
  feed(session, ev('tool/result', {
    turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: text('版本是 22') },
  }))
  feed(session, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))

  const frames = await waitFrames(full, 'trajectory', 5)
  assert.equal(frames.length, 5, '一轮下来五帧：起轮、思考、工具步、结果、收尾')
  assert.deepEqual(frames.map((f) => [f.state, f.add.length, f.update.length]), [
    ['running', 0, 0],   // turn/start：手机上那一组先立起来
    [null, 1, 0],        // 思考（正文只在「完整」模式里出现）
    [null, 1, 0],        // 工具步，正在跑
    [null, 0, 1],        // 结果回来，**只补那一笔**（不是重发整轮）
    ['done', 0, 0],      // 收尾
  ])
  assert.deepEqual(frames.map((f) => f.seq), [1, 2, 3, 4, 5], '帧序号一格一格走，客户端靠它认出漏帧')
  assert.equal(frames[1].add[0].kind, 'think')
  assert.equal(frames[1].add[0].output, '先看看现在是什么版本')
  assert.equal(frames[2].add[0].name, 'read')
  assert.equal(frames[2].add[0].summary, 'README.md', '折叠行给的是参数摘要，原始参数在 args 里')
  assert.equal(frames[2].add[0].args, '{"path":"README.md"}')
  assert.equal(frames[3].update[0].id, frames[2].add[0].id, '结果补的是那一次调用')
  assert.equal(frames[3].update[0].state, 'ok')
  assert.equal(frames[3].update[0].output, '版本是 22')
  assert.equal(frames[0].sessionId, 'sess-1')
  assert.equal(frames[0].turn, 1)
  assert.equal(frames[0].epoch, frames[4].epoch, '同一代服务的编号一样')
  assert.ok(frames[0].epoch.length > 0, '帧里要带这一代服务的编号——重连后靠它认出服务重启过')

  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(chat.frames.filter((f) => f.name === 'trajectory').length, 0,
    '没声明完整模式的那条，轨迹一个字节都不收')
  await chat.reader.cancel()
  await full.reader.cancel()
})

test('执行轨迹：过程一个字都不进回答区、不进聊天记录、不进快照', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)
  await bindSession(p, 'sess-1')
  const feed = p.handlers.get('session/event')
  const session = { id: 'sess-1', header: { id: 'sess-1' } }
  const answer = 'README 的安装部分已更新为 Node 22+。'

  feed(session, ev('user/message', { source: { kind: 'user' }, content: text('帮我看下 README') }))
  feed(session, ev('turn/start', { turn: 1 }))
  feed(session, ev('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      content: [
        { type: 'reasoning', text: '先看看现在是什么版本' },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"README.md"}' },
      ],
    },
  }))
  feed(session, ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"README.md"}' }))
  feed(session, ev('tool/result', {
    turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: text('版本是 22') },
  }))
  feed(session, ev('assistant/message', { turn: 1, step: 2, message: { content: text(answer) } }))
  feed(session, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))

  const snap = await snapOf(p)
  assert.equal(snap.latest.text, answer, '回答区还是那一句回答，一个字都没变')
  assert.equal(snap.history.filter((m) => m.role === 'assistant').length, 1)
  const dump = JSON.stringify(snap)
  assert.ok(!dump.includes('先看看现在是什么版本'), '思考不许进回答区、不许进聊天记录')
  assert.ok(!dump.includes('版本是 22'), '工具的结果也一样')
  assert.ok(!dump.includes('tool-call'), '过程留下的任何痕迹都不许进快照')
  assert.equal(snap.trajectory, undefined, '快照里连这个字段都不该有')

  // 没丢：它走了另一条路（GET 是重连/切模式时的补齐口）
  const [code, body] = await apiCall(p, '/mini/api/trajectory?sessionId=sess-1')
  assert.equal(code, 200)
  assert.deepEqual(body.turns[0].entries.map((e) => [e.kind, e.name]), [
    ['think', null], ['tool', 'read'],
  ], '过程在这里，一条不少')
})

test('执行轨迹：只推手机正在遥控的那个会话，别的会话切过去再拉', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)
  await bindSession(p, 'sess-1')
  const feed = p.handlers.get('session/event')
  const phone = { id: 'sess-1', header: { id: 'sess-1' } }
  const desk = { id: 'sess-2', header: { id: 'sess-2' } }

  const full = await openTraceStream(`${p.base}/mini/api/stream?token=${p.token}&full=1&clientId=phone`)
  await waitFrames(full, 'state', 1)

  feed(phone, ev('turn/start', { turn: 1 }))
  feed(phone, ev('assistant/message', {
    turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: '手机上这个会话在想' }] },
  }))
  // 电脑上另开的那个会话：过程不该震手机（和 reply 那条同一个口径）
  feed(desk, ev('turn/start', { turn: 1 }))
  feed(desk, ev('assistant/message', {
    turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: '电脑上那个会话在想' }] },
  }))

  const frames = await waitFrames(full, 'trajectory', 2)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.ok(frames.every((f) => f.sessionId === 'sess-1'), '推的全是手机正在看的那个会话')
  assert.equal(full.frames.filter((f) => f.name === 'trajectory' && f.data.sessionId === 'sess-2').length, 0,
    '别的会话的过程不该推')
  await full.reader.cancel()

  // 但它没丢：切过去（或者事后点开）用接口拉得到
  const [, other] = await apiCall(p, '/mini/api/trajectory?sessionId=sess-2')
  assert.deepEqual(other.turns.map((g) => [g.turn, g.entries.map((e) => e.output)]), [
    [1, ['电脑上那个会话在想']],
  ])
})

test('执行轨迹：子智能体的会话一条都不进轨迹', async (t) => {
  // 和「子 agent 的回答不进手机」同一条纪律：用户遥控的是自己的主会话，不是它派出去的小弟。
  const p = await bootPlugin({ agents: { s1: {} } })
  t.after(p.stop)
  await bindSession(p, 's1')
  const feed = p.handlers.get('session/event')
  const child = { id: 'child-1', header: { id: 'child-1', origin: 'subagent', parentSession: 's1' } }

  feed(child, ev('turn/start', { turn: 1 }))
  feed(child, ev('assistant/message', {
    turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: '子 agent 的想法' }] },
  }))

  const [, body] = await apiCall(p, '/mini/api/trajectory?sessionId=child-1')
  assert.deepEqual(body.turns, [], '子 agent 的过程不该进手机')
})

test('执行轨迹：关掉一个睡着的会话，日志里的过程要能重放出来', async (t) => {
  const p = await bootPlugin({ sessionQuery: fakeQuery({}) })
  t.after(p.stop)

  let clock = 1_700_000_000_000
  const at = () => (clock += 1000)
  writeSessionLog(p.home, 'sess-trace', [
    { ...ev('turn/start', { turn: 1 }), time: at() },
    { ...ev('assistant/message', {
      turn: 1, step: 1,
      message: {
        content: [
          { type: 'reasoning', text: '读一下那个文件' },
          { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a.txt"}' },
        ],
      },
    }), time: at() },
    { ...ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.txt"}' }), time: at() },
    { ...ev('tool/result', {
      turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: text('文件内容') },
    }), time: at() },
    { ...ev('assistant/message', { turn: 1, step: 2, message: { content: text('看完了。') } }), time: at() },
    { ...ev('turn/end', { turn: 1, reason: { kind: 'completed' } }), time: at() },
  ])
  // 绑定的同时就会读这个会话的记录（readTailHistory 那条日常路）
  await bindSession(p, 'sess-trace')

  const [code, body] = await apiCall(p, '/mini/api/trajectory?sessionId=sess-trace')
  assert.equal(code, 200)
  assert.equal(body.turns.length, 1)
  assert.equal(body.turns[0].turn, 1)
  assert.equal(body.turns[0].state, 'done', 'completed = 完成')
  assert.deepEqual(body.turns[0].entries.map((e) => [e.kind, e.name, e.state, e.output]), [
    ['think', null, 'ok', '读一下那个文件'],
    ['tool', 'read', 'ok', '文件内容'],
  ], '日志里的过程重放出来：思考 + 工具步，结果已经配上了')

  // 按轮取：只给那一轮；取不存在的轮给空的，不是错
  const [, only] = await apiCall(p, '/mini/api/trajectory?sessionId=sess-trace&turn=1')
  assert.deepEqual(only.turns.map((g) => g.turn), [1])
  const [, none] = await apiCall(p, '/mini/api/trajectory?sessionId=sess-trace&turn=99')
  assert.deepEqual(none.turns, [])
  // 手机重新连上来第一件事就是拉这个接口；不能让它把「正在读」当「没有过程」
  assert.equal(body.loading, false, '读完了就不许再说「正在读」')
  assert.equal(body.epoch.length > 0, true, '接口和帧共用同一代服务编号')
})

test('执行轨迹：切回聊天模式就停推，重连带上 full=1 自己就重新订上', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)
  await bindSession(p, 'sess-1')
  const feed = p.handlers.get('session/event')
  const session = { id: 'sess-1', header: { id: 'sess-1' } }
  const talk = (turn, text0) => {
    feed(session, ev('turn/start', { turn }))
    feed(session, ev('assistant/message', {
      turn, step: 1, message: { content: [{ type: 'reasoning', text: text0 }] },
    }))
  }

  const first = await openTraceStream(`${p.base}/mini/api/stream?token=${p.token}&full=1&clientId=phone-1`)
  await waitFrames(first, 'state', 1)
  talk(1, '第一轮的思考')
  assert.equal((await waitFrames(first, 'trajectory', 2)).length, 2)

  // 切回聊天模式：这条连接不再收
  const [code, off] = await apiCall(p, '/mini/api/trajectory/subscribe', {
    method: 'POST', body: { clientId: 'phone-1', on: false },
  })
  assert.equal(code, 200)
  assert.equal(off.subscribed, false)
  assert.equal(off.connections, 1)
  talk(2, '第二轮的思考')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(first.frames.filter((f) => f.name === 'trajectory').length, 2, '关掉之后不再推')
  await first.reader.cancel()

  // 断线重连：带 full=1 上来就自动订上（不用先握手一次），并靠 epoch + 拉一次接口对齐
  const again = await openTraceStream(`${p.base}/mini/api/stream?token=${p.token}&full=1&clientId=phone-1`)
  await waitFrames(again, 'state', 1)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(again.frames.filter((f) => f.name === 'trajectory').length, 0,
    '刚连上不该补推旧帧——对齐靠那一次接口，不靠重放')
  talk(3, '第三轮的思考')
  const frames = await waitFrames(again, 'trajectory', 2)
  assert.equal(frames.length, 2, '重连之后自动又收得到')
  assert.deepEqual(frames.map((f) => f.turn), [3, 3])
  assert.equal(frames[1].add[0].output, '第三轮的思考')
  await again.reader.cancel()

  // 对齐用的那一次接口：把没亲眼看见的那两轮（手机上那些）也一并给出来
  const [, view] = await apiCall(p, '/mini/api/trajectory?sessionId=sess-1')
  assert.deepEqual(view.turns.map((g) => [g.turn, g.entries.map((e) => e.output)]), [
    [1, ['第一轮的思考']],
    [2, ['第二轮的思考']],
    [3, ['第三轮的思考']],
  ], '三轮都在，重连之后拉一次就能补全')
})

// ---------------------------------------------------------------------------
// 轨迹的活气：思考片段逐字顺出来（2026-10-04 用户解禁「流式不做」，仅完整模式）
// ---------------------------------------------------------------------------
//
// 用户原话：「我想要电脑上那种『正在想的片段一点点顺出来』的活气，完整模式确实可以动
// 『流式不做』那条旧裁决，但是不要影响其他模式。」边界一寸不让：只放思考
// （reasoning-delta）；回答正文（text-delta）照旧等落定；聊天那条连接一个字节都不收；
// 落盘即清——活片段只是「还没落定」的影子，落定的字才留得下来。

test('执行轨迹·活气：思考片段逐字顺出来，回答正文一个字都不流、落盘即清', async (t) => {
  const p = await bootPlugin()
  t.after(p.stop)
  await bindSession(p, 'sess-1')
  const session = { id: 'sess-1', header: { id: 'sess-1' } }
  const agent = { status: 'running', session }
  const stream = p.handlers.get('agent/assistant-stream')
  const feed = p.handlers.get('session/event')

  const full = await openTraceStream(`${p.base}/mini/api/stream?token=${p.token}&full=1&clientId=phone`)
  const chat = await openTraceStream(`${p.base}/mini/api/stream?token=${p.token}&clientId=chat`)
  await waitFrames(full, 'state', 1)
  await waitFrames(chat, 'state', 1)

  stream({ agent, frame: { type: 'start' } })
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '先看看仓库结构' } } })
  const [first] = await waitFrames(full, 'trajectory-live', 1)
  assert.equal(first.detail, '先看看仓库结构', '思考片段要顺出来')
  assert.equal(first.sessionId, 'sess-1')

  // 再来一段思考：片段跟着走（PC 的 live detail 是「当前这一段」）
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '，然后决定从哪儿下手' } } })
  const two = await waitFrames(full, 'trajectory-live', 2)
  assert.ok(String(two[1].detail).includes('然后决定从哪儿下手'), '片段跟着打字走')

  // 回答正文不外泄：text-delta 再多也不进片段
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '这是最终回答的正文' } } })
  await new Promise((resolve) => setTimeout(resolve, 400))
  const leaked = full.frames.filter((f) => f.name === 'trajectory-live')
    .some((f) => String(f.data.detail).includes('最终回答的正文'))
  assert.ok(!leaked, '回答正文一个字都不许进活片段')

  // 落盘即清：这条思考变成真条目了，影子就散
  feed(session, ev('turn/start', { turn: 1 }))
  feed(session, ev('assistant/message', {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'reasoning', text: '先看看仓库结构，然后决定从哪儿下手' }] },
  }))
  const frames = await waitFrames(full, 'trajectory-live', 3)
  assert.equal(String(frames[2].detail), '', '条目落盘就把活片段清掉')

  // 聊天那条连接：一个字节都不收
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(chat.frames.filter((f) => f.name === 'trajectory-live').length, 0,
    '没声明完整模式的连接，活片段也不收')
  await chat.reader.cancel()
  await full.reader.cancel()
})

// ---------------------------------------------------------------------------
// Agent 模式：新建会话时手机上也能选（2026-10-04 用户要求，PC 一直可以）
// ---------------------------------------------------------------------------

test('Agent 模式：模式清单可读（含默认档与坏档），读不到就如实说读不到', async (t) => {
  const p = await bootPlugin({
    agentPresets: {
      defaultId: 'standard',
      list: async () => [
        { id: 'standard' },
        { id: 'ptc', name: '我自己起的名', description: '自建的说明' },
        { id: 'write', name: '写东西', description: '文案与文档' },
        { id: 'old', name: '坏掉的', broken: '插件没装' },
      ],
    },
  })
  t.after(p.stop)
  const [status, body] = await apiCall(p, '/mini/api/agent-presets')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.defaultId, 'standard', '默认哪一档要标出来')
  assert.deepEqual(body.presets.map((x) => x.id), ['standard', 'ptc', 'write', 'old'], '清单原样给，坏档也给（如实）')

  // 名字两条政策（照 PC；用户 2026-10-04 点名「模式选择应该为中文」）：
  // 内置档没自带名字 → 落中文词条表；自建模式声明了自己的名字 → 用它自己的，不翻译。
  const byId = Object.fromEntries(body.presets.map((x) => [x.id, x]))
  assert.equal(byId.standard.name, '标准模式', '内置档落中文词条表')
  assert.match(byId.standard.description, /处理代码、文件和资料/, '说明也照抄 PC 词条表')
  assert.equal(byId.ptc.name, '我自己起的名', '自建的名字不翻译（PC 政策：不翻译用户自造的词）')
  assert.equal(byId.old.broken, '插件没装', '坏档如实带原因')

  // 服务缺席（纯 headless 组合）：如实说没有——不摆一个没得选的选择题。
  const p2 = await bootPlugin()
  t.after(p2.stop)
  const [s2, b2] = await apiCall(p2, '/mini/api/agent-presets')
  assert.equal(s2, 200)
  assert.equal(b2.ok, false)
  assert.equal(b2.reason, 'unavailable', '没有这个能力就说没有')
})

test('Agent 模式：建会话把选中的模式带给 DSH 的 create', async (t) => {
  // 「agentPreset 原样进 create」在 tree.test.mjs 钉；这里钉 HTTP 这一头接得住。
  const calls = []
  const p = await bootPlugin({
    sessionController: { create: async (req) => { calls.push(req); return { sessionId: 'sess-new' } } },
    workspaceRegistry: { list: () => [{ id: 'w1', title: '甲', path: 'I:\\a', sessions: [] }] },
  })
  t.after(p.stop)
  const res = await fetch(`${p.base}/mini/api/workspaces/w1/sessions?token=${p.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentPreset: 'write' }),
  })
  const out = await res.json()
  assert.equal(out.ok, true, `建失败了：${JSON.stringify(out)}`)
  assert.equal(calls[0].agentPreset, 'write', '手机点了哪个模式，create 就收到哪个')
})

/**
 * 手机端「插件」页面（2026-10-04）。
 *
 * 要点是**内置插件到底是什么粒度**。DSH 是「一切皆插件、无特权核心」——一整套系统
 * 由几百个插件模块拼成，所以「内置插件」的真相在 Cordis Loader 的实时条目表里，
 * 不在 npm 包清单里。2026-10-04 用户真机看到内置插件只有 6 个，而 PC 的「内置插件」
 * 页写着「全局 241 + 会话 29」，一眼就看出不对：那一版拿 `listBundles()` 充了数。
 */
test('插件页面：内置插件是 Loader 的条目表，不是 npm 包清单', async (t) => {
  const baseUrl = 'I:\\proj'
  /** 造一条 Loader 条目。分组、disabled、fiber 三个字段是要区分开的三件事。 */
  const entry = (id, name, extra = {}) => ({
    id,
    options: { name, group: extra.group === true },
    disabled: extra.disabled === true,
    ...(extra.fiber === undefined ? {} : { fiber: extra.fiber }),
    parent: { tree: { ctx: { baseUrl } } },
  })

  const p = await bootPlugin({
    pluginPackages: {
      metaOf: (name) => ({
        '@deepseek-ai/dsh-tool-fs': { title: '文件工具', description: '读写文件' },
        '@deepseek-ai/dsh-persona': { title: { en: 'Persona', 'zh-CN': '人设' } },
      })[name],
    },
    loader: {
      entries: function* () {
        yield entry('g1', './group.ts', { group: true }) // 分组只是容器，不是插件
        yield entry('e1', '@deepseek-ai/dsh-tool-fs', { fiber: { state: 2 } })
        yield entry('e2', '@deepseek-ai/dsh-persona', { fiber: { state: 0 } })
        yield entry('e3', 'dsh-advisor-group', { disabled: true })
      },
    },
    agentPresets: {
      compositionInventory: async () => [{
        id: 'standard', name: '标准模式', isDefault: true,
        rows: [
          { entryId: 'r1', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberState: 2 },
          { entryId: null, moduleName: '@deepseek-ai/dsh-tool-pwsh', enabled: 'conditional' },
        ],
      }],
    },
    pluginManager: {
      listBundles: async () => [
        {
          name: '@deepseek-ai/dsh-agent-teams', optional: true, installed: false, enabled: true,
          meta: { title: { 'zh-CN': '智能体团队' }, description: { 'zh-CN': '团队协作' } },
        },
        { name: 'dsh-advisor-group', installed: true, enabled: true, description: '顾问群' },
        { name: '@deepseek-ai/dsh-base', installed: true, enabled: true },
      ],
    },
  })
  t.after(p.stop)

  const out = await (await fetch(`${p.base}/mini/api/plugins?token=${p.token}`)).json()
  assert.equal(out.ok, true)

  // ① 内置＝Loader 条目表（分组跳过），**不是 npm 包的个数**。
  assert.equal(out.entries.length, 3, '全局插件该是 Loader 的条目，不是包')
  assert.deepEqual(out.entries.map((e) => e.title), ['文件工具', '人设', 'advisor-group'],
    '有标题就用标题（本地化对象取中文，字符串原样）；没有才把模块名压成短名：dsh-advisor-group → advisor-group')
  // ② Fiber 状态码要译成词：2=运行中、0=待定；没有 fiber 就是 null，别编一个。
  assert.deepEqual(out.entries.map((e) => e.phase), ['active', 'pending', null])
  assert.deepEqual(out.entries.map((e) => e.enabled), [true, true, false],
    'disabled 的条目如实标已停用')

  // ③ 会话插件＝预设的组合行。'conditional'（带 !!js 条件、要挂载才定得下来）
  //    和 false（确实停用）是两件事，不能混成一个。
  assert.equal(out.presets.length, 1)
  assert.equal(out.presets[0].name, '标准模式')
  assert.deepEqual(out.presets[0].rows.map((r) => [r.title, r.enabled, r.conditional]), [
    ['tool-bash', true, false],
    ['tool-pwsh', false, true],
  ])
})

test('插件页面：三块各带各的错，一块读不到不把另两块弄没', async (t) => {
  const p = await bootPlugin({
    pluginManager: { listBundles: async () => { throw new Error('注册表问不到') } },
    // loader 缺席 = 这台电脑没提供（真机上不会有，但契约里是可选的，得如实说）
  })
  t.after(p.stop)

  const out = await (await fetch(`${p.base}/mini/api/plugins?token=${p.token}`)).json()
  assert.equal(out.bundlesError, '注册表问不到', '包清单读不到要带原话回去')
  assert.equal(out.builtinError, 'unavailable', 'Loader 不在就如实说没有，不拿空清单充数')
  assert.deepEqual(out.entries, [])
  assert.deepEqual(out.bundles, [])
})

/**
 * 官方那一栏的第二半：注册了设置卡片的官方插件（2026-10-04 用户确认官方就是这 8 个）。
 *
 * 这 4 张卡片由**浏览器端**插件在运行时注册，宿主看不见浏览器的插槽注册表，
 * 所以名单只能照 DSH 客户端源码列一张表；但**出不出现**照 DSH 同一条规矩来——
 * 宿主的设置文档 served 了它那几个命名空间才出现。这里钉的就是后半句。
 */
test('插件页面：官方那 4 张设置卡片，按宿主 served 的命名空间决定出不出现', async (t) => {
  const p = await bootPlugin({
    // 真机上 desktop 部署这几个都在（用户截图里 4 张卡都在）
    settings: {
      describe: () => [
        { ns: 'pwsh-sandbox' }, // 终端看 bash-sandbox / pwsh-sandbox 任一个
        { ns: 'agent-loop' },
        { ns: 'subagent' },
        { ns: 'web-search-deepseek' },
      ],
    },
  })
  t.after(p.stop)

  const out = await (await fetch(`${p.base}/mini/api/plugins?token=${p.token}`)).json()
  assert.deepEqual(out.official.map((c) => c.title), ['终端', 'Agent 循环', '子智能体', '网页搜索'],
    '次序照 DSH 的 order：终端 → Agent 循环 → 子智能体 → 网页搜索')
  assert.deepEqual(out.official.map((c) => c.kind), ['card', 'card', 'card', 'card'],
    '带 kind 标记，前端才知道它们不是开关、没有状态徽标')
  assert.equal(out.official[0].description, '限制每条命令最多能跑多久、最多输出多少内容。',
    '文案逐字取自 DSH 自己的语言包，不自己编')
})

test('插件页面：宿主没 served 的设置卡片，手机上也不许凭空出现', async (t) => {
  // 一个只 served 了子智能体「模型选择」那一个命名空间的部署：子智能体卡片仍在
  // （两个命名空间任一个 served 就注册，照 DSH 的 whileServed），另外三张不出现。
  const p = await bootPlugin({
    settings: { describe: () => [{ ns: 'subagent-model-selection-settings' }] },
  })
  t.after(p.stop)

  const out = await (await fetch(`${p.base}/mini/api/plugins?token=${p.token}`)).json()
  assert.deepEqual(out.official.map((c) => c.title), ['子智能体'],
    '两个命名空间任一个 served 就该出现；没 served 的一张都不许多')
})

test('插件页面：问不到设置文档时，官方卡片整块不出现（宁可少画，不凭空多画）', async (t) => {
  const p = await bootPlugin() // 不给 settings
  t.after(p.stop)

  const out = await (await fetch(`${p.base}/mini/api/plugins?token=${p.token}`)).json()
  assert.deepEqual(out.official, [], '问不到就不画——不猜「大概都有」')
  assert.equal(out.officialError, '', '「这台没提供这个能力」不算出错，不该红字吓人')
})

