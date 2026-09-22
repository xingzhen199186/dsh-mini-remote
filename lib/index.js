/**
 * DSH 极简移动端遥控器 —— 插件端入口。
 *
 * 设计上的三个「不」：
 *   - 不代理 DSH 桌面界面（那是 dsh-pocket 的做法），手机只拿两样东西：
 *     用户发出的指令 + Agent 的最终回复。
 *   - 不监听 waterfall 事件。只订阅纯 emit 事件，避免误吞 agent 的默认行为。
 *   - 不 import 任何 @deepseek-ai/* 的运行时值。DSH 事件契约已经用 .d.ts 核实，
 *     消息对象自己造（MessageId 的 brand 在运行时是恒等函数、不做校验），
 *     这样插件加载期零外部依赖，也不会有 cordis 双副本的坑。
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

import { createStore } from './store.js'
import { createTurnTracker, visibleText } from './events.js'
import { createMiniServer, sendJson, readBody } from './server.js'
import { sendExternalNotification } from './notify.js'
import { reachableAddresses, resolveBindAddresses, isLocalRequest } from './net.js'
import { buildPairing, tunnelUrlFor, tunnelProbeVerdict } from './pairing.js'
import { ensureCloudflared } from './cloudflared.js'
import { startTunnel, TUNNEL_HINT } from './tunnel.js'
import { listWorkspaces, listSessionsOf } from './tree.js'
import { buildId } from './build.js'

export const name = 'dsh-mini-remote'
export const inject = ['agents']

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
}

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

export function apply(ctx, config = {}) {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })

  const settingsFile = join(dir, 'settings.json')
  const stored = readJson(settingsFile)
  const settings = deepMerge(DEFAULTS, stored ?? {}, config)
  // 首次启动把默认配置落一份出来，用户才有东西可以改。
  if (stored === null) {
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
  }
  const token = loadOrCreateToken(dir, settings.token)
  const store = createStore({ file: join(dir, 'state.json'), maxHistory: settings.maxHistory })
  const tracker = createTurnTracker()
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

  async function onInstruction(text, uploadIds) {
    const sessionId = targetSessionId()
    if (!sessionId) {
      return { ok: false, error: '电脑上还没有可遥控的会话，请先在 DSH 里开一个。' }
    }
    const agent = ctx.agents.get(sessionId)
    if (!agent) {
      return { ok: false, error: '这个会话已经结束了，请在手机上重新选一个会话。' }
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
    if (!agent) return { ok: false, error: '这个会话已经结束了，请在手机上重新选一个会话。' }
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
    if (!agent) return { ok: false, error: '这个会话已经结束了，请在手机上重新选一个会话。' }
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

  // ------------------------------------------------------------------
  // 事件订阅：只取「最后一帧」
  // ------------------------------------------------------------------
  ctx.on('session/event', (session, event) => {
    // 子 agent 的会话不进手机——用户遥控的是自己的主会话，不是它派出去的小弟。
    if (session.header?.origin === 'subagent') return
    const sessionId = session.id

    // 会话标题（可选事件，拿到就用，拿不到就用 id 前 8 位兜底）
    if (event.type === 'session/title') {
      const title = event.data?.title ?? event.data?.text
      if (typeof title === 'string' && title.trim()) {
        store.touchSession(sessionId, { title: title.trim() })
      }
      return
    }

    const action = tracker.feed(sessionId, event)
    if (!action) return
    store.touchSession(sessionId)

    // 手机还没绑会话时，谁先有动静就绑谁。
    if (!store.state.boundSessionId) store.bind(sessionId)

    // 下面只处理手机正在遥控的那个会话。别的会话（比如你在电脑上另开的）
    // 既不该震手机，也不该顶掉单帧模式显示的内容——实时推送和刷新后拿到的
    // 状态必须是同一套口径，否则刷新一下就看到别人的结果了。
    if (sessionId !== targetSessionId()) return

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
      store.pushUser({ text: action.text, sessionId, id: action.id })
      server?.broadcast('state', store.snapshot())
      return
    }

    // action.kind === 'reply'
    store.pushReply({
      text: action.text, sessionId, reason: action.reason, interrupted: action.interrupted,
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
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const sessionId = agent?.session?.id
    if (!sessionId) return
    if (agent.session.header?.origin === 'subagent') return
    store.setRunning(sessionId, status === 'running')
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
    if (!sessionId || agent.session.header?.origin === 'subagent') return
    store.touchSession(sessionId, {
      running: agent.status === 'running',
    })
    server?.broadcast('state', store.snapshot())
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (!sessionId) return
    store.forgetSession(sessionId)
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
  // 手机上传文件要用的附件服务
  // ------------------------------------------------------------------
  // 同样走 ctx.inject、不写进 inject 数组（理由同上）。没有它的时候上传按钮会
  // 如实说「这台电脑传不了文件」，而不是让用户点了没反应。
  ctx.inject(['attachments'], (attachCtx) => {
    attachments = attachCtx.attachments
    console.log('[dsh-mini-remote] 附件服务已就绪：可以接收手机上传的文件')
  })

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

  const nav = {
    listWorkspaces: (runningIds, force) =>
      listWorkspaces({ registry: treeServices.registry, query: treeServices.query, runningIds, force }),
    listSessionsOf: (workspaceId, limit, force) =>
      listSessionsOf({
        registry: treeServices.registry,
        query: treeServices.query,
        agents: ctx.agents,
        knownTitles: knownTitles(),
        workspaceId,
        limit,
        force,
      }),
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
      onUpload,
      onStop,
      onUnqueue,
      tree: nav,
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

    return () => {
      offGet?.()
      offTunnel?.()
    }
  })
}
