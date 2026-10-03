/**
 * DSH 极简移动端遥控器 —— 插件端入口。
 *
 * 设计上的三个「不」：
 *   - 不代理 DSH 桌面界面（那是 dsh-pocket 的做法），手机只拿两样东西：
 *     用户发出的指令 + Agent 的最终回复。
 *   - 不监听 waterfall 事件。只订阅纯 emit 事件，避免误吞 agent 的默认行为。
 *   - 不 import 任何 @deepseek-ai/* 的运行时值，只有一个例外：@deepseek-ai/schemastery。
 *     它只用来声明 Config（见下面 export const Config）——DSH 0.1.7 起，只有把字段标成
 *     volatile，改它才不需要重载插件，而声明 schema 绕不开 schemastery。它由宿主提供
 *     （写进 peerDependencies、不进 dependencies，免得出现第二份副本）。
 *     其余照旧：事件契约已经用 .d.ts 核实，消息对象自己造（MessageId 的 brand 在运行时
 *     是恒等函数、不做校验），插件加载期几乎没有外部依赖，也没有 cordis 双副本的坑。
 *
 * 事件契约（DSH 0.1.5-rc.2 实测）：
 *   session/event(session, event)  event = { type, seq, time, data }
 *     ├─ turn/start        data { turn }
 *     ├─ user/message      data UserMessage（source.kind === 'user' 才是人发的）
 *     ├─ assistant/message data { turn, step, message, stream, usage? }
 *     └─ turn/end          data { turn, reason: { kind } }
 *   agent/status({ agent, status })  status ∈ 'idle' | 'running'
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'

import z from '@deepseek-ai/schemastery'

import { createStore } from './store.js'
import { createTurnTracker, visibleText, stepSelfTalk } from './events.js'
import { replayHistory, lastReply } from './history.js'
import { createTrajectoryTracker, replayTrajectory, capTrajectory } from './trajectory.js'
import { readTailEvents, findSessionLog } from './log-tail.js'
import {
  parseSlashLine, describeCommands, commandRow, commandPatch,
  invalidCommandMessage, unknownCommandMessage,
} from './commands.js'
import { createMiniServer, miniControl, sendJson, readBody } from './server.js'
import { sendExternalNotification } from './notify.js'
import { createFeishuChannel, feishuQuestionText, approvalText, FEISHU_TEXT_LIMIT } from './lark.js'
import { reachableAddresses, resolveBindAddresses, isLocalRequest } from './net.js'
import { buildPairing, tunnelUrlFor, tunnelProbeVerdict } from './pairing.js'
import { serveState, serveEnable, serveDisable } from './serve.js'
import { ensureCloudflared } from './cloudflared.js'
import { startTunnel, TUNNEL_HINT } from './tunnel.js'
import { listWorkspaces, listSessionsOf, createSessionIn, createWorkspaceAt } from './tree.js'
import { createTitleCache } from './title-cache.js'
import { createSessionMetaCache } from './session-meta-cache.js'
import { createSubagentCache } from './subagent-cache.js'
import { listRoots, listDirectory, makeDirectory } from './browse.js'
import { listPresets, setPreset, available as presetsAvailable } from './permissions.js'
import { buildId } from './build.js'

export const name = 'dsh-mini-remote'
// `sessionController` 是 DSH 的宿主会话业务接口（`@deepseek-ai/dsh-api-session-controller`
// 挂上 Context 的那个），手机端要改每个会话的模型和思考强度就得靠它。
//
// **这一行单独加是有意的**：注入清单里写错名字不会报错，它会安静地让整个插件不加载——
// 那就不是一行功能坏了，是整个遥控器起不来。所以先只加这行、重启，确认插件还活着，
// 再往上加功能。真出问题也一眼知道是哪儿。
export const inject = ['agents', 'sessionController']

/** 公网隧道起不来时重试几次——向 Cloudflare 注册会偶发超时，实测大约一半概率。 */
const TUNNEL_ATTEMPTS = 3

/**
 * 手机上最多同时挂着几个「传了但还没发出去」的文件。
 *
 * 传完到按下发送之间，那张小票得留在内存里。要是用户传了却不发，这些引用就会一直
 * 挂着。20 是个宽松的上限——同时挂二十个待发文件不现实，而超了就淘汰最早的。
 */
const MAX_PENDING_UPLOADS = 20

/**
 * 飞书里发 `/会话` 最多列几个会话。
 *
 * 10 是「一屏能看完」定的：手机页是把工作区一层层展开看的，飞书里只有一条消息，
 * 列太长要划半天，而这条命令要的只是「切到那一个」。超出的部分如实说还剩多少条
 * （见 lib/lark.js 的 sessionPickText）。
 */
const FEISHU_PICK_MAX = 10

/**
 * 这份代码的构建指纹，加载时算一次。
 * 用来回答「现在应答我的进程，跑的是不是我改的这份代码」——重启期间旧进程还在
 * 应答，「以为在验新代码其实在验旧的」已经踩过两次。
 */
const BUILD = buildId()

const DEFAULTS = {
  port: 3090,
  /**
   * 'auto' = 自动挑出内网和 Tailscale 的地址分别监听，本机也留着（配对页要
   * 在电脑上打得开）。这样手机在家连 Wi-Fi、出门连 Tailscale 都能用，而 WSL
   * 之类的虚拟网卡不开门。也可以填 '127.0.0.1'（只有本机）或具体某个 IP。
   */
  bindAddress: 'auto',
  /**
   * 公网访问：用 cloudflared 快速隧道，让没装 Tailscale 的用户也能从外面连进来。
   *
   * 默认关。开了等于把这个服务挂到公网上——虽然有密码和限速挡着，但那是用户
   * 自己的安全边界，该由他自己决定，不能替他默认打开。
   *
   * 和 Tailscale 的关系是「二选一或都要」：内网那条路一直都在，Tailscale 和
   * 隧道各自解决「出门怎么连」，可以只开一个，也可以都开。
   */
  tunnel: {
    enabled: false,
    /** 留空 = 自动找（系统 PATH → dsh-pocket 下过的那份 → 自己下载） */
    cloudflaredPath: '',
  },
  token: '', // 留空 = 首次启动自动生成 32 位 hex 并落盘
  maxHistory: 50,
  defaultMode: 'minimal',
  notify: {
    enabled: false,
    channel: 'none', // none | bark | ntfy | telegram
    barkUrl: '',
    ntfyUrl: 'https://ntfy.sh',
    ntfyTopic: '',
    telegramBotToken: '',
    telegramChatId: '',
    onlyWhenBackground: true,
    maxLength: 200,
    sound: 'default',
  },
  /**
   * 飞书通路（长连接）。默认关。
   *
   * 为什么默认关：开了之后这台电脑就多了一扇「从飞书进来的门」，该由用户自己决定。
   * 而且**两个名单都空 = 谁都不认**（判据在 lib/lark.js 的 admitSource）——门开着但
   * 名单不填，等于开着没钥匙，这是刻意的默认值。
   */
  feishu: {
    enabled: false,
    appId: '',
    appSecret: '',
    /** 允许的 open_id，一行一个（逗号、分号也行）。空 = 这份名单不设限。 */
    openIds: '',
    /** 允许的 chat_id，同上。两个都空 = 任何来源都不处理。 */
    chatIds: '',
  },
}

/**
 * 给 schema 标上 volatile（"改了不用重载"）。
 *
 * 为什么要绕这一层判断：`.volatile()` 是 schemastery **3.18.3** 才加的方法，3.18.1／3.18.2
 * 都没有。DSH 0.1.5 声明的依赖范围是 `^3.18.2`，是可以落到没有它的那一版上的——那种环境下
 * 直接写 `.volatile()` 会在**加载插件的那一刻**抛异常，整个插件起不来，手机上什么都没有。
 * 这个插件一贯的做法是"少了哪样就关掉哪一块，不整个倒下"，所以这里降级处理：没有这个方法
 * 就原样返回，插件照常可用，只是少了"改配置不用重载"这一条（`liveConfig` 那边也会因此
 * 认不出 volatile 字段，读到的就是普通值，行为与从前一致）。
 */
export function markVolatile(schema) {
  return typeof schema?.volatile === 'function' ? schema.volatile() : schema
}

/**
 * 插件设置的标准声明（DSH 0.1.7 起的做法）。宿主拿它校验 profile 补丁给我们的 config，
 * 设置页那条编辑通道也按它生成表单——**只有标了 volatile 的字段才会出现在那张表单里**。
 *
 * **为什么一个 .default() 都没有**：schema 里的默认值会被 Loader 落进 config，而我们的
 * 合并顺序是 `DEFAULTS < settings.json < config`——那样一来 schema 默认值就会盖住用户存在
 * settings.json 里的值。留空即 undefined，deepMerge 会跳过 undefined，内置默认值照旧只在
 * 下面 DEFAULTS 写一处。
 *
 * **为什么只有两个字段标 .volatile()**：标了就是承诺「改它不用重载插件」，而承诺得在代码里
 * 兑现——这类字段必须用的时候现读（见 liveConfig）。端口和绑定地址要重新监听、隧道要重建、
 * 口令的真相在 token 文件和手机页面的改密入口，这些改完确实要重建插件，就不标：DSH 会替我们
 * 重载，那才是实话。宁可少标，不能乱标。
 */
export const Config = z.object({
  port: z.number().description('手机上打开的那个端口。改了要重载插件（得重新监听）。'),
  bindAddress: z.string().description("监听哪个地址：'auto'、'127.0.0.1' 或具体某个 IP。改了要重载插件。"),
  tunnel: z.object({
    enabled: z.boolean(),
    cloudflaredPath: z.string(),
  }).description('公网隧道（cloudflared）。改了要重载插件。'),
  token: z.string().role('secret')
    .description('访问口令。留空 = 首次启动自动生成；改口令用手机页面上的改密入口，改完要重载插件。'),
  maxHistory: z.number().description('手机端每个会话保留多少条历史。改了要重载插件。'),
  defaultMode: markVolatile(z.string())
    .description("手机打开时默认进哪个模式：'minimal' 或 'chat'。改了立即生效，不用重载。"),
  notify: markVolatile(z.object({
    enabled: z.boolean(),
    channel: z.string(),
    barkUrl: z.string(),
    ntfyUrl: z.string(),
    ntfyTopic: z.string(),
    telegramBotToken: z.string().role('secret'),
    telegramChatId: z.string(),
    onlyWhenBackground: z.boolean(),
    maxLength: z.number(),
    sound: z.string(),
  })).description('外部推送（Bark / ntfy / Telegram）。改了立即生效，不用重载。'),
  /**
   * 飞书这一块**没有**标 volatile（口径见上面那段注释）。
   *
   * 这不是省事：飞书的长连接是用 appId/appSecret 建起来的，改了凭据就得把那条连接
   * 整个换掉——那一步不是「就地改一个值」能兑现的。标了 volatile 等于向 DSH 承诺
   * 「改它不用重载」，而承诺得在代码里兑现。**宁可少标，不能乱标。**
   *
   * 用户实际不会因此多做什么：设置页那一页有自己的保存按钮，存完插件自己就会把连接
   * 换掉（见 restartFeishu）。只有手改 settings.json 的人需要重载一次插件。
   */
  feishu: z.object({
    enabled: z.boolean(),
    appId: z.string(),
    appSecret: z.string().role('secret'),
    openIds: z.string(),
    chatIds: z.string(),
  }).description('飞书（长连接）：机器人的两个凭据与两个允许名单。改了要重载插件（凭据变了得重建连接）。'),
})

function deepMerge(base, ...overrides) {
  const out = { ...base }
  for (const patch of overrides) {
    if (!patch || typeof patch !== 'object') continue
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      out[key] = value && typeof value === 'object' && !Array.isArray(value)
        ? deepMerge(out[key] ?? {}, value)
        : value
    }
  }
  return out
}

function dataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-mini-remote')
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 首次启动生成一个 32 位 hex 的 token 并落盘，之后一直复用。 */
function loadOrCreateToken(dir, configured) {
  if (configured) return configured
  const file = join(dir, 'token')
  const existing = (() => {
    try { return readFileSync(file, 'utf8').trim() } catch { return '' }
  })()
  if (existing) return existing
  const token = randomBytes(16).toString('hex')
  writeFileSync(file, token, { mode: 0o600 })
  return token
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * 造一条用户消息。等价于 @deepseek-ai/dsh-llm 的 createUserMessage：
 *   createMessage = deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }))
 * 而 MessageId 的 brand 在运行时不做任何校验（见 dsh-llm/lib/types/brand.d.ts）。
 *
 * `files` 是手机传上来的附件引用（`FileAttachmentRef`，原样来自 DSH 的附件服务，
 * 绝不自己构造——那个结构里有文件名消毒和引用校验，手搓会在校验上失败）。
 * 消息的 content 是块数组，附件就是其中一种块（`{type:'file', attachment}`）；
 * DSH 在发请求前会自动把它换成一段带路径的提示文字，模型靠自己的文件工具去读。
 */
function userMessage(text, files = []) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...files.map((attachment) => ({ type: 'file', attachment })),
    ],
    source: { kind: 'user' },
  })
}

/**
 * 把标了 volatile 的配置字段接到 settings 上：读的时候现取，不在加载时抄一份。
 *
 * 为什么必须现取：DSH 对 volatile 字段的处理是「就地提交、不重建插件」——它只把新值写进那个
 * 引用里，再 emit 一次 loader/volatile-update。要是我们加载时抄了一份，就地更新就永远看不见，
 * 那这个声明比不声明更糟：DSH 不再重载我们，而我们手里还是旧值。
 *
 * 取值仍沿用原来的合并顺序：config 里显式写了就用 config（undefined 算没写），没写就用
 * settings.json / 内置默认值那一路（`localBase` 那一份，不能拿合并了 config 的那份，
 * 否则会把 volatile 的引用对象自己也当成"本地值"）。
 */
function liveConfig(settings, config, localBase) {
  for (const [key, ref] of Object.entries(config ?? {})) {
    if (!Config.dict?.[key]?.meta?.volatile) continue
    if (!ref || typeof ref.get !== 'function') continue
    let local = localBase?.[key]
    Object.defineProperty(settings, key, {
      enumerable: true,
      configurable: true,
      get: () => (ref.get() === undefined ? local : ref.get()),
      set: (value) => { local = value },
    })
  }
}

export function apply(ctx, config = {}) {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })

  const settingsFile = join(dir, 'settings.json')
  const stored = readJson(settingsFile)
  // 两份来源分清楚：`local` 是"我们这份"（内置默认 + settings.json），`settings` 再叠上
  // profile 补丁给的 config。volatile 字段要拿 `local` 当兜底，所以基线单独留一份。
  const local = deepMerge(DEFAULTS, stored ?? {})
  const settings = deepMerge(local, config)
  // 标了 volatile 的字段改成"读的时候现取"（见 liveConfig）：这类字段改了不用重载插件。
  liveConfig(settings, config, local)

  // 首次启动把默认配置落一份出来，用户才有东西可以改。
  if (stored === null) {
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
  }
  const token = loadOrCreateToken(dir, settings.token)
  const store = createStore({ file: join(dir, 'state.json'), maxHistory: settings.maxHistory })
  /**
   * 会话标题的落盘缓存（见 lib/title-cache.js）。
   *
   * 放在插件自己的数据目录里，和 token / settings.json / state.json 并排——
   * 那是这个插件唯一的"自己的地方"，DSH 升级、插件重装都不动它。
   * 为什么值得单独落一份：读一条标题要加载整份会话日志（本机 1.4 GB / 1419 个文件），
   * 而这件事**每重启一次就得重付一遍**——标题却是定下来基本不变的东西。
   */
  const titles = createTitleCache({ file: join(dir, 'titles.json') })
  const sessionMeta = createSessionMetaCache({ file: join(dir, 'session-meta.json') })
  const subagentCache = createSubagentCache({ file: join(dir, 'subagents.json') })
  const tracker = createTurnTracker()
  /**
   * 执行轨迹的累计器（「完整」模式要的过程区）。
   *
   * **和上面的 tracker 是两个人**：上面那个只认「用户说的话」和「最终回答」，轨迹那个
   * 认的是思考、工具调用、工具结果。分开的理由是它们服务的是**两种模式**——聊天模式的
   * 回答区里一个字的过程都不该有（2026-09-22 用户亲自否掉的），而完整模式要的就是过程。
   * 两条路共用的是同一批原始事件，不是同一份产出。
   */
  const trajectory = createTrajectoryTracker()
  // 队列的真相在 agent 的收件箱里，store 拿不到 ctx，所以给它一个回调去问。
  // 不缓存、每次取快照现读：没有第二份状态，也就不会和电脑上不一致。
  store.setQueueSource(queuedOf)

  /**
   * 输出一律走 console。
   *
   * 原因一：真机上 cordis logger 的 info 不会出现在 stdout（只进它自己的 buffer /
   * 宿主侧通道），而「手机打开下面这条网址」这种话必须让用户当场看见。dsh-pocket、
   * dsh-cost-meter 也都是直接 console 打。
   *
   * 原因二（坑，别再踩）：真机上 `(ctx.logger?.warn ?? console.warn)(m)` 这种
   * 「先把方法取出来再裸调」的写法会抛 "this is not a function"——cordis 的 logger
   * 是 createCallable 造的可调用对象，warn 内部要 `this()` 把自己再当函数调一次，
   * this 一丢就崩。真要用 ctx.logger，必须保住接收者：`const l = ctx.logger;
   * l.warn(m)`。
   */
  const log = {
    info: (m) => console.log(`[dsh-mini-remote] ${m}`),
    warn: (m) => console.warn(`[dsh-mini-remote] ${m}`),
  }

  /** @type {Awaited<ReturnType<typeof createMiniServer>> | null} */
  let server = null

  /**
   * 服务起不来时的原因；null = 没出错。
   *
   * 有这个字段是为了把「还在启动」和「起不来了」分开说。原来两种情况都回一句
   * 「手机服务还在启动，过几秒刷新一下」——但失败之后那个 server 永远不会建好，
   * 用户会一直刷新，而且提示里没有半个字告诉他出了什么事。
   */
  let serverError = null

  /**
   * 手机传上来的文件：小票 id → DSH 的附件引用。
   *
   * 为什么中间要绕一张小票，而不是把附件 id 直接给手机：桌面端也是这么做的。
   * DSH 那边的原话是「一个线端调用者绝不能引用它没上传过的附件」——客户端能报什么
   * 就得由服务端说了算，否则改一个字符串就能让模型去读电脑上任意一个已有附件。
   * 表只在内存里，重启就清空，这也正合适。
   */
  const uploads = new Map()

  /** DSH 的附件服务；纯 headless 组合里没有它，所以是可选的。 */
  let attachments = null

  /**
   * DSH 的斜杠指令账本（`ctx.commands`）。同样是可选的：DSH 明说无界面的组合
   * 不提供这个面（headless / ACP 自动化），所以拿不到时就如实说「这台电脑上的
   * DSH 没提供指令」，而不是给手机一个空名单。
   */
  let commandService = null

  /**
   * 正在流出来的那一段。
   *
   * 手机上有一条硬要求：**显示的必须是最终回答，不能是中间步骤的旁白**
   * （2026-09-21 用户实机报的「回答过来的是思考过程」）。麻烦在于流式阶段拿不到
   * 完整内容，没法提前判断这一步最后会不会调工具——而模型调工具前几乎都会先写
   * 一句旁白。等工具调用出现时才知道它是旁白，那时候它已经流到屏幕上了。
   *
   * 与其让一句话冒出来又缩回去（比不流式更让人困惑），不如先按兵不动一小会儿：
   * 一段文字连续流这么久还没出现工具调用，才认为它是回答、开始往外露。
   * 最终答案通常要写好几秒甚至几十秒，等这一下几乎看不出来；旁白通常很短，
   * 多半等不到就露馅了。
   *
   * **这是启发式，不是判据。** 真正作数的还是 events.js 里那条「不含工具调用的
   * 那一步才是回答」——这里只决定「什么时候开始显示」。万一旁白比这个时间还长，
   * 它会先露出来，然后在工具调用出现的一瞬间被撤回。
   */
  const STREAM_GRACE_MS = 1200

  /**
   * 少到这个字数以下，一律不往外露。
   *
   * **为什么光靠时间不够。** 上面那个「连续流 1.2 秒」挡不住旁白——模型完全可以在
   * 一步里先写一句「我先看看这个文件」，流够 1.2 秒，然后才发出工具调用。
   * 用户 2026-09-22 实机报的正是这个：「非结论回答的那些内容会以流式生成的形态
   * 出现又迅速消失，就像泄露出来的一样。」
   *
   * **为什么只能用长度兜。** 判据本身（这一步有没有工具调用）要到这一步末尾才出现，
   * 等知道了，字早就流出去了。所以退一步用长度：旁白通常一两句话（几十个字），
   * 回答动辄几百字。
   *
   * **40 这个数是被两头夹出来的，别再往上调。** 第一版定的 120，理由写的是「留很宽
   * 的余量」，结果用户当天就报「流式生成又没了」——真实日志是「开始往外露（287 字）」：
   * 答案早就越过了 120，可那时候它已经是半篇回答，一次性砸出来和没有流式一样。
   * 门槛越高，用户越看不到流式；门槛越低，越可能让旁白闪一下。40 是这两者之间
   * 取的值：绝大多数旁白是「我先看看这个文件」这种十几个字的，死在 40 以下。
   *
   * 万一还是有个超长旁白越过了这条线，它照样会在工具调用出现的一瞬间被撤回，
   * 日志里记着它有多少字——下次要调这个数，看日志里那几行就知道该调多少。
   */
  const STREAM_MIN_CHARS = 40

  /**
   * 流式**关着**。
   *
   * 用户 2026-09-22 的裁决：「流式的效果不好，先不做流式了吧，改回一次性把最终回答抛出来，
   * 过程中的自言自语、执行语句就不要在手机端出现了。」
   *
   * 关掉它之后，手机上**只会**收到落定的那条回答（判据在 events.js：不含工具调用的那一步），
   * 中途一个字都不推。这正是他一直要的东西——流式这一路从上线起就在漏旁白，
   * 靠长度门槛（STREAM_MIN_CHARS）和「出现工具调用就撤回」两条补丁勉强压着，
   * 压不住的时候他就报一次。与其继续调参，不如把这条路关掉。
   *
   * **为什么留着代码而不是删掉**：他说的是「先不做」。下面这一整套（门槛、宽限定时器、
   * 撤回、限流推送）是好几轮排查才弄对的，而本机不用 git——删掉就真没了。
   * 想再试回来，把这里改成 true 即可；那条路本身没坏。
   */
  const STREAMING_ENABLED = false

  /**
   * 往外推的节奏。
   *
   * 模型一秒能吐几十个分片，原样转发会把 SSE 打爆，手机也会跟着抖。150 毫秒大约
   * 每秒 7 帧，肉眼已经是连续的，而推送量降到十分之一以下。
   */
  const STREAM_PUSH_MS = 150

  /** @type {{ text: string, shown: boolean, timer: NodeJS.Timeout | null }} */
  const streaming = { text: '', shown: false, timer: null }
  let lastLivePush = 0
  /** 只报一次「事件送到了」，用来把「订阅没生效」和「后面某一步坏了」分开。 */
  let sawStreamEvent = false

  /**
   * 按兵不动到点了，来看看该不该往外露。
   *
   * **收到文字之前不能收手，要再等一轮。** 这是实机上查出来的 bug（2026-09-22）：
   * 第一版是个一次性定时器，到点了只要还没收到文字就 return，定时器就此没了。
   * 而模型常常先想一会儿才吐第一个字——等它真开始写，已经没人在等着把它露出来了。
   * 结果就是整段回答从头到尾一次都不显示，最后靠落盘那条路一次性蹦出来，
   * 看着和没做流式一模一样。日志里的症状很好认：一堆「撤回还没露出的旁白」，
   * 外加「一个字都没收到」，而「开始往外露」一条都没有。
   *
   * 所以这里没文字就再排一轮。真正该收手的时候（这一步跑完、或者出现工具调用）
   * stopStreaming 会把定时器清掉，不会一直空转。
   */
  function revealLive(sessionId) {
    streaming.timer = null
    if (streaming.shown) return
    // 字不够多就再等——旁白多半死在这条线上，压根不会露出来。
    if (streaming.text.length < STREAM_MIN_CHARS) {
      streaming.timer = setTimeout(() => revealLive(sessionId), STREAM_GRACE_MS)
      return
    }
    streaming.shown = true
    store.setLive(sessionId, streaming.text)
    log.info(`流式：开始往外露（${streaming.text.length} 字）`)
    server?.broadcast('state', store.snapshot())
  }

  /** 正在流的那一段收工：停表、清干净、通知手机。 */
  function stopStreaming(sessionId) {
    if (streaming.timer) {
      clearTimeout(streaming.timer)
      streaming.timer = null
    }
    streaming.text = ''
    streaming.shown = false
    store.setLive(sessionId, '')
    server?.broadcast('state', store.snapshot())
  }

  /** 公网隧道；null = 没开。 */
  let tunnel = null
  /** 用户是不是**希望**隧道开着——用来区分「我们自己关的」和「它自己断了」。 */
  let tunnelWanted = false
  let tunnelStarting = false
  let tunnelError = null
  /**
   * 公网隧道到底通不通。
   *
   * **cloudflared 打印出网址 ≠ 隧道能用。** 2026-09-22 实测遇到：进程好好活着，但它到
   * Cloudflare 边缘的连接已经断了（一条 ESTABLISHED 都没有），Cloudflare 那边没人应答，
   * 手机打开就是 Error 1033——而插件只认「网址打印出来了」，面板上照样写着「已开启」。
   * 用户就是照着一个写着「已开启」的面板去扫码的。
   *
   * 原来的代码只在 cloudflared **退出**时报错（见下面的 onExit）。它不退出，就永远发现不了。
   * 所以补一道：网址有了之后隔一会儿真去打一次，只有打得到才算通。
   *
   * `null` = 还不知道（刚起来，还没公布出去）。连不上两次才判死——第一次很可能是太早。
   */
  let tunnelHealthy = null
  let tunnelProbeTimer = null
  let tunnelProbeFails = 0
  const TUNNEL_PROBE_MS = 30000
  const TUNNEL_PROBE_TIMEOUT_MS = 8000
  const TUNNEL_PROBE_FAILS = 2

  /** 手机当前该看哪个会话：用户绑定的优先，没绑过才退回最近活跃的。 */
  function targetSessionId() {
    // 绑定了就认绑定，不再看「谁最近活跃」——否则你在电脑上另开一个会话，
    // 手机上的内容就被悄悄换掉了。绑定的会话如果真的没了，
    // 发指令时会明确提示「这个会话已经结束了」。
    if (store.state.boundSessionId) return store.state.boundSessionId
    const recent = store.mostRecentSession()
    if (recent) return recent.id
    // 还没从事件流里见过任何会话（插件是热加载进来的，或者会话早就开着了），
    // 就退回问 agent 注册表要一个——否则手机会莫名其妙地「没有可遥控的会话」。
    const live = ctx.agents.list().filter((a) => a.session?.header?.origin !== 'subagent')
    return live[0]?.session?.id ?? null
  }

  function broadcastStatus() {
    const id = targetSessionId()
    const running = id ? (store.sessions.get(id)?.running ?? false) : false
    server?.broadcast('status', { running })
  }

  // ------------------------------------------------------------------
  // 公网访问（cloudflared 快速隧道）
  // ------------------------------------------------------------------
  /** 当前公网域名，没开隧道时 null。只给限速分桶用。 */
  function tunnelHost() {
    if (!tunnel) return null
    try {
      return new URL(tunnel.url).hostname
    } catch {
      return null
    }
  }

  /** 把 settings 里隧道相关的状态回写，用户在设置页点了开关要能持久化。 */
  function persistSettings() {
    try {
      writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
    } catch (err) {
      log.warn(`配置写不进去：${err?.message ?? err}`)
    }
  }

  async function bringTunnelUp() {
    if (tunnel || tunnelStarting || !server) return
    tunnelStarting = true
    tunnelError = null
    tunnelWanted = true
    try {
      const found = await ensureCloudflared({
        configuredPath: settings.tunnel?.cloudflaredPath,
        dataDir: dir,
        log,
      })
      if (!found.path) {
        tunnelError = found.error
        log.warn(`公网访问没起来：${found.error}`)
        return
      }
      if (found.source === 'downloaded') log.info('cloudflared 准备好了。')

      // 实测向 api.trycloudflare.com 注册会偶发超时（大约一半的概率），
      // cloudflared 碰到就直接退出码 1 结束。这是对方网络的问题，不是配置错了，
      // 所以重试几次——否则用户会以为是自己哪里没弄对。
      let lastError = null
      for (let attempt = 1; attempt <= TUNNEL_ATTEMPTS; attempt += 1) {
        try {
          const handle = await startTunnel({ binPath: found.path, port: server.port, log })
          tunnel = handle
          log.info(`公网访问已开：${handle.url}`)
          log.info('这个地址每次重启 DSH 都会换一个，换了之后到设置页重新扫一下码。')
          // 拿到网址只是「它说它开了」，从这里开始盯它是不是真的通。
          startTunnelProbe(handle.url)
          handle.onExit((code) => {
            stopTunnelProbe()
            if (tunnel !== handle) return
            tunnel = null
            tunnelHealthy = null
            // 我们自己关的不算故障
            if (!tunnelWanted) return
            tunnelError = `隧道断了（cloudflared 退出码 ${code}），公网那边暂时连不上。\n\n${TUNNEL_HINT}`
            log.warn(tunnelError)
          })
          return
        } catch (err) {
          lastError = err
          if (attempt < TUNNEL_ATTEMPTS) {
            log.warn(`第 ${attempt} 次没起来，再试一次…`)
            await new Promise((resolve) => setTimeout(resolve, 2000))
          }
        }
      }
      tunnelError = `${TUNNEL_ATTEMPTS} 次都没起来。${lastError?.message ?? lastError}\n\n${TUNNEL_HINT}`
      log.warn(`公网访问没起来：${tunnelError}`)
    } catch (err) {
      tunnelError = err?.message ?? String(err)
      log.warn(`公网访问没起来：${tunnelError}`)
    } finally {
      tunnelStarting = false
    }
  }

  function bringTunnelDown() {
    tunnelWanted = false
    stopTunnelProbe()
    tunnelHealthy = null
    tunnel?.stop()
    tunnel = null
    tunnelError = null
  }

  function stopTunnelProbe() {
    if (tunnelProbeTimer) clearInterval(tunnelProbeTimer)
    tunnelProbeTimer = null
    tunnelProbeFails = 0
  }

  /**
   * 盯着隧道是不是真的通。
   *
   * 打的是自己那个版本接口：它够轻，而且**只有整条路都活着才会有 200**——
   * 从本机出去、经 Cloudflare、再回到本机的手机服务。任何一段断了都拿不到 200。
   */
  function startTunnelProbe(url) {
    stopTunnelProbe()
    tunnelHealthy = null
    const probe = async () => {
      try {
        const res = await fetch(`${url}/mini/api/version?token=${encodeURIComponent(token)}`, {
          signal: AbortSignal.timeout(TUNNEL_PROBE_TIMEOUT_MS),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        tunnelProbeFails = 0
        tunnelHealthy = true
        tunnelError = null
      } catch (err) {
        const code = err?.cause?.code ?? err?.code ?? ''
        // **域名解析不出来 ≠ 隧道坏了。**
        // 2026-09-22 实测：cloudflared 连着 3 条边缘连接、域名在 1.1.1.1 / 8.8.8.8 / 223.5.5.5
        // 上都解析得出、强制指到真实 IP 打过去是 200——可本机路由器（192.168.1.1）就是查不到
        // *.trycloudflare.com。这种时候**绝对不能判死**：手机在外面走的是运营商的 DNS，
        // 很可能好好的，把网址收回去反而让用户连地址都看不到。
        if (tunnelProbeVerdict(code) === 'dns') {
          tunnelError = '隧道本身是通的，但这台电脑解析不了这个域名。\n\n'
            + '多半是代理或路由器的问题。先试试关掉代理；还不行就在手机上换成流量，'
            + '或者把电脑的 DNS 改成 1.1.1.1。'
          log.warn(tunnelError)
          return
        }
        tunnelProbeFails += 1
        if (tunnelProbeFails < TUNNEL_PROBE_FAILS) return
        tunnelHealthy = false
        tunnelError = '公网隧道还开着，但已经连不上了：'
          + `${code || err?.message || err}。手机打开会看到 Cloudflare 的 Error 1033。\n\n${TUNNEL_HINT}`
        log.warn(tunnelError)
        // 判死之后就别再打了：结果不会变，白跑网络。
        stopTunnelProbe()
      }
    }
    tunnelProbeTimer = setInterval(probe, TUNNEL_PROBE_MS)
    // 这个定时器不该拖着进程不让它退出。
    if (tunnelProbeTimer.unref) tunnelProbeTimer.unref()
    probe()
  }

  function maybeNotify(text) {
    const notify = settings.notify
    if (!notify?.enabled) return
    // 手机页面正开着就靠页面自己的提示音，不用再发系统推送，免得响两次。
    if (notify.onlyWhenBackground !== false && store.isForeground()) return
    sendExternalNotification(notify, text).then((result) => {
      if (!result.ok && result.error !== 'disabled') {
        log.warn(`外部推送失败：${result.error}`)
      }
    })
  }

  // ------------------------------------------------------------------
  // 飞书通路（长连接）
  // ------------------------------------------------------------------
  /**
   * 飞书那条路：入站走官方 SDK 的 WebSocket 长连接（不需要公网地址、不需要域名），
   * 出站用「回复某条消息」接口挂回原消息下。实现全在 lib/lark.js，这里只管它的生死。
   */
  /** @type {Awaited<ReturnType<typeof createFeishuChannel>> | null} */
  let feishu = null
  /** 正在建连接；用来挡住「连点两次开关起出两条」。 */
  let feishuStarting = false
  /** 上一次没起来的原因；null = 没出错。和 serverError 一样，用来把「还没连上」和「起不来」分开说。 */
  let feishuError = null

  async function bringFeishuUp() {
    if (feishu || feishuStarting) return
    const cfg = settings.feishu ?? {}
    if (!cfg.enabled) return
    feishuStarting = true
    feishuError = null
    try {
      feishu = await createFeishuChannel({
        config: cfg,
        log,
        onInstruction,
        // 飞书里回了「同意／1」这类话，交回电脑。走的是手机页同一份清单、同一个 settle
        // （见 lib/server.js 的 answerQuestion / decideApproval），谁先答谁生效。
        onAnswer: answerFromFeishu,
        // `/会话` 要的两件事：列可选会话（标题是手机页同一份缓存）、切到某一个
        // （切的是手机页同一个全局绑定，切完手机页跟着变）。文案全在 lib/lark.js。
        listSessions: feishuSessionList,
        bindSession: bindSessionForFeishu,
      })
      log.info('飞书：通路挂上了，等消息。')
    } catch (err) {
      feishu = null
      feishuError = err?.message ?? String(err)
      log.warn(`飞书没起来：${feishuError}`)
    } finally {
      feishuStarting = false
    }
  }

  function bringFeishuDown() {
    feishu?.close()
    feishu = null
    feishuError = null
  }

  /**
   * 换配置就地重建。
   *
   * 长连接是绑在凭据上的，改一处就得整条换掉——所以不是「改个值」而是「关了重开」。
   * 关这一步必须真的断干净（`close()` 里连定时器一起收），否则会留下一条看不见的
   * 旧连接，用旧凭据继续收消息。
   */
  async function restartFeishu() {
    bringFeishuDown()
    await bringFeishuUp()
  }

  /**
   * 这条会话叫什么。给飞书那行「会话：…」标记用（见 lib/lark.js 的 sessionTagLine）。
   *
   * 来源就是**手机页显示的那个名字**：lib/title-cache.js 那份落盘缓存。取不到就回空串，
   * 标记那边会写成「未命名会话」——**不把会话 id 露出去**，手机上从不显示 id，
   * 用户拿着它没有地方可以对。
   */
  function titleOfSession(sessionId) {
    if (!sessionId) return ''
    const known = titles.get(sessionId)
    return typeof known === 'string' ? known : ''
  }

  /**
   * 这一轮落定的回答，回给在飞书里发指令的那个人。
   *
   * **归属靠 sessionId**（见 lib/lark.js 的 takeTarget / markRoundStarted）：哪条会话
   * 这一轮是从飞书起跑的，回答就回那条飞书消息。`meta.userText` 是这一轮**用户的原话**，
   * 只做兜底比对——它会被同一轮里后来的一句人话顶掉，所以不能当主凭据。
   * 手机发起的轮次在这里天然落空——对不上号就不发，不会把手机上的回答倒进飞书。
   *
   * 顺带把这条会话的名字一起交出去：飞书那边要在回答末尾补一行「会话：…」。
   * 只有飞书这条路拿得到它——手机页那份文本一个字都不变。
   */
  function onReply(text, meta) {
    if (!feishu) return
    // reply() 自己把失败写进日志并返回 { ok:false }，不会抛——这里不用再兜一层。
    feishu.reply(text, { ...meta, sessionTitle: titleOfSession(meta?.sessionId) })
  }

  /**
   * 飞书那边拍完板，把结果交回电脑。
   *
   * **这里不判「这道题还在不在」**：那份清单和 settle 都在 lib/server.js，交回去的时候
   * 它还在不在，由它如实回答（`expired` = 手机先拍了板）。这边只是把飞书的说法翻译成
   * 那个入口收的形状。
   *
   * 末尾那个 `'feishu'` 是**说出来源**，只用来让手机页那张还挂着的卡片知道该收起来、
   * 该写「已在飞书答过」（见 lib/server.js 的 notifySettled）。不是身份判据。
   *
   * @param {{kind: string, id: string, cancel?: boolean, answers?: Array, decision?: string}} reply
   * @returns {{ok: boolean, error?: string}}
   */
  function answerFromFeishu(reply) {
    const take = reply?.kind === 'approval' ? miniControl.decideApproval : miniControl.answerQuestion
    if (typeof take !== 'function') return { ok: false, error: 'no-channel' }
    const input = reply?.cancel === true
      ? { cancel: true }
      : (reply?.kind === 'approval' ? { decision: reply?.decision } : { answers: reply?.answers })
    return take(reply?.id, input, 'feishu')
  }

  /**
   * `/会话` 要列的那些：这台电脑上的会话，新的在前。
   *
   * 标题走的是**手机页同一份东西**：`nav.listSessionsOf` 拿的正是手机页展开工作区时那份
   * （knownTitles + 落盘缓存 lib/title-cache.js），取不到就是空串，飞书那边写「未命名会话」。
   *
   * 上限是给「一屏能看完」定的，不是给性能定的：工作区一多，全列出来在手机上要划半天。
   * `total` 一起交出去，好在超出时如实说「只列了最近 N 条」。
   */
  async function feishuSessionList() {
    const workspaces = await nav.listWorkspaces(new Set(), false, false)
    const rows = []
    let total = 0
    for (const ws of workspaces) {
      const got = await nav.listSessionsOf(ws.id, FEISHU_PICK_MAX, false)
      if (!got) continue
      total += Number(got.total) || 0
      for (const one of got.sessions ?? []) {
        rows.push({ id: one.id, title: one.title, at: Number(one.createdAt) || 0 })
      }
    }
    // 新的在前——和手机页展开一个工作区时的顺序同一条口径（那边也是按 createdAt 倒序）。
    rows.sort((a, b) => b.at - a.at)
    return {
      rows: rows.slice(0, FEISHU_PICK_MAX).map((one) => ({ id: one.id, title: one.title })),
      total,
      bound: store.snapshot().boundSessionId ?? '',
    }
  }

  /**
   * 切到那一个会话。
   *
   * **切的是手机页同一个全局绑定**（和 `/mini/api/bind` 那条路逐条一样：bind → 读历史 →
   * 广播一份快照），所以飞书里切完，手机页跟着变。这不是顺手：两边各绑各的会让用户
   * 以为在跟同一个会话说话，而实际上没有。
   */
  function bindSessionForFeishu(sessionId) {
    store.bind(sessionId)
    // 和 /mini/api/bind 那条逐句一样：读这个会话的历史（异步补，读完自己会广播一份快照），
    // 再广播一次当前快照——手机页正开着的话，它当场就跟着切过去了。
    ensureHistory(sessionId)
    server?.broadcast('state', store.snapshot())
    return titleOfSession(sessionId)
  }

  /** 飞书那一块给设置页看的现状。**绝不包含 appSecret**，只回答「有没有凭据」。 */
  function feishuStatus() {
    const cfg = settings.feishu ?? {}
    const live = feishu?.status?.() ?? null
    return {
      enabled: Boolean(cfg.enabled),
      appId: String(cfg.appId ?? ''),
      openIds: String(cfg.openIds ?? ''),
      chatIds: String(cfg.chatIds ?? ''),
      hasSecret: String(cfg.appSecret ?? '').trim() !== '',
      starting: feishuStarting,
      running: Boolean(feishu),
      connected: Boolean(live?.connected),
      // 上一次被白名单挡住的来源（含 open_id / chat_id 原值）。设置页要把这一行印出来：
      // 名单默认是空的，用户不可能凭空知道自己的 id 长什么样，全靠这一行抄。
      rejected: live?.rejected ?? null,
      error: feishuError,
    }
  }

  // ------------------------------------------------------------------
  // 手机发来的指令 → 注入 DSH
  // ------------------------------------------------------------------

  /**
   * 手机发来的指令，我们自己已经记过一笔；它注入之后还会以 `user/message` 事件的
   * 形式回来一趟，事件流那一路会**再记一笔**——聊天模式里就成了同一条显示两次。
   *
   * 用消息 id 精确认出来，不靠「时间差不多、文字一样」这种猜法。
   */
  const injectedIds = new Set()
  const INJECTED_KEEP = 50

  function rememberInjected(id) {
    if (!id) return
    injectedIds.add(id)
    // Set 是插入序，超了就从最早的开始丢。手机发指令是人手速度，这点量足够了。
    while (injectedIds.size > INJECTED_KEEP) {
      injectedIds.delete(injectedIds.values().next().value)
    }
  }

  /**
   * 排队中的指令——真相在 agent 的收件箱里，这里只负责翻译成人话。
   *
   * `agent.inbox.nextTurn` 是「等着各自开一轮」的那些（`followup()` 排进去的），
   * `nextStep` 是「插到下一步」的那些（steering，手机端目前不产生，但电脑上可能有）。
   * 两个都列出来，手机上看到的队列才和电脑上一致。
   */
  function queuedOf(sessionId) {
    const agent = ctx.agents.get(sessionId)
    if (!agent?.inbox) return []
    const rows = []
    for (const [placement, list] of [['next-turn', agent.inbox.nextTurn], ['next-step', agent.inbox.nextStep]]) {
      for (const m of list ?? []) {
        rows.push({ id: m.id, text: visibleText(m.content), placement })
      }
    }
    return rows
  }

  /**
   * 把一个"睡着"的会话叫醒，拿回它的活动实例。
   *
   * **睡着不等于结束。** 用户 2026-09-28 实机踩到：手机上切到没在跑的会话，
   * 一发指令就被回「这个会话已经结束了」——可那个会话好端端躺在硬盘上。
   * 一个工作区常有上百个会话，真正"活着"的只有三两个（2026-09-25 查过：147 个里 3 个），
   * 而手机能选的偏偏是全部。所以这条路不是边角，是主路：**不修的话，手机只能发给
   * 那两三个正跑着的会话，其余全被这句错话挡回来。**
   *
   * DSH 自己给的就是 `sessionController.resolveAgent`，注释原话
   * 「Resolve **or resume** one ordinary Session」。它返回 `{agent}` 或 `{error}`，
   * 而 error 里区分三件事，**必须分开报**：
   *   - `session/not-found`：真没了（会话不存在），该让用户另选一个；
   *   - `session/agent-busy` / `session/writer-held`：正忙、或被写锁占着，等一会儿能成；
   *   - 其他（服务缺席、抛错）：叫不醒，如别说成"没了"。
   * 把"暂时叫不醒"也说成"已经结束了"，就是把用户支去重选一个其实还在的会话。
   */
  async function wakeSession(sessionId) {
    const controller = ctx.get('sessionController')
    if (typeof controller?.resolveAgent !== 'function') return { agent: null, reason: 'unavailable' }
    try {
      const res = await controller.resolveAgent(sessionId)
      if (res && res.agent) return { agent: res.agent, reason: null }
      return { agent: null, reason: (res && res.error && res.error.code) || 'unknown' }
    } catch (err) {
      return { agent: null, reason: 'threw', message: err && err.message ? err.message : String(err) }
    }
  }

  /** 叫不醒时该跟用户说的那句话（三种情况分开说）。 */
  function wakeFailureText(reason) {
    if (reason === 'session/not-found') return '这个会话已经不在了，请在手机上重新选一个会话。'
    if (reason === 'session/agent-busy' || reason === 'session/writer-held') {
      return '这个会话现在被电脑那边占着，等一会儿再发。'
    }
    return '这个会话现在叫不醒（电脑那边没答应），等一会儿再试。'
  }

  async function onInstruction(text, uploadIds) {
    const sessionId = targetSessionId()
    if (!sessionId) {
      return { ok: false, error: '电脑上还没有可遥控的会话，请先在 DSH 里开一个。' }
    }
    // 睡着的会话先叫醒（见 wakeSession）。**只有真没了才让用户另选一个。**
    let agent = ctx.agents.get(sessionId)
    if (!agent) {
      const woke = await wakeSession(sessionId)
      agent = woke.agent
      if (!agent) {
        console.log('[dsh-mini-remote] 手机上发指令：这个会话叫不醒（' + sessionId + '，原因 ' + woke.reason + '）')
        return { ok: false, error: wakeFailureText(woke.reason) }
      }
      console.log('[dsh-mini-remote] 手机上发指令：这个会话原本在睡着，已经把它叫起来了（' + sessionId + '）')
    }

    // 先把小票换成真正的附件引用。认不出来的小票会被丢掉——宁可当没传过，
    // 也不能让手机报什么就信什么。
    const files = takeUploads(uploadIds)
    if (!text && !files.length) {
      return { ok: false, error: '指令为空' }
    }

    /**
     * 跑着的时候**不再拒绝**，改成排队。
     *
     * 原来这里有一条 `agent.status === 'running'` 的挡板，回一句「上一个任务还在跑，
     * 等它完成再发」。那条挡板是多余的，而且**比 DSH 自己还严**：`followup()` 的
     * 语义本来就是「排队一个后续轮次并唤醒驱动」（dsh-agent 的类型注释原话：
     * "Queue an ordinary follow-up turn and wake the driver"），跑着的时候照样收，
     * 排进 inbox.nextTurn，等当前这一轮结束再跑。DSH 桌面端同一时刻就能接着排。
     *
     * 所以这里只是把「拒绝」换成「收下并说清楚它排队了」。
     */
    const queued = agent.status === 'running'

    const message = userMessage(text, files)
    // 必须在 followup 之前登记。
    // 消息是**原样**进 agent 收件箱的（dsh-agent-loop 的 send() 直接把它 splice 进
    // inbox，不克隆、不换 id），所以事件回来时带的还是这个 id，认得出。
    // 但事件什么时候回来不确定——驱动是异步 kick 起来的（wakeDriver 返回 Promise）。
    // 先登记，就不必去赌这个时序。
    //
    // **排队的那条不登记。** 登记是为了「等它跑起来时别记两遍」，而排队的那条
    // 现在**还不该在手机上出现**——用户 2026-09-22 实机提的：排队的指令会立刻
    // 显示成一条「像已经发出去」的气泡，其实还在队列里等着。
    // 不登记、也不记账，等它真轮到时 session/event 那条路会把它补进 history，
    // 正好记一次、也只在那时候出现。
    if (!queued) rememberInjected(message.id)
    try {
      agent.followup(message)
    } catch (err) {
      return { ok: false, error: `注入失败：${err?.message ?? err}` }
    }
    // 手机上回显的那条：附件也得看得见。不然发完一条「只有文件、没写文字」的指令，
    // 气泡是空的，用户会以为没发出去。
    const shown = files.length
      ? `${text}${text ? '\n' : ''}📎 ${files.map((f) => f.name).join('、')}`
      : text
    if (!queued) store.pushUser({ text: shown, sessionId, id: message.id })
    if (!store.state.boundSessionId) store.bind(sessionId)
    store.setRunning(sessionId, true)
    broadcastStatus()
    // 排队的那条也要推快照：队列列表是从 agent 收件箱读的，不推手机上就看不到
    // 它排在哪儿。区别只在于**不往 history 里记**，所以它不会长成一条气泡。
    server?.broadcast('state', store.snapshot())
    // queued 只是给界面上那句提示用的：现在就在跑，所以这条得等下一轮。
    return { ok: true, sessionId, queued }
  }

  /**
   * 把一条还在排队的指令撤回来。
   *
   * `agent.inbox.remove()` 返回的是「它当时是否还在队列里」——**不能不看这个返回值**：
   * 手机上那条队列是几百毫秒前推过去的，这中间它完全可能已经轮到自己、开始跑了。
   * 那种情况下它已经不在收件箱里，remove 返回 false，界面必须如实说「它已经开跑了」，
   * 而不是假装撤掉了。
   */
  function onUnqueue(id) {
    const sessionId = targetSessionId()
    if (!sessionId) return { ok: false, error: '电脑上还没有可遥控的会话。' }
    const agent = ctx.agents.get(sessionId)
    // 睡着的会话没有收件箱，排着的东西也跟着没了。**不能照旧说"这个会话已经结束了"**
    // ——它会醒，而且手机上还挂着它（2026-09-28 用户就是被这句误导过）。
    if (!agent) return { ok: false, error: '这个会话睡下了，队列里排着的也跟着没了——重新发一条吧。' }
    if (!id) return { ok: false, error: '没说要撤哪一条。' }
    let removed = false
    try {
      removed = agent.inbox.remove(id) === true
    } catch (err) {
      return { ok: false, error: `撤不回来：${err?.message ?? err}` }
    }
    if (!removed) {
      // 没撤成也要把最新队列推一遍：手机上那份是上一次推送时的样子，这条已经开跑了，
      // 界面得跟着纠正，不能一直挂着一条其实早就不在队列里的东西。
      server?.broadcast('state', store.snapshot())
      return { ok: false, error: '这条已经轮到自己开始跑了，撤不回来了。' }
    }
    server?.broadcast('state', store.snapshot())
    return { ok: true, sessionId }
  }

  /**
   * 停掉正在跑的那一轮。
   *
   * 和 DSH 自己的停止按钮**完全一致**——照抄 dsh-api-session-controller 里
   * commands.cancel 的写法：`agent.cancel({ kind: 'user' }, { keepInbox: true })`。
   * 那个 keepInbox 是照抄的重点：中止当前这一轮，但**收件箱里还没跑的东西留着**。
   * 不加的话，你在电脑上排好的下一条会被手机这一下悄悄吃掉，而且是无声的。
   *
   * cancel() 是「递个请求」，不是「等它停」：它立刻返回，真正停下要等驱动收敛，
   * 到那时候 agent/status 才翻成 idle、turn/end 才带着 aborted 出来。
   * 所以返回的 ok 只表示请求递进去了，界面上得等状态翻——不能按完就当停好了。
   *
   * 停下来之后**不会**推出什么「回答」：中止的那一轮通常卡在工具调用里，
   * events.js 那边本来就不会把它当回答（见 isIntermediateStep）。推空的。
   */
  function onStop() {
    const sessionId = targetSessionId()
    if (!sessionId) return { ok: false, error: '电脑上还没有可遥控的会话。' }
    const agent = ctx.agents.get(sessionId)
    // 会话睡着 = 没有一轮在跑，本来就没有可停的东西。照旧说"已经结束了"会让人以为
    // 得重选会话（2026-09-28 用户被这句误导过）。
    if (!agent) return { ok: false, error: '这个会话现在没在跑，不用停。' }
    // 子 Agent 不归手机管：导航栏里不显示它们，手机上也不该能停它们。
    // DSH 自己那条路也是这么挡的（hasApiSessionSubagentOwner）。
    if (agent.session?.header?.origin === 'subagent') {
      return { ok: false, error: '这是个子 Agent，手机上停不了它。' }
    }
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    } catch (err) {
      return { ok: false, error: `停不下来：${err?.message ?? err}` }
    }
    return { ok: true, sessionId }
  }

  // 最近见过的工具调用：调用编号 → 一行能读的命令。
  //
  // **为什么要留这份**：审批请求（`approval/request`）只带工具名和一个调用编号，
  // 参数不在里面；而手机上要敢点「同意」，得先看见到底要跑什么。参数原本就在会话
  // 事件 `tool/call` 的 `arguments` 里（模型原样产出的 JSON），顺手记一份即可。
  // **只留最近 40 条**：够审批用，长会话也不会越攒越多。
  const toolCalls = new Map()
  const TOOL_CALL_KEEP = 40

  /**
   * 把模型原样产出的那段参数 JSON 变成卡上能读的一行。
   *
   * 只做「取字段 + 限长」，不做美化：命令就该原样给人看，他才敢拍板。
   * 常见字段按优先级取；都取不到就把短字段摊成几行；再不行给原文——
   * 宁可难看，不能"看不到"。
   */
  function commandPreview(rawArgs) {
    if (typeof rawArgs !== 'string' || !rawArgs.trim()) return ''
    let args = null
    try {
      args = JSON.parse(rawArgs)
    } catch (err) {
      return rawArgs.trim().slice(0, 1200)
    }
    if (!args || typeof args !== 'object') return rawArgs.trim().slice(0, 1200)
    for (const key of ['command', 'cmd', 'script', 'code', 'pattern', 'file_path', 'path', 'url']) {
      const v = args[key]
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 1200)
    }
    const lines = []
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' && v.length <= 200) lines.push(k + ': ' + v)
      else if (typeof v === 'number' || typeof v === 'boolean') lines.push(k + ': ' + String(v))
      if (lines.length >= 6) break
    }
    return lines.length ? lines.join('\n').slice(0, 1200) : rawArgs.trim().slice(0, 1200)
  }
  // ------------------------------------------------------------------
  // 事件订阅：只取「最后一帧」
  // ------------------------------------------------------------------
  /**
   * 上下文窗口用量：分母按会话记着，分子每步现算。
   *
   * 分母来自 `request/context`——DSH 每次发请求前报一份当前路由的信息，里面有
   * contextWindow。分子来自 `assistant/message` 的 usage。**三块计数互不重叠**：
   * `inputTokens` 只是没走缓存的那部分，缓存读、缓存写各算各的，
   * 「billed input = 三者之和」（dsh-llm 的 TokenUsage 注释原话）。少加一块，
   * 量出来的用量就偏小，而且越长的一轮偏得越多。
   *
   * 为什么不用 dsh-token-meter 的 contextPressure 投影：2026-09-28 实测它在这一组合里
   * 拿不到——接口通、不报错、投影里就是没有那三个数，手机上的用量一直空着（直接问
   * /mini/api/state，整个状态里连一个 token/window 字段都没有）。事件是同一份事实的一手
   * 来源，不依赖任何可选服务。
   */
  const contextWindows = new Map()

  function usageInputTokens(usage) {
    const n = (v) => (typeof v === 'number' && v > 0 ? v : 0)
    return n(usage.inputTokens) + n(usage.cacheReadTokens) + n(usage.cacheWriteTokens)
  }

  /**
   * 这个会话的窗口有多大（分母）。
   *
   * **两条来源，第二条是必须的。** `request/context` 那条事件只在**路由变了**的时候
   * 才写一次（见 dsh-agent-loop 的追加条件：和日志里上一条 request/context 不一样才写）。
   * 实测本机三个会话，从几十步到两千多步，`request/context` 都**只有一条**，就在会话
   * 第一次发请求那一刻；而 `request/header` 有两百多条。插件要是晚一步起来——重启过、
   * 或者是早就开着的会话——那一条早进日志了，光等事件永远等不到，分母一直缺，
   * 手机上就永远空着（2026-09-28 用户报的正是这个）。
   *
   * 所以第二条走 `session.requestContext()`：DSH 自己把日志里最后那条 request/context
   * 折叠在会话对象上，重启之后照样在（agent-loop 判断「要不要再写一条」用的就是它，
   * 正因为它在，那条事件才不会每次重启都重写一遍）。拿到就顺手记进 map，
   * 后面每一步都省一次折叠。
   */
  function contextWindowOf(session, sessionId) {
    const known = contextWindows.get(sessionId)
    if (typeof known === 'number' && known > 0) return known
    const folded = typeof session?.requestContext === 'function' ? session.requestContext() : undefined
    const win = folded?.contextWindow
    if (typeof win !== 'number' || !(win > 0)) return undefined
    contextWindows.set(sessionId, win)
    return win
  }

  /**
   * 喂一口执行轨迹，并把这一批的变化推给**正在看这个会话、而且要「完整」模式**的手机。
   *
   * 三个决定，都有理由：
   *   ① **落在 store 的内存缓冲里**，不落盘（体积是回答正文的 90.7 倍，落盘那份是每
   *      500 毫秒重写整份 JSON；理由见 lib/store.js 的 trajectoryBySession）。
   *   ② **只推当前绑定的那个会话**（和 reply 那条同一个口径）：手机遥控的是这一个，
   *      别的会话在想什么跟它无关；那些会话照旧攒在缓冲里，切过去时用接口拉一份。
   *   ③ **推的是增量帧**，不是整份快照（见 lib/server.js 的 broadcastTrajectory）。
   */
  function feedTrajectory(sessionId, event) {
    const change = trajectory.feed(sessionId, event)
    if (!change) return
    const frame = store.applyTrajectory(sessionId, change)
    if (!frame) return
    if (sessionId !== targetSessionId()) return
    server?.broadcastTrajectory({ sessionId, ...frame })
  }

  ctx.on('session/event', (session, event) => {
    // 子 agent 的会话不进手机——用户遥控的是自己的主会话，不是它派出去的小弟。
    if (session.header?.origin === 'subagent') return
    const sessionId = session.id

    // 执行轨迹：**在所有早退之前**喂一口。下面 `tool/call` 那条分支取完命令原文就 return
    // 了（审批卡要用），而工具调用正是轨迹的主干——放在这一句之前，它才不会漏掉。
    feedTrajectory(sessionId, event)

    // 手机正在看的这个会话：顺手让它的完整历史保持新鲜（一分钟最多重读一次）。
    // 只对「当前绑定的那一个」做——手机上没在看的会话，读了也没人看，白花 CPU。
    if (sessionId === targetSessionId()) ensureHistory(sessionId)

    // 命令原文：记下这次要跑的是什么，审批卡上要显示。**不进日志**——正文是用户自己的东西。
    if (event.type === 'tool/call') {
      const data = event.data ?? {}
      if (data.callId) {
        toolCalls.set(String(data.callId), commandPreview(data.arguments))
        while (toolCalls.size > TOOL_CALL_KEEP) toolCalls.delete(toolCalls.keys().next().value)
      }
      return
    }

    // 会话标题（可选事件，拿到就用，拿不到就用 id 前 8 位兜底）
    if (event.type === 'session/title') {
      const title = event.data?.title ?? event.data?.text
      if (typeof title === 'string' && title.trim()) {
        store.touchSession(sessionId, { title: title.trim() })
        // 同时盖掉落盘那份里的旧说法。**不能只等下次展开工作区时才写**：
        // 那时如果插件已经重启过（内存清零），手机上看到的就是盘上那个旧值了。
        titles.set(sessionId, title.trim())
      }
      return
    }

    // 这个会话现在用的是哪个模型、哪一档思考强度。
    //
    // **来源就是这儿**：DSH 每次发请求前都会广播一份 header，里面带着
    // `config: { provider, model, reasoningEffort? }`——和 DSH 接口定义里那个
    // `ModelSelection` 是同一个形状（见 tasks/todo.md 第 32 轮的侦察结论）。
    // 所以读当前值不用另找接口，跟着事件走就行。
    //
    // 记下来给手机端显示用（2026-09-25 用户要求：手机上要能改每个会话的模型和强度）。
    // 改完之后 DSH 会再发一份新的 header，这里跟着刷新，两边不会走散。
    if (event.type === 'request/header') {
      const cfg = event.data?.header?.config
      if (cfg && typeof cfg.model === 'string') {
        store.touchSession(sessionId, {
          provider: typeof cfg.provider === 'string' ? cfg.provider : null,
          model: cfg.model,
          // 这一项可能是空的：那表示「用 provider 自己的默认」，不是出错
          reasoningEffort: typeof cfg.reasoningEffort === 'string' ? cfg.reasoningEffort : null,
        })
      }
      return
    }

    // 斜杠指令：它**不是一轮对话**，上面那个提取器不认它（会走到 `if (!action) return`
    // 直接丢掉），所以得在这儿单独接住。
    //
    // 为什么值得单独一条路：指令不产生模型消息（DSH 的契约），所以它既不该长成用户
    // 气泡，也不该被单帧模式当成「最新回复」。它是第三种东西——手机上画成一条紧凑的
    // 「指令」行，和电脑端画在正文里是同一个意思。
    //
    // 开始（command/run）和收尾（command/done）靠 commandId 配对。配对逻辑和
    // 「重放硬盘日志」那条路共用 lib/commands.js 里的映射，两边不会走散。
    if (event.type === 'command/run' || event.type === 'command/done') {
      // 手机还没绑会话时，谁先有动静就绑谁（和下面那条同一套口径）。
      if (!store.state.boundSessionId) store.bind(sessionId)
      if (sessionId !== targetSessionId()) return
      if (event.type === 'command/run') {
        const row = commandRow(event)
        if (row) store.pushCommand({ ...row, sessionId })
      } else {
        const patch = commandPatch(event)
        if (patch) store.settleCommand({ sessionId, ...patch })
      }
      store.touchSession(sessionId)
      server?.broadcast('state', store.snapshot())
      return
    }

    /**
     * 一轮跑完，台词就作废。
     *
     * 不广播也安全：这一轮结束必然跟着一条回复或一条状态推送，手机自己会重画；
     * 而页面那边还认着「这句我念过了」（比 at），所以旧的残留不会诈尸。
     */
    if (event.type === 'turn/end' && sessionId === targetSessionId()) {
      store.setThought(sessionId, null)
    }

    // 上下文窗口用量：分母跟着 request/context 记，分子每步现量（见 usageInputTokens）。
    // 缺任一半就什么都不写——宁可空着，也不编一个数出来。
    if (event.type === 'request/context') {
      const win = event.data?.contextWindow
      if (typeof win === 'number' && win > 0) contextWindows.set(sessionId, win)
    }
    if (event.type === 'assistant/message' && event.data?.usage) {
      const used = usageInputTokens(event.data.usage)
      // 分母从 `contextWindowOf` 拿：事件里那份优先，事件没赶上就问会话自己折叠的那份
      // （理由见那个函数）。
      const win = contextWindowOf(session, sessionId)
      if (used > 0 && win > 0) {
        store.touchSession(sessionId, { context: { used, window: win } })
        // 只有手机正在看的那个会话值得推一遍；别的会话照样记着，等它被切过来时
        // /mini/api/state 会给最新的一份。
        if (sessionId === targetSessionId()) server?.broadcast('state', store.snapshot())
      }
    }

    const action = tracker.feed(sessionId, event)
    if (!action) {
      /**
       * 到这里还不是「指令」也不是「回答」，但可能是别的会话都不管的第三种东西：
       * 中间步骤的自言自语（鲸鱼娘的台词）。
       *
       * **必须在这儿接，不能等到下面。** 下面第一件事就是 `if (sessionId !==
       * targetSessionId()) return`——那是给「会震动手机的内容」定的规矩，而台词也一样：
       * 别的会话在想什么，跟手机正遥控的这个会话无关。
       *
       * 它取的是中间步骤的旁白或思考首行，**不落盘、不进历史**，所以回答区的口径
       * （latest/history）一个字都不会因此改变——2026-09-22 用户否掉的是「过程的文字
       * 跑进回答区」，不是「她说了句话」。
       */
      if (event.type === 'assistant/message') {
        if (sessionId !== targetSessionId()) return
        const talk = stepSelfTalk(event.data?.message?.content)
        // 没话可说时**什么都不做**：留着上一句，比让气泡闪一下空要好。
        if (!talk) return
        store.setThought(sessionId, { text: talk.text, at: event.time ?? Date.now() })
        store.touchSession(sessionId)
        server?.broadcast('state', store.snapshot())
      }
      return
    }
    store.touchSession(sessionId)

    // 手机还没绑会话时，谁先有动静就绑谁。
    if (!store.state.boundSessionId) store.bind(sessionId)

    // 下面只处理手机正在遥控的那个会话。别的会话（比如你在电脑上另开的）
    // 既不该震手机，也不该顶掉单帧模式显示的内容——实时推送和刷新后拿到的
    // 状态必须是同一套口径，否则刷新一下就看到别人的结果了。
    if (sessionId !== targetSessionId()) return

    if (action.kind === 'notice') {
      // 子智能体完工的通知。记进聊天记录，**但不震动、不弹通知**——它是「你派出去的
      // 那件事有结果了」，和「模型答了你一句」不是同一件事。可它确实是这个会话里
      // 发生的一件事，聊天记录里不能缺（原来就是被 user/message 那道过滤一起挡掉的）。
      store.pushNotice({
        text: action.text,
        summary: action.summary,
        senderSessionId: action.senderSessionId,
        sessionId,
        timestamp: event.time,
      })
      server?.broadcast('state', store.snapshot())
      return
    }

    if (action.kind === 'user') {
      // 手机自己发的那条：onInstruction 里已经记过一笔了，这里跳过。
      // 不跳的话聊天模式里同一条指令会显示两次（用户实机报过）。
      if (action.id && injectedIds.has(action.id)) {
        injectedIds.delete(action.id)
        // **但不能直接 return**：这条事件的意思是「它轮到、开始跑了」，
        // 队列里少了一条。不推这一下，手机上那块「排队中」就会一直挂着
        // 一条其实已经在跑的东西。（内容那一笔确实已经在 onInstruction 里记过了，
        // 所以只推快照、不重复记。）
        server?.broadcast('state', store.snapshot())
        return
      }
      // 电脑上自己敲的指令也记一笔，聊天模式才完整。
      // 带上 id：那条也可能是**排队**排进去的，手机上要靠它对上号、标出「排队中」。
      // 时间戳用事件自己的 `time`：硬盘重放出来的那份也是这个 `time`，两边同钟，
      // 合成时才认得出「这条记录里已经有了」，不会接成两条（见 store.pushUser）。
      store.pushUser({ text: action.text, sessionId, id: action.id, timestamp: event.time })
      server?.broadcast('state', store.snapshot())
      return
    }

    // action.kind === 'reply'
    store.pushReply({
      text: action.text, sessionId, reason: action.reason, interrupted: action.interrupted,
      // 同上：和硬盘那份用同一个钟（事件的 `time`），否则同一条回复会显示两遍。
      timestamp: event.time,
    })
    server?.broadcast('reply', {
      text: action.text,
      sessionId,
      reason: action.reason,
      // 这是「你按停的那半句」，不是完整回答。手机要标出来，别让人以为是模型答崩了。
      interrupted: action.interrupted === true,
      timestamp: Date.now(),
    })
    maybeNotify(action.text)
    // 飞书那条路：这一轮落定的回答，回给在飞书里发指令的那个人（见 onReply）。
    // `sessionId` 既是**归属**（飞书那边靠它认出发起这一轮的那条消息），也要拿去查会话名；
    // `userText` 是 events.js 取好的「这一轮用户的原话」，只做兜底比对。
    onReply(action.text, { userText: action.userText, sessionId })
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const sessionId = agent?.session?.id
    if (!sessionId) return
    if (agent.session.header?.origin === 'subagent') {
      const parent = agent.session.header?.parentSession
      if (parent) {
        subagentCache.delete(parent)
        store.setSubagentRunning(parent, sessionId, status === 'running')
        server?.invalidateSubagents?.(parent)
        server?.broadcast('state', store.snapshot())
      }
      return
    }
    store.setRunning(sessionId, status === 'running')
    server?.invalidateNavigation?.()
    server?.broadcast('navigation-refresh', { reason: 'session-status', sessionId })
    broadcastStatus()
  })

  /**
   * 模型每吐一小段，DSH 就发一帧。这是**唯一**能拿到增量文本的地方。
   *
   * 别的路都不行：`session/event` 是落盘之后才发的（等它到，整段已经写完了），
   * 消息账本里那条 assistant/message 也是收尾时才写。所以「流式」只能挂在这儿。
   *
   * 两个已知的限制，都绕不开，只能自己兜着：
   * ① 它是**进程本地**的，不重放。手机中途刷新就接不上了——所以流出来的那段
   *    自己在 store 里留一份，塞进快照，任何一条广播都能把它补回去。
   * ② 它不带 sessionId，得从 agent 上拿。和 session/event 同一套过滤口径：
   *    子 Agent 的流不往手机上推。
   */
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    // 流式关着：这里直接掉头。手机上只认落定的那条回答，中途一个字都不推。
    // 为什么关、为什么留着代码，见 STREAMING_ENABLED 的注释。
    if (!STREAMING_ENABLED) return

    const session = agent?.session
    const sessionId = session?.id
    if (!sessionId) return
    if (session.header?.origin === 'subagent') return

    // 只报一次：这条日志回答的是「事件到底有没有送到插件」。一条都没有，就说明
    // 问题在订阅那一层，不用再往下查。
    if (!sawStreamEvent) {
      sawStreamEvent = true
      log.info('流式：收到第一个增量事件了')
    }

    if (frame?.type === 'start') {
      streaming.text = ''
      streaming.shown = false
      if (streaming.timer) clearTimeout(streaming.timer)
      // 先按兵不动。到点了再看这段文字还在不在、有没有被工具调用打断。
      streaming.timer = setTimeout(() => revealLive(sessionId), STREAM_GRACE_MS)
      return
    }

    if (frame?.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk?.type === 'tool-call-delta') {
        // 出现工具调用 = 这一步是中间步骤，刚才流出来的那句是旁白。
        // 立刻撤回，不等它跑完——早一帧撤回，用户就少看一眼不该看的东西。
        log.info(`流式：出现工具调用，撤回${streaming.shown ? '已露出的' : '还没露出的'}旁白（${streaming.text.length} 字）`)
        stopStreaming(sessionId)
        return
      }
      if (chunk?.type !== 'text-delta' || !chunk.text) return
      streaming.text += chunk.text
      // 没露过的话，**每收到一个字就问一次够不够长**，而不是干等定时器。
      //
      // 实机踩过（2026-09-22）：原来只在定时器到点时才检查，而定时器 1.2 秒一轮，
      // 模型一秒能写几十个字。于是越过门槛的那一刻没人发现，等定时器醒来时字已经
      // 堆到 287——日志里就是「开始往外露（287 字）」，用户看到的是半篇回答一次性
      // 砸出来，报「流式生成又没了」。现在跨过门槛的那一瞬间就露。
      if (!streaming.shown) {
        if (streaming.text.length < STREAM_MIN_CHARS) return
        revealLive(sessionId)
        return
      }
      store.setLive(sessionId, streaming.text)
      // 限流：模型一秒能吐几十个分片，原样转发会把 SSE 打爆。
      const now = Date.now()
      if (now - lastLivePush < STREAM_PUSH_MS) return
      lastLivePush = now
      server?.broadcast('state', store.snapshot())
      return
    }

    // frame.type === 'end'
    //
    // 收工时**不需要**判断这一步是不是回答：如果是，落盘的 assistant/message 早就
    // 先一步到（走的 session/event），latest 已经换成了完整的那一段，屏幕上自然
    // 接上；如果不是，本来也没显示过什么。两种情况都只要把临时的清掉。
    //
    // 注意 end 里的 outcome 即使被用户按停也仍是 'committed'，所以这里不能拿它
    // 判断「是不是正常结束」——那是 events.js 里 interrupted 的活。
    if (frame?.type === 'end') {
      if (streaming.shown) log.info(`流式：这一步写完了，共 ${streaming.text.length} 字`)
      stopStreaming(sessionId)
      return
    }

    // 走到这儿说明帧的形状和我们以为的不一样。把前 200 字打出来——比起猜，
    // 看一眼真实的东西更快。
    log.warn(`流式：不认识的帧 ${String(JSON.stringify(frame)).slice(0, 200)}`)
  })

  // 会话一建出来就登记，这样手机上的会话选择器不用等到有活动才出现。
  ctx.on('agent/created', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (!sessionId) return
    if (agent.session.header?.origin === 'subagent') {
      const parent = agent.session.header?.parentSession
      if (parent) {
        subagentCache.delete(parent)
        store.setSubagentRunning(parent, sessionId, agent.status === 'running')
        server?.invalidateSubagents?.(parent)
        server?.broadcast('state', store.snapshot())
      }
      return
    }
    sessionMeta.upsert({ header: agent.session.header, live: true, persisted: false })
    store.touchSession(sessionId, {
      running: agent.status === 'running',
    })
    server?.invalidateNavigation?.()
    server?.broadcast('navigation-refresh', { reason: 'session-created' })
    server?.broadcast('state', store.snapshot())
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (!sessionId) return
    if (agent.session.header?.origin === 'subagent') {
      const parent = agent.session.header?.parentSession
      if (parent) {
        subagentCache.delete(parent)
        store.setSubagentRunning(parent, sessionId, false)
        server?.invalidateSubagents?.(parent)
        server?.broadcast('state', store.snapshot())
      }
      return
    }
    sessionMeta.upsert({ header: agent.session.header, live: false, persisted: true })
    store.forgetSession(sessionId)
    // 轨迹那个累计器也清掉（它有自己的一份 per-session 状态）。
    trajectory.forget(sessionId)
    server?.invalidateNavigation?.()
    server?.broadcast('navigation-refresh', { reason: 'session-disposed' })
    server?.broadcast('state', store.snapshot())
  })

  // ------------------------------------------------------------------
  // 左侧导航栏要用的两个服务
  // ------------------------------------------------------------------
  // 同样走 ctx.inject，不写进 inject 数组：这两个服务只在 web 组合里有，写进去
  // 的话 headless 组合下服务永远不来，这个插件就一直挂着不激活——启动失败那个
  // 坑刚踩过一次，不再踩第二次。服务没到位时导航栏退回「只知道当前会话」。
  //
  // 拿到的时机可能晚于建服务，所以存进一个可变的持有对象，让服务端每次请求
  // 现读，而不是建服务时读一次快照。
  const treeServices = { registry: null, query: null }
  ctx.inject(['sessionQuery', 'workspaceRegistry'], (treeCtx) => {
    treeServices.registry = treeCtx.workspaceRegistry
    treeServices.query = treeCtx.sessionQuery
    // 这行日志是有用的：服务到底有没有到位，只能在这里确定地看到。
    // 「配置和源码里都有」不等于「运行时真的提供了」，前者是推断，后者才是事实。
    console.log('[dsh-mini-remote] 会话树已就绪：workspaceRegistry='
      + Boolean(treeServices.registry) + ' sessionQuery=' + Boolean(treeServices.query))
  })

  // ------------------------------------------------------------------
  // 点开一个会话，就把它**完整的历史**读出来（2026-09-25 用户要求）
  //
  // 为什么不能只靠手里那份记录：手机能点开全部会话（一个工作区常有上百条），
  // 而插件手里那份只有「它在场时看见过的事件」——重启前跑过的、在电脑上开的，
  // 点进去是空的。用户要的是：点开就该看到它之前的每一轮。
  //
  // 数据来源是 DSH 自己的会话记录（`sessionQuery.readSession`）。它有个很好的性质：
  // **会话活着就从内存给（不读盘），睡着才去读它的日志**，而且日志是完整的
  // （多帧 zstd 由 DSH 自己解）。所以对正在跑的那个会话，这条路几乎不要钱。
  //
  // 读出来的是原始事件，用 lib/history.js 重放成聊天记录——**和实时那条路
  // 共用同一个提取器**，两条路对「哪条才算最终回答」的判断不会走散。
  // ------------------------------------------------------------------

  /** sessionId -> { at, entries, latest }。只活在内存里，不落盘（理由见 store.setReplaySource）。 */
  const historyCache = new Map()
  /** 正在读的那些：用户连点几下也只读一遍。 */
  const historyPending = new Set()
  /** 多久重读一次。会话跑着的时候历史会变长，一分钟够跟上；睡着的不变，重读也只是白读一次。 */
  const HISTORY_TTL_MS = 60000

  /**
   * 手机端读历史的**上限**（2026-09-25 用户要求：读历史要有上限）。
   *
   * 三层**都跟会话总量无关**：
   *   - 窗口：只读日志末尾这么多**压缩**字节；
   *   - 事件：窗口里最多留多少条事件（再向前对齐到一条 user 消息，让重放从一轮的开头起）；
   *   - 条目：重放成聊天记录后，最多给手机多少条（≈ 轮数 × 2）。
   */
  // 窗口按「本机最坏的那条日志」实测选的（26MB / 2.2 万事件）：16MB 窗口 → 约 1.2 万事件、
  // 197 条聊天记录、472ms、堆峰 ~400MB；4MB 窗口只有 29 条（太少）。日志比窗口小就是全读。
  // 事件上限只作极端兜底。
  //
  // **这条有上限的路现在是日常路**，理由见 ensureHistory：内核那条整份读要先把全部会话
  // 列两遍，1MB 的日志也要 1.7–3.6 秒。原来那两条「子会话超过 20 个 / 日志超过 8MB 才
  // 走这里」的红线（以及为它们服务的 tree.js sessionScale）随之删掉——触发它们的那条
  // 整份读已经只剩「盘上还没有日志的会话」这一种情况了，那时它给的是内存里现成的那份，
  // 不会去做 v3→v4 迁移，所以 2026-09-25 那次 OOM 的路已经走不通。
  const HISTORY_TAIL_WINDOW_BYTES = 16 * 1024 * 1024
  const HISTORY_TAIL_MAX_EVENTS = 20000
  const HISTORY_MAX_ENTRIES = 200

  /**
   * 去 DSH 的会话记录里读一次，重放成聊天记录。读不出来返回 null。
   *
   * **只在盘上找不到这个会话的日志时才用**（会话刚建、还没落盘；或者是子 agent 的会话，
   * 那种要读出来才知道该不该显示）。这时内核给的是内存里现成的那份，不读盘、不迁移，
   * 正好免费。盘上有日志时请走 readTailHistory——理由是实测数字，见 ensureHistory。
   */
  async function readHistory(sessionId) {
    const q = treeServices.query
    if (typeof q?.readSession !== 'function') return null
    try {
      const snap = await q.readSession(sessionId)
      // 子 agent 的会话不进手机——和实时那条路同一条口径（见 session/event 里那句）。
      if (snap?.session?.origin === 'subagent') return null
      const events = Array.isArray(snap?.events) ? snap.events : []
      const entries = replayHistory(events)
      const capped = capEntries(entries)
      // 轨迹和聊天记录是**同一批事件的两面**，顺手一起重放出来；不这样就得为它再读一遍盘。
      const traj = capTrajectory(replayTrajectory(events))
      return {
        entries: capped.entries,
        latest: lastReply(capped.entries, sessionId),
        truncated: capped.dropped > 0,
        // 说「最近一段」而不是「最近 200 条」：这条记录读完之后，store 还会把
        // 「刚发生、还没落进日志」的那一两条实时记录接在后面（见 mergeHistory），
        // 于是手机上真看到的条数可能比这里多一两条。数字对不上就是假话，
        // 所以这里只声称**读取的上限**，不声称列表长度。
        note: capped.dropped > 0 ? `只显示最近一段（读取上限：${HISTORY_MAX_ENTRIES} 条）` : null,
        // 轨迹在**插件这一层就按自己的上限截好**再进缓存：不截的话，20 个会话的缓存会
        // 各压着几兆（见 lib/store.js 的 setReplaySource 那段说明）。
        trajectory: traj.turns,
        trajectoryDropped: traj.dropped,
      }
    } catch (err) {
      // 老日志格式对不上、文件坏了，都会走到这儿。退回「手里那份」，**不编**。
      console.log('[dsh-mini-remote] 这个会话的完整记录没读出来（' + sessionId + '）：'
        + (err?.message ?? err))
      return null
    }
  }

  /** 聊天记录条数上限：从**尾部**留（手机上看的是最近发生的事）。 */
  function capEntries(entries) {
    if (!Array.isArray(entries) || entries.length <= HISTORY_MAX_ENTRIES) {
      return { entries, dropped: 0 }
    }
    return { entries: entries.slice(-HISTORY_MAX_ENTRIES), dropped: entries.length - HISTORY_MAX_ENTRIES }
  }

  /**
   * 有上限的读法：只解日志**尾部**的若干 zstd 帧，自己重放（见 lib/log-tail.js）。
   *
   * 日志比窗口小就是整份都读到（`tail.whole`），所以小会话走这里也不会少看东西。
   * 拿不到就返回 null：由调用方如实说「没读到」，**不编内容**。
   */
  function readTailHistory(sessionId) {
    let tail
    try {
      tail = readTailEvents(sessionId, {
        windowBytes: HISTORY_TAIL_WINDOW_BYTES,
        maxEvents: HISTORY_TAIL_MAX_EVENTS,
      })
    } catch (err) {
      log.warn(`尾部读失败 ${sessionId}：${err?.message ?? err}`)
      return null
    }
    if (!tail) return null
    const entries = replayHistory(tail.events)
    const capped = capEntries(entries)
    if (!capped.entries.length) return null
    const traj = capTrajectory(replayTrajectory(tail.events))
    const windowMb = (HISTORY_TAIL_WINDOW_BYTES / 1048576).toFixed(0)
    // 「不是全部」有两处会砍：readTailEvents 那层（窗口 / 事件上限）和这里 capEntries 那层
    // （聊天记录条数上限）。**两层都要算进去**——小会话的窗口盖得住整份日志，唯一会砍它的
    // 就是条数上限，漏了这一层就会「少给了内容却不说」，用户会以为这个会话就这么点。
    const truncated = tail.truncated || capped.dropped > 0
    return {
      entries: capped.entries,
      latest: lastReply(capped.entries, sessionId),
      truncated,
      // 这话得分开说：① 窗口只够日志的尾部——那是「这个会话很大」；② 窗口盖住了整份，
      // 只是条数到了上限——那跟大小无关，不能也对用户说「很大」。
      note: truncated
        ? (tail.whole
          ? `只显示最近一段（读取上限：${HISTORY_MAX_ENTRIES} 条）`
          : `这个会话很大，只显示最近一段（读取上限：${HISTORY_MAX_ENTRIES} 条 / ${windowMb}MB 窗口）`)
        : null,
      // 轨迹那一份的「不是全部」由 store 自己说（它知道轨迹的上限），这里只把
      // 「被砍了多少条」交出去——读取窗口那一层的截断在上面 note 里已经说过一次了。
      trajectory: traj.turns,
      trajectoryDropped: traj.dropped,
    }
  }

  /**
   * 确保某个会话的完整历史就位。
   *
   * 不 await：这是个补数据的后台动作。刚切过去时界面先显示手里那份（或「正在读」），
   * 读完广播一份新快照，手机上那一串自然就补全了。
   */
  async function ensureHistory(sessionId) {
    if (!sessionId || historyPending.has(sessionId)) return
    // 服务没到位（headless 组合）就没得读。**不能装作在读**——那会让手机上一直
    // 显示「正在读取这个会话的记录…」，而其实谁也没去读。
    if (typeof treeServices.query?.readSession !== 'function') return
    const hit = historyCache.get(sessionId)
    if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return

    // 先占坑：手机显示「正在读」靠的就是这个标记，**必须同步到位**——
    // 同步部分走完之前不能让快照说「读完了」，否则刚绑定那一下会显示成空会话。
    historyPending.add(sessionId)

    // 盘上有日志就自己读那个窗口，不请内核那条「整份读」。2026-09-28 在本机实测
    // （1432 份会话日志的副本上跑的，见提交信息）：内核那条每读一个会话都要先把
    // **全部会话列两遍**——`corpus.load` 里一遍、v3→v4 迁移前又一遍，每遍 0.8–1.2 秒
    // ——再解整份日志、逐条克隆。1MB 的会话也要 1.7–3.6 秒；**贵的不是日志，是那两遍枚举**。
    // 自己读同一个会话：1MB 约 0.17 秒、5MB 约 0.24 秒，跟日志大小成正比、跟会话总数无关。
    // 手机点一个没选中的会话等的就是这一段，所以这条是日常路。
    //
    // 只有「盘上找不到日志」才回退内核那条：那会儿是刚建、还没落盘的会话，它给的是
    // 内存里现成的那份，不读盘、也不做迁移，正好免费。会话活着（跑着）时内核那条也不贵，
    // 但不为它分叉——大日志的活会话本来就一直走窗口读，行为是一致的；窗口读拿到的是
    // 日志尾部，刚发生、还没落盘的条目由 store 的 mergeHistory 按时间戳接在后面。
    let got = null
    try {
      if (findSessionLog(sessionId)) {
        got = readTailHistory(sessionId)
      } else {
        got = await readHistory(sessionId)
      }
    } finally {
      // 读不出来也记一笔（空结果），免得每次点进来都去读一遍坏文件。
      if (historyCache.size >= 20) historyCache.clear()
      historyCache.set(sessionId, {
        at: Date.now(),
        entries: got?.entries ?? null,
        latest: got?.latest ?? null,
        truncated: got?.truncated === true,
        note: got?.note ?? null,
        trajectory: got?.trajectory ?? null,
        trajectoryDropped: got?.trajectoryDropped ?? 0,
      })
      historyPending.delete(sessionId)
      server?.broadcast('state', store.snapshot())
    }
  }

  // store 取「完整历史」的地方（它拿不到 ctx，所以由插件注入一个回调）。
  store.setReplaySource((sessionId) => {
    const hit = historyCache.get(sessionId)
    if (hit) {
      return {
        entries: hit.entries,
        latest: hit.latest,
        pending: false,
        // 「这不是全部」要和内容一起给出去：手机得说清楚，不能让人以为
        // 这个会话只有这么点内容（读历史有上限，见 HISTORY_MAX_* 那组常量）。
        truncated: hit.truncated === true,
        note: hit.note ?? null,
        // 同一份记录里重放出来的执行轨迹（「完整」模式要的过程区）。
        // store 会把它和内存里那份合成一张表，见 store.trajectoryOf。
        trajectory: hit.trajectory ?? null,
        trajectoryDropped: hit.trajectoryDropped ?? 0,
      }
    }
    if (historyPending.has(sessionId)) return { entries: null, latest: null, pending: true }
    return null
  })

  // ------------------------------------------------------------------
  // 子智能体（2026-10-03 用户要求：把电脑端「子智能体」搬到手机）
  //
  // 和会话树同一套拿法：走 ctx.inject，服务不在就退回「没这个能力」。**不写进
  // `inject` 数组**——写进去，headless 组合下这个服务永远不来，插件就整个不加载了
  // （这个坑上面刚踩过，见 inject 那行的注释）。
  //
  // 三条路都**在进程内直接调 DSH 的服务**，不经过任何 HTTP / WebSocket：
  //   `subagents`           子代理编排服务（列表、停止、继续）
  //   `sessionProjections`  投影注册表（耗时、用量）
  //   `sessions`            会话存储（不读日志就能拿到 Session 对象）
  //
  // 插件和它们同在一个进程里，这是它比桌面前端占便宜的地方：桌面前端只能隔着
  // 一条 WebSocket 问，而那条线上只开了 `prompt` / `interruptByParent` 两个口子；
  // 列表和运行记录它反而拿不到，得靠投影另推一份。
  // ------------------------------------------------------------------
  const subagentServices = { runtime: null, projections: null, sessions: null }
  ctx.inject(['subagents'], (subCtx) => {
    subagentServices.runtime = subCtx.subagents ?? null
    // 和会话树那句同一个道理：配置里有不等于运行时真的提供了，这一句是唯一的事实来源。
    console.log('[dsh-mini-remote] 子智能体服务已就绪：' + Boolean(subagentServices.runtime))
  })
  ctx.inject(['sessionProjections'], (projCtx) => {
    subagentServices.projections = projCtx.sessionProjections ?? null
  })
  ctx.inject(['sessions'], (sessCtx) => {
    subagentServices.sessions = sessCtx.sessions ?? null
  })

  /**
   * DSH 那几个失败代号 → 一句人话。说不上来的照原样带出去，**不吞也不编**。
   *
   * 代号取自 dsh-subagent 的 `SubagentError.code`。头三句是手机上真点得到的三种：
   * 父会话不在线、同时跑的数量满了、这道子智能体接不了话。
   */
  const SUBAGENT_FAILURES = {
    PARENT_UNAVAILABLE: '它在的那个会话不在线了，这条发不过去。',
    ACTIVATION_LIMIT_REACHED: '同时能跑的子智能体已经到上限了，等一个跑完再试。',
    NOT_RESUMABLE: '这道子智能体没有对话可以接，只能看它跑过什么。',
    UNAUTHORIZED: '这道子智能体不在当前会话名下。',
    DRAINING: '它正在收尾，这会儿不接受新消息。',
    ACTIVATION_CLOSING: '它正在停下，等停稳了再试。',
    CONTINUATION_UNAVAILABLE: '这台电脑上的 DSH 没开「继续子智能体对话」这条路。',
    PERSISTENCE_UNAVAILABLE: '这台电脑上的 DSH 没开会话记录，接不了话。',
    CANCELLED: '这条请求已经取消了。',
  }
  function subagentFailure(err, what) {
    const code = err?.code
    if (typeof code === 'string' && SUBAGENT_FAILURES[code]) return SUBAGENT_FAILURES[code]
    return `${what}：${err?.message ?? err}`
  }

  /**
   * 每一行要的那两个数：耗时、用量。
   *
   * 都从 DSH 自己的投影里读（`subagentTiming` / `tokenUsage`），**不自己拿事件累加**——
   * 自己算出来的数和电脑上那一栏对不上，用户一眼就看得出来。读不到就给 null，
   * 页面上显示「—」：给 0 会被读成「真的一次都没跑过」，那是另一句话。
   *
   * 会话对象从 `sessions.get` 拿：内存里现成的，**不读日志**。老早跑完、进程里
   * 已经不在的那些拿不到——那就如实空着，不为数字好看去读它整份日志。
   */
  function subagentMetrics(childId) {
    const session = subagentServices.sessions?.get?.(childId)
    const projections = subagentServices.projections
    if (!session || typeof projections?.snapshot !== 'function') {
      return { tokens: null, durationMs: null, lastTurnCompleted: null }
    }
    let values
    try {
      values = projections.snapshot(session, ['subagentTiming', 'tokenUsage'])?.values
    } catch (err) {
      return { tokens: null, durationMs: null, lastTurnCompleted: null }
    }
    let durationMs = null
    // 「最近跑完的那一轮是正常收尾的」——页面上拿它区分绿点（真的干完了）和灰点（
    // 没在跑，但不知道最后是怎么结束的）。读不到就给 null，别猜成「成功」。
    let lastTurnCompleted = null
    const timing = values?.subagentTiming
    if (timing) {
      // 跑完的轮次累加在 settledMs；还开着的那一轮按投影记的切面算，**不用 Date.now()**
      // ——那会读出一个投影没盖到的时间，和电脑上对不上。
      const settled = Number(timing.settledMs) || 0
      const active = timing.active
        ? Math.max(0, (Number(timing.active.through) || 0) - (Number(timing.active.since) || 0))
        : 0
      durationMs = settled + active
      if (typeof timing.lastTurnCompleted === 'boolean') lastTurnCompleted = timing.lastTurnCompleted
    }
    let tokens = null
    const usage = values?.tokenUsage
    if (usage) {
      // 四个桶互不重叠（dsh-token-meter 的注释：思考 token 已算在 output 里，不再加一次）。
      tokens = (Number(usage.uncachedInputTokens) || 0) + (Number(usage.outputTokens) || 0)
        + (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0)
    }
    return { tokens, durationMs, lastTurnCompleted }
  }

  /**
   * 当前绑定会话派出的子智能体清单（含后代，按目录顺序）。
   *
   * `listDescendants` 读的是父会话自己的目录**事实**，不加载也不唤醒任何子代理——
   * 所以列一下很便宜，也不会把睡着的子代理弄醒。
   */
  const subagentMetricInflight = new Map()

  async function fillSubagentMetrics(parentSessionId, rows) {
    if (subagentMetricInflight.has(parentSessionId)) return
    const task = (async () => {
      for (const row of rows) {
        if (!row || row.diagnostic) continue
        const metrics = subagentMetrics(row.id)
        server?.broadcast('subagent-metrics', {
          parentSessionId,
          childId: row.id,
          ...metrics,
        })
      }
    })().finally(() => subagentMetricInflight.delete(parentSessionId))
    subagentMetricInflight.set(parentSessionId, task)
  }

  async function readSubagentRows(parentSessionId) {
    const runtime = subagentServices.runtime
    if (!parentSessionId) return { ok: false, error: '手机上还没有绑定会话。' }
    if (typeof runtime?.listDescendants !== 'function') {
      return { ok: false, error: '这台电脑上的 DSH 没提供子智能体。' }
    }
    let rows
    try {
      rows = await runtime.listDescendants(parentSessionId)
    } catch (err) {
      return { ok: false, error: subagentFailure(err, '读不到子智能体') }
    }
    const out = []
    for (const row of rows ?? []) {
      if (!row) continue
      // 有一支目录读不动时，DSH 拿一行「诊断」顶上来（corrupt / unsupported / unavailable）。
      // 如实转达，别当空的吞掉——吞了的表现是「明明有子智能体，却一个都不显示」。
      if (row.kind === 'diagnostic') {
        out.push({ id: String(row.id), diagnostic: String(row.reason ?? 'unavailable') })
        continue
      }
      const metrics = { tokens: null, durationMs: null, lastTurnCompleted: null }
      out.push({
        id: String(row.id),
        parentId: String(row.parentId ?? ''),
        depth: Number(row.depth) || 1,
        // 只有「可续接」谈得上继续聊；两个值之外的都按一次性处理——未知模式不许接话。
        mode: row.mode === 'continuable' ? 'continuable' : 'one-shot',
        label: typeof row.label === 'string' ? row.label : '',
        running: row.activity === 'running',
        tokens: metrics.tokens,
        durationMs: metrics.durationMs,
        lastTurnCompleted: metrics.lastTurnCompleted,
      })
    }
    return { ok: true, subagents: out, boundSessionId: parentSessionId }
  }

  async function listSubagents(parentSessionId, { includeMetrics = true, scheduleMetrics = false } = {}) {
    if (!parentSessionId) return readSubagentRows(parentSessionId)
    const cached = !includeMetrics ? subagentCache.get(parentSessionId) : null
    const rows = cached
      ? { ok: true, subagents: cached, boundSessionId: parentSessionId }
      : await readSubagentRows(parentSessionId)
    if (!rows.ok) return rows
    if (includeMetrics) {
      rows.subagents = rows.subagents.map((row) => row.diagnostic
        ? row
        : { ...row, ...subagentMetrics(row.id) })
    }
    if (!cached) subagentCache.set(parentSessionId, rows.subagents)
    if (scheduleMetrics && !includeMetrics) {
      setTimeout(() => { fillSubagentMetrics(parentSessionId, rows.subagents) }, 0).unref?.()
    }
    return rows
  }

  /**
   * 某个子智能体**自己的运行过程**。
   *
   * 数据来源和主会话**完全同一条**：`sessionQuery.readSession(childId)` 拿原始事件，
   * `replayHistory` 重放成聊天记录（和实时那条路共用同一个提取器）。电脑端「点进去
   * 看它跑了什么」看的也是它自己的会话记录，两边因此长得一样——各写一套迟早会走散。
   *
   * 地址是手机传上来的，**不能拿它当权限**：先确认它真的挂在当前绑定会话名下。
   */
  async function subagentTranscript(childId, parentSessionId) {
    if (!childId) return { ok: false, error: '没说要读哪一道子智能体。' }
    const listed = await listSubagents(parentSessionId, { includeMetrics: false, scheduleMetrics: false })
    if (!listed.ok) return listed
    const row = listed.subagents.find((s) => s.id === childId)
    if (!row) return { ok: false, error: '这道子智能体不在当前会话名下。' }
    const q = treeServices.query
    if (typeof q?.readSession !== 'function') {
      return { ok: false, error: '这台电脑上的 DSH 没提供读取会话记录的能力。' }
    }
    let snap
    try {
      snap = await q.readSession(childId)
    } catch (err) {
      return { ok: false, error: subagentFailure(err, '读不到它的记录') }
    }
    const events = Array.isArray(snap?.events) ? snap.events : []
    if (!events.length) {
      // 一次性子智能体跑完、记录已被回收时就是这里。**如实说没有记录**，不拿
      // 「读不到」冒充「它没干过活」——这两件事对用户含义不同。
      return {
        ok: true, mode: row.mode, running: row.running,
        entries: [], reclaimed: true, truncated: false, note: null,
      }
    }
    const capped = capEntries(replayHistory(events))
    return {
      ok: true,
      mode: row.mode,
      running: row.running,
      entries: capped.entries,
      reclaimed: false,
      truncated: capped.dropped > 0,
      note: capped.dropped > 0 ? `只显示最近一段（读取上限：${HISTORY_MAX_ENTRIES} 条）` : null,
    }
  }

  /**
   * 停：只停**当前这一轮**，不销毁这道子智能体（排队里的消息、它的后代都留着）。
   *
   * 权限走「人」这条：`interruptByParent(childId, parentSessionId, mode)` 拿这三个当凭据，
   * 它**不做父 Agent 在线检查**——这正是「父会话不在线，也能停下正在跑的它」的原因。
   * 一次性的没有可停的轮次，这里就挡掉，不往 DSH 递。
   */
  async function stopSubagent(childId, parentSessionId, mode) {
    const runtime = subagentServices.runtime
    if (!childId) return { ok: false, error: '没说要停哪一道子智能体。' }
    if (!parentSessionId) return { ok: false, error: '手机上还没有绑定会话。' }
    if (mode !== 'continuable') {
      return { ok: false, error: '这是一次性子智能体，跑完就结束，没有可停的轮次。' }
    }
    if (typeof runtime?.interruptByParent !== 'function') {
      return { ok: false, error: '这台电脑上的 DSH 没提供停止子智能体的能力。' }
    }
    try {
      await runtime.interruptByParent(childId, parentSessionId, 'continuable')
    } catch (err) {
      return { ok: false, error: subagentFailure(err, '停不下来') }
    }
    // 和主会话那条同一个口径：递进去不等于停稳，界面上得等它的状态翻过来。
    return { ok: true }
  }

  /**
   * 继续：往这道子智能体里递一句**人**的话。
   *
   * `prompt` 把这条记成 `source.kind === 'user'`（带 rpcId），也就是「你在它旁边说了
   * 一句」，而不是「别的 agent 转达的」。delivery 选 queue（排到它当前这轮之后）——
   * 和手机自己对主会话的做法一致：主会话正在跑时，手机上发的指令也是排队，不打断。
   *
   * requestId 是这条消息的身份，**每次都得新铸一个**：复用同一个会被判成重复投递。
   */
  async function askSubagent(childId, parentSessionId, mode, text) {
    const runtime = subagentServices.runtime
    if (!childId) return { ok: false, error: '没说要跟哪一道子智能体说话。' }
    if (!parentSessionId) return { ok: false, error: '手机上还没有绑定会话。' }
    if (!text) return { ok: false, error: '话是空的。' }
    if (mode !== 'continuable') {
      return { ok: false, error: '这是一次性子智能体，跑完就结束了，接不了话。' }
    }
    if (typeof runtime?.prompt !== 'function') {
      return { ok: false, error: '这台电脑上的 DSH 没提供继续子智能体对话的能力。' }
    }
    let requestId
    try {
      requestId = randomUUID()
    } catch (err) {
      // 兜底：uuid 拿不到也不该让这句话发不出去。
      requestId = 'mini-' + Date.now() + '-' + randomBytes(8).toString('hex')
    }
    try {
      const receipt = await runtime.prompt({
        requestId,
        parentSessionId,
        childSessionId: childId,
        mode: 'continuable',
        delivery: 'queue',
        content: [{ type: 'text', text }],
      })
      return { ok: true, messageId: receipt?.messageId ? String(receipt.messageId) : null }
    } catch (err) {
      return { ok: false, error: subagentFailure(err, '这句话没送出去') }
    }
  }

  // ------------------------------------------------------------------
  // 手机上答题：把电脑这边的提问推到手机，等它答，再把答案交还给电脑。
  //
  // 三条要点，都是踩过或想清楚了才这么写的：
  //
  // ① **必须 `{ prepend: true }`**。这条链是「遇到第一个愿意接的人就停」，而电脑上的
  //    浏览器（经由 `dsh-api-remotes`）本来就接这个提问——排在它后面就永远轮不到我。
  //    实测过：不带 prepend 时，挂根上、挂到 Agent 范围内，**两处都收不到**。
  //
  // ② **不接就让路**（`next()`）。手机没连着、问的不是手机上绑着的那个会话、
  //    提问是空的——任何一种情况都原样让给浏览器，电脑那边照常弹窗，行为不变。
  //    **插队不是为了抢，是为了有得选。**
  //
  // ③ **手机没了就把问题还回去**。用户选的是「一直等，不还回电脑」，但那不等于
  //    「手机都关了他还等」——那种情况下电脑会永远卡住、而且没人提醒他。所以判据
  //    不是倒计时，是「手机还在不在」。
  // ------------------------------------------------------------------

  // **注意这个监听器不是 async，这是刻意的，不是漏写。**
  //
  // 顾问指出的关键一条（对照 DSH 自己那个转发给远端的监听器，写法完全一致）：
  // **「接不接」必须在同步的那一瞬间定下来，异步只用来产答案。**
  // 它的形状是：同步判断 → 不接就同步 `return next()` → 接就同步 `return 一个将来会有答案的东西`。
  //
  // 我上一版是先 `await` 拿到服务、再判断、再 `return next()`——**让路的动作发生在异步之后**，
  // 交不回派发的那个链条，于是表现为"完全没接管"，而且一句错都不报。
  //
  // 另外一条同样是顾问点出来的：**异步函数抛的错，同步的 try/catch 抓不到**（它是被拒绝的
  // Promise，不是抛出的异常）。所以我之前说"日志里没报错"，**根本不能证明没出错**。
  ctx.on('user-questions/request', function (request, next) {
    const agentId = request?.agent?.id ?? null
    const bound = store.snapshot().boundSessionId
    const questions = Array.isArray(request?.questions) ? request.questions : []
    // ——— 同步阶段：只做"接不接"的判断，绝不 await ———
    // 能力从 `miniControl` 这个固定取用点拿（服务启动时主动放进去的），
    // **不再经过 createMiniServer 的回执**——实测那个回执兑现出来是 undefined。
    const phoneReady = typeof miniControl.hasPhone === 'function' ? miniControl.hasPhone() : false
    /**
     * **飞书那条路此刻能不能接这道题。**
     *
     * 三个条件，缺一不接：
     *   ① 通路在、而且**有一轮从飞书发起的指令还没落定**（见 lib/lark.js 的 serving）——
     *      手机上发起的轮次不该因此抢掉电脑上的弹窗；
     *   ② 这道题在飞书里写得成一段纯文本（`feishuQuestionText` 写不成时给空串：
     *      两道以上的题里混着一道没有选项的题，数字协议表达不了）；
     *   ③ 那段话不超过一条消息的上限。
     * 接不了就当飞书那边不存在，电脑和手机照旧——**一个字都不变**。
     */
    const askText = feishuQuestionText(questions)
    const feishuReady = Boolean(feishu)
      && askText !== ''
      && askText.length <= FEISHU_TEXT_LIMIT
      && typeof feishu.serving === 'function'
      && feishu.serving()
    /**
     * **让路的那三种情况，每一种都留一行。**
     *
     * 2026-09-27 用户报「电脑上弹出了选项，手机上什么都没有」。当时这条链上只有
     * 「答好了」和「出错」两句日志——正好把**让路**这半边全留白了，于是只能靠猜：
     * 是手机没连、还是问的不是手机上绑的那个会话，日志里看不出来。
     * 现在每次被叫到都记一行「问的是谁、手机绑的是谁、题数、手机在不在」。
     * **不记题目正文**——那是用户自己的话。
     */
    if (!agentId || agentId !== bound || questions.length === 0) {
      console.log(`[dsh-mini-remote] 提问让路：问的=${agentId ?? '无'}，手机绑的=${bound ?? '无'}，题目数=${questions.length}`)
      return next()
    }
    if (!phoneReady && !feishuReady) {
      console.log('[dsh-mini-remote] 提问让路：手机和飞书此刻都接不上（页面没开、锁屏或断网，飞书那头没有在等的轮次），交给电脑')
      return next()
    }
    if (typeof miniControl.askPhone !== 'function') {
      console.log('[dsh-mini-remote] 提问让路：拿不到 askPhone（手机服务还没起来），交给电脑')
      return next()
    }
    // ——— 同步交出"将来会有答案"的东西；下面的等待都在这里，不再有同步判断 ———
    console.log(`[dsh-mini-remote] 提问推给手机：${questions.length} 题，等它答`
      + (feishuReady ? '（飞书那边一起问）' : ''))
    /**
     * `askId` 是这道题在**手机页那份清单**里的编号，由 `onPending` 当场交出来。
     * 它只用来问一件事：「飞书那边还挂着这道题吗」（见 keepAlive）——
     * 题目的胜负、谁先答谁生效，全在 lib/server.js 那份清单里，这里不另判。
     */
    let askId = null
    return miniControl.askPhone(questions, agentId, {
      onPending: (id) => {
        askId = id
        // 飞书那边写成一段普通文字问出来。它没接（写不成、或发不出去就当场撤回）时，
        // keepAlive 下一次为 false，题照旧还给电脑。
        feishu?.openAsk?.({ id, kind: 'question', payload: questions })
      },
      // 「手机全断了要不要收摊」的第二个判据：飞书那边还挂着这道题就别收。
      keepAlive: () => Boolean(feishu && askId && feishu.isWaiting?.(askId)),
    }).then((answer) => {
      // 手机中途没了：把问题还给电脑，那边照常弹窗——不会两头都答不上。
      // 这一句日志是「手机上答了、电脑上没动静」那类现象唯一能落下来的痕迹：
      // 有它才知道手机那份答案没接上（断线、或者答晚了一步），而不是插件没在跑。
      if (askId) feishu?.expireAsk?.(askId)
      if (!answer) {
        console.log('[dsh-mini-remote] 手机上没答成（连接断了、或者答晚了），这题还给电脑')
        return next()
      }
      console.log('[dsh-mini-remote] 手机上答好了，交给电脑')
      return answer
    }).catch((err) => {
      // 我这边出任何问题都不能把提问吞掉，一律让回电脑。
      if (askId) feishu?.expireAsk?.(askId)
      console.log('[dsh-mini-remote] 接管提问出错，让回电脑：' + String(err))
      return next()
    })
  }, { prepend: true })
  // ------------------------------------------------------------------
  // 命令确认（审批）也推到手机上
  // ------------------------------------------------------------------
  // 形状照抄上面那条提问链，**连同它踩过的坑一起抄**：
  // ①监听器不能写成 async——「接不接」必须在同步那一瞬间定下来，异步只用来产答案；
  //   写成先 await 再判断，会让路的动作交不回派发的链条，表现是"完全没接管、且不报错"。
  // ②让路的每一种情况都留一行日志，否则下次报"手机上什么都没有"又只能靠猜。
  // ③**不记正文**：只记工具名，命令原文是用户自己的东西。
  // ④出错一律 next()，绝不把命令确认吞掉。
  ctx.on('approval/request', function (request, next) {
    const agentId = request?.agent?.id ?? null
    const bound = store.snapshot().boundSessionId
    const toolName = request?.toolName ?? '某个工具'
    // 这次到底要跑什么：审批请求只带调用编号，参数在会话事件里记着的那份。
    const command = request?.callId ? (toolCalls.get(String(request.callId)) ?? '') : ''
    const phoneReady = typeof miniControl.hasPhone === 'function' ? miniControl.hasPhone() : false
    // 飞书那条路此刻能不能接：判据和上面那条提问链**一模一样**（可能接、写得成、不超长）。
    const view = {
      toolName: typeof toolName === 'string' && toolName ? toolName : '某个工具',
      reason: typeof request?.reason === 'string' ? request.reason : '',
      command: typeof command === 'string' ? command : '',
    }
    const approvalAskText = approvalText(view)
    const feishuReady = Boolean(feishu)
      && approvalAskText.length <= FEISHU_TEXT_LIMIT
      && typeof feishu.serving === 'function'
      && feishu.serving()
    if (!agentId || agentId !== bound) {
      console.log(`[dsh-mini-remote] 审批让路：批的=${agentId ?? '无'}，手机绑的=${bound ?? '无'}`)
      return next()
    }
    if (!phoneReady && !feishuReady) {
      console.log('[dsh-mini-remote] 审批让路：手机和飞书此刻都接不上（页面没开、锁屏或断网，飞书那头没有在等的轮次），交给电脑')
      return next()
    }
    if (typeof miniControl.askApproval !== 'function') {
      console.log('[dsh-mini-remote] 审批让路：拿不到 askApproval（手机服务还没起来），交给电脑')
      return next()
    }
    console.log(`[dsh-mini-remote] 审批推给手机：${toolName}，等它拍板`
      + (feishuReady ? '（飞书那边一起问）' : ''))
    let askId = null
    return miniControl.askApproval(request, agentId, command, {
      onPending: (id) => {
        askId = id
        feishu?.openAsk?.({ id, kind: 'approval', payload: view })
      },
      keepAlive: () => Boolean(feishu && askId && feishu.isWaiting?.(askId)),
    }).then((outcome) => {
      if (askId) feishu?.expireAsk?.(askId)
      if (!outcome) {
        console.log('[dsh-mini-remote] 手机上没拍成（连接断了、或者拍晚了），这条还给电脑')
        return next()
      }
      console.log('[dsh-mini-remote] 手机上拍板了：' + outcome)
      return outcome
    }).catch((err) => {
      if (askId) feishu?.expireAsk?.(askId)
      console.log('[dsh-mini-remote] 接管审批出错，让回电脑：' + String(err))
      return next()
    })
  }, { prepend: true })

  // ------------------------------------------------------------------
  // 手机端「新建会话」要用的服务
  // ------------------------------------------------------------------
  // **单独 inject，绝不能并进上面那个数组**：`ctx.inject` 是「等齐了才回调」，
  // 把一个可能不来的服务并进去，连工作区列表都会一起没了——本来只是少个按钮，
  // 结果整个导航栏都空掉。分开就互不牵连。
  //
  // 拿到的是 `sessionController`（`@deepseek-ai/dsh-api-session-controller` 注册的名字），
  // 就是网页端新建会话走的那条路。它的 `create({ workspaceId })` 内部会拼好会话、
  // 装模型、挂 preset，最后交给 `ctx.agents.create()`。
  //
  // 这行日志是运行时事实的唯一来源：服务到底来没来、`create` 是不是函数，
  // 「配置里挂了」只是推断，这里打出来的才算数。
  const canCreate = { controller: null }
  ctx.inject(['sessionController'], (createCtx) => {
    canCreate.controller = createCtx.sessionController
    console.log('[dsh-mini-remote] 新建会话已就绪：sessionController='
      + Boolean(canCreate.controller) + ' create=' + typeof canCreate.controller?.create)
  })

  // ------------------------------------------------------------------
  // 手机上传文件要用的附件服务
  // ------------------------------------------------------------------
  // 同样走 ctx.inject、不写进 inject 数组（理由同上）。没有它的时候上传按钮会
  // 如实说「这台电脑传不了文件」，而不是让用户点了没反应。
  ctx.inject(['attachments'], (attachCtx) => {
    attachments = attachCtx.attachments
    console.log('[dsh-mini-remote] 附件服务已就绪：可以接收手机上传的文件')
  })

  // ------------------------------------------------------------------
  // 斜杠指令账本
  // ------------------------------------------------------------------
  // 走 ctx.inject、不写进 inject 数组（理由同上）。**指令列表不属于这个插件**：
  // 它是 DSH 的账本，别的插件往里注册。手机只是多了一个「能发起指令的界面」——
  // 所以这里不认识任何一条具体指令，也就不会有「手机上少了一条」的问题。
  ctx.inject(['commands'], (cmdCtx) => {
    commandService = cmdCtx.commands
    console.log('[dsh-mini-remote] 指令服务已就绪：手机上可以执行斜杠指令')
  })

  /**
   * 手机要的那份指令名单。
   *
   * 三种「拿不到」要分开说，因为下一步动作完全不同：没绑会话 / 会话没在跑 /
   * 这台电脑没有指令服务。合成一句「取不到指令」，用户不知道该去做什么。
   */
  function onCommands() {
    const sessionId = targetSessionId()
    if (!sessionId) return { ok: false, error: '电脑上还没有可遥控的会话。' }
    const agent = ctx.agents.get(sessionId)
    if (!agent) {
      return { ok: false, error: '这个会话现在没在跑，指令要先让它跑起来（发一句话）。' }
    }
    if (agent.session?.header?.origin === 'subagent') {
      return { ok: false, error: '这是个子 Agent，手机上用不了它的指令。' }
    }
    if (!commandService) return { ok: false, error: '这台电脑上的 DSH 没提供指令。' }
    try {
      return { ok: true, commands: describeCommands(commandService.list(agent)) }
    } catch (err) {
      return { ok: false, error: `取指令列表失败：${err?.message ?? err}` }
    }
  }

  /**
   * 执行一条斜杠指令。
   *
   * **照抄 DSH 自己的语义，不自己发明**：指令行以 `/` 开头、名字是小写字母打头，
   * 名字后面原样的一段归指令自己解释（我们连那个分隔空格都不动）。满足形状、
   * 又确实注册过的，才交给 `execute`；其余一律**拒绝并说明**，绝不退回去当普通消息
   * 发给模型——那正是「打错的指令白跑一轮模型」的来源。
   *
   * 这里**不等它跑完**（`execute` 要到处理器结束才 resolve）：指令的进度和结果是通过
   * 会话事件（command/run、command/done）推到手机上的，和电脑端同一份账。
   * 等它跑完会让这条 HTTP 请求一直挂着——像 /compact 这种要跑十几秒的指令，
   * 手机上就成了「点了没反应」。
   *
   * 附件**这一版递不进去**：`execute` 要的是 DSH 自己那套上传小票，而手机上传走的是
   * 另一套存储，两者不通（2026-09-25 查证）。所以这里一个附件都不传——输入框里那些
   * 附件会原样留着，跟下一条普通消息一起发出去，不会丢。
   */
  async function onCommand(line) {
    const sessionId = targetSessionId()
    if (!sessionId) return { ok: false, error: '电脑上还没有可遥控的会话。' }
    const agent = ctx.agents.get(sessionId)
    if (!agent) {
      return { ok: false, error: '这个会话现在没在跑，指令要先让它跑起来（发一句话）。' }
    }
    if (agent.session?.header?.origin === 'subagent') {
      return { ok: false, error: '这是个子 Agent，手机上用不了它的指令。' }
    }
    if (!commandService) return { ok: false, error: '这台电脑上的 DSH 没提供指令。' }

    const parsed = parseSlashLine(line)
    if (!parsed) return { ok: false, error: invalidCommandMessage() }
    if (!commandService.find(agent, parsed.name)) {
      return { ok: false, error: unknownCommandMessage(parsed.name) }
    }

    // 不等：结果走事件流。但仍要接住异常，否则会变成没人处理的 Promise 拒绝，
    // 在这台机器上表现为进程级的告警，而手机上什么也看不到。
    const signal = new AbortController().signal
    Promise.resolve(commandService.execute(agent, line, [], signal)).catch((err) => {
      log.warn(`指令 /${parsed.name} 执行异常：${err?.message ?? err}`)
    })
    return { ok: true }
  }

  /**
   * 把手机传来的字节交给 DSH 存，换一张小票回来。
   *
   * 为什么不自己存到某个目录、再在指令文字里写一行路径：DSH 的消息结构里本来就有
   * 附件这种块，它会在发请求前自动把附件换成一段带路径的提示给模型读。文件名消毒、
   * 内容寻址、只读副本、引用校验全是它的事。自己拼路径等于把这些统统绕过去，还要
   * 自己管清理、自己保证不把文件塞进工作区。
   *
   * `data` 是请求流本身（Node 的 IncomingMessage 就是异步可迭代的字节流），DSH 那边
   * 是边收边落盘，不在内存里攒整份。
   */
  async function onUpload({ data, name }) {
    if (!attachments) throw new Error('这台电脑上的 DSH 没装附件服务')
    const ref = await attachments.saveFileStream({ data, ...(name ? { name } : {}) })
    const uploadId = randomUUID()
    uploads.set(uploadId, ref)
    // 别让它无限涨：手机传完却一直不发指令的话，这些引用就一直挂着。
    // 按插入顺序淘汰最早的——手机上同时挂着二十个待发文件不现实。
    if (uploads.size > MAX_PENDING_UPLOADS) {
      uploads.delete(uploads.keys().next().value)
    }
    return { uploadId, name: ref.name, bytes: ref.bytes }
  }

  /** 把小票换成附件引用。认不出来的小票直接丢掉，不猜。 */
  function takeUploads(uploadIds) {
    const refs = []
    for (const id of Array.isArray(uploadIds) ? uploadIds : []) {
      const ref = uploads.get(id)
      if (ref) {
        refs.push(ref)
        uploads.delete(id) // 用掉就作废，同一条不能发两次
      }
    }
    return refs
  }

  // 插件自己在事件流里见过的标题——内存里就有，不用去读日志。
  function knownTitles() {
    const map = new Map()
    for (const s of store.snapshot().sessions ?? []) {
      if (s.title) map.set(s.id, s.title)
    }
    return map
  }

  // 权限档位。跟建会话一样**单独一条 inject**：这个服务依赖 ctx.shell 和
  // ctx.approval，headless 组合里根本不存在。要是跟别的服务挤在同一条 inject 里，
  // 它不到场会把那条 inject 上的其它服务一起拖住——本项目在 tree 那三件套上
  // 踩过这个坑，上面有注释。
  const presets = { service: null }
  ctx.inject(['permissionPresets'], (permCtx) => {
    presets.service = permCtx.permissionPresets
    console.log('[dsh-mini-remote] 权限档位已就绪：'
      + (presetsAvailable(presets.service) ? presets.service.names.join(' / ') : '拿不到'))
  })

  // 审批通道。同款做法：**单独一条 inject**，因为它也可能不到场（headless 组合里就没有）。
  // 到场了，手机才有机会接住命令确认；不到场就什么都不做，电脑端原来的弹窗照旧。
  const approvals = { service: null }
  ctx.inject(['approval'], (approvalCtx) => {
    approvals.service = approvalCtx.approval ?? null
    console.log('[dsh-mini-remote] 审批通道已就绪：'
      + (approvals.service ? '拿得到' : '拿不到'))
  })

  /**
   * 按 id 取会话对象。
   *
   * `PermissionPresetService` 的读和写都收**会话对象**而不是 id
   * （`current(session)` / `set(session, name)`），所以得先拿 agent 再取它的 session。
   * 拿不到就回 null——手机那边会显示「暂时读不到」，而不是整页崩掉。
   */
  function sessionFor(sessionId) {
    if (!sessionId) return null
    try {
      return ctx.agents?.get(sessionId)?.session ?? null
    } catch (err) {
      return null
    }
  }

  const nav = {
    listWorkspaces: (runningIds, force, includeEmpty) =>
      listWorkspaces({ registry: treeServices.registry, query: treeServices.query, runningIds, force, includeEmpty, meta: sessionMeta }),
    listSessionsOf: (workspaceId, limit, force, onTitle) =>
      listSessionsOf({
        registry: treeServices.registry,
        query: treeServices.query,
        agents: ctx.agents,
        knownTitles: knownTitles(),
        persisted: titles,
        workspaceId,
        limit,
        force,
        onTitle,
        meta: sessionMeta,
      }),
    // 建会话：先用 inject 拿到的那个，拿不到就现读一次——`ctx.get` 对没写进 inject
    // 的服务名是**返回 undefined**（不是抛错），所以这么写是安全的。
    createSession: (workspaceId) =>
      createSessionIn({
        controller: canCreate.controller ?? ctx.get('sessionController'),
        registry: treeServices.registry,
        workspaceId,
      }),
    // 「这一刻到底能不能建会话」。给 /mini/api/version 用：那是个不用动手、
    // 一条命令就能问的运行时事实，比翻日志快。和 createSession 同一条判据，
    // 免得出现「探测说能、真按了却不行」。
    canCreateSession: () =>
      typeof (canCreate.controller ?? ctx.get('sessionController'))?.create === 'function',
    // 登记工作区。`workspaceRegistry` 就是上面那三个服务里的 registry，
    // 已经注入到位了，不用再开一条依赖。
    createWorkspace: (path) =>
      createWorkspaceAt({ registry: treeServices.registry, path }),
    // 权限档位。作用域就是传进来的那个会话——手机只绑一个会话，所以
    // 「当前会话」和「绑定会话」是同一件事，不用另外记状态。
    permissions: (sessionId) =>
      listPresets({ service: presets.service, session: sessionFor(sessionId) }),
    setPermission: (sessionId, name) =>
      setPreset({ service: presets.service, session: sessionFor(sessionId), name }),

    // 子智能体（2026-10-03）。四条都取**当前绑定会话**那一份，和上面 send / stop
    // 同一套口径：手机上遥控的是你正看着的那个会话，不该牵动你在电脑上另开的那个。
    subagents: (sessionId, options) => listSubagents(sessionId, options),
    subagentTranscript: (childId, sessionId) => subagentTranscript(childId, sessionId),
    stopSubagent: (childId, sessionId, mode) => stopSubagent(childId, sessionId, mode),
    askSubagent: (childId, sessionId, mode, text) => askSubagent(childId, sessionId, mode, text),

    // 模型与思考强度（2026-09-25 用户要求：手机上要能改每个会话的模型和强度）。
    // `canCreate.controller` 就是 `ctx.sessionController`——和上面 createSession 同一个东西。
    //
    // 有个区别要记牢：**目录是全局的，选中的那个是会话级的**。所以列清单只要问一次，
    // 「现在用哪个」得按会话问。`ModelSelection` 就是 `{ provider, model, reasoningEffort? }`，
    // 强度不是单独一项设置，它是模型选择的一部分——这也是为什么两个按钮要一起改。
    //
    // 拿不到能力时如实说 `unavailable`，让手机整块不显示。**不假装只有一种模型可选**：
    // 那会让用户以为自己的模型被换掉了。
    modelCatalog: async () => {
      const controller = canCreate.controller ?? ctx.get('sessionController')
      if (typeof controller?.modelCatalog !== 'function') return { ok: false, reason: 'unavailable' }
      return { ok: true, catalog: await controller.modelCatalog() }
    },
    selectModel: async (sessionId, selection) => {
      const controller = canCreate.controller ?? ctx.get('sessionController')
      if (typeof controller?.selectModel !== 'function') return { ok: false, reason: 'unavailable' }
      const value = await controller.selectModel({ sessionId, ...selection })
      return { ok: true, selected: value?.selected ?? null }
    },
    // 某个会话**现在到底用哪个模型**。
    //
    // 为什么非得问 DSH、不能自己记：插件只在会话跑起来时才从事件里看到模型
    // （request/header），没在插件眼皮底下跑过的会话——比如重启之前用过的那些——
    // 手里就是空的。上一版给空值兜了一个「目录默认值」，结果把一个不知道的会话
    // 显示成上次选过的那个模型：看着像对的，其实是编的。**宁可说不知道，也不编。**
    //
    // 两条路，**第二条是必须的**：
    //   ① 会话正活着 → 它的 `requestHeader()` 直接给结果，走内存，最快。
    //   ② 会话睡在硬盘上 → 去它的日志里翻最后那条 request/header 事件。
    //
    // ② 不是备胎，是主路。手机上能挑的是**全部**会话（这个工作区里就有上百个），
    // 而「活着的」通常只有开着的两三个——只走 ① 的话，用户切到绝大多数会话都只能
    // 看到「还没问到」。查证过：147 个会话里只有 3 个是活的。
    //
    // 用 `sessionQuery.listEvents`：它的说明是「列出原始日志事件」，并且注明
    // **优先取活着的、没有就读硬盘**——两件事一个方法全包，不用我自己分支。
    // 用量不再需要主动去问：它跟着事件自己更新（见 usageInputTokens）。

    sessionModel: async (sessionId) => {
      if (!sessionId) return { ok: false, reason: 'no-id' }
      const shape = (cfg) => ({
        provider: typeof cfg.provider === 'string' ? cfg.provider : null,
        model: cfg.model,
        reasoningEffort: typeof cfg.reasoningEffort === 'string' ? cfg.reasoningEffort : null,
      })

      // ① 活着的会话：内存里就有
      const sessions = ctx.get('sessions')
      const live = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
      const liveCfg = live && typeof live.requestHeader === 'function' ? live.requestHeader()?.config : null
      if (liveCfg && typeof liveCfg.model === 'string') return { ok: true, model: shape(liveCfg) }

      // ② 睡着的会话：读硬盘上的日志，从后往前找最后那条 request/header。
      //
      // **必须用 `readSession`，不能用 `listEvents`。** 后者给的是**元数据**
      // （sessionId / seq / type / time / surface），**没有 `data`**——而配置恰恰在
      // `data` 里。这个已经试过一次，读出来是空的，白跑一轮。`readSession` 给的是
      // 完整的原始事件，`data.header.config` 就在里面。
      //
      // 读整个日志是贵的，而手机每 15 秒会来问一次，所以缓存 60 秒：桌面那边改了模型，
      // 最迟一分钟内在手机上出现。手机自己改的那次走另一条路（那条接口会把新值直接
      // 写进会话记录），不受这个缓存影响。
      const cache = treeServices.modelCache || (treeServices.modelCache = new Map())
      const hit = cache.get(sessionId)
      if (hit && Date.now() - hit.at < 60000) return hit.value

      const q = treeServices.query
      let value
      if (typeof q?.readSession !== 'function') {
        value = { ok: false, reason: 'unavailable' }
      } else {
        try {
          const snap = await q.readSession(sessionId)
          const events = Array.isArray(snap?.events) ? snap.events : []
          value = { ok: false, reason: 'no-header' }
          for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i]
            if (!e || e.type !== 'request/header') continue
            const cfg = e.data?.header?.config
            if (cfg && typeof cfg.model === 'string') { value = { ok: true, model: shape(cfg) }; break }
          }
        } catch (err) {
          value = { ok: false, reason: 'read-failed', error: String(err && err.message ? err.message : err) }
        }
      }
      if (cache.size > 50) cache.clear()
      cache.set(sessionId, { at: Date.now(), value })
      return value
    },

    /**
     * 某个会话「上下文用了多少」——**只在内存里那份缺分母时**才用得上的兜底。
     *
     * 正常情况不用走到这儿：会话跑起来时每一步的 usage 都会把 {used, window} 记进
     * store（见上面 usageInputTokens / contextWindowOf），手机读到的是最鲜活的一份。
     * 这条路是给「插件晚一步起来」的会话准备的：窗口那条事件一个会话只写一次
     * （理由见 contextWindowOf），插件没赶上就永远等不到，内存里于是永远缺分母。
     * 而日志里两半都齐——最后一条 `request/context` 是分母，最后一次
     * `assistant/message` 的 usage 是分子，都是 DSH 自己记下的事实，不是我们估的。
     *
     * 读整份日志是贵的，所以和 sessionModel 一样缓存 60 秒。**只在内存里没有时才问**，
     * 所以会话一跑起来（store 有了值）就再也不会读盘。
     *
     * 两半缺任一个都返回 null：宁可空着，也不拿别的数凑。
     */
    sessionContext: async (sessionId) => {
      if (!sessionId) return null
      const cache = treeServices.contextCache || (treeServices.contextCache = new Map())
      const hit = cache.get(sessionId)
      if (hit && Date.now() - hit.at < 60000) return hit.value

      const q = treeServices.query
      let value = null
      if (typeof q?.readSession === 'function') {
        try {
          const snap = await q.readSession(sessionId)
          const events = Array.isArray(snap?.events) ? snap.events : []
          // 一遍扫到底、各自留最后一条：窗口在日志开头（那时才写），用量在末尾，
          // 从后往前找反而要白走几千条。两个数都是「最近一次」才算数。
          let window = 0
          let used = 0
          for (const e of events) {
            if (!e) continue
            if (e.type === 'request/context') {
              const w = e.data?.contextWindow
              if (typeof w === 'number' && w > 0) window = w
            } else if (e.type === 'assistant/message' && e.data?.usage) {
              const u = usageInputTokens(e.data.usage)
              if (u > 0) used = u
            }
          }
          if (used > 0 && window > 0) value = { used, window }
        } catch {
          // 读不出来就当没有——手机上少一个数，好过报一个错。
          value = null
        }
      }
      if (cache.size > 50) cache.clear()
      cache.set(sessionId, { at: Date.now(), value })
      return value
    },
  }

  // ------------------------------------------------------------------
  // 起服务
  // ------------------------------------------------------------------
  ctx.effect(() => {
    let closed = false
    createMiniServer({
      store,
      config: settings,
      token,
      bindAddresses: resolveBindAddresses(settings.bindAddress),
      tunnelHost,
      log,
      onInstruction,
      onCommands,
      onCommand,
      onUpload,
      onStop,
      onUnqueue,
      // 手机点开会话（或刷新页面）时，把那条会话的完整历史读出来。
      onSessionOpened: (sessionId) => ensureHistory(sessionId),
      tree: nav,
      // 正文里写相对路径的图（`![](scratch/a.png)`）相对的是**那段对话的工作目录**，
      // 而不一定是插件根。所以把当前已注册工作区的目录一并递过去当额外候选根。
      // `treeServices.registry` 就是 DSH 的 workspaceRegistry（注入见上面那段），
      // 服务这边拿不到 ctx，只能由插件给——传函数不传快照，理由和 treeServices 一样：
      // 服务每次请求现读，工作区是随时会变的。
      imageRoots: () => (treeServices.registry?.list?.() ?? []).map((w) => w?.path),
      // 目录浏览自己读盘（理由见 lib/browse.js 开头：DSH 的目录选择器在
      // 「Windows + 只绑回环」时会判成 native，那套动词是直接拒绝的，
      // 会在电脑屏幕上弹框——而用户正在外面用手机）。
      browse: { listRoots, listDirectory, makeDirectory },
      build: BUILD,
    })
      .then((instance) => {
        if (closed) {
          instance.close()
          return
        }
        server = instance
        serverError = null
        for (const f of instance.failed) {
          log.warn(`地址 ${f.address} 没绑上，已跳过：${f.message}`)
        }
        const usable = reachableAddresses().filter((a) => instance.addresses.includes(a.address))
        if (usable.length) {
          console.log(`[dsh-mini-remote] 构建指纹 ${BUILD}`)
          log.info('已启动。手机打开下面任意一条（或到 DSH 设置 → 手机遥控 扫码）：')
          for (const a of usable) {
            log.info(`  ${a.label}  http://${a.address}:${instance.port}/mini?token=${token}`)
          }
        } else {
          log.info(`已启动，但只绑上了本机：http://127.0.0.1:${instance.port}/mini?token=${token}`)
          log.warn('没找到手机能连上的地址——检查 Wi-Fi／网线，或者 Tailscale 是否已登录。')
        }
        // 服务起来了才谈得上开隧道：cloudflared 要指向这个端口
        if (settings.tunnel?.enabled) bringTunnelUp()
        // 重启前手机在看哪个会话，就先把它的完整历史补上——用户打开手机时
        // 该看到的是那个会话的全貌，而不是「重启之后才发生的事」。
        ensureHistory(store.snapshot().boundSessionId)
      })
      .catch((err) => {
        // 记下来。设置页那边要拿它把「还在启动」和「起不来了」分开说——
        // 只写日志的话，用户看到的永远是那句「过几秒刷新一下」。
        serverError = err?.message ?? String(err)
        log.warn(`启动失败：${serverError}`)
      })

    return () => {
      closed = true
      bringTunnelDown()
      server?.close()
      server = null
    }
  })

  // ------------------------------------------------------------------
  // 飞书那条路自己的生死
  // ------------------------------------------------------------------
  /**
   * 单独一个 effect，不和手机服务那一个搅在一起：这两样各有各的失败方式，
   * 一个起不来不该把另一个拖下水。
   *
   * `closed` 那一道和手机服务同一个道理——建连接是异步的，而插件随时可能被卸载。
   * 建好时如果已经卸了，当场把它关掉，不能留下一条没人管的连接和它自己的定时器。
   */
  ctx.effect(() => {
    let closed = false
    const start = async () => {
      await bringFeishuUp()
      if (closed) bringFeishuDown()
    }
    start()
    return () => {
      closed = true
      bringFeishuDown()
    }
  })

  // ------------------------------------------------------------------
  // DSH 设置页的「手机遥控」标签从这里取数据
  // ------------------------------------------------------------------
  // 用 ctx.inject 而不是 ctx.effect + 直接读 ctx.webServer，两个理由：
  //   1. cordis 的 ctx 代理对「没写进 inject 的服务名」是**抛错**
  //      （cannot get property "webServer" without inject），不是给 undefined，
  //      所以「不注入、拿不到就降级」这条路走不通；
  //   2. boot 期各插件是并行加载的，apply 这一刻 webServer 常常还没 provide，
  //      ctx.get('webServer') 只会拿到 undefined 而且永不重试（dsh-config-manager
  //      现在就在 boot 时打这条 warn）。
  // ctx.inject 会在 webServer 就绪后回调；纯 headless 组合里它永远不来，这个子
  // fiber 就一直不激活——不报错，也不影响手机端自己那个 3090 服务。
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (typeof webServer?.register !== 'function') {
      log.warn('拿不到 webServer 服务，设置页里的扫码面板用不了（手机端不受影响）。')
      return
    }

    // 面板和开关都带着 token，所以两者都只允许从这台电脑自己访问。否则同一个
    // Wi-Fi 下谁都能把密码取走，token 就白设了。
    function localOnly(req, res) {
      if (isLocalRequest(req)) return true
      sendJson(res, 403, { ok: false, error: '配对信息只能在这台电脑上看。' })
      return false
    }

    async function pairingPayload() {
      if (!server) {
        // 分清「还在启动」和「起不来了」。原来两种情况都回同一句「过几秒刷新一下」，
        // 但失败之后 server 永远不会建好——用户会一直刷新，而且提示里没有半个字
        // 告诉他出了什么事。失败时把真实原因说出来，并告诉他去哪儿改。
        return {
          status: 503,
          body: {
            ok: false,
            error: serverError
              ? `手机服务起不来：${serverError}\n端口可以在设置文件里改（settings.json 里的 port）。`
              : '手机服务还在启动，过几秒刷新一下。',
            // 手机服务没起来，不影响飞书那一块——它和手机服务没有关系，谁用谁的。
            // 所以这一条早退路径上也带着 feishu，用户至少改得动它。
            feishu: feishuStatus(),
          },
        }
      }
      const payload = await buildPairing({
        port: server.port,
        token,
        bound: server.addresses,
        tunnel: {
          enabled: Boolean(settings.tunnel?.enabled),
          // 判死之后**不再把网址交出去**（判断在 pairing.js 的 tunnelUrlFor 里，
          // 抽出去是为了能单测——它决定了用户会不会扫到一个扫不开的码）。
          url: tunnelUrlFor(tunnelHealthy, tunnel?.url),
          starting: tunnelStarting,
          error: tunnelError,
        },
        /**
         * Tailscale 那条路上的 HTTPS 地址。
         *
         * **每次刷新都现问一次**，不缓存：这个状态会被别的东西改掉——用户可能在
         * 命令行里 `tailscale serve --https=443 off`，也可能 Tailscale 自己升级后
         * 配置没了。缓存一份就会漂移，而漂移的表现是「面板上写着已开启、手机却打不开」，
         * 正是 2026-09-22 隧道那次踩过的坑。
         *
         * 问的是 `server.port`（**实际**在听的那个），不是配置里的 port——
         * 端口被占时服务会自己往后让，用配置值会指错。
         */
        serve: await serveState(server.port),
        // 飞书那一块的现状（**永远不含 appSecret**，只回答「有没有凭据」）。
        feishu: feishuStatus(),
      })
      return { status: payload.ok ? 200 : 500, body: payload }
    }

    const offGet = webServer.register({
      kind: 'exact',
      path: '/mini-remote/pairing',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        try {
          const { status, body } = await pairingPayload()
          sendJson(res, status, body)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: `读取配对信息失败：${err?.message ?? err}` })
        }
      },
    })

    const offTunnel = webServer.register({
      kind: 'exact',
      path: '/mini-remote/tunnel',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        let want
        try {
          want = await readBody(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
          return
        }
        const enabled = Boolean(want?.enabled)
        settings.tunnel = { ...settings.tunnel, enabled }
        persistSettings()
        if (enabled) await bringTunnelUp()
        else bringTunnelDown()
        try {
          const { status, body } = await pairingPayload()
          sendJson(res, status, body)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: `切换之后读不到状态：${err?.message ?? err}` })
        }
      },
    })

    /**
     * 开/关 Tailscale 的 HTTPS 地址。
     *
     * 和公网那个开关一样**只允许本机调用**（`localOnly`）：它会改这台电脑上
     * Tailscale 的配置，不该让手机或同网段的别人碰到。
     *
     * 失败时把 `enableLink` 一起带回去——那是 tailnet 没开 Serve 时 Tailscale
     * 官方印出来的开启链接。整个功能里门槛最高的就是这一步，把链接原样递给用户，
     * 他点一下就完事；自己写一句「请到后台开启」等于把门槛加回去。
     */
    const offServe = webServer.register({
      kind: 'exact',
      path: '/mini-remote/serve',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        let want
        try {
          want = await readBody(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
          return
        }
        if (!server) {
          sendJson(res, 503, { ok: false, error: '手机服务还在启动，过几秒再试。' })
          return
        }
        try {
          const r = want?.enabled ? await serveEnable(server.port) : await serveDisable()
          if (!r.ok) {
            sendJson(res, 400, {
              ok: false,
              error: r.error,
              enableLink: r.enableLink ?? null,
              reason: r.reason ?? 'other',
            })
            return
          }
        } catch (err) {
          sendJson(res, 500, { ok: false, error: `切换 HTTPS 地址失败：${err?.message ?? err}` })
          return
        }
        try {
          const { status, body } = await pairingPayload()
          sendJson(res, status, body)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: `切换之后读不到状态：${err?.message ?? err}` })
        }
      },
    })

    /**
     * 密码最短多少位。
     *
     * 12 位是「好记」和「猜不出」之间的折中。之所以不能像普通登录框那样放开短的：
     * 密码是编在网址里的（`?token=...`），猜的人不受表单那套限速的约束——他可以直接
     * 对着地址栏试，而限速只在服务端挡。用户想设成自己记得住的东西，这个需求是合理的，
     * 但「123456」这种等于把门拆了。
     */
    const MIN_TOKEN_LEN = 12

    /**
     * 换一个自己设的密码。
     *
     * **要重启 DSH 才生效。** 服务在启动时就把 token 读进内存了（见上面的
     * `loadOrCreateToken`），改文件不影响正在跑的那个。做成「立刻生效」得改服务内部的
     * 取值方式，影响面比这个需求本身大，所以这里如实告诉用户要重启，而不是假装换好了。
     *
     * 返回的 payload 里带一个 `pendingToken`：界面据此显示「新密码已保存，重启后生效」。
     * 面板上那些二维码仍然是**当前在用的**旧密码编出来的——它们在重启前确实还能用，
     * 显示成新的就成了骗人。
     */
    const offToken = webServer.register({
      kind: 'exact',
      path: '/mini-remote/token',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        let want
        try {
          want = await readBody(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
          return
        }
        const next = typeof want?.token === 'string' ? want.token.trim() : ''
        if (next.length < MIN_TOKEN_LEN) {
          sendJson(res, 400, { ok: false, error: `密码至少要 ${MIN_TOKEN_LEN} 位，现在这串只有 ${next.length} 位。` })
          return
        }
        if (/[\s?#&/]/.test(next)) {
          // 密码要拼进网址，这些字符会把网址拆坏，或者让密码只生效一半
          sendJson(res, 400, { ok: false, error: '密码里不能有空格，也不能有 ? # & / 这几个符号。' })
          return
        }
        settings.token = next
        persistSettings()
        // token 文件也一起写：将来要是把 settings.json 里的 token 清空，读到的该是现在这个，
        // 而不是上一个。两处不一致的话，用户会莫名其妙被挡在门外。
        try {
          writeFileSync(join(dir, 'token'), next, { mode: 0o600 })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: `密码写进配置文件了，但 token 文件没写成：${err?.message ?? err}` })
          return
        }
        try {
          const { status, body } = await pairingPayload()
          sendJson(res, status, { ...body, pendingToken: next })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: `改完之后读不到状态：${err?.message ?? err}` })
        }
      },
    })

    /**
     * 飞书那一块的配置：开关、两个凭据、两个允许名单。
     *
     * 和公网开关、改密码一样**只允许本机调用**：那是一对凭据，改它等于改这个插件
     * 在飞书那边的身份。同一个 Wi-Fi 下的别人不该替你做主。
     *
     * 两条不成文但必须守的规矩：
     *   1. **appSecret 从不回显**（见 feishuStatus）。所以界面上那个框天生是空的，
     *      于是「留空」只能解释成「不改动原来那份」——不然用户每点一次保存都得重新
     *      贴一遍密码，贴错一次就是一段查不出原因的鉴权失败。
     *   2. 存完**就地重建连接**。飞书的长连接是绑在凭据上的，不重建的话用户会看到
     *      「填好了、开关也开着，就是不回消息」，而屏幕上没有任何东西提示他原因。
     */
    const offFeishu = webServer.register({
      kind: 'exact',
      path: '/mini-remote/feishu',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        let want
        try {
          want = await readBody(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
          return
        }
        const next = {
          enabled: Boolean(want?.enabled),
          appId: typeof want?.appId === 'string' ? want.appId.trim() : '',
          appSecret: typeof want?.appSecret === 'string' ? want.appSecret.trim() : '',
          openIds: typeof want?.openIds === 'string' ? want.openIds.trim() : '',
          chatIds: typeof want?.chatIds === 'string' ? want.chatIds.trim() : '',
        }
        // 留空 = 保留原来那份（理由见上面第 1 条）。
        if (!next.appSecret) next.appSecret = String(settings.feishu?.appSecret ?? '')
        settings.feishu = next
        persistSettings()
        if (next.enabled) await restartFeishu()
        else bringFeishuDown()
        try {
          const { status, body } = await pairingPayload()
          sendJson(res, status, body)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: `改完之后读不到状态：${err?.message ?? err}` })
        }
      },
    })

    /**
     * 卸载时把注册过的路由全部注销。
     *
     * **每加一条 `webServer.register` 都要往这里补一笔**，否则插件卸载后那条路由
     * 还挂在服务器上，指向一个已经死掉的闭包——再有人打过来就是莫名其妙的报错。
     *
     * 2026-09-24 补：`offToken` 一直是漏的（改密码那条路由注册了却没注销），
     * 加 HTTPS 这条时对照着数了一遍才发现。五条注册，五条注销，现在对得上。
     */
    return () => {
      offGet?.()
      offTunnel?.()
      offServe?.()
      offToken?.()
      offFeishu?.()
    }
  })
}
