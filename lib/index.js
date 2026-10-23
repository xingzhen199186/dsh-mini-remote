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
import { join, win32 as winPath } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'

import z from '@deepseek-ai/schemastery'

import { createStore } from './store.js'
import { createDevices, credentialLooksLikeOurs } from './devices.js'
import { createAgentHub } from './agent-hub.js'
import { createAgentClient, pairAgent, normalizeRoots } from './agent-client.js'
import { registerAgentTools } from './agent-tools.js'
import { B_AGENT_PRESET, B_AGENT_BLOCKED_TOOLS } from './b-agent-preset.js'
import { createRemotes, normalizeBaseUrl } from './remotes.js'
import { createTurnTracker, visibleText, stepSelfTalk } from './events.js'
import { replayHistory, lastReply } from './history.js'
import { createTrajectoryTracker, replayTrajectory, capTrajectory } from './trajectory.js'

/**
 * Agent 模式（内置四档）的中文词条。**照抄 PC 的词条表**（dsh-client-ui-agent-preset
 * 里的 presetStandardName / presetStandardDescription 等八个键），一个字不改。
 * 自建模式不进这张表——PC 的政策原话是「不翻译用户自造的名字」。
 */
const AGENT_MODE_COPY = {
  standard: ['标准模式', '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。'],
  ptc: ['PTC 模式', '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。'],
  minimal: ['极简模式', 'Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。'],
  cordis: ['创造模式', '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。'],
}
import { readTailEvents, findSessionLog } from './log-tail.js'
import {
  parseSlashLine, describeCommands, commandRow, commandPatch,
  invalidCommandMessage, unknownCommandMessage,
} from './commands.js'
import { createMiniServer, miniControl, sendJson, readBody, tokenEquals, LOCAL_WINDOW_DEVICE } from './server.js'
import { createMirror } from './mirror.js'
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
import { buildId, newestSource } from './build.js'

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
 * B 侧去另一台电脑打一次接口，最多等多久。
 *
 * 给一个上限不是可选项：对面不通（地址写错、没开机、不在同一个网络里）时，
 * 界面会一直转圈，而用户看不出是"在等"还是"坏了"。8 秒够内网和 Tailscale 上
 * 一个来回，又不至于让人干等。
 */
const REMOTE_CALL_TIMEOUT_MS = 8000

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
  /**
   * 跨机「远程窗口」：**允许别的电脑连到这台电脑来**（2026-10-16 跨机第二步）。
   * 默认**关**。
   *
   * ## 为什么默认关（方案文档第五节那份判断，照办）
   *
   * 本机版那张票的前提是「只有本机回环上的宿主发得出来」，而本机的软件本来就有这台
   * 电脑的全部权限，所以它没挂开关。**跨机之后这个前提消失了**——来换票的人在另一台
   * 电脑上，而它换到的是**整个电脑端界面**（会话记录、模型配置、插件装卸全在里面），
   * 比手机那条路能碰到的更多。这个边界该由用户自己划，不能替他默认打开。
   *
   * ## 「关」是一个整体状态（用户拍板）
   *
   * 关着的时候，**两条跨机路由一条都不接**：配对（`/mini-remote/pair`）和跨机取票
   * （`/mini-remote/remote/window`）。只关一条的话，"关"就变成了"少录一项配置"，
   * 用户读不懂；两条一起关才等于他要的那句话：**这台电脑不接受别的电脑连过来**。
   *
   * ## 为什么是一个平铺的布尔
   *
   * `tunnel` / `feishu` 那两层是因为各自还有别的字段（路径、凭据、名单）。这里就一个
   * 开关，套一层只会让读的人多跳一次。
   */
  allowRemoteComputers: false,
  /** 允许 B 端执行代理接进来（2026-10-22）。默认关；开了也只给 B 端只读工具。 */
  allowAgent: false,
  /** B 端这一侧：是否作为执行端、连哪台 A、授权哪些文件夹。默认全关。 */
  agentMode: false,
  agentUrl: '',
  agentToken: '',
  agentRoots: '',
  agentAllowWrite: false,
  agentAllowShell: false,
  agentAllowManage: false,
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
  /**
   * 跨机「远程窗口」那个总开关（2026-10-16 跨机第二步）。默认关。
   *
   * **不标 volatile**（和飞书同一条口径，理由不同）：插件自己的设置页存完**就地生效**
   * ——那两条跨机路由读的是同一个 `settings`（见下面 `pairingPayload` 与那两条路由），
   * 所以不必重载插件；只有手改 settings.json 的人需要重载一次（DSH 只在加载时读那份
   * 文件）。标了 volatile 等于向 DSH 承诺"改它不用重载"，而这里兑现得了，但会让这个
   * 开关在 DSH 自己的配置表单里也出现一份——同一个开关两处可点，用户迟早对不上。
   */
  allowRemoteComputers: z.boolean()
    .description('允许别的电脑连过来（配对 + 跨机取票）。默认关；手改 settings.json 之后要重载插件。'),
  allowAgent: z.boolean()
    .description('允许 B 端执行代理接进来（配对 + 文件任务）。默认关；手改 settings.json 之后要重载插件。'),
  agentMode: z.boolean()
    .description('B 端这一侧：作为执行端连回 A。默认关。'),
  agentUrl: z.string()
    .description('B 端要连的 A 地址（配对时自动写入）。'),
  agentToken: z.string().role('secret')
    .description('B 端配对换来的长期凭据（配对时自动写入）。'),
  agentRoots: z.string()
    .description('B 端本地授权的文件夹，一行一个（配对时自动写入）。'),
  agentAllowWrite: z.boolean()
    .description('预留给写文件；这一版仍是只读。'),
  agentAllowShell: z.boolean()
    .description('允许执行一次性命令和持久终端。'),
  agentAllowManage: z.boolean()
    .description('允许建目录、移动、复制、删除；默认关。'),
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

/**
 * 这份插件在磁盘上的版本号（`package.json` 的 `version`）。自检那一栏要它。
 *
 * **每次现读**、不在加载时抄一份：抄一份的话，用户装上新版之后自检里那个号码还是旧的，
 * 而那正是最需要看准的一格。读不到（文件缺了、内容不是 JSON）回 `null`——
 * 自检宁可说「未知」，也不抛错。
 *
 * 「进程加载的是不是这一版」不靠它判断，靠下面 `staleCodeVerdict` 那条时刻比较。
 */
function pluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof pkg?.version === 'string' && pkg.version ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * 「现在应答我的，是不是最新那份代码」——自检里最要紧的一句话（2026-10-17）。
 *
 * 判据只有一条：**进程的启动时刻早于插件文件最后被改动的时刻**。早于，说明那份文件
 * 是进程起来之后才写下的，而 Node 只在启动时读一次代码——那些改动现在还没生效。
 * 这正是那天真机上那件怪事的样子：桌面端连开一天，装是装了新版，跑的却是旧的。
 *
 * 两个时刻任何一个拿不到，`stale` 一律回 **`null`（未知）**，不猜：猜错的代价是
 * 用户去重启一次白折腾，或者更糟——真旧了却告诉他"是最新的"。
 *
 * @param {number} startedAtMs 进程启动时刻（`Date.now() - process.uptime()*1000`）
 * @param {{file:string, at:number}|null} newest `newestSource()` 的结果
 * @returns {{stale:boolean|null, file:string|null, message:string|null}}
 *//** 最近错误缓冲的容量与单条长度上限（见 `apply` 里 `recentErrors` 那段）。 */
const RECENT_ERRORS_MAX = 20
const RECENT_ERROR_TEXT_MAX = 300

/**
 * 把消息里属于我们自己的凭据换成 `***`。
 *
 * ## 为什么它必须存在
 *
 * 自检会把错误消息**摆到界面上**，而错误消息很容易夹着带凭据的东西：跨机那条路
 * 失败时回的话就带着 `baseUrl`（今天不带凭据，但那是设计约束、不是形状保证），
 * 飞书 SDK 的报错还常把请求详情拼进去。原样进缓冲，等于自己给自己开一条泄漏路。
 *
 * ## 判据和 `lib/server.js` 的 `stripOurSecrets` 是同一条：**看值，不看参数名**
 *
 * 参数名可以换（`token=` 写成 `device=` 照样转发），所以按名字摘是摘不干净的。
 * 设备凭据那个形状复用 `credentialLooksLikeOurs`——那份正则只许有一处
 * （见 lib/devices.js 上面那段注释）。
 *
 * ## 为什么是导出给测试的纯函数
 *
 * 和 `staleCodeVerdict` 同一个理由：脱敏这件事**必须能被单独钉住**。埋在闭包里只能
 * 靠"造一个泄漏事故"来验，而那正是我们不想在测试里排练的事。
 *
 * @param {unknown} text 原始消息（不是字符串就按字符串处理）
 * @param {string[]} secrets 这台电脑上已知的凭据值（口令、飞书密钥……），按**值**换
 * @returns {string} 已脱敏、且截到 `RECENT_ERROR_TEXT_MAX` 字的消息
 */
export function redactSecrets(text, secrets = []) {
  let s = String(text ?? '')
  // ① 已知凭据按值换。短于 4 位不换：那多半是 "ab" 这种碎片，换了会伤到正常文字。
  for (const value of Array.isArray(secrets) ? secrets : []) {
    if (typeof value === 'string' && value.length >= 4) s = s.split(value).join('***')
  }
  // ② 查询串里的凭据参数：名字对得上就换（值可能是编码过的，也可能带标点）。
  s = s.replace(/([?&](?:token|device|credential|app_secret)=)[^&\s"'<>]+/gi, '$1***')
  // ③ 兜底：任何一段整体长得像我们的设备凭据，无论出现在哪儿都换。
  s = s.replace(/[^\s"'<>()[\]]+/g, (piece) => (credentialLooksLikeOurs(piece) ? '***' : piece))
  return s.slice(0, RECENT_ERROR_TEXT_MAX)
}

export function staleCodeVerdict(startedAtMs, newest) {
  const file = newest?.file ?? null
  const at = newest?.at
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(at)) {
    return { stale: null, file, message: null }
  }
  const stale = startedAtMs < at
  return {
    stale,
    file,
    message: stale
      ? '这台电脑的插件可能不是最新的，重启 DSH 才会加载新版本。'
      : null,
  }
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
  // B 项目：A 这边只放「门牌」（占位目录 + 一张卡片），真实文件在 B。
  const bProjectsFile = join(dir, 'b-projects.json')
  let bProjects = readJson(bProjectsFile)
  if (!Array.isArray(bProjects)) bProjects = []
  bProjects = bProjects.filter((p) => p && p.id && p.bRoot && p.aPath)
  /** 会话 id → 这个会话所属 B 项目的根目录。 */
  const bProjectRoots = new Map()

  function saveBProjects() {
    writeFileSync(bProjectsFile, `${JSON.stringify(bProjects, null, 2)}\n`)
  }

  function bProjectsView() {
    return bProjects.map((p) => ({
      id: p.id,
      name: p.name || 'B 项目',
      bRoot: p.bRoot,
      agentId: p.agentId || '',
      agentName: p.agentName || '',
      workspaceId: p.workspaceId || '',
      aPath: p.aPath,
      createdAt: p.createdAt || 0,
    }))
  }

  function sameProjectPath(a, b) {
    if (!a || !b) return false
    try { return winPath.resolve(a).toLowerCase() === winPath.resolve(b).toLowerCase() } catch { return false }
  }

  function onlineBAgent() {
    return agentHub.list().find((one) => one && one.online) || null
  }

  function bProjectAgent(project) {
    const list = agentHub.list()
    if (project && project.agentId) return list.find((one) => one.id === project.agentId) || null
    return list.find((one) => one && one.online) || null
  }

  function bProjectForCwd(cwd) {
    return bProjects.find((p) => sameProjectPath(p.aPath, cwd)) || null
  }

  function insideBPath(root, target) {
    if (!root || !target) return false
    try {
      const rel = winPath.relative(winPath.resolve(root), winPath.resolve(target))
      return rel === '' || (!rel.startsWith('..') && !winPath.isAbsolute(rel))
    } catch { return false }
  }
  const store = createStore({ file: join(dir, 'state.json'), maxHistory: settings.maxHistory })
  /**
   * 「设备身份」名册（见 lib/devices.js）：一台手机一条，落盘在同一个数据目录里。
   *
   * **为什么和 settings.json 分开放**：那是给用户手改的文件，字段会进设置页那张表单
   * ——把密钥哈希混进去，等于让「改个设置」有机会碰坏登录凭据。这份名册由插件自己管，
   * 用户要看也是下一步的设置页按它渲染一份名单。
   *
   * 这份东西**和「远程窗口」那套是两个人**（lib/mirror.js）：那张票是一次通行证、
   * 寿命跟着宿主进程、只够进镜像；这里是长期名单、要落盘、认的是手机。两者不合并，
   * 手机也不会因为被登记就多得到镜像权限（那条权限挂在「进阶设置」那个开关上，没动）。
   */
  const devices = createDevices({ file: join(dir, 'devices.json') })
  /**
   * 「我能连的电脑」名册（**B 侧**，见 lib/remotes.js）：B 记着"我连得上哪几台电脑"。
   *
   * 和 `devices.json` **并排、不合并**：那份记的是"谁连得上我"（A 侧，密钥只存哈希），
   * 这一份记的是"我连得上谁"，里面那枚凭据是**别人发给我的长期门卡**，必须原样留着。
   * 两个方向、两种东西，混在一份文件里只会让"撤销"和"断开"分不清。
   *
   * 同样**不进 settings.json**（那是给用户手改、会进设置页表单的文件）——理由和
   * devices.json 当初定的一模一样，见 lib/remotes.js 开头那一段。
   */
  const remotes = createRemotes({ file: join(dir, 'remotes.json') })
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

  /**
   * B 端执行代理的账本（2026-10-22）。只做配对、任务队列和结果回传；
   * 文件权限由 B 端本地给，这里只记 B 报上来的摘要。
   */
  const agentHub = createAgentHub({
    file: join(dir, 'agents.json'),
    enabled: () => settings.allowAgent === true,
    log,
  })

  /**
   * 「B 端执行」预设：等 b_* 工具和 agentPresets 都就绪再注册。
   *
   * 不能一拿到 agentPresets 就注册：预设里的 guard 用 allow 列了四个 b_* 名字，
   * 名字还没注册时 restrict 会拒绝，预设会变成 broken。两边都到齐再动手。
   *
   * 只在这台电脑**接受 B 端**时注册；B 自己那台（agentMode=true）不需要这个预设，
   * 也避免旧安装包没有 b-agent-preset.js 时在 B 上报一条坏预设。
   */
  let bPresetSvc = null
  let bPresetService = null
  let bToolsReady = false
  let bPresetDispose = null
  let bPresetDisposed = false
  let bPresetRegistered = false
  let bPresetError = null

  function maybeRegisterBPreset() {
    if (bPresetDisposed || bPresetDispose || !bToolsReady || !bPresetSvc) return
    if (settings.agentMode === true || settings.allowAgent !== true) return
    if (typeof bPresetSvc.register !== 'function') {
      bPresetError = 'agentPresets 服务没有 register 方法，B 端预设无法注册'
      return
    }
    const svc = bPresetSvc
    bPresetSvc = null
    bPresetError = null
    svc.register(B_AGENT_PRESET).then((off) => {
      if (bPresetDisposed) {
        Promise.resolve(off()).catch(() => { /* 已经卸载了 */ })
        return
      }
      bPresetDispose = off
      bPresetRegistered = true
      bPresetError = null
      log.info('B 端执行预设已注册（B 工具 + A 非物理工具）')
    }).catch((err) => {
      bPresetRegistered = false
      bPresetError = err && err.message ? err.message : String(err)
      log.warn(`B 端执行预设注册失败：${bPresetError}`)
    })
  }

  ctx.effect(() => () => {
    bPresetDisposed = true
    const off = bPresetDispose
    bPresetDispose = null
    if (off) Promise.resolve(off()).catch(() => { /* 忽略卸载错误 */ })
  })

  // 只在有 tools 服务的组合里注册；拿不到就只少这一组 B 端工具，不影响插件其余部分。
  ctx.inject(['tools'], (toolsCtx) => {
    // 兜底：万一自动切预设没赶上（或者被人改回别的预设），B 项目会话里的本地
    // 文件和命令工具仍然拒绝执行，不能把项目写到 A 的门牌目录里。
    if (toolsCtx.tools && typeof toolsCtx.tools.guard === 'function') {
      toolsCtx.tools.guard((exec) => {
        const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
        if (!bProjectForCwd(cwd)) return undefined
        if (exec.name && B_AGENT_BLOCKED_TOOLS.includes(exec.name)) {
          return '这是 B 项目会话：A 本地文件和命令工具不可用，请用 b_* 操作 B；A 的联网/浏览器/画图/会话/团队/顾问仍可用。'
        }
        return undefined
      })
    }
    registerAgentTools(toolsCtx, {
      hub: agentHub,
      log,
      projectRootFor: (exec) => bProjectRoots.get(exec && exec.agent && exec.agent.id),
    }).then((out) => {
      if (out && out.ok) {
        bToolsReady = true
        maybeRegisterBPreset()
      } else {
        log.warn(out && out.error ? out.error : 'B 端工具没有注册')
      }
    }).catch((err) => {
      log.warn(`B 端工具注册失败：${err && err.message ? err.message : err}`)
    })
  })

  /**
   * 给所有 agent（含子代理）的一句 B 端工具指引。
   *
   * 只注册工具还不够：子代理看见 `edit`/`bash` 会顺手用，那改的是 A。这段只在
   * **有 B 端在线**时出现，不打扰只用 A 的会话。
   */
  ctx.inject(['systemPrompt'], (spCtx) => {
    // 测试/无界面组合里可能没有这个服务；拿不到就只少一句提示，不能把插件带崩。
    if (!spCtx.systemPrompt || typeof spCtx.systemPrompt.section !== 'function') return
    spCtx.systemPrompt.section({
      name: 'dsh-mini-remote:b-agent',
      order: 900,
      text: () => {
        const online = agentHub.list().some((a) => a.online)
        if (!online) return ''
        return 'A remote B computer is connected through dsh-mini-remote. When the task targets B, use b_list / b_read / b_write / b_shell. The local read, edit, write, glob, grep and bash tools operate on A, not B. For B-side delegation, use b_subagent, whose child is forced into the b-agent preset with only b_* tools; do not use subagent or subagent_* for B tasks.'
      },
    })
  })

  /**
   * B 端执行端（同一个插件在 B 上的那一面）。
   *
   * 它只在 `agentMode` 打开、并且有 URL/token/roots 时启动；启动后是一个**出站**的
   * 长轮询循环，和命令行 `dsh-mini-remote-agent run` 共用 lib/agent-client.js。
   * 设置页的「配对并开启」会直接调这里，不需要重载插件。
   */
  let bAgentClient = null
  let bAgentAbort = null
  let bAgentError = null

  function splitRoots(value) {
    return String(value || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)
  }

  /** 检查/创建 B 上的项目目录；先 list 判断存在，避免无管理权限时白 mkdir。 */
  async function ensureBProjectFolder(bRoot, agentId) {
    try {
      await agentHub.call('list', { path: bRoot }, { agentId })
      return false
    } catch (err) {
      const message = err && err.message ? err.message : String(err)
      if (!/不存在|not found|ENOENT/i.test(message)) throw new Error(`B 端项目目录不可用：${message}`)
    }
    try {
      await agentHub.call('mkdir', { path: bRoot }, { agentId })
      return true
    } catch (err) {
      throw new Error(`B 上建不了项目目录：${err && err.message ? err.message : err}。先在 B 设置里打开文件夹管理，或手动建好这个目录。`)
    }
  }

  async function createBProject({ name, bRoot } = {}) {
    const title = String(name || '').trim()
    const root = String(bRoot || '').trim()
    if (!title) throw new Error('项目名不能为空')
    if (!root || !winPath.isAbsolute(root)) throw new Error('B 项目目录要写完整路径，例如 D:\\work\\我的项目')
    if (bProjects.some((p) => sameProjectPath(p.bRoot, root))) throw new Error('这个 B 目录已经是一个项目了')
    const agent = onlineBAgent()
    if (!agent) throw new Error('B 端还没有连上')
    if (!treeServices.registry || typeof treeServices.registry.create !== 'function') {
      throw new Error('宿主没有工作区服务，建不了工作区')
    }

    const made = await ensureBProjectFolder(root, agent.id)
    const id = randomUUID()
    const aPath = join(dir, 'projects', id)
    mkdirSync(aPath, { recursive: true })
    writeFileSync(join(aPath, '.dsh-b-project.json'), `${JSON.stringify({ id, name: title, bRoot: root }, null, 2)}\n`)

    let workspace
    try {
      workspace = await treeServices.registry.create(aPath, `B · ${title}`)
    } catch (err) {
      throw new Error(`A 端建工作区失败：${err && err.message ? err.message : err}`)
    }
    const project = {
      id,
      name: title,
      bRoot: root,
      aPath,
      agentId: agent.id,
      agentName: agent.name || 'B 端电脑',
      workspaceId: workspace && workspace.id ? workspace.id : '',
      createdAt: Date.now(),
    }
    bProjects.push(project)
    saveBProjects()
    return { project, made }
  }

  async function removeBProject(id) {
    const project = bProjects.find((p) => p.id === id)
    if (!project) throw new Error('没有这个 B 项目')
    bProjects = bProjects.filter((p) => p.id !== id)
    saveBProjects()
    try { rmSync(project.aPath, { recursive: true, force: true }) } catch { /* 门牌没了也没关系 */ }
    if (project.workspaceId && treeServices.registry && typeof treeServices.registry.delete === 'function') {
      try { await treeServices.registry.delete(project.workspaceId) } catch { /* 工作区删不掉也不影响 B 文件 */ }
    }
    return { removed: project.id }
  }

  function bProjectForRequest(id) {
    const project = bProjects.find((p) => p.id === id)
    if (!project) throw new Error('没有这个 B 项目')
    return project
  }

  async function bProjectList(id, requested) {
    const project = bProjectForRequest(id)
    const target = String(requested || project.bRoot)
    if (!insideBPath(project.bRoot, target)) throw new Error('只能浏览这个项目自己的目录')
    const agent = bProjectAgent(project)
    if (!agent) throw new Error('这台 B 端没有连上')
    return agentHub.call('list', { path: target }, { agentId: agent.id })
  }

  async function bProjectRead(id, requested) {
    const project = bProjectForRequest(id)
    const target = String(requested || '')
    if (!target || !insideBPath(project.bRoot, target)) throw new Error('只能读这个项目自己的文件')
    const agent = bProjectAgent(project)
    if (!agent) throw new Error('这台 B 端没有连上')
    return agentHub.call('read', { path: target }, { agentId: agent.id })
  }

  function bAgentStatus() {
    const live = bAgentClient && typeof bAgentClient.status === 'function' ? bAgentClient.status() : null
    const lastPollAt = Number(live && live.lastPollAt) || 0
    const lastError = bAgentError || (live && live.lastError) || null
    return {
      mode: settings.agentMode === true,
      url: settings.agentUrl || '',
      roots: splitRoots(settings.agentRoots),
      allowWrite: settings.agentAllowWrite === true,
      allowShell: settings.agentAllowShell === true,
      allowManage: settings.agentAllowManage === true,
      connected: Boolean(lastPollAt && Date.now() - lastPollAt < 90 * 1000),
      lastPollAt,
      lastError,
      error: lastError,
    }
  }

  function stopBAgent() {
    if (bAgentAbort) {
      try { bAgentAbort.abort() } catch { /* 忽略 */ }
      bAgentAbort = null
    }
    if (bAgentClient) {
      try { bAgentClient.stop() } catch { /* 忽略 */ }
      bAgentClient = null
    }
  }

  function startBAgent() {
    stopBAgent()
    bAgentError = null
    if (settings.agentMode !== true) return
    const roots = splitRoots(settings.agentRoots)
    if (!settings.agentUrl || !settings.agentToken) {
      bAgentError = '还没有配对凭据：先在上面输入 A 的地址和配对码。'
      return
    }
    if (!roots.length) {
      bAgentError = '还没有授权文件夹。'
      return
    }
    try {
      bAgentClient = createAgentClient({
        url: settings.agentUrl,
        token: settings.agentToken,
        roots,
        allowWrite: settings.agentAllowWrite === true,
        allowShell: settings.agentAllowShell === true,
        allowManage: settings.agentAllowManage === true,
        log,
      })
      bAgentAbort = new AbortController()
      bAgentClient.run({ signal: bAgentAbort.signal }).catch((err) => {
        bAgentError = err && err.message ? err.message : String(err)
        log.warn(`B 端执行端断开：${bAgentError}`)
      })
    } catch (err) {
      bAgentError = err && err.message ? err.message : String(err)
      log.warn(`B 端执行端起不来：${bAgentError}`)
    }
  }

  // 插件卸载时把循环停掉；配置在加载时已经就绪，开机即启动（默认 agentMode=false，不会连）。
  ctx.effect(() => {
    startBAgent()
    return () => stopBAgent()
  })

  /**
   * 最近发生的错误，先进先出，最多 20 条。
   *
   * ## 为什么要有它（2026-10-17，两次真机故障的产物）
   *
   * 三块错误本来各有各的字段（`serverError` / `tunnelError` / `feishuError`），而且都会
   * `log.warn` 一句。问题不在"没有记录"，在**记录只到 stdout**：用户看着图形界面，
   * 终端里写了什么他一个字都看不到。而跨机那条路连状态字段都没有 —— `callRemote` 失败时
   * 只把一句话回给界面，**不留痕**。
   *
   * 于是那天两次故障都只能靠猜：一次是桌面端连开 24 小时（跑的还是旧代码），一次是
   * 另一台装的是旧版本。自检能回答"版本对不对"，这个缓冲回答"刚才出了什么事"。
   *
   * ## 只留 20 条、每条 300 字，不落盘
   *
   * 它**不是日志**：重启即清空、按条数淘汰、只回答"刚才发生了什么"，不回答"上周三下午
   * 发生了什么"。要长历史就去 stdout。
   */
  const recentErrors = []

  /**
   * 记一条错误：进缓冲，同时照旧打一行 stdout。
   *
   * `kind` 是给人看的分类：`service`（手机服务起不来）、`tunnel`（公网隧道）、
   * `feishu`（飞书长连接）、`notify`（外部推送）、`remote`（跨机那一头不通）、
   * `internal`（别的地方兜到的）。分类不是为了统计，是为了让用户一眼看出"是哪一块在坏"。
   *
   * **文本一律先过 `redactSecrets`**：这里是错误消息唯一进入界面的通道，也是唯一可能
   * 把凭据带出去的地方（见那个函数上面那段）。
   */
  function report(kind, message) {
    // 口令和飞书密钥按**值**换：这两个是这台电脑上最要命的两样。
    const line = redactSecrets(message, [token, settings?.feishu?.appSecret])
    recentErrors.push({ at: Date.now(), kind, message: line })
    if (recentErrors.length > RECENT_ERRORS_MAX) recentErrors.shift()
    // 行为与从前完全一致：以前这儿是裸 `log.warn`，现在只是多存了一份。stdout 那条路没变。
    log.warn(`[${kind}] ${line}`)
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
      report('service', `配置写不进去：${err?.message ?? err}`)
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
        report('tunnel', `公网访问没起来：${found.error}`)
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
            report('tunnel', tunnelError)
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
      report('tunnel', `公网访问没起来：${tunnelError}`)
    } catch (err) {
      tunnelError = err?.message ?? String(err)
      report('tunnel', `公网访问没起来：${tunnelError}`)
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
          report('tunnel', tunnelError)
          return
        }
        tunnelProbeFails += 1
        if (tunnelProbeFails < TUNNEL_PROBE_FAILS) return
        tunnelHealthy = false
        tunnelError = '公网隧道还开着，但已经连不上了：'
          + `${code || err?.message || err}。手机打开会看到 Cloudflare 的 Error 1033。\n\n${TUNNEL_HINT}`
        report('tunnel', tunnelError)
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
        report('notify', `外部推送失败：${result.error}`)
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
      report('feishu', `飞书没起来：${feishuError}`)
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

  /**
   * 「繁忙时的发送行为」当前是哪个值——**发送那一刻现读，不缓存**。
   *
   * 为什么现读：这个值是**电脑端和手机端共用**的（就是 PC「设置 → 通用」里那一条），
   * 用户在电脑上改了我们这边不一定知道。发送是低频动作，读一次 describe() 不值几个钱，
   * 而缓存一份就会有「设置改了但发送还用老值」这种最难查的不一致。
   *
   * 读不到一律当 `queue`（排队）——那是 DSH 自己的默认值，也是最保守的那个：
   * 宁可多等一轮，也不要莫名其妙打断正在跑的一轮。
   */
  function busyEnterMode() {
    try {
      const settings = invServices.settings ?? ctx.get('settings')
      const doc = (settings?.describe?.() || []).find((d) => String(d?.ns ?? '') === 'ui-conversation')
      const value = doc?.value && typeof doc.value === 'object' ? doc.value : {}
      return value.busyEnter === 'steer' ? 'steer' : 'queue'
    } catch (err) {
      return 'queue'
    }
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
     * 跑着的时候**不再拒绝**，改成「排队」或「插话」——按设置里那一条走。
     *
     * 原来这里有一条 `agent.status === 'running'` 的挡板，回一句「上一个任务还在跑，
     * 等它完成再发」。那条挡板是多余的，而且**比 DSH 自己还严**：`followup()` 的
     * 语义本来就是「排队一个后续轮次并唤醒驱动」（dsh-agent 的类型注释原话：
     * "Queue an ordinary follow-up turn and wake the driver"），跑着的时候照样收，
     * 排进 inbox.nextTurn，等当前这一轮结束再跑。DSH 桌面端同一时刻就能接着排。
     *
     * **2026-10-06 补上真正的「插话」。** 原来这里只会 `followup()`——那是**永远排队**。
     * 手机设置里那条「繁忙时的发送行为」当时只做了开关、没接上线，所以选了插话也照样排队
     * （用户实机发现：「插话发送似乎没实现，依然是排队发生」）。
     *
     * 现在按设置分岔，两条都是 DSH 自己的接口（`dsh-agent` 的类型注释原文）：
     *   · `followup(message)` —— "Queue an ordinary follow-up turn and wake the driver"，
     *     进 inbox.nextTurn，等这一轮跑完；
     *   · `steer(message)` —— "Submit steering for the nearest step"，进 inbox.nextStep，
     *     跑着的驱动**在下一个步骤边界**就取走它（一个工具调用就是一个步骤，所以是秒级）。
     *
     * 两处刻意的保守：
     *   ① 只有**真在跑**（queued）才插话。不跑的时候没什么可插的，走正常发送；
     *   ② 老版本 DSH 上 `agent.steer` 可能不存在（它是后加的），所以要探一下类型——
     *      没有就退回排队，不能让一条指令发不出去。
     * PC 源码那边还留了一句定心的话："Direct `steer` is intentionally best-effort:
     * AgentLoop turns a closed-window submission into the next waking Queue item."
     * ——**最坏情况它会自己退回排队**，不会丢。
     */
    const queued = agent.status === 'running'
    const steered = queued && busyEnterMode() === 'steer' && typeof agent.steer === 'function'

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
      // 跑着的时候按设置分岔：插话进 nextStep（下一个步骤边界就取走），
      // 排队进 nextTurn（等这一轮跑完）。两条都是 DSH 自己的接口，见上面那段注释。
      if (steered) agent.steer(message)
      else agent.followup(message)
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
    // queued / steered 只是给界面上那句提示用的：
    //   queued  —— 现在就在跑，所以这条得等下一轮；
    //   steered —— 现在就在跑，但这条会在**下一个步骤边界**被取走（通常几秒）。
    // 两个不会同时为真。
    return { ok: true, sessionId, queued: queued && !steered, steered }
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
    // 真条目落盘了：活片段的使命结束（它只是「还没落定」的影子，见 feedTrajectoryLive）。
    if (change.entries.length || change.state) resetLiveThink(sessionId)
    if (sessionId !== targetSessionId()) return
    server?.broadcastTrajectory({ sessionId, ...frame })
  }

  /**
   * 轨迹的活片段（2026-10-04 用户解禁「流式不做」，仅完整模式消费，别的模式零影响）：
   * 模型正在想的那一句，从 `agent/assistant-stream` 的 reasoning-delta 里顺出来。
   *
   * 边界三条：
   *   ① **只吃思考**（reasoning-delta）；回答正文（text-delta）一概不用——回答照旧等
   *      落定才显示，「流式不做」那条裁决只对轨迹的思考片段解禁；
   *   ② **只推当前绑定的那个会话**，子 Agent 的流不过来（和轨迹增量帧同一个口径）；
   *   ③ **落盘即清、打断即清**：真条目一到就让位。它是进程本地的，不重放——手机刷新
   *      后没了就没了，等下一步的片段接着来，不补假的。
   *
   * 节流：模型一秒能吐几十个字，250 毫秒一发、尾随必发；第一段立刻发——
   * 「有没有动静」这件事最要紧的就是第一眼。
   */
  const liveThink = new Map()
  const LIVE_THINK_MS = 250
  /**
   * **正文的活片段**（2026-10-21 加，配合手机页的「流式」开关）。
   *
   * 和思考那条**分开管**：思考是「瞄一眼」的（压成一行、250 毫秒够用），正文是「打字机」
   * （一个字一个字追着看，250 毫秒会一顿一顿的）。两边各自一个 slot，互不清场。
   *
   * **推的是增量（`delta`），不是全量**：长回答发全量会把流量翻几十倍。丢包/切后台的
   * 缺字由落定帧（`trajectory`）整体覆盖补上——和官方 `settleMessage` 那条一个道理。
   */
  const liveText = new Map()
  const LIVE_TEXT_MS = 60
  /**
   * **工具调用的参数**那一路（2026-10-21，用户要求补上）。
   *
   * 官方那套里工具参数是流式的（`argumentsDelta`）：PC 上能看到一条命令被一个字一个字
   * 写出来。这里照同一口径推，前端贴在轨迹的「正在调用 X」那一行后面。
   *
   * **它跟正文不是一回事**：正文是模型的最终回答，工具参数是它要执行的命令/文件路径。
   * 步子的大小也不同（参数可能几百字），所以单独一路、单独清场。
   */
  const liveTool = new Map()
  /**
   * 这两路**已经往手机上露过字**了吗？
   *
   * 和 slot 分开记：`block-end` 时 slot 要删掉（下个块从空开始），但屏幕上那段字还在，
   * 得等落定的回复 / 条目到了才能清屏。只靠 slot.sent 判断的话，块一结束就失去了
   * "露过"的记忆，尾巴补发之后没有人负责收场。
   */
  const liveTextShown = new Set()
  const liveToolShown = new Set()

  /** 「当前这一段」的尾句：压成一行、限 160 字——给人瞄一眼的，不是给人读的。 */
  function liveThinkDetail(text) {
    const paragraphs = String(text).split(/\r?\n[\t ]*\r?\n/)
    const last = paragraphs[paragraphs.length - 1].replace(/\s+/g, ' ').trim()
    return last.length > 160 ? `${last.slice(0, 159)}…` : last
  }

  function resetLiveThink(sessionId) {
    const slot = liveThink.get(sessionId)
    if (!slot) return
    if (slot.timer) clearTimeout(slot.timer)
    liveThink.delete(sessionId)
    // 只在真露过字之后才喊「清空」——不然每来一次工具调用都白发一帧。
    if (slot.sent) server?.broadcastTrajectoryLive({ sessionId, kind: 'reasoning', detail: '' })
  }

  /**
   * 一路活片段的收场。**先补发攒着的尾巴，再决定要不要清屏。**
   *
   * 为什么非补不可（2026-10-22 真机 e2e 实测）：60 毫秒节流会把最后几个 delta 留在
   * slot 里，而原来 `block-end` 一到就把定时器清掉、直接删 slot——三个 delta 在同一
   * 毫秒到达时，手机上只看得见第一个字「流」，剩下「式测试」永远没发出去，紧接着
   * 一个空帧把屏幕也清了，最后整段回答一次性蹦出来。
   *
   * `keepClient`：块刚写完时**不清屏**。补发的尾巴得留在屏幕上，等落定的回复
   * （`reply`）或真条目（`trajectory` 的 add）到了再由客户端收掉；这里紧跟一个空帧
   * 会把它一起抹掉。整帧结束 / 打断时才清（此时没有后续落定帧来收场）。
   */
  function flushLiveSlot(slots, shown, kind, sessionId, keepClient = false) {
    const slot = slots.get(sessionId)
    if (slot) {
      if (slot.timer) clearTimeout(slot.timer)
      if (slot.text) {
        server?.broadcastTrajectoryLive({ sessionId, kind, delta: slot.text, blockIndex: slot.index })
        shown.add(sessionId)
      }
      slots.delete(sessionId)
    }
    if (!keepClient && shown.has(sessionId)) {
      shown.delete(sessionId)
      server?.broadcastTrajectoryLive({ sessionId, kind, delta: '', blockIndex: slot?.index ?? 0 })
    }
  }

  /** 正文那一路的收场。**和思考分开**：块写完时补发尾巴但不清屏，等回复落定。 */
  function resetLiveText(sessionId, keepClient = false) {
    flushLiveSlot(liveText, liveTextShown, 'text', sessionId, keepClient)
  }

  /** 工具参数那一路的收场。**只在那个块写完 / 整帧结束时调**，别跟正文相互牵连。 */
  function resetLiveTool(sessionId, keepClient = false) {
    flushLiveSlot(liveTool, liveToolShown, 'tool', sessionId, keepClient)
  }

  /**
   * 往一路 slot 里喂一段增量，按各自的节流往外发。
   *
   * @param {Map} slots 那一路的槽位表（思考 / 正文各一份）
   * @param {number} ms 这一路的节流间隔
   * @param {string} kind `'reasoning'` / `'text'`
   */
  function feedLiveSlot(slots, ms, kind, sessionId, blockIndex, text, extra, shown) {
    let slot = slots.get(sessionId)
    // 换了块就重来：同一个会话里每开一个新正文块，都是新的一段。
    // 旧块里攒着没发的字要先补发，不能跟着 slot 一起丢掉（理由见 flushLiveSlot）。
    if (slot && slot.index !== blockIndex) {
      if (slot.timer) clearTimeout(slot.timer)
      if (slot.text) {
        server?.broadcastTrajectoryLive({ sessionId, kind, delta: slot.text, blockIndex: slot.index })
        shown?.add(sessionId)
      }
      slots.delete(sessionId)
      slot = undefined
    }
    if (!slot) {
      slot = { text: '', index: blockIndex, sent: false, at: 0, timer: null }
      slots.set(sessionId, slot)
    }
    slot.text += text
    const flush = () => {
      slot.timer = null
      slot.at = Date.now()
      slot.sent = true
      if (kind === 'reasoning') {
        // 思考那条**照旧发 `detail` 全量**（压成一行 160 字，很轻），旧前端不认 `kind` 也能用。
        server?.broadcastTrajectoryLive({ sessionId, kind, detail: liveThinkDetail(slot.text) })
      } else {
        server?.broadcastTrajectoryLive({
          sessionId, kind, delta: slot.text, blockIndex, ...extra,
        })
        // 记着"这一路露过字"：块结束补发尾巴之后，得有人负责清屏。
        shown?.add(sessionId)
        // 发完就把攒的这一段清掉：下次发的还是"这一段新攒的"，前端累加即可。
        slot.text = ''
      }
    }
    if (!slot.sent || Date.now() - slot.at >= ms) {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null }
      flush()
    } else if (!slot.timer) {
      slot.timer = setTimeout(flush, ms - (Date.now() - slot.at))
      if (slot.timer.unref) slot.timer.unref()
    }
  }

  function feedTrajectoryLive(sessionId, frame) {
    if (sessionId !== targetSessionId()) return
    if (!frame || frame.type !== 'chunk') {
      resetLiveThink(sessionId); resetLiveText(sessionId); resetLiveTool(sessionId)
      return
    }
    const chunk = frame.chunk ?? {}
    // **正文增量**（2026-10-21）：流式开关开着的那台手机才收到——没订阅就一个字节都不发。
    if (chunk.type === 'text-delta' && chunk.text) {
      feedLiveSlot(liveText, LIVE_TEXT_MS, 'text', sessionId, chunk.index ?? 0, chunk.text,
        undefined, liveTextShown)
      return
    }
    if (chunk.type === 'reasoning-delta' && chunk.text) {
      feedLiveSlot(liveThink, LIVE_THINK_MS, 'reasoning', sessionId, chunk.index ?? 0, chunk.text)
      return
    }
    // **块写完了**：先补发攒着的尾巴，但**不清屏**——屏幕上的那半句要留到落定的回复
    // 或真条目到了再收（见 flushLiveSlot）。紧跟一个空帧会把刚补发的尾巴一起抹掉。
    if (chunk.type === 'block-end') {
      resetLiveText(sessionId, true)
      resetLiveTool(sessionId, true)
      return
    }
    // **工具调用的参数**（2026-10-21，用户要求补上）：官方那套里参数是流式拼出来的
    // （`argumentsDelta`），PC 上能看到一条命令被一个字一个字写出来。这里照同样口径推，
    // 前端贴在轨迹的「正在调用 X」那一行后面。
    //
    // 同一帧里思考必须先收：**走到工具这一步，思考已经结束了**（这一条不能省——不收的话
    // 标题行会一直挂着上一段思考的尾巴）。
    if (chunk.type === 'tool-call-delta') {
      resetLiveThink(sessionId)
      if (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta) {
        // `name` 只在第一个 delta 上带（官方就是这么给的）：带上它前端才知道该显示
        // 「正在调用 edit」还是「正在调用 bash」。
        feedLiveSlot(
          liveTool, LIVE_TEXT_MS, 'tool', sessionId, chunk.index ?? 0, chunk.argumentsDelta,
          chunk.name ? { name: String(chunk.name) } : undefined, liveToolShown,
        )
      }
    }
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
        turn: action.turn,
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
      store.pushUser({ text: action.text, sessionId, id: action.id, turn: action.turn, timestamp: event.time })
      server?.broadcast('state', store.snapshot())
      return
    }

    // action.kind === 'reply'
    store.pushReply({
      text: action.text, sessionId, reason: action.reason, interrupted: action.interrupted,
      turn: action.turn,
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
    const session = agent?.session
    const sessionId = session?.id
    if (!sessionId) return
    if (session.header?.origin === 'subagent') return

    // 轨迹的活片段：完整模式要「正在想的片段一点点顺出来」（2026-10-04 用户解禁，
    // 只解禁这一处）。它跑在下面那道闸门**之前**——回答的流式照旧关着，两者互不相干：
    // 这里吃的是 reasoning-delta，text-delta 一个字都不碰。
    feedTrajectoryLive(sessionId, frame)

    // 流式关着：这里直接掉头。手机上只认落定的那条回答，中途一个字都不推。
    // 为什么关、为什么留着代码，见 STREAMING_ENABLED 的注释。
    if (!STREAMING_ENABLED) return

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
  ctx.on('agent/created', async ({ agent }) => {
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
    // 这是 A 上的 B 项目门牌：记住项目根，并把这支会话切到 B 预设。
    const bProject = bProjectForCwd(agent.session.header?.cwd)
    if (bProject) {
      bProjectRoots.set(sessionId, bProject.bRoot)
      if (bPresetService && typeof bPresetService.select === 'function') {
        try {
          await bPresetService.select(agent, 'b-agent')
        } catch (err) {
          log.warn(`B 项目会话切预设失败：${err && err.message ? err.message : err}`)
        }
      }
    }
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
    bProjectRoots.delete(sessionId)
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

  /**
   * 「哪个会话此刻在等人」——手机导航栏那三枚待处理徽标的**唯一**来源。
   *
   * 为什么是这里、而不是去问 DSH 要一个状态字段：PC 侧栏那三个分类（等待审批 / 计划待审 /
   * 等待回答）**在 Host 侧并不存在**。DSH 自己的做法是让每个功能插件在客户端注册一个
   * `registerPendingInteraction`，也就是"谁在等，谁自己说"。我们这边真正在等的那两扇门
   * 就是下面这两条 waterfall（审批与提问），所以正确的做法只有：**在这两扇门上各挂一个
   * 旁观者**，进门记一笔、落定销一笔。
   *
   * 为什么不另写一套轮询去猜：猜出来的徽标会在"其实已经答完了"之后还挂着，那比没有徽标更坏。
   *
   * 计数而不是布尔：同一个会话理论上可以同时挂着一条审批和一道题（一次工具调用触发的审批
   * 还没落定，模型又问了问题），谁先落定都不该把另一枚一起抹掉。
   */
  const pendingBySession = new Map()
  /** 三类同时挂着时的显示优先级：审批最"堵"，计划审阅次之，普通提问最后。 */
  const PENDING_ORDER = ['approval', 'plan', 'question']
  const PENDING_LABEL = { approval: 'approval', plan: 'plan', question: 'question' }

  function markPending(sessionId, kind) {
    if (typeof sessionId !== 'string' || !sessionId) return () => {}
    let kinds = pendingBySession.get(sessionId)
    if (!kinds) {
      kinds = new Map()
      pendingBySession.set(sessionId, kinds)
    }
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
    broadcastPending()
    return function release() {
      const left = (kinds.get(kind) ?? 1) - 1
      if (left > 0) kinds.set(kind, left)
      else kinds.delete(kind)
      if (!kinds.size) pendingBySession.delete(sessionId)
      broadcastPending()
    }
  }

  function pendingSnapshot() {
    const out = {}
    for (const [id, kinds] of pendingBySession) {
      for (const kind of PENDING_ORDER) {
        if (kinds.has(kind)) { out[id] = PENDING_LABEL[kind]; break }
      }
    }
    return out
  }

  /**
   * 徽标一变就吱一声。手机那边不改整棵树，只就地换那几行的尾部标记——
   * 重绘会把用户正在划的滚动位置弹回顶部（和 paintNavCurrent 同一条理由）。
   */
  function broadcastPending() {
    try {
      server?.broadcast('navigation-pending', pendingSnapshot())
    } catch {
      // 服务还没起来、或者正在关：徽标晚一步知道不影响遥控本身。
    }
  }

  /**
   * **只做旁观**：把"这条链什么时候落定"记下来，返回值**原样**交回去。
   *
   * 为什么不能写成 `return next().finally(release)`：那会把一个同步的返回值包成 Promise，
   * 而这条链的契约是"接不接、给什么，都在同步那一瞬间定下来"（见下面那段说明）。形状一变
   * 就可能让整条派发认不出谁接了这一手。
   *
   * 所以只在它**确实是 thenable** 时才挂回调；给回来一个普通值时，说明下游已经当场答完了，
   * 徽标立刻销掉是对的——**不挂一枚永远不会落定的假徽标**。
   */
  function watchSettle(value, release) {
    if (value && typeof value.then === 'function') value.then(release, release)
    else release()
    return value
  }

  /** 这一批题目是不是"计划审阅"。DSH 把计划审批和普通提问放在同一扇门里，靠 intent 分。 */
  function isPlanReview(questions) {
    return (Array.isArray(questions) ? questions : [])
      .some((q) => q && q.intent && q.intent.kind === 'plan-review')
  }

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
    // 进门先记一笔：这个会话此刻在等人。落定（答了、或者本来就没接）时销掉。
    // 计划审阅走的是同一扇门，只是 intent 不同——不分开记的话，手机上那三个
    // 分类就只剩两种（PC 侧栏是分三种的）。
    const release = markPending(agentId, isPlanReview(questions) ? 'plan' : 'question')
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
      return watchSettle(next(), release)
    }
    if (!phoneReady && !feishuReady) {
      console.log('[dsh-mini-remote] 提问让路：手机和飞书此刻都接不上（页面没开、锁屏或断网，飞书那头没有在等的轮次），交给电脑')
      return watchSettle(next(), release)
    }
    if (typeof miniControl.askPhone !== 'function') {
      console.log('[dsh-mini-remote] 提问让路：拿不到 askPhone（手机服务还没起来），交给电脑')
      return watchSettle(next(), release)
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
    return watchSettle(miniControl.askPhone(questions, agentId, {
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
    }), release)
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
    // 和上面那条提问链同一件事：进门记一笔「这个会话在等人」，落定时销掉。
    const release = markPending(agentId, 'approval')
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
      return watchSettle(next(), release)
    }
    if (!phoneReady && !feishuReady) {
      console.log('[dsh-mini-remote] 审批让路：手机和飞书此刻都接不上（页面没开、锁屏或断网，飞书那头没有在等的轮次），交给电脑')
      return watchSettle(next(), release)
    }
    if (typeof miniControl.askApproval !== 'function') {
      console.log('[dsh-mini-remote] 审批让路：拿不到 askApproval（手机服务还没起来），交给电脑')
      return watchSettle(next(), release)
    }
    console.log(`[dsh-mini-remote] 审批推给手机：${toolName}，等它拍板`
      + (feishuReady ? '（飞书那边一起问）' : ''))
    let askId = null
    return watchSettle(miniControl.askApproval(request, agentId, command, {
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
    }), release)
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

  // Agent 模式注册表（2026-10-04 用户要求：新建会话时手机上也要能选模式，PC 一直
  // 可以）。**单独 inject**（理由同上：缺一个服务不该连别的都没了）。没有它的时候
  // 手机直接建 DSH 的默认模式，如实说「没有可选的」——不摆一个没得选的选择题。
  const canPresets = { registry: null }
  ctx.inject(['agentPresets'], (presetsCtx) => {
    canPresets.registry = presetsCtx.agentPresets
    bPresetService = presetsCtx.agentPresets
    bPresetSvc = presetsCtx.agentPresets
    maybeRegisterBPreset()
    console.log('[dsh-mini-remote] Agent 模式清单已就绪：agentPresets=' + Boolean(canPresets.registry))
  })

  // 插件管理服务（手机端「插件」页面用）。
  const pluginServices = { manager: null }
  // DSH 版本号问到一次就记着（版本不会中途变），省得每 30 秒问一趟。
  let cachedDshVersion = ''
  ctx.inject(['pluginManager'], (pCtx) => {
    pluginServices.manager = pCtx.pluginManager
    console.log('[dsh-mini-remote] 插件管理服务已就绪：pluginManager=' + Boolean(pluginServices.manager))
  })

  /**
   * 「内置插件」要用的两样东西（2026-10-04 用户指出：内置插件只显示 6 个是不对的）。
   *
   * DSH 的理念是「一切皆插件、无特权核心」——一整套系统是几百个插件模块拼起来的，
   * 所以「内置插件」的真相不在 npm 包清单里（那是「插件市场」的粒度），
   * 而在 **Cordis Loader 的实时条目表**里。PC 的「设置 → 内置插件」页读的正是它，
   * 分成两块：全局插件（系统与所有会话共用）+ 会话插件（按 Agent 预设组合而成）。
   *
   * 两样都走 ctx.inject（软注入）：拿不到就只少这一块，不整个倒下。
   * `pluginPackages` 只提供显示用的本地化标题/说明，没有它照样能列出来（退成模块名）。
   */
  const invServices = { loader: null, packages: null, settings: null }
  ctx.inject(['loader'], (lCtx) => {
    invServices.loader = lCtx.loader
    console.log('[dsh-mini-remote] Cordis Loader 已就绪（内置插件清单要用）：loader='
      + Boolean(invServices.loader))
  })
  ctx.inject(['pluginPackages'], (pkCtx) => {
    invServices.packages = pkCtx.pluginPackages
    console.log('[dsh-mini-remote] 插件包元数据已就绪：pluginPackages='
      + Boolean(invServices.packages))
  })
  // 设置文档：问「官方插件里注册了设置卡片的那几个，这台部署是不是提供了」。
  ctx.inject(['settings'], (sCtx) => {
    invServices.settings = sCtx.settings
    console.log('[dsh-mini-remote] 设置文档已就绪（官方插件卡片要用）：settings='
      + Boolean(invServices.settings))
  })

  /**
   * 官方插件里「注册了一张设置卡片」的那几个。
   *
   * **为什么只能列在这里**：这几张卡片是**浏览器端**的插件在运行时注册进 Plugins 页的
   * `plugins.item` 插槽的（dsh-client-ui-plugin-manager 读的是 `ctx.slots`），
   * 宿主进程看不见浏览器里的插槽注册表——没有哪条宿主接口能问出来。
   * 所以包 identity、卡片 id、开关注册所用的命名空间、中文文案，
   * 只能照 DSH 0.2.0-rc.2 的客户端源码抄一份（4 个包各注册一张卡）：
   *
   *   dsh-client-ui-settings-shell        id=shell       等 bash-sandbox / pwsh-sandbox
   *   dsh-client-ui-settings-agent-loop   id=agent-loop  等 agent-loop
   *   dsh-client-ui-settings-subagent     id=subagent    等 subagent / subagent-model-selection-settings
   *   dsh-client-ui-settings-web-search   id=web-search  等 web-search-deepseek
   *
   * 文案逐字取自那几个包 `lib/client.js` 里自己的 zh 词典（不自己编）。
   *
   * **出现条件照 DSH 同一条规矩**：宿主的设置文档里 served 了它那几个命名空间才出现
   * （DSH 那边是 `configForms.whileServed(namespaces, …)`）——所以「这台部署没有终端设置」
   * 时，手机上也不会凭空多出一张终端卡。DSH 以后再加官方卡片，这张表要跟着补。
   */
  const OFFICIAL_CARDS = [
    { id: 'shell', namespaces: ['bash-sandbox', 'pwsh-sandbox'], title: '终端',
      description: '限制每条命令最多能跑多久、最多输出多少内容。' },
    { id: 'agent-loop', namespaces: ['agent-loop'], title: 'Agent 循环',
      description: '控制 Agent 派发工具调用的方式。' },
    { id: 'subagent', namespaces: ['subagent', 'subagent-model-selection-settings'], title: '子智能体',
      description: '设置子智能体的递归层级、数量和模型。' },
    { id: 'web-search', namespaces: ['web-search-deepseek'], title: '网页搜索',
      description: '设置 DeepSeek 的搜索提供方。' },
  ]

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

  /**
   * 取一份「本地化文案」里的中文。
   *
   * 形状是 LocalizedText：一个字符串，或 `{ en, 'zh-CN', … }` 这种按语言分份的对象。
   * 插件的标题和说明都是这个形状——不挑语言直接读，官方插件在手机上就全是英文。
   * 没有中文退英文，再没有就取第一个非空串；都没有返回空串（调用方自己决定怎么兜）。
   */
  function localizedText(v) {
    if (typeof v === 'string') return v
    if (!v || typeof v !== 'object') return ''
    for (const k of ['zh-CN', 'zh-Hans', 'zh', 'en']) {
      if (typeof v[k] === 'string' && v[k]) return v[k]
    }
    for (const val of Object.values(v)) if (typeof val === 'string' && val) return val
    return ''
  }

  /**
   * Loader 条目的 Fiber 状态码 → 词。照 dsh-host-plugin-inventory 里那张表：
   * 0 待定 / 1 加载中 / 2 运行中 / 3 失败 / 4 已销毁（报 null）/ 5 卸载中。
   */
  const FIBER_PHASE = ['pending', 'loading', 'active', 'failed', null, 'unloading']

  /**
   * 一个 Agent 模式（预设）拿给用户看的名字与说明。
   *
   * 政策照 PC：**声明里自带名字的（自建模式）用它自己的**，没名字的（内置那几档）
   * 才落 AGENT_MODE_COPY；认不出又没名字的落 null——如实，不瞎起名。
   *
   * 抽出来是因为两处要用：手机上「选模式」的清单，以及插件页「会话插件」按预设分组。
   * （2026-10-05 实测抓到：分组那儿漏了这一步，页面上露出 standard / ptc / cordis
   * 这种英文代号——组合清单里的 name 是预设声明的原名，不是给用户看的名字。）
   */
  function presetCopyOf(p) {
    const copy = AGENT_MODE_COPY[p?.id]
    const hasName = typeof p?.name === 'string' && p.name
    const hasDesc = typeof p?.description === 'string' && p.description
    return {
      id: p?.id,
      name: hasName ? p.name : (copy ? copy[0] : null),
      description: hasDesc ? p.description : (copy ? copy[1] : null),
      broken: typeof p?.broken === 'string' ? p.broken : null,
    }
  }

  // ------------------------------------------------------------------
  // 会话条目的执行功能（2026-10-09）：置顶 / 重命名 / 分叉 / 归档
  // ------------------------------------------------------------------
  //
  // 四件都**走 DSH 自己的服务**，不自己写盘：
  //   · 重命名  `sessionController.rename({ sessionId, title })`
  //   · 分叉    `sessionController.fork({ sessionId })`（＋照 PC 补一次 rename 递增标题）
  //   · 置顶    `workspaceRegistry.pinSession / unpinSession`
  //   · 归档    `workspaceRegistry.archiveSession / unarchiveSession`
  //
  // 读状态也走官方现成的两个 getter（`archivedSessionIds` / `pinnedSessionIds`），
  // 它们正是 PC 侧栏读的那一份。**不去读 `~/.dsh/storages/workspace.json`**：
  // 那是 DSH 的内部落盘格式，跟着版本变，而 getter 是它的公开面。
  //
  // 拿不到服务时一律**如实说没这个能力**（reason 带回手机），界面据此不摆一个按了没反应的按钮。

  /** `sessionController` 现在拿不拿得到——和 createSession 同一条取用路径。 */
  function sessionControllerNow() {
    return canCreate.controller ?? ctx.get('sessionController')
  }

  /**
   * 已归档 / 已置顶两个集合。
   *
   * 这两个 getter 在服务还没就绪时会抛（`requireState()`）——那时候导航栏少两枚徽标，
   * 不该影响遥控本身，所以照 lib/tree.js 里 safeList 那条老规矩：读不到就当空。
   * 但**要把 `ok:false` 带出去**，手机那边据此不显示「没有已归档」这种会被当成事实的说法。
   */
  function readSessionFlags() {
    const reg = treeServices.registry
    if (!reg) return { ok: false, reason: 'no-registry', archived: [], pinned: [] }
    const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [])
    try {
      return {
        ok: true,
        archived: strings(reg.archivedSessionIds),
        pinned: strings(reg.pinnedSessionIds),
      }
    } catch (err) {
      return { ok: false, reason: 'not-ready', archived: [], pinned: [], error: String(err?.message ?? err) }
    }
  }

  /**
   * 每个会话的官方摘要（`SessionSummary`）：我们要的只有 `blank` 一个字段。
   *
   * **为什么非它不可**：「空白新会话」这条判据在我们这边没有第二个来源——
   * `sessionQuery.listSessions()` 给的记录只有 `{header, live, persisted}`，
   * 里面没有"用过没用过"。而 `blank` 正是 PC 侧栏用来决定"这一行要不要摆出来"的那个字段。
   * 编一个（比如"标题为空就算空白"）会让一条只是标题没读出来的老会话当场消失，
   * 那是拿猜测当事实——**拿不到就如实说拿不到**，手机侧退回原来的行为（一条都不隐藏）。
   *
   * 缓存 30 秒：和导航那两层同一个口径。展开一个工作区本来就要读日志折标题，
   * 这一趟相对便宜，但没必要每次展开都重问一遍。
   */
  const SUMMARIES_TTL_MS = 30_000
  const summariesCache = { at: 0, value: null, inflight: null }
  async function readSessionSummaries(force = false) {
    const controller = sessionControllerNow()
    if (!controller || typeof controller.list !== 'function') {
      return { ok: false, reason: 'unavailable', byId: new Map() }
    }
    const now = Date.now()
    if (!force && summariesCache.value && now - summariesCache.at < SUMMARIES_TTL_MS) {
      return summariesCache.value
    }
    if (summariesCache.inflight) return summariesCache.inflight
    summariesCache.inflight = (async () => {
      try {
        const res = await controller.list({}, undefined)
        const byId = new Map()
        for (const item of res?.items ?? []) {
          if (item && typeof item.sessionId === 'string') byId.set(item.sessionId, item)
        }
        const value = { ok: true, byId }
        summariesCache.at = Date.now()
        summariesCache.value = value
        return value
      } catch (err) {
        // 失败不进缓存：下一次展开还会重试。返回的形状和上面一样，只是 ok:false。
        return { ok: false, reason: 'failed', byId: new Map(), error: String(err?.message ?? err) }
      } finally {
        summariesCache.inflight = null
      }
    })()
    return summariesCache.inflight
  }

  /**
   * 改一个会话的标题。
   *
   * **官方语义（2026-10-09 从 0.2.0-rc.2 的 `dsh-session-title` 读到原文）**：
   * `rename` 会追加一条 `session/title` 事件、`source.kind = 'user'`，这一条**钉住标题**——
   * 在途的自动生成当场作废，之后的用户消息也不再生成新标题。也就是说：**传什么都会钉**，
   * 哪怕跟当前自动标题一模一样。
   *
   * 所以"防误钉"这一步**不在这里**，在手机页：新标题与当前标题逐字相同就**根本不发这一趟**
   * （见 lib/page.html 的 renameSubmit）。服务端这一层只负责把官方的拒绝如实翻译回去。
   */
  async function renameSession(sessionId, title) {
    const controller = sessionControllerNow()
    if (!controller || typeof controller.rename !== 'function') {
      return { ok: false, reason: 'no-service' }
    }
    const text = typeof title === 'string' ? title : ''
    // 空/全空白：官方会抛 SessionTitleInvalidError（"归一化之后是空的"）。我们在这里就先拦住，
    // 措辞更直白，也省一趟往返。
    if (!text.trim()) return { ok: false, reason: 'blank' }
    try {
      const res = await controller.rename({ sessionId, title: text })
      // 官方会把归一化之后真正接受的那一份交回来（可能被截断、被去掉控制字符）。
      // 界面上要显示的是**它接受的那份**，不是我们递过去的那份。
      const accepted = typeof res?.title === 'string' ? res.title : text
      // 就手记到我们自己这两层缓存上。**不记的话**，用户改完名字再展开一次工作区，
      // 列表里还是旧标题（标题有 7 天的落盘缓存，已知标题优先于去读日志）——
      // 那就是"我刚改的名字它没记住"，界面自己打自己的脸。
      store.touchSession(sessionId, { title: accepted })
      titles.set(sessionId, accepted)
      return { ok: true, title: accepted }
    } catch (err) {
      if (err?.code === 'session/title-invalid' || err?.name === 'SessionTitleInvalidError') {
        return { ok: false, reason: 'blank' }
      }
      if (err?.code === 'session/not-found') return { ok: false, reason: 'not-found' }
      return { ok: false, reason: 'failed', error: String(err?.message ?? err) }
    }
  }

  /**
   * 标题里那个「(N)」，照官方**客户端的原函数**递增。
   *
   * 为什么这份逻辑在我们这边：官方 Host 的 `fork` 只管复制事件，**不动标题**——
   * 子会话继承源会话的标题。PC 是客户端自己再补一次改名：
   * `ClientSessions.fork({ increaseTitle: true })` 里那一行原文是
   *   `const renamed = await this.manager.rename(childId, increasedForkTitle(sourceTitle));`
   * 所以要跟电脑端一模一样，就得把 `increasedForkTitle` 这个函数也搬一份。
   *
   * 规则照抄（半角/全角括号都认，认不出就补 ` (1)`）：
   *   `^(.*?)\((\d+)\)$`  → `前缀(数字+1)`
   *   `^(.*?)（(\d+)）$`  → `前缀（数字+1）`
   *   其它一律               → `${title} (1)`
   */
  function increasedForkTitle(title) {
    const ascii = /^(.*?)\((\d+)\)$/u.exec(title)
    if (ascii?.[1] !== undefined && ascii[2] !== undefined) return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`
    const fullWidth = /^(.*?)（(\d+)）$/u.exec(title)
    if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`
    return `${title} (1)`
  }

  /**
   * 分叉时要拿来做递增的那个「源标题」。
   *
   * PC 用的是它自己列表快照里的 `title`（`this.list.getSnapshot().byId[id]?.title`）。
   * 我们这边等价的来源是 Host 的列表投影：`SessionSummary.projections.values.title`，
   * 也就是 `controller.list()` 给的那一份——和手机列表显示的是同一个字段。
   *
   * 拿不到就退到插件自己的标题缓存（就是下面那个 `titles`：读过一次就留着，改名也记一笔）。
   * **两个都没有就返回空串**——空串表示"不知道源标题"，那就**不做这次改名**，
   * 和 PC 的 `sourceTitle === undefined` 那条路一致（不硬编一个 `(1)` 出来骗人）。
   */
  async function forkSourceTitle(sessionId) {
    const summaries = await readSessionSummaries()
    const fromHost = summaries.byId?.get(sessionId)?.projections?.values?.title
    if (typeof fromHost === 'string' && fromHost.trim()) return fromHost
    const cached = titles.get(sessionId)
    return typeof cached === 'string' && cached.trim() ? cached : ''
  }

  /**
   * 分叉会话：在源会话**最后一个已完成轮次**处复制出一个新会话。
   *
   * 官方语义（2026-10-09 从 0.2.0-rc.2 的 `@deepseek-ai/dsh-api-session-controller` 读到原文）：
   * `fork(request: { sessionId, atSeq? })`，省略 `atSeq` 就是"最近一个已完成的前缀"——
   * 原文（lib/index.js 第 776-798 行）：
   * ```
   * async fork(request) {
   *   atSeq = request.atSeq === void 0 ? void 0 : SessionSeq(request.atSeq)
   *   const boundary = atSeq ?? latestCompletedPrefixBoundary(source.events)
   *   if (boundary === void 0 || source.events[boundary]?.seq !== boundary)
   *     throw new RemoteError("session/fork-unavailable", request.atSeq === void 0
   *       ? `session "${request.sessionId}" has no completed turn to fork from`
   *       : `event ${...} does not exist in session "${...}" (last seq: ${...})`,
   *       { sessionId: request.sessionId })
   *   ...
   *   return { sessionId: childId }
   * }
   * ```
   * 也就是说：**源会话里一个已完成轮次都没有时，Host 抛 `session/fork-unavailable`**，
   * 那句话就是上面那串英文；`not-found` 是另一条（`session "${id}" not found`）。
   *
   * **它不会打开新会话、也不会改当前选中的会话**——PC 那条路上
   * `navigation.forkSession()` 之后就结束了，没有任何 `replaceMain/open` 调用。
   * 我们这边同样一个字节都不动 `store` 里的绑定会话。
   *
   * 失败时**把 Host 那句话原样交给手机**：这是用户点名要的（"不要自己编一句『无法分叉』"），
   * 而且它正是 PC 用来区分「没有已结束轮次」和「真的失败了」的那个判据
   * （PC 的 `error.rpcError.code === "session/fork-unavailable"`）。
   * 唯一多写的一句是 `no-turn` 的中文引子——**照抄 PC 自己词条表里的原句**
   * （`"shortcut.noCompletedTurn": "当前会话没有已结束的轮次"`），让非技术用户看得懂；
   * Host 原话跟在它后面，一个字都没被改写。
   */
  async function forkSession(sessionId) {
    const controller = sessionControllerNow()
    if (!controller || typeof controller.fork !== 'function') {
      return { ok: false, reason: 'no-service' }
    }
    let childId = ''
    try {
      const res = await controller.fork({ sessionId })
      childId = typeof res?.sessionId === 'string' ? res.sessionId : ''
    } catch (err) {
      const message = String(err?.message ?? err)
      if (err?.code === 'session/fork-unavailable') {
        return { ok: false, reason: 'no-turn', error: `当前会话没有已结束的轮次。Host 原话：${message}` }
      }
      if (err?.code === 'session/not-found') {
        return { ok: false, reason: 'not-found', error: message }
      }
      return { ok: false, reason: 'failed', error: message }
    }
    // Host 说成功却没交出 id：那是它违约，不能编一个"大概建好了"糊过去。
    if (!childId) return { ok: false, reason: 'failed', error: 'Host 建好了会话却没有交出它的 id。' }
    // 标题递增。**失败不算分叉失败**——会话是真建出来了，把它说成没建出来更坏；
    // 只是标题留在继承来的那一个上（如实把 title 报成空串，手机就不拿标题说事）。
    let title = ''
    const source = await forkSourceTitle(sessionId)
    if (source) {
      const next = increasedForkTitle(source)
      try {
        await controller.rename({ sessionId: childId, title: next })
        title = next
      } catch (err) {
        title = ''
      }
    }
    if (title) {
      // 和 renameSession 一样就手记上，不然用户刷新回来还是旧标题（标题有 7 天的落盘缓存，
      // 而这一条是刚建出来的、哪一层都还没有）。
      store.touchSession(childId, { title })
      titles.set(childId, title)
    }
    return { ok: true, sessionId: childId, title }
  }

  /**
   * 归档 / 取消归档。
   *
   * `stop` 这一个布尔是**官方那条两段式流程**的全部：
   *   · 不带它（默认）：会话**还有工作在跑时服务会拒绝**，抛 `WorkspaceActiveSessionError`，
   *     错的 `.activity` 上按族列着"会停掉什么"（turn / job / subagent / schedule，各自带 items）。
   *     我们**原样交给手机**，手机照族列出来问过用户才继续——**不自己猜会停掉什么**。
   *   · 带了它（`{ stopActivity: true }`）：跳过检查，写完归档再去请各个 provider 停。
   *
   * 官方的原话是「Host 拒绝普通归档并列出这些工作，侧栏随即打开『停止并归档』对话框」——
   * 我们做的就是同一件事，只是"侧栏"换成了手机页。
   */
  async function archiveSession(sessionId, stop) {
    const reg = treeServices.registry
    if (!reg || typeof reg.archiveSession !== 'function') return { ok: false, reason: 'no-registry' }
    try {
      await reg.archiveSession(sessionId, stop ? { stopActivity: true } : {})
      return { ok: true, ...readSessionFlags() }
    } catch (err) {
      if (err?.name === 'WorkspaceActiveSessionError' || Array.isArray(err?.activity)) {
        return { ok: false, reason: 'active', activity: shapeActivity(err?.activity) }
      }
      if (err?.name === 'WorkspaceUnknownSessionError') return { ok: false, reason: 'not-found' }
      return { ok: false, reason: 'failed', error: String(err?.message ?? err) }
    }
  }

  /**
   * 把官方那四族活动收成手机要的形状。**只搬运，不重写**：
   * `kind` 原样（`turn`/`job`/`subagent`/`schedule`），中文说法在页面上拼——
   * 界面文字归界面管，服务端不该替它起中文名。
   *
   * 每族最多带 20 项：官方的 items 原则上不长，但这是**用户自己机器上的数据**，
   * 不该让一条超长的清单把手机页撑爆。截断了就把真实条数一起带出去，页面如实说。
   */
  function shapeActivity(activity) {
    return (Array.isArray(activity) ? activity : [])
      .filter((a) => a && typeof a.kind === 'string')
      .map((a) => {
        const items = (Array.isArray(a.items) ? a.items : [])
          .map((it) => ({
            id: typeof it?.id === 'string' ? it.id : '',
            label: typeof it?.label === 'string' ? it.label : '',
          }))
        return { kind: a.kind, count: items.length, items: items.slice(0, 20) }
      })
  }

  async function setPinned(sessionId, on) {
    const reg = treeServices.registry
    if (!reg || typeof reg.pinSession !== 'function') return { ok: false, reason: 'no-registry' }
    try {
      await (on ? reg.pinSession(sessionId) : reg.unpinSession(sessionId))
      return { ok: true, ...readSessionFlags() }
    } catch (err) {
      // 已归档的不能置顶（官方规定两者互斥）。界面上归档行本来就不给置顶入口，
      // 这条是兜底：真走到了也要说人话，不能回一个"失败"了事。
      if (err?.name === 'WorkspaceArchivedSessionPinError') return { ok: false, reason: 'archived' }
      if (err?.name === 'WorkspaceUnknownSessionError') return { ok: false, reason: 'not-found' }
      return { ok: false, reason: 'failed', error: String(err?.message ?? err) }
    }
  }

  async function unarchiveSession(sessionId) {
    const reg = treeServices.registry
    if (!reg || typeof reg.unarchiveSession !== 'function') return { ok: false, reason: 'no-registry' }
    try {
      await reg.unarchiveSession(sessionId)
      return { ok: true, ...readSessionFlags() }
    } catch (err) {
      return { ok: false, reason: 'failed', error: String(err?.message ?? err) }
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
    // —— 会话条目的执行功能（2026-10-09）：都由 lib/server.js 那几条路由调用 ——
    // 分组口径（隐藏空白、5 条空闲配额、已归档筛选）**不在这一层**：树那一层
    // （lib/tree.js）只回答"这个工作区有哪些会话"，页面口径属于服务层。
    sessionFlags: () => readSessionFlags(),
    sessionSummaries: (force) => readSessionSummaries(force),
    pendingInteractions: () => pendingSnapshot(),
    renameSession: (sessionId, title) => renameSession(sessionId, title),
    forkSession: (sessionId) => forkSession(sessionId),
    pinSession: (sessionId) => setPinned(sessionId, true),
    unpinSession: (sessionId) => setPinned(sessionId, false),
    archiveSession: (sessionId, stop) => archiveSession(sessionId, stop),
    unarchiveSession: (sessionId) => unarchiveSession(sessionId),
    // 建会话：先用 inject 拿到的那个，拿不到就现读一次——`ctx.get` 对没写进 inject
    // 的服务名是**返回 undefined**（不是抛错），所以这么写是安全的。
    createSession: (workspaceId, agentPreset) =>
      createSessionIn({
        controller: canCreate.controller ?? ctx.get('sessionController'),
        registry: treeServices.registry,
        workspaceId,
        agentPreset,
      }),
    // Agent 模式清单（2026-10-04）：手机新建会话时挑模式用。坏档也如实给（broken），
    // 拿不到能力就说 unavailable——不摆一个没得选的选择题。默认哪一档由
    // registry 的 defaultId 说（那是 DSH 自己的默认，不猜）。
    //
    // 名字照抄 PC 的词条表（见 AGENT_MODE_COPY，用户 2026-10-04 点名「模式选择应该
    // 为中文」）。政策也照 PC：**声明里自带名字的（自建模式）用它自己的**，没名字的
    // （内置档）才落词条表；认不出又没名字的才落 id——如实，不瞎起名。
    agentPresets: async () => {
      const svc = canPresets.registry ?? ctx.get('agentPresets')
      if (!svc || typeof svc.list !== 'function') return { ok: false, reason: 'unavailable' }
      try {
        const list = await svc.list()
        return {
          ok: true,
          defaultId: typeof svc.defaultId === 'string' ? svc.defaultId : null,
          presets: (Array.isArray(list) ? list : []).map(presetCopyOf),
        }
      } catch (err) {
        return { ok: false, reason: 'failed', error: String(err?.message ?? err) }
      }
    },
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

    /**
     * 插件清单（手机端「插件」页面用，2026-10-04）。
     *
     * 字段照 DSH 的 `BundleInfo`（pluginManager 的契约，逐字段对过）：
     *   name / version / installed / optional / enabled / description
     *   meta: { title?, description? } —— **本地化文案**，中文说明在这一份里；
     *   error: { code, diagnostic? } —— 出问题的那一笔。
     *
     * 两处不照抄会难看：① 只取 `description`（包的英文说明），
     * PC 上那句中文「启用团队协作、团队工具……」来自 `meta.description`，得优先用它；
     * ② `error` 是个对象，直接递出去页面上会显示 `[object Object]`。
     */
    /**
     * 正在跑的这只 DSH 是哪个版本（设置页底部那行用，2026-10-04）。
     *
     * **为什么不读文件**：早先这里去翻 `node_modules/@deepseek-ai/dsh/package.json`，
     * 两个毛病都踩了——① 那是「命令行那份 dsh」的版本，未必等于正在跑的这只 Host
     * （实测桌面端跑的是 0.2.0-rc.2，而命令行那份写着 0.2.0-rc.1）；
     * ② 桌面端的工作目录里压根没有那个文件，于是手机上一直显示 `unknown`。
     *
     * 改问正在跑的这只 Host：它自己报的运行时版本才作数。问到一次就记住。
     */
    dshVersion: async () => {
      if (cachedDshVersion) return cachedDshVersion
      const mgr = pluginServices.manager ?? ctx.get('pluginManager')
      try {
        // 这个接口本意是列「版本豁免」，但它捎带把运行时版本报出来了
        // ——宿主唯一一处直接说「我是哪个版本」的地方。
        const got = await mgr?.listVersionExemptions?.()
        if (typeof got?.runtimeVersion === 'string' && got.runtimeVersion) {
          cachedDshVersion = got.runtimeVersion
          return cachedDshVersion
        }
      } catch (err) {
        // 问不到就往下一步退，不把设置页那行弄崩。
      }
      try {
        // 退一步：核心包自己的版本就是 DSH 的版本（整个仓库一起发版）。
        const bundles = await mgr?.listBundles?.()
        const base = (bundles || []).find((b) => b?.name === '@deepseek-ai/dsh-base')
        if (typeof base?.version === 'string' && base.version) {
          cachedDshVersion = base.version
          return cachedDshVersion
        }
      } catch (err) {
        // 都没有就如实说不知道（页面据此整行不显示，不拿 unknown 糊一行）。
      }
      return 'unknown'
    },

    pluginList: async () => {
      const mgr = pluginServices.manager ?? ctx.get('pluginManager')
      if (!mgr) return { ok: false, reason: 'unavailable' }
      try {
        const bundles = await mgr.listBundles()
        return {
          ok: true,
          bundles: (bundles || []).map((b) => ({
            name: b?.name ?? '',
            // 显示名优先用本地化标题（官方插件在 PC 上显示的是「智能体团队」而不是包名），
            // 没有就退回包名——第三方插件多半没有标题。
            title: localizedText(b?.meta?.title) || b?.name || '',
            description: localizedText(b?.meta?.description) || b?.description || '',
            version: typeof b?.version === 'string' ? b.version : '',
            installed: b?.installed === true,
            optional: b?.optional === true,
            enabled: b?.enabled !== false,
            // 出问题的那一笔：有原话就说原话，没有就报错误码。没它就别硬编。
            problem: b?.error ? (b.error.diagnostic || b.error.code || '有问题') : '',
          })),
        }
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) }
      }
    },

    /**
     * 内置插件清单（手机端「插件 → 已安装 → 内置」用，2026-10-04 补）。
     *
     * **为什么不是 listBundles**：那是 npm 包的粒度（十几个），答不了「内置插件有多少」。
     * DSH 是「一切皆插件、无特权核心」，一整套系统由几百个插件模块拼成，真相在
     * Cordis Loader 的实时条目表里。PC 的「设置 → 内置插件」页就是读这里，分两块：
     *   全局插件 = Loader 自己的条目（系统与所有会话共用）；
     *   会话插件 = 各 Agent 预设的组合行（预设挂载后才在会话里跑）。
     *
     * 读取逻辑照 `dsh-host-plugin-inventory`（那是只读投影，我们直接读同几个源：
     * loader.entries() / agentPresets.compositionInventory() / pluginPackages.metaOf()），
     * 因为它在宿主服务目录里查不到，只能按它的实现来。
     */
    pluginInventory: async () => {
      const loader = invServices.loader ?? ctx.get('loader')
      if (!loader || typeof loader.entries !== 'function') {
        return { ok: false, reason: 'unavailable' }
      }
      const packages = invServices.packages ?? ctx.get('pluginPackages')
      // 显示用的本地化元数据。取不到就是没有——退成模块名，不影响列出来。
      const metaOf = (moduleName, base) => {
        if (!packages || typeof packages.metaOf !== 'function' || base === undefined) return null
        try {
          return packages.metaOf(moduleName, base) ?? null
        } catch (err) {
          return null
        }
      }
      /**
       * 模块名压成短名。照 PC 的「内置插件」面板（dsh-client-ui-settings-plugin-inventory
       * 里那个 moduleShortName）：`@deepseek-ai/dsh-tool-fs` → `tool-fs`。
       * 手机上不压的话每一行都是 `@deepseek-ai/dsh-xxx`，一屏放不下几个。
       */
      const shortName = (name) => String(name ?? '')
        .replace(/^@[^/]+\//, '')
        .replace(/^cordis:/, '')
        .replace(/^cordis-plugin-/, '')
        .replace(/^dsh-(?:host-|client-)?/, '')
      /**
       * 显示名。PC 的规矩：`meta.title` 是本地化对象就取文案，否则把那一份
       * （字符串标题，或干脆是模块名）压成短名。没有标题就退到模块名的短名。
       */
      const titleOf = (meta, moduleName) => {
        const t = meta?.title
        if (t && typeof t === 'object') return localizedText(t) || shortName(moduleName)
        return shortName(t || moduleName)
      }
      const rowOf = (moduleName, base, extra) => {
        const meta = metaOf(moduleName, base)
        return {
          entryId: extra.entryId,
          moduleName,
          title: titleOf(meta, moduleName),
          description: localizedText(meta?.description),
          enabled: extra.enabled,
          // 预设组合行可能是 'conditional'（带 !!js 条件、要挂载后才定得下来）。
          conditional: extra.conditional === true,
          condition: extra.condition,
          phase: extra.phase,
        }
      }

      const entries = []
      try {
        for (const entry of loader.entries()) {
          // 分组只是树上的容器，不是插件（PC 的内置插件页同样跳过它们）。
          if (entry?.options?.group) continue
          const moduleName = String(entry?.options?.name ?? '')
          entries.push(rowOf(moduleName, entry?.parent?.tree?.ctx?.baseUrl, {
            entryId: String(entry?.id ?? ''),
            enabled: entry?.disabled !== true,
            condition: '',
            phase: entry?.fiber === undefined ? null : (FIBER_PHASE[entry.fiber.state] ?? null),
          }))
        }
      } catch (err) {
        return { ok: false, reason: '读 Loader 条目失败：' + String(err?.message || err) }
      }

      // 会话插件：预设的组合行。拿不到就空着——那说明这个部署没挂预设名册，
      // 不是「一个都没有」，所以页面那一块整块不画。
      const presets = []
      try {
        const registry = canPresets.registry ?? ctx.get('agentPresets')
        // 组合清单里的 `name` 是预设自己声明的**原名**（内置那几档就是 standard / ptc
        // 这种代号），不是给用户看的。给用户看的名字在名册那边——走和「选模式」同一套
        // 政策取（见 presetCopyOf）。名册读不到就退到原名，不硬编一张对照表。
        const shownName = new Map()
        try {
          const roster = await registry?.list?.()
          for (const p of Array.isArray(roster) ? roster : []) {
            const copy = presetCopyOf(p)
            if (copy.id !== undefined && copy.name) shownName.set(String(copy.id), copy.name)
          }
        } catch (err) {
          // 名册问不到不影响列出组合（只是名字会退回代号）。
        }
        const list = await registry?.compositionInventory?.()
        for (const one of list || []) {
          const id = String(one?.id ?? '')
          presets.push({
            id,
            name: shownName.get(id) || localizedText(one?.name) || id,
            isDefault: one?.isDefault === true,
            broken: one?.broken ? String(one.broken) : '',
            rows: (one?.rows || []).map((r) => rowOf(String(r?.moduleName ?? ''), ctx.baseUrl, {
              entryId: r?.entryId === null || r?.entryId === undefined ? '' : String(r.entryId),
              enabled: r?.enabled === true,
              conditional: r?.enabled === 'conditional',
              condition: r?.condition ? String(r.condition) : '',
              phase: r?.fiberState === undefined ? null : (FIBER_PHASE[r.fiberState] ?? null),
            })),
          })
        }
      } catch (err) {
        // 预设读不动不该把全局那一半也拖没：两块各报各的。
        console.log('[dsh-mini-remote] 预设组合读不到（内置插件的会话那一块会空着）：'
          + String(err?.message || err))
      }

      return { ok: true, entries, presets, hasRoster: canPresets.registry !== null }
    },

    /**
     * 官方插件里那几张「设置卡片」（2026-10-04 用户确认：官方就是这 8 个，手机上也要看得到）。
     *
     * 官方那一栏其实是两样东西拼的，PC 上也是：
     *   ① 可开关的官方插件**包**（optional && 未装）——走 pluginList，4 个；
     *   ② 注册了设置卡片的官方插件——就是这里，4 个（终端 / Agent 循环 / 子智能体 / 网页搜索）。
     * 两张合起来正好是 PC 上那 8 个。
     *
     * 判据照 DSH：宿主的设置文档 served 了卡片那几个命名空间才出现。问不到设置文档时
     * **整块不出现**（宁可少画，不凭空多画）——这和 DSH 自己「不 served 就不注册」一致。
     */
    officialPlugins: async () => {
      const settings = invServices.settings ?? ctx.get('settings')
      if (!settings || typeof settings.describe !== 'function') return { ok: true, cards: [] }
      let served = null
      try {
        served = new Set((settings.describe() || []).map((d) => String(d?.ns ?? '')))
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) }
      }
      return {
        ok: true,
        cards: OFFICIAL_CARDS
          .filter((c) => c.namespaces.some((n) => served.has(n)))
          .map((c) => ({ kind: 'card', id: c.id, title: c.title, description: c.description })),
      }
    },
    /**
     * 「繁忙时的发送行为」（2026-10-05 用户要求搬进手机设置）。
     *
     * **这是什么**：智能体正在跑的时候，你在手机上进的那句话到底怎么交给它——
     *   排队发送（queue）：排到队尾，等当前这一轮跑完再跑；
     *   插话发送（steer）：直接插进去，它当场看到并调整方向。
     *
     * **PC 上是同一个东西**：设置 → 通用里的「繁忙时的发送行为」。
     * 真相在 `dsh-client-ui-conversation` 里：
     *   命名空间 ui-conversation、字段 busyEnter、取值 queue|steer、默认 queue。
     *   它的注释原话是「Busy-Enter preference shared by the composer bar inject face
     *   and its Settings row: one live store … backed by the Host user-settings document」。
     *
     * **两端共用一个值**（用户 2026-10-05 拍板「都 ok」）：宿主只有一份用户设置文档，
     * 手机上改它，电脑上也是这个值。这样才不会出现「手机上选了插话、电脑上还是排队」。
     *
     * **拿不到就整条不显示**，不摆一个假的开关——和插件页那套「宁可少画」同一口径。
     */
    busyEnterSetting: async () => {
      const settings = invServices.settings ?? ctx.get('settings')
      if (!settings || typeof settings.describe !== 'function') return { ok: false, reason: 'unavailable' }
      let doc = null
      try {
        doc = (settings.describe() || []).find((d) => String(d?.ns ?? '') === 'ui-conversation') ?? null
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) }
      }
      // 这个命名空间得真的被 served 才有得改——没有它就没有这一条。
      if (!doc) return { ok: false, reason: 'unavailable' }
      const value = doc?.value && typeof doc.value === 'object' ? doc.value : {}
      const current = value.busyEnter === 'steer' ? 'steer' : 'queue'
      return {
        ok: true,
        current,
        // 带上 revision：写的时候要它做乐观锁，免得和电脑上同时改打架。
        revision: typeof doc.revision === 'number' ? doc.revision : undefined,
      }
    },

    /**
     * 改「繁忙时的发送行为」。值只有两个，别的一律拒绝——**不替用户猜一个**。
     *
     * 走 `settings.update(ns, patch, revision)`（官方契约里的「把一个 entry 的可编辑
     * 字段合并进去」）。带 revision 是有意的：万一电脑上刚改过，这次写入会被挡下来
     * 而不是把对方的改动盖掉——那种覆盖用户看不见，最难查。
     */
    setBusyEnter: async (next) => {
      if (next !== 'queue' && next !== 'steer') {
        return { ok: false, reason: 'invalid' }
      }
      const settings = invServices.settings ?? ctx.get('settings')
      if (!settings || typeof settings.update !== 'function') return { ok: false, reason: 'unavailable' }
      let revision
      try {
        const doc = (settings.describe() || []).find((d) => String(d?.ns ?? '') === 'ui-conversation')
        if (!doc) return { ok: false, reason: 'unavailable' }
        revision = typeof doc.revision === 'number' ? doc.revision : undefined
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) }
      }
      try {
        await settings.update('ui-conversation', { busyEnter: next }, revision)
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) }
      }
      return { ok: true, current: next }
    },

    /**
     * 「进阶设置（电脑端界面）」的当前状态。
     *
     * `available` 和 `enabled` 是**两件事**，界面要分开说：
     *   available=false —— 这台机器上就没有这个能力（没拿到 DSH_WEB_URL），整条不显示；
     *   available=true、enabled=false —— 有能力，但用户没开（默认就是这个）。
     */
    mirrorSetting: () => ({
      ok: true,
      // `available` 问的是**此刻**能不能用（上游地址解析得出来），不是「建没建出这个对象」——
      // webServer 就绪得晚，插件刚加载那一刻问不到端口，那时候要如实说不可用。
      available: mirror.available(),
      enabled: store.state.mirrorEnabled === true,
    }),

    /**
     * 开/关「进阶设置」。**这是权限开关，不是普通偏好**——见 store 里那段说明。
     *
     * 只认布尔值，别的一律拒绝（和 busyEnter 同一条口径：不替用户猜一个）。
     * 关掉时不做任何「清理」：那条路由是每请求现读开关的，关掉就等于不存在了，
     * 不需要再去撤销什么。
     */
    setMirror: (enabled) => {
      if (typeof enabled !== 'boolean') return { ok: false, reason: 'invalid' }
      if (!mirror.available()) return { ok: false, reason: 'unavailable' }
      const value = store.setMirrorEnabled(enabled)
      log.info?.(value ? '手机开了「进阶设置」：现在可以打开电脑端界面。' : '手机关掉了「进阶设置」。')
      return { ok: true, enabled: value }
    },

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
  // 「进阶设置」：电脑端界面的镜像（2026-10-06）
  //
  // 手机上那张遥控页是**专门为手机做的**，所以电脑上那些插件贡献的设置页它进不去。
  // 这一块是退路：**要改那些设置时，把电脑端界面整个搬过来看**——不迁移页面、
  // 不逐个适配、同一份界面。原委和认证怎么走，都写在 lib/mirror.js 开头。
  //
  // **地址从 webServer 服务问，不从环境变量猜。** 这一条是实测撞出来的：
  // 第一版读 `process.env.DSH_WEB_URL`，结果 `available=false`——那个变量是
  // **命令行工具那一侧**才有的（DSH 给子进程注入的），**宿主进程里根本没有**。
  // 宿主自己报地址的地方就是 webServer（它有 `port` 和 `host`），而且**两端都成立**：
  // 桌面端它指向那个只绑回环的界面，`dsh web` 那边它就是界面本身。
  //
  // 而且**必须惰性**：boot 期各插件并行加载，apply 这一刻 webServer 常常还没 provide。
  // 所以端口在下面那个 `ctx.inject(['webServer'])` 回调里才填上，
  // 在那之前镜像会如实说自己「还没法用」，界面那一行也就不显示。
  // ------------------------------------------------------------------
  let mirrorAppPort = null

  function mirrorUpstream() {
    // webServer 到位了就用它——**回环字面量写在这里**：上游必须是本机那一个，
    // 而 webServer 的 host 可能是 0.0.0.0（那是「绑哪张网卡」，不是「连哪个地址」）。
    //
    // 没有 webServer 就没有可镜像的界面（纯 headless 组合），如实回 null，
    // 界面那一行不显示。**这里刻意不留 `DSH_WEB_URL` 的退路**：实测那个变量只在
    // 命令行工具那一侧存在，宿主里没有；而且留着它会让测试在开发机上意外指到
    // 用户真实运行的界面上——测试不该有这种机会。
    if (typeof mirrorAppPort === 'number' && mirrorAppPort > 0) {
      return `http://127.0.0.1:${mirrorAppPort}`
    }
    return null
  }

  const mirror = createMirror({
    upstream: mirrorUpstream,
    /**
     * 取「带官方令牌的地址」。**惰性求值**：这一刻 connection 服务可能还没 provide，
     * 但转发是真发生请求时才问，那时候它一定在。
     */
    tokenUrl: () => {
      const connection = ctx.get('connection')
      if (!connection || typeof connection.authenticatedUrl !== 'function') return null
      const base = mirrorUpstream()
      if (!base) return null
      try {
        return connection.authenticatedUrl(`${base}/`)
      } catch (err) {
        report('service', '取电脑端界面的访问凭据失败：' + (err?.message ?? err))
        return null
      }
    },
    log: (msg) => log.warn?.('[镜像] ' + msg),
  })

  log.info?.('「进阶设置（电脑端界面）」已就绪，默认关；等 webServer 报出端口后可用。')

  // ------------------------------------------------------------------
  // 起服务
  // ------------------------------------------------------------------
  /**
   * 「跨机那两条」在**手机服务那个端口上**的第二份挂载点（2026-10-17 第七步）。
   *
   * ## 为什么要有它（"B 填哪条地址"那个毛病的答案）
   *
   * 这两台电脑之间，B 手上只会填**一条**地址。而 A 这边两条路本来长在两个端口上：
   * 配对和跨机取票在宿主那一半（DSH 的 web 端口），取票回来的那条地址指向的
   * `/mini/mirror/` 在手机服务那一半（3090）。取票回的那条地址用的是**请求到达时的
   * Host**（见下面的 `requestOrigin`），于是 B 填哪一边都有一半对不上。
   *
   * 把这两条**原样**挂在手机服务上，B 就只填手机页那条地址——两端同源，`/mini/mirror/`
   * 本来就在那儿。
   *
   * ## 形状是可变的，而且这里只有挂载点
   *
   * `createMiniServer` 在 `webServer` 之前就起来了（上面那个 effect），而这两条路由
   * 要等 webServer 就绪才谈得上注册——所以这里先占位、注册那一刻填上，
   * 手机服务每次请求现取（见 lib/server.js 的 `remoteRoutes`）。
   * **逻辑一份都不在这儿**：下面两个处理函数原样交出去，两个端口共用同一份实现
   * （总开关、限速、口令/凭据的比对、票怎么发，一处都没多）。
   * 卸载时跟着摘掉（见那个 disposer）。
   */
  const hostHalfRoutes = { pair: null, remoteWindow: null, browse: null, browseRoots: null, browseMkdir: null, workspaces: null }

  ctx.effect(() => {
    let closed = false
    createMiniServer({
      store,
      config: settings,
      token,
      // 「设备身份」名册：认凭据（每一次请求现查，删掉记录即失效）和登记新设备。
      devices,
      bindAddresses: resolveBindAddresses(settings.bindAddress),
      tunnelHost,
      // server 那边的 `log.warn` 接到 `report` 上：这样它报的错（比如「窗口凭据没被浏览器
      // 收下」）会进自检的「最近出错」，而不是只打在终端里——而用户在图形界面上看不到终端。
      log: { info: log.info, warn: (m) => report('service', m) },
      // 镜像那一路：实例 + **每个请求现读的开关**（关着时那条路由根本不存在）。
      // 上游地址没解析出来时也当关着——宁可回 404（查无此路），也不要回一个
      // 「有这条路但它坏了」的 502：前者是实话，后者会让用户以为功能坏了。
      mirror,
      mirrorEnabled: () => store.state.mirrorEnabled === true && mirror.available(),
      // 跨机那两条在手机服务上的第二份挂载点（见上面那段）。
      remoteRoutes: hostHalfRoutes,
      agentHub,
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
          report('service', `地址 ${f.address} 没绑上，已跳过：${f.message}`)
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
          report('service', '没找到手机能连上的地址——检查 Wi-Fi／网线，或者 Tailscale 是否已登录。')
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
        report('service', `启动失败：${serverError}`)
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
      report('service', '拿不到 webServer 服务，设置页里的扫码面板用不了（手机端不受影响）。')
      return
    }

    // 「进阶设置」的镜像要往**这台服务器**转发——它就是电脑端界面本身
    // （桌面端那个只绑回环的 19387；`dsh web` 那边就是 3080）。
    // 端口到这里才知道，所以镜像那边是惰性求值的（见上面 mirrorUpstream）。
    if (typeof webServer.port === 'number' && webServer.port > 0) {
      mirrorAppPort = webServer.port
      log.info?.(`「进阶设置」的上游定为这台界面：127.0.0.1:${webServer.port}`)
    }

    // 面板和开关都带着 token，所以两者都只允许从这台电脑自己访问。否则同一个
    // Wi-Fi 下谁都能把密码取走，token 就白设了。
    function localOnly(req, res) {
      if (isLocalRequest(req)) return true
      sendJson(res, 403, { ok: false, error: '配对信息只能在这台电脑上看。' })
      return false
    }

    /**
     * 路由登记簿 + 挂载口（自检要看的「我们注册了哪些 / 哪些现在真的在」）。
     *
     * **登记和注册必须同一处发生**。另写一份常量清单看着更省事，但它迟早会和实际注册的
     * 那几条对不上——而这份清单的用处**恰恰是回答"这台跑的是哪一版"**：对不上的清单会
     * 把用户引到一个错结论上（"接口都在"其实少一条，或者反过来，让他白重启一趟）。
     *
     * `mounted` 在注销那一刻翻成 `false`：路由交出去之后，**只有我们自己知道它还在不在**
     * （`webServer.register` 返回的那个 disposer 被调用过没有）。
     */
    const routeBook = new Map()
    function mountRoute(route) {
      routeBook.set(route.path, { kind: route.kind ?? 'exact', mounted: true })
      const off = webServer.register(route)
      return () => {
        const entry = routeBook.get(route.path)
        if (entry) entry.mounted = false
        // 注销失败不该盖住真正要报的错（下面那个 disposer 一把全摘，一条出错不能拖着别的）。
        try { off?.() } catch { /* 见上 */ }
      }
    }

    /**
     * 跨机那个开关的现状，交给设置页。
     *
     * **包在 `buildPairing` 外面**（不是当参数传进去）：那个函数有四条早退路径
     * （成功 / 隧道报错 / 绑定配置问题 / 一条地址都没有），逐条补字段就是同一个坑
     * ——`serve` 和 `feishu` 都在那上面栽过（见 test/tunnel.test.mjs 里那两条测试）。
     * 包在外面，以后它再加一条早退路径也不会漏。
     */
    function remoteStatus() {
      return { allowed: Boolean(settings.allowRemoteComputers) }
    }

    /** B 端执行那一块的现状：总开关 + 已配对的 B 端名单（不含 token）。 */
    function agentStatus() {
      return {
        allowed: Boolean(settings.allowAgent),
        agents: agentHub.list(),
        presetRegistered: bPresetRegistered,
        presetError: bPresetError,
        projects: bProjectsView(),
      }
    }

    /** B 端这一侧的执行端状态（不含 token）。 */
    function bAgentView() {
      return bAgentStatus()
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
            // 跨机那个开关同理：它的路由长在宿主这一半（不在手机服务里），所以服务没
            // 起来的时候它照旧点得动、也照旧该显示出来。
            remote: remoteStatus(),
            agent: agentStatus(),
            bAgent: bAgentView(),
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
      return { status: payload.ok ? 200 : 500, body: { ...payload, remote: remoteStatus(), agent: agentStatus(), bAgent: bAgentView() } }
    }

    const offGet = mountRoute({
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

    const offTunnel = mountRoute({
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
    const offServe = mountRoute({
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
    const offToken = mountRoute({
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
    const offFeishu = mountRoute({
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
     * 「远程窗口」：给桌面端那个面板换一张**一次性票**（2026-10-15）。
     *
     * ## 为什么要有它（而不是让界面自己去拿）
     *
     * 桌面端的界面半边跑在 DSH 自己的页面里（实测：那个页面在自定义协议
     * `dsh-app://app/` 上，见 DSH 桌面端 main.js 的 `protocol.handle(SCHEME…)`），
     * 我们的镜像在 `http://127.0.0.1:<端口>` 上——**既跨源又跨站**。它自己去要凭据，
     * 要么被跨源拦住，要么就得把令牌发给浏览器，而令牌一旦进了 iframe 的地址就会留在
     * 那台电脑的浏览历史里（设计稿那条硬规矩）。
     *
     * 所以由**宿主这一半**（就跑在这个进程里、本来就拿着令牌）去换票，再把票交给界面：
     * 界面只拿得到「票 + 一条地址」，令牌一个字节都过不去。
     *
     * ## 票怎么用
     *
     * 地址是 `http://127.0.0.1:<我们的端口>/mini/mirror/?ticket=…`。浏览器拿着它进那扇门，
     * 门里把票兑现成一枚**窗口会话 cookie**（iframe 后续那些请求全靠它认人），
     * 票自己**只授权那一次**；地址里留着的那张票之后只用来回答「这一页是我嵌出来的吗」
     * ——取景政策靠它（见 `lib/server.js` 的取景政策与 `lib/mirror.js` 的票）。
     * **票 30 秒、一次性、用完即废。**
     *
     * 用 `127.0.0.1` 而不是本机在局域网里的地址：这个面板只可能在**这台电脑**上打开。
     *
     * 和别的 `/mini-remote/*` 一样**只允许本机调用**——能发这张票的只能是本机上的软件。
     *
     * **票上要写着这扇窗是谁的**（2026-10-16 第五步）：本机这一条给 `local`，兑票那一下
     * 照着它签窗口会话（见 lib/server.js 的 ticketWindowOwner）。兑票的浏览器在**这台
     * 电脑**上，所以那一关仍然要求"这一下是这台电脑自己发的"（回环、无转发头）。
     */
    const offWindow = mountRoute({
      kind: 'exact',
      path: '/mini-remote/window',
      handler: (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        if (!server) {
          sendJson(res, 503, { ok: false, error: '手机服务还在启动，过几秒再试。' })
          return
        }
        if (!mirror.available()) {
          // 这台机器上没拿到「电脑端界面」的地址（宿主刚起来那一段是这样）。
          sendJson(res, 503, { ok: false, error: '这台电脑上现在找不到可嵌入的「电脑端界面」，过几秒重新打开这一次。' })
          return
        }
        sendJson(res, 200, {
          ok: true,
          url: `http://127.0.0.1:${server.port}/mini/mirror/?ticket=${encodeURIComponent(mirror.issueTicket(LOCAL_WINDOW_DEVICE))}`,
          expiresIn: Math.round(mirror.ticketTtlMs / 1000),
        })
      },
    })

    /**
     * 回给外面那台电脑的地址里，那个「源」是什么（2026-10-16 跨机第二步）。
     *
     * ## 为什么必须是**请求到达时的 Host**，不能写死 `127.0.0.1`
     *
     * 本机版那条可以写死（那个面板只可能在这台电脑上打开），跨机这一条**不行**：
     * 这条地址会原样交到**对面那台电脑**的浏览器里，而在那台电脑上 `127.0.0.1`
     * 指的是**它自己**——框会去连它自己的本机端口，屏幕上是一片白/一个莫名其妙的
     * 404，而 A 这边日志干干净净，最难查的就是这种。所以用请求里那个 Host：
     * 它天然就是"对面用来够到我的那个地址"。
     *
     * 协议跟着 `X-Forwarded-Proto` 走：A 很可能藏在 Tailscale 的 https 后面
     * （那边转发进来的是明文 http），这时对面要的是 `https://`。
     *
     * **Host 缺失就回 null**，由调用方当场报错。宁可明说"说不清该回哪条地址"，
     * 也绝不退回一个写死的本机地址——那正是这一条要防的错。
     */
    function requestOrigin(req) {
      const host = String(req.headers?.host ?? '').trim()
      if (!host) return null
      const proto = String(req.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
      return `${proto === 'https' ? 'https' : 'http'}://${host}`
    }

    /**
     * 「跨机远程窗口」：**另一台电脑拿自己的设备凭据，来换一张带票的地址**
     * （2026-10-16 跨机第二步）。
     *
     * ## 它和本机那条（`/mini-remote/window`）是同一件事的两个人
     *
     * 本机那条拿票的是**这台电脑自己的软件**，所以只允许回环（`localOnly`）；
     * 这一条拿票的人在**另一台电脑上**，手上那枚东西是配对时换来的**设备凭据**
     * ——不是这台电脑的口令，也不是本机回环。所以：
     *
     *   · **不调用 `localOnly`**（照 `pair` 那条的先例——它也是给外面调的）；
     *   · 认的是**设备凭据**，三种带法（`X-Mini-Device` 头 / `?device=` / cookie）
     *     走**同一份实现**（`server.verifyDevice` → `isAuthorized` 里认设备那一路），
     *     而且每次都现查名册：那台电脑被撤销之后，这枚凭据当场失效；
     *   · 票还是那一种票（30 秒、一次性、用完即废），换来的会话里签着它的设备身份
     *     ——撤销对**已经开着的那扇窗**也生效（见 lib/server.js 的 windowSession）。
     *
     * ## 票上要写着这台设备的 id（2026-10-16 第五步）
     *
     * 兑票的那一下在**对面那台电脑的浏览器**里发生：那个浏览器**没有设备凭据**（凭据
     * 只活在这条路由的调用方——对面那个宿主进程里），也**不是这台电脑的回环**。所以
     * 身份必须在**发票这一刻**定下来、跟着票走：这里就是刚验过的 `deviceId`
     * （`server.verifyDevice` 那一步，每次都现查名册）。兑票那一下照它签会话，
     * 而且**兑现时还会再查一次名册**（见 lib/server.js 的 ticketWindowOwner）。
     *
     * ## 少掉 `localOnly` 之后补的是什么（照 `pair` 那套，顺序固定）
     *
     * 1. **开关**：`allowRemoteComputers` 关着时**这条路由一条都不接**；
     * 2. **服务在不在**：不在就 503——限速那一套就长在那个服务实例里；
     * 3. **限速**：和手机服务**共用同一张表**（`server.rateLimit`）。这条是外面能调的，
     *    闸不是可选项。**不写 `?.`**：拿不到闸宁可当场报错（关着），也不静默放行；
     * 4. **凭据**：比对本身走 `devices.verify`（`timingSafeEqual`，定长比较），
     *    和口令那条同一个口径。
     *
     * ## 为什么限速只查不记（和 `pair` 不同的一处，有意）
     *
     * `pair` 那条输的是**口令**——用户自己定的、猜得动，所以错一次记一次。这条输的是
     * **设备凭据**（256 位随机数），猜不动，记失败一个字节的安全都换不来；而它会造出
     * 一个死结：那台电脑被撤销之后手上那枚凭据必然失败，它的界面会反复重试，5 次就把
     * 来源封一分钟——用户在同一台电脑上重新配对时撞上的是"错误次数太多"。这正是
     * `lib/server.js` 的 `noteTokenFailure` 那段写下过的坑，所以这里照它办：
     * **只 `noteSuccess`，不 `noteFailure`**；闸门照旧查（共用同一张表）。
     *
     * ## 回给对面的字段
     *
     * `{ ok, url, expiresIn }`——和本机那条**逐字同形状**（对面那台电脑的宿主两件事
     * 都要做：拿地址、按到期时间决定多久重取一次）。凭据、名册、id 一概不回。
     *
     * ## 这一条**两个端口上各挂一份**（2026-10-17 第七步）
     *
     * 上面这些规矩一条都不变；变的是"它能从哪儿进来"。同一个处理函数既挂在宿主这一半
     * （下面 `webServer.register`），也挂在**手机服务那一半**（`hostHalfRoutes.remoteWindow`
     * → lib/server.js 的 `remoteRoutes`）。理由见 `hostHalfRoutes` 那段：B 只填一条地址，
     * 而那条地址上必须有配对、取票、`/mini/mirror/` 三样。
     */
    const remoteWindowRoute = {
      kind: 'exact',
      path: '/mini-remote/remote/window',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        if (!settings.allowRemoteComputers) {
          sendJson(res, 403, {
            ok: false,
            error: '这台电脑没有允许别的电脑连接。要连的话，先在这台电脑的设置里打开「允许别的电脑连接」。',
          })
          return
        }
        if (!server) {
          sendJson(res, 503, { ok: false, error: '手机服务还在启动，过几秒再试。' })
          return
        }
        if (server.rateLimit.isBlocked(req)) {
          sendJson(res, 429, { ok: false, error: '口令错误次数太多，等一分钟再试。' })
          return
        }
        // 认人（**三种带法都收**）：`?device=` 在地址里，cookie 是浏览器自己带的，
        // 跨机那条主路是 `X-Mini-Device` 请求头（对面那台电脑的宿主进程带着它发过来）。
        const deviceId = server.verifyDevice(req, new URL(req.url ?? '/', 'http://placeholder'))
        if (!deviceId) {
          sendJson(res, 401, { ok: false, error: '没带对凭据。这一枚是配对的时候换来的，撤销之后也没法再用。' })
          return
        }
        // 认下来了：把这一小段试错历史清掉（和手机页进门那一下同一条口径）。
        server.rateLimit.noteSuccess(req)
        if (!mirror.available()) {
          sendJson(res, 503, { ok: false, error: '这台电脑上现在找不到可嵌入的「电脑端界面」，过几秒再试。' })
          return
        }
        const origin = requestOrigin(req)
        if (!origin) {
          sendJson(res, 400, { ok: false, error: '这个请求没有带 Host，说不清该回哪条地址。' })
          return
        }
        // 只记设备 id：不记凭据、不记地址——和 issueDeviceCookie 那条日志同一条规矩。
        console.log(`[dsh-mini-remote] 跨机取票：给名册里那台电脑（${deviceId}）发了一张票`)
        sendJson(res, 200, {
          ok: true,
          // **这一张票记的就是这台设备**（见上面那段）：兑票的浏览器手上没有凭据。
          url: `${origin}/mini/mirror/?ticket=${encodeURIComponent(mirror.issueTicket(deviceId))}`,
          expiresIn: Math.round(mirror.ticketTtlMs / 1000),
        })
      },
    }
    // 手机服务那一半也挂这一份（见 hostHalfRoutes 那段）：B 填的那条地址上，
    // 取票和票指向的 `/mini/mirror/` 必须在同一个源上。
    hostHalfRoutes.remoteWindow = remoteWindowRoute.handler
    const offRemoteWindow = mountRoute(remoteWindowRoute)

    /**
     * 跨机「挑目录 / 登记工作区」（2026-10-19 加）——给**远程窗口**用。
     *
     * ## 为什么需要这一组
     *
     * 远程窗口里嵌的是 A 的官方界面。点「新建工作区」会走官方的 `directoryPicker/pick`，
     * 它的实现是 `dialog.showOpenDialog(...)`——**在 A 的屏幕上弹系统对话框**。
     * 用户坐在 B 前面，看不到也点不到那个框，请求一直挂到超时（实测报 `HTTP 502`）。
     * **转发得再对也没用：那是物理上够不着。**
     *
     * 手机页早就绕过这件事了（见 `lib/browse.js` 开头那段：自己用 `node:fs` 读目录，
     * 不碰官方的 native 选择器）。这里把**同一套能力**开放给 B：
     * B 列 A 的目录 → B 选一个 → **A 登记成工作区**。
     *
     * ## 鉴权
     *
     * 与跨机取票那条**同一条口径**：开关 → 服务在不在 → 限速 → 设备凭据（`X-Mini-Device`）。
     * B 手上只有配对换来的那一枚，不能另造一套。
     */
    function remoteGuard(req, res) {
      if (!settings.allowRemoteComputers) {
        sendJson(res, 403, {
          ok: false,
          error: '这台电脑没有允许别的电脑连接。要连的话，先在这台电脑的设置里打开「允许别的电脑连接」。',
        })
        return false
      }
      if (!server) {
        sendJson(res, 503, { ok: false, error: '手机服务还在启动，过几秒再试。' })
        return false
      }
      if (server.rateLimit.isBlocked(req)) {
        sendJson(res, 429, { ok: false, error: '口令错误次数太多，等一分钟再试。' })
        return false
      }
      const deviceId = server.verifyDevice(req, new URL(req.url ?? '/', 'http://placeholder'))
      if (!deviceId) {
        sendJson(res, 401, {
          ok: false,
          error: '没带对凭据。这一枚是配对的时候换来的，撤销之后也没法再用。',
        })
        return false
      }
      server.rateLimit.noteSuccess(req)
      return true
    }

    /** 常用位置：主目录 / 最近用过 / 磁盘。和手机页那条（`/mini/api/browse/roots`）同一份数据。 */
    async function remoteBrowseRootsHandler(req, res) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '这个地址只接受 GET。' })
        return
      }
      if (!remoteGuard(req, res)) return
      const recent = (nav.listWorkspaces ? await nav.listWorkspaces(new Set(), false) : [])
        .map((w) => w.path)
        .filter(Boolean)
      sendJson(res, 200, { ok: true, ...(await listRoots({ recent })) })
    }

    /** 列一个目录下的子目录。读不出来**如实说**，不当作空目录。 */
    async function remoteBrowseHandler(req, res) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '这个地址只接受 GET。' })
        return
      }
      if (!remoteGuard(req, res)) return
      const asked = new URL(req.url ?? '/', 'http://placeholder').searchParams.get('path')
      if (!asked) {
        sendJson(res, 400, { ok: false, error: '要带 path 参数。' })
        return
      }
      const result = await listDirectory(asked)
      if (!result.ok) {
        const known = {
          'bad-path': [400, '这个路径不合法。'],
          unreadable: [404, '读不到这个目录，可能是不存在或者没有权限。'],
          unavailable: [503, '这台电脑上的 DSH 没提供目录浏览。'],
        }
        const [status, message] = known[result.reason]
          ?? [500, `读目录失败：${result.error ?? '原因未知'}`]
        sendJson(res, status, { ok: false, error: message })
        return
      }
      sendJson(res, 200, result)
    }

    /** 在指定目录下新建一个子文件夹。**`name` 只收单个目录名**，不接受路径。 */
    async function remoteBrowseMkdirHandler(req, res) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
        return
      }
      if (!remoteGuard(req, res)) return
      let body
      try {
        body = await readBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
        return
      }
      const result = await makeDirectory(body?.path, body?.name)
      if (!result.ok) {
        const known = {
          'bad-name': [400, '文件夹名不合法：不能为空、不能带斜杠，也不能是 . 或 ..'],
          'bad-path': [400, '这个路径不合法。'],
          exists: [409, '这个名字已经有一个文件夹了。'],
        }
        const [status, message] = known[result.reason]
          ?? [500, `建文件夹失败：${result.error ?? '原因未知'}`]
        sendJson(res, status, { ok: false, error: message })
        return
      }
      sendJson(res, 200, result)
    }

    /** 把一个目录登记成工作区。 */
    async function remoteWorkspacesHandler(req, res) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
        return
      }
      if (!remoteGuard(req, res)) return
      let body
      try {
        body = await readBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
        return
      }
      const target = typeof body?.path === 'string' ? body.path : ''
      const made = await nav.createWorkspace(target)
      if (!made.ok) {
        const known = {
          'no-registry': [503, '这台电脑上的 DSH 没提供工作区服务。'],
          'bad-path': [400, '没给路径。'],
        }
        const [status, message] = known[made.reason]
          ?? [400, `登记不了这个目录：${made.error ?? '原因未知'}`]
        sendJson(res, status, { ok: false, error: message })
        return
      }
      sendJson(res, 200, { ok: true, created: made.created, workspace: made.workspace })
    }

    // 挂到手机服务那一半（和取票同一条理由：B 填的那一条地址上必须有它们）。
    hostHalfRoutes.browseRoots = remoteBrowseRootsHandler
    hostHalfRoutes.browse = remoteBrowseHandler
    hostHalfRoutes.workspaces = remoteWorkspacesHandler
    hostHalfRoutes.browseMkdir = remoteBrowseMkdirHandler

    /**
     * 「允许别的电脑连接」那个总开关（2026-10-16 跨机第二步）。
     *
     * 和公网开关、改密码、飞书那几条**同一个位置、同一条规矩**（`localOnly`）：
     * 它决定**别的电脑能不能连过来**，是同一张 Wi-Fi 下别人不该替你做主的事。
     *
     * 存进 `settings.allowRemoteComputers`（落 settings.json），**存完就地生效**——
     * 那两条跨机路由读的是同一个值，不必重载插件。返回的是整份配对信息
     * （和公网开关那条一样），界面拿它一次刷新到位。
     *
     * **默认关**：新用户第一次进这一页看到的是关着的。**装好不会自动打开**——
     * 这是刻意留白，那个动作只能由人来点。
     */
    const offRemoteAccess = mountRoute({
      kind: 'exact',
      path: '/mini-remote/remote-access',
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
        settings.allowRemoteComputers = Boolean(want?.enabled)
        persistSettings()
        console.log(`[dsh-mini-remote] 「允许别的电脑连接」现在是${settings.allowRemoteComputers ? '开' : '关'}`)
        try {
          const { status, body } = await pairingPayload()
          sendJson(res, status, body)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: `切换之后读不到状态：${err?.message ?? err}` })
        }
      },
    })

    /** B 端执行总开关。和「允许别的电脑连接」同一个位置、同一条本机限制。 */
    const offAgentAccess = mountRoute({
      kind: 'exact',
      path: '/mini-remote/agent-access',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        let want
        try { want = await readBody(req) } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
          return
        }
        settings.allowAgent = Boolean(want?.enabled)
        try { persistSettings() } catch { /* 和别处一样：写不进去不该把界面打崩 */ }
        if (settings.allowAgent) maybeRegisterBPreset()
        console.log(`[dsh-mini-remote] 「允许 B 端执行」现在是${settings.allowAgent ? '开' : '关'}`)
        const { status, body } = await pairingPayload()
        sendJson(res, status, body)
      },
    })

    /** B 端名单的只读快照，设置页用来定时刷新。 */
    const offAgentList = mountRoute({
      kind: 'exact',
      path: '/mini-remote/agent-list',
      handler: (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 GET。' })
          return
        }
        sendJson(res, 200, { ok: true, agent: agentStatus() })
      },
    })

    /** 生成一次性配对码（只在本机）。 */
    const offAgentCode = mountRoute({
      kind: 'exact',
      path: '/mini-remote/agent-pair-code',
      handler: (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        const out = agentHub.issuePairCode()
        sendJson(res, out.ok ? 200 : 403, out)
      },
    })

    /** 撤销一台已配对的 B 端。 */
    const offAgentRevoke = mountRoute({
      kind: 'exact',
      path: '/mini-remote/agent-revoke',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        let want
        try { want = await readBody(req) } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
          return
        }
        const out = agentHub.revoke(String(want?.id || ''))
        const { status, body } = await pairingPayload()
        sendJson(res, out.ok ? status : 404, out.ok ? body : out)
      },
    })

    /** B 端执行端的现状（只读）。 */
    const offBAgentStatus = mountRoute({
      kind: 'exact',
      path: '/mini-remote/b-agent/status',
      handler: (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 GET。' })
          return
        }
        sendJson(res, 200, { ok: true, bAgent: bAgentStatus() })
      },
    })

    /** B 端配对并开启：拿 A 的地址 + 配对码，换长期凭据，然后立刻启动循环。 */
    const offBAgentPair = mountRoute({
      kind: 'exact',
      path: '/mini-remote/b-agent/pair',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        let want
        try { want = await readBody(req) } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
          return
        }
        const url = String(want?.url || '').trim()
        const code = String(want?.code || '').trim()
        let roots
        try { roots = normalizeRoots(splitRoots(want?.roots)) } catch (err) {
          sendJson(res, 400, { ok: false, error: err && err.message ? err.message : String(err) })
          return
        }
        if (!url || !code) {
          sendJson(res, 400, { ok: false, error: '要填 A 的地址和配对码。' })
          return
        }
        try {
          const allowWrite = want?.allowWrite === true
          const allowShell = want?.allowShell === true
          const allowManage = want?.allowManage === true
          const paired = await pairAgent({
            url, code, name: 'B 端电脑', platform: process.platform,
            roots, allowWrite, allowShell, allowManage,
          })
          settings.agentUrl = paired.url
          settings.agentToken = paired.token
          settings.agentRoots = roots.join('\n')
          settings.agentAllowWrite = allowWrite
          settings.agentAllowShell = allowShell
          settings.agentAllowManage = allowManage
          settings.agentMode = true
          persistSettings()
          startBAgent()
          sendJson(res, 200, { ok: true, bAgent: bAgentStatus() })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err && err.message ? err.message : String(err) })
        }
      },
    })

    /** B 端执行端的开关：开就启动循环，关就停掉。 */
    const offBAgentMode = mountRoute({
      kind: 'exact',
      path: '/mini-remote/b-agent/mode',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        let want
        try { want = await readBody(req) } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
          return
        }
        settings.agentMode = Boolean(want?.enabled)
        persistSettings()
        if (settings.agentMode) startBAgent(); else stopBAgent()
        sendJson(res, 200, { ok: true, bAgent: bAgentStatus() })
      },
    })

    /** B 端执行端的能力开关（目前只有写文件；命令以后单独一条）。 */
    const offBAgentOptions = mountRoute({
      kind: 'exact',
      path: '/mini-remote/b-agent/options',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        let want
        try { want = await readBody(req) } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
          return
        }
        if (Object.prototype.hasOwnProperty.call(want || {}, 'allowWrite')) {
          settings.agentAllowWrite = want.allowWrite === true
        }
        if (Object.prototype.hasOwnProperty.call(want || {}, 'allowShell')) {
          settings.agentAllowShell = want.allowShell === true
        }
        if (Object.prototype.hasOwnProperty.call(want || {}, 'allowManage')) {
          settings.agentAllowManage = want.allowManage === true
        }
        persistSettings()
        if (settings.agentMode) startBAgent()
        sendJson(res, 200, { ok: true, bAgent: bAgentStatus() })
      },
    })

    /** B 项目：列出 / 新建 / 移除（只动 A 的门牌，不动 B 的真实文件）。 */
    const offBProjects = mountRoute({
      kind: 'exact',
      path: '/mini-remote/b-projects',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method === 'GET') {
          sendJson(res, 200, { ok: true, projects: bProjectsView() })
          return
        }
        if (req.method === 'DELETE') {
          let want
          try { want = await readBody(req) } catch (err) {
            sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
            return
          }
          try {
            const out = await removeBProject(String(want?.id || ''))
            sendJson(res, 200, { ok: true, ...out, projects: bProjectsView() })
          } catch (err) {
            sendJson(res, 400, { ok: false, error: err && err.message ? err.message : String(err) })
          }
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 GET、POST 或 DELETE。' })
          return
        }
        let want
        try { want = await readBody(req) } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
          return
        }
        try {
          const out = await createBProject({ name: want?.name, bRoot: want?.bRoot })
          sendJson(res, 200, { ok: true, ...out, projects: bProjectsView() })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err && err.message ? err.message : String(err) })
        }
      },
    })

    /** 新建 B 项目时挑 B 上的文件夹：列 B 的授权根 / 子目录，或在当前目录建新文件夹。 */
    const offBBrowse = mountRoute({
      kind: 'exact',
      path: '/mini-remote/b-browse',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        const agent = onlineBAgent()
        if (!agent) {
          sendJson(res, 400, { ok: false, error: 'B 端还没有连上' })
          return
        }
        if (req.method === 'POST') {
          let want
          try { want = await readBody(req) } catch (err) {
            sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
            return
          }
          const path = String(want?.path || '').trim()
          if (!path) {
            sendJson(res, 400, { ok: false, error: '要填新建文件夹的完整路径' })
            return
          }
          try {
            const out = await agentHub.call('mkdir', { path }, { agentId: agent.id })
            sendJson(res, 200, { ok: true, result: out })
          } catch (err) {
            sendJson(res, 400, { ok: false, error: err && err.message ? err.message : String(err) })
          }
          return
        }
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 GET 或 POST。' })
          return
        }
        const url = new URL(req.url || '/', 'http://localhost')
        const path = String(url.searchParams.get('path') || '').trim()
        try {
          if (!path) {
            sendJson(res, 200, { ok: true, path: '', roots: agent.roots || [], entries: [] })
            return
          }
          const listing = await agentHub.call('list', { path }, { agentId: agent.id })
          sendJson(res, 200, { ok: true, ...listing, roots: agent.roots || [] })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err && err.message ? err.message : String(err) })
        }
      },
    })

    /** B 项目的文件面板：列目录 / 读文本。路径必须落在项目根内。 */
    const offBProjectFiles = mountRoute({
      kind: 'exact',
      path: '/mini-remote/b-project',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 GET。' })
          return
        }
        const url = new URL(req.url || '/', 'http://localhost')
        const action = String(url.searchParams.get('action') || 'list')
        const id = String(url.searchParams.get('id') || '')
        const target = String(url.searchParams.get('path') || '')
        try {
          if (action === 'read') {
            const file = await bProjectRead(id, target)
            sendJson(res, 200, { ok: true, file })
          } else {
            const listing = await bProjectList(id, target)
            sendJson(res, 200, { ok: true, listing })
          }
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err && err.message ? err.message : String(err) })
        }
      },
    })

    /**
     * 「设备名册」那三条：**列出 / 改名 / 撤销**（2026-10-16 第三步）。
     *
     * ## 为什么在这里、为什么只允许本机
     *
     * 和配对信息、改密码、开关公网同一个位置、同一条规矩（`localOnly`）：这几条决定
     * **谁进得来**，是同一张 Wi-Fi 下别人不该替你做主的事。
     *
     * ## 为什么三条都只跟 `devices` 说话
     *
     * `devices`（见 lib/devices.js）是这份名册**唯一**的读写口。设置页那半边不做第二份
     * 判断、更不自己去读写那个 JSON：内存一份、磁盘一份，两处各写各的迟早对不上，
     * 而对不上的表现是「界面上删了，那台手机还能进」——最难查、也最要命的那种。
     *
     * 返回里**永远没有 keyHash、也没有凭据本身**：list / rename 回的都是
     * `devices.js` 的 publicRecord（id、名字、类型、创建时间、最近使用）。
     */
    const offDevices = mountRoute({
      kind: 'exact',
      path: '/mini-remote/devices',
      handler: (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 GET。' })
          return
        }
        sendJson(res, 200, { ok: true, devices: devices.list() })
      },
    })

    /**
     * 改一台设备的名字。
     *
     * **名字只是标签**（见 lib/devices.js 开头）：改了它，那台设备照旧进得来、照旧
     * 什么都做得了。所以这一条不掐连接、不碰凭据，只动那一个字符串。
     *
     * 名字的合法性由 devices.rename 判（空名字、超长），错误原样带回去——两处各写一份
     * 校验，迟早一处改了一处没改，而表现是「界面放行、服务端拒绝」。
     */
    const offDeviceRename = mountRoute({
      kind: 'exact',
      path: '/mini-remote/devices/rename',
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
        const done = devices.rename(want?.id, want?.name)
        if (!done.ok) {
          sendJson(res, 400, { ok: false, error: done.error })
          return
        }
        sendJson(res, 200, { ok: true, device: done.device })
      },
    })

    /**
     * 撤销一台设备：**删掉记录 + 掐掉它手上的活连接**。
     *
     * ## 顺序不能反（先删记录，再掐线）
     *
     * 反过来的话，那条流断开时客户端会立刻重连一次——而记录还在，它重连就成功了。
     * 用户看到的就是「撤销了，但那台手机照旧在动」。先删记录：重连撞上 401，
     * 于是按设计回到门禁页。
     *
     * ## 为什么要掐（这一步的核心）
     *
     * 手机那边是**服务端单向推**的。只让"下一次请求被拒"，那条已经挂着的 SSE 照样
     * 收得到新消息——用户会以为撤销没生效。掐断是这件事**看得见**的那一半，
     * 具体在 lib/server.js 的 dropDeviceConnections 里（SSE + 镜像那个框的 WebSocket，
     * **「远程窗口」那扇窗的常驻连接也算它的**——会话里签着设备身份，见 server.js 的升级处理器）。
     *
     * ⚠️ **那扇开着的窗不会"当场断开"**：窗口里的请求是浏览器自动带 cookie 发的短请求，
     * 不是长连接。撤销之后它**下一次请求**才 401（静态资源、`/api/*`、下一次点击/轮询），
     * 随后页面自己回门禁页。**给用户的话就照这个说**，别承诺"立刻变"。
     *
     * 撤销**不需要二次确认**吗？需要，但那一步在**界面那一侧**（用户拍板的：撤销要
     * 二次确认，确认框里说清"这台设备要重新扫码才能再用"）。服务端这条只管执行——
     * 它只对本机的软件开口，而本机的软件本来就有这台电脑的全部权限，谈不上绕过。
     */
    const offDeviceRevoke = mountRoute({
      kind: 'exact',
      path: '/mini-remote/devices/revoke',
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
        const id = typeof want?.id === 'string' ? want.id : ''
        if (!id) {
          sendJson(res, 400, { ok: false, error: '要撤销哪一台？请求里没有 id。' })
          return
        }
        const removed = devices.remove(id)
        if (!removed) {
          // 另一台电脑/另一个标签页刚撤过：如实说"它已经不在名册里了"，别假装成功。
          sendJson(res, 404, { ok: false, error: '这台设备已经不在名册里了，刷新看看。' })
          return
        }
        // 服务还没起来时它手上不可能有活连接（那条流是它自己起的），所以这里可以缺。
        const dropped = server?.dropDeviceConnections?.(id) ?? 0
        console.log(`[dsh-mini-remote] 撤销了一台设备（${id}），掐掉 ${dropped} 条活连接`)
        sendJson(res, 200, { ok: true, id, dropped })
      },
    })

    /**
     * 「配对」：**另一台电脑拿这台电脑的口令，给自己换一枚设备凭据**（2026-10-16，跨机第一步）。
     *
     * ## 为什么它**不走 `localOnly`**（2026-10-16 第二步起，这样的有两条）
     *
     * 别的 `/mini-remote/*` 都只允许本机调用，因为它们是"本机的软件替你做主"。这一条
     * 正相反：**要配对的那台电脑在"外面"**——它不在本机回环上，而且调用的这一刻它手里
     * 还没有任何凭据（凭据正是它来这儿要的东西）。所以这里**不调用 `localOnly`**。
     * 另一条是「跨机取票」（`/mini-remote/remote/window`），同一条理由：来换票的人在
     * 另一台电脑上，手上那枚凭据是这一条刚换给它的。
     *
     * 少掉的那道门用三样补上，缺一不可：
     *   · **开关**（`settings.allowRemoteComputers`，默认关）：关着时这一条一条都不接
     *     ——"关"是"这台电脑不接受别的电脑连过来"这个整体状态；
     *   · **口令**（`tokenEquals`，定长比较，和手机页同一枚、同一个判据）；
     *   · **试错限速**（`server.rateLimit`，和手机服务**共用同一张表**，见 lib/server.js）。
     *     这条是外面能调的，限速不是可选项。**不另写一套**：现成那一套就是为猜口令准备的，
     *     两套各数各的，等于给猜的人两份额度。
     *
     * ## 口令**不是一次性的**
     *
     * 配对成功之后它照旧有效：口令是"这台电脑的入场邀请函"，本来就允许多次使用
     * ——手机页那一路每次带 `?token=` 进来都会发一枚新凭据，用的还是同一枚口令。
     * 所以一台 A 可以配多台电脑，配完照样能继续用手机。**一次性的东西是"票"**
     * （`/mini-remote/window` 那张，30 秒、用完即废），不是口令。要收回哪一台，
     * 走名册那一行撤销（`/mini-remote/devices/revoke`）。
     *
     * ## 回给调用方的**只有凭据**
     *
     * `{ ok: true, credential }`：名字、创建时间、名册、keyHash 一概不回——对面要的就是
     * 这一枚，多一个字段就多一处泄漏面。`id` 本来就在凭据里（`<id>.<密钥>`），不用另给一份。
     *
     * ## 口令只从请求体里收（**不接受 `?token=`**）
     *
     * 口令进了地址，就会被写进对面、以及中间任何一台代理的日志和历史里。别的路由把
     * 地址里带参数当成方便，这一条不行：它是跨机的，路上不止一台机器。
     *
     * ## 这一条也是**两个端口上各挂一份**（2026-10-17 第七步）
     *
     * 和「跨机取票」同一条理由（见 `hostHalfRoutes` 那段）：B 填的那一条地址必须同时
     * 容得下配对和 `/mini/mirror/`，而那两样本来分在两个端口上。规矩一个字没改，
     * 只是同一个处理函数多了一个挂载点。
     */
    const pairRoute = {
      kind: 'exact',
      path: '/mini-remote/pair',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        // 「允许别的电脑连接」关着：**配对也不接**（用户拍板的：关 = 这台电脑不接受
        // 别的电脑连过来，是一个整体状态，不是"少录一项配置"）。这一闸放在最前面，
        // 排在限速和口令之前——关着的时候连"猜口令"这件事都不该发生。
        if (!settings.allowRemoteComputers) {
          sendJson(res, 403, {
            ok: false,
            error: '这台电脑没有允许别的电脑连接。要连的话，先在这台电脑的设置里打开「允许别的电脑连接」。',
          })
          return
        }
        if (!server) {
          // 限速那一套长在手机服务里（同一张表）。服务没起来时配对也没有意义——
          // 换回去的凭据进不了门，所以如实说"还在启动"，别让对面以为配好了。
          sendJson(res, 503, { ok: false, error: '手机服务还在启动，过几秒再试。' })
          return
        }
        // **不写 `?.`**：限速这一套就在上面那个服务实例里（同一个模块给的），拿不到就等于
        // 这道门没闸——那种情况下宁可当场报错（关着），也不要静悄悄放它过去（开着）。
        if (server.rateLimit.isBlocked(req)) {
          sendJson(res, 429, { ok: false, error: '口令错误次数太多，等一分钟再试。' })
          return
        }
        let want
        try {
          want = await readBody(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
          return
        }
        const given = typeof want?.token === 'string' ? want.token : ''
        if (!tokenEquals(given, token)) {
          // 记一次试错。**只有外面能调的这条路**才需要在这里数：猜口令的次数就是在
          // 这一行数出来的（同来源错 5 次封一分钟，下次请求进门就被上面那道 429 挡住）。
          server.rateLimit.noteFailure(req)
          sendJson(res, 401, { ok: false, error: '口令不对。' })
          return
        }
        // 口令对了：把这一小段历史清掉（和手机页进门那一下同一条口径）。
        server.rateLimit.noteSuccess(req)
        // 名字留空 = register 的默认名，用户可以之后在设置页改名。**不从请求体里收名字**：
        // 这一条的输入只有口令一样（见上面"只给凭据"那一段的同一条理由）。
        const issued = devices.register({ kind: 'desktop' })
        // 只记 id、不记口令、不记凭据：和 issueDeviceCookie 那条日志同一条规矩。
        console.log(`[dsh-mini-remote] 配对成功，登记了一台电脑（${issued.id}）`)
        sendJson(res, 200, { ok: true, credential: issued.credential })
      },
    }
    // 手机服务那一半也挂这一份（见 hostHalfRoutes 那段）。
    hostHalfRoutes.pair = pairRoute.handler
    const offPair = mountRoute(pairRoute)

    /**
     * 「我能连的电脑」那四条（**B 侧**，2026-10-16 跨机第三步）。
     *
     * ## 它管的是哪一件事
     *
     * 前两步都在 A 侧（A 面对"别的电脑来连我"：配对、跨机取票、那个总开关）。
     * 这一族在 **B 侧**：B 自己记着"我连得上哪几台电脑"（lib/remotes.js 的
     * `remotes.json`），并且**替自己的界面**去那台电脑换票。
     *
     * ## 为什么四条都只允许本机（`localOnly`）
     *
     * 这一族是"**这台电脑的软件替你做主**"：添加（要输对面的口令）、列出、取票、断开，
     * 全都发生在 B 自己的设置页上——同一个 Wi-Fi 下，别人不该替 B 决定"我要连谁"。
     * 和 `/mini-remote/pair`、`/mini-remote/remote/window` 那两条恰好相反：那两条长在 A 上、
     * 服务的是**外面**那台电脑，所以它们不调 localOnly。
     *
     * ## 凭据一步都不进浏览器
     *
     * 界面能拿到的只有 `lib/remotes.js` 的 `publicRecord`（id、名字、地址、两个时间）。
     * 凭据只在**这一半**（宿主进程）手里：去 A 取票时放进 `X-Mini-Device` **请求头**，
     * 既不进地址（那会留在浏览历史、中间代理和对面日志里），也不进任何一条回给界面的
     * JSON。取票回来的 `{url}` 里只有一张 30 秒、一次性的票——**票不是凭据**。
     *
     * ## 「重连」没有第五条路由
     *
     * 用户拍板的：**重连 = 重新取一次票**。界面点「重连」就是再调一次
     * `/mini-remote/remotes/window`——票本来就是一次性的、30 秒就过期，界面按回来的
     * `expiresIn` 自己决定多久重取一次。再加一条"重连"路由，只会多一份做着同一件事的代码。
     *
     * ## 「断开」只动 B 本地（用户拍板的那一条）
     *
     * **B 不管理它连的那台 A**，所以这里不替用户去 A 撤销——断开 = 从 B 的名册里删掉那条
     * 记录（`remotes.forget`）。用户看到的文案在 `REMOTE_FORGOTTEN_NOTE`：说清"A 那边
     * 还留着这条记录，要彻底收回得去 A 的设置页撤销"。
     */

    /**
     * 对面已经撤销了 B 这枚凭据时说的话。
     *
     * 为什么不照抄 A 那句（"没带对凭据。这一枚是配对的时候换来的，撤销之后也没法再用。"）：
     * 那句是在**交代自己的规则**，没有告诉用户**接下来怎么办**。而在 B 这边，用户手上
     * 真正能做的只有一件事：拿 A 的口令重新添加一台。
     */
    const REMOTE_REVOKED_HINT = '那台电脑已经不认这枚凭据了——多半是它那边把这条记录撤销了。\n'
      + '要重新连，得拿那台电脑的口令在这儿重新添加一次。'

    /**
     * 断开之后给用户看的那句话。
     *
     * **必须说清"A 那边还留着"**：断开的语义是"B 不再管它了"，不是"收回那台电脑的权限"。
     * 用户以为自己收回了、其实 A 名册里那一条还在，是这一步最容易留下的误会。
     */
    const REMOTE_FORGOTTEN_NOTE = '已经从这台电脑的列表里移除了，本地存的那枚凭据也一起删了。\n'
      + '那台电脑上还留着「这台电脑」那条记录——要彻底收回，得去它的「手机遥控」设置页里撤销那一台。'

    /**
     * 对面回了错、又没说原因时，照状态码说一句人话。
     *
     * 正常情况下 A 会把原因写在 `error` 里（照抄即可）。这条兜底是给"路上不是 A"准备的：
     * 地址指到了别的服务（一页 HTML 的 404）、中间挡了一层代理，都可能一个字段都不给。
     */
    function remoteStatusText(status) {
      if (status === 404) return '那台电脑上没有这个接口（404）：多半是它的 DSH 还没更新到这一步，或者地址、端口写错了。'
      if (status === 403) return '那台电脑现在不接受别的电脑连接。要连的话，先在它的「手机遥控」设置里打开「允许别的电脑连接」。'
      return `那台电脑没通过这一下（HTTP ${status}），它也没说原因。`
    }

    /**
     * 替 B 去 A 打一次接口。返回 `{ ok, status, body?, error? }`。
     *
     * **两件事分开说**：网络层失败（连不上、超时）和对面回了个错（401/403/503）是两种
     * 人话——前者要用户去看地址和网络，后者对面已经写好了原因，照抄就行（加一句"那台电脑说："
     * 让用户知道这话是谁说的）。
     *
     * 超时用 `AbortSignal.timeout`（和隧道那条探针同一个写法）。
     *
     * **这个方法只发两样东西**：请求体里的口令（`pair` 那一下）和请求头里的凭据
     * （取票那一下）。凭据一个字节都不进地址——那是这一族最硬的一条规矩。
     */
    /**
     * 调对面那台电脑的一条接口。
     *
     * `method` 默认 POST（现有调用全是 POST）；**GET 不能带 body**，所以带 GET 时
     * 请求体整个不发——`/mini-remote/remote/browse?path=` 那条就是 GET（2026-10-19 加）。
     */
    async function callRemote(baseUrl, path, { body, headers, method = 'POST' } = {}) {
      let res
      try {
        res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
          signal: AbortSignal.timeout(REMOTE_CALL_TIMEOUT_MS),
        })
      } catch (err) {
        const code = err?.cause?.code ?? err?.code ?? ''
        const text = `连不上那台电脑（${baseUrl}）：${code || err?.message || err}。`
        // **这条路以前完全不留痕**（2026-10-17 补）：错误只回给界面，用户一退出面板就再也
        // 查不到上一次报的是什么。跨机碰的是"另一边的东西"，出错时最需要的就是"上一次到底
        // 报了什么"——地址写错、对面没开、还是网络不通，全靠这一句分。
        //
        // 只记网络层失败（连不上 / 超时）。对面回 401/403 那类**不记**：那是业务拒绝，
        // 界面已经把人话和下一步说清楚了，记下来只会把真正的故障挤出这 20 条。
        report('remote', text)
        return {
          ok: false,
          status: 0,
          error: text + '\n先确认它在开着、地址和端口没写错、而且和这台电脑在同一个网络里。',
        }
      }
      let payload = null
      try {
        payload = await res.json()
      } catch {
        // 对面回的不是 JSON：下面按状态码说人话，别把一页 HTML 丢给用户。
      }
      if (res.ok && payload?.ok) return { ok: true, status: res.status, body: payload }
      const said = typeof payload?.error === 'string' && payload.error ? payload.error : ''
      return { ok: false, status: res.status, error: said ? `那台电脑说：${said}` : remoteStatusText(res.status) }
    }

    /**
     * ① 列出「我能连的电脑」。
     *
     * **永远不含凭据**（`remotes.list()` 走的一定是 publicRecord）。这一条是界面那张
     * 列表的唯一数据来源；名字改了、时间更新了，界面刷一下就知道。
     */
    const offRemotesList = mountRoute({
      kind: 'exact',
      path: '/mini-remote/remotes',
      handler: (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 GET。' })
          return
        }
        sendJson(res, 200, { ok: true, remotes: remotes.list() })
      },
    })

    /**
     * ② 添加一台电脑：**拿它的口令，换一枚自己的凭据存下来**。
     *
     * 收 `{ name?, baseUrl, token }`。口令走**请求体**去 A 的 `/mini-remote/pair`
     * （A 那条路由只从请求体收口令，理由见它上面那一段：进了地址就会被写进对面和中间
     * 任何一台代理的日志里）。名字只是 B 这边的标签，可以不给——不给就取地址里的 host。
     *
     * ## 失败一律不落盘
     *
     * 口令错、对面开关关着、地址不通、对面回的凭据不像话——**一条记录都不许留下**。
     * 名册里出现一条"其实连不上"的记录，用户下次点它只会得到一个查不出原因的失败。
     * 所以顺序是：**先换凭据、成功了才 `remotes.add`**（`add` 自己不落盘失败）。
     *
     * ## 回给界面的是 publicRecord（**没有凭据**）
     */
    const offRemotesAdd = mountRoute({
      kind: 'exact',
      path: '/mini-remote/remotes/add',
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
        const baseUrl = normalizeBaseUrl(want?.baseUrl)
        if (!baseUrl) {
          sendJson(res, 400, {
            ok: false,
            // 不举 `IP:端口` 的例子：这一步只管逻辑，"那条地址到底长什么样"取决于
            // 两台电脑怎么连上（内网 / Tailscale / 隧道）——那是后面的「网络形态」那一步。
            // 举一个具体的端口只会把人带到错误的方向上。
            error: '要填那台电脑的地址，写成 http:// 或 https:// 开头的一整条'
              + '（就是那台电脑的「手机遥控」地址：http:// 地址:3090，或者 https:// 的 Tailscale 地址；'
              + '不要带 /mini 和它后面的参数）。',
          })
          return
        }
        const given = typeof want?.token === 'string' ? want.token.trim() : ''
        if (!given) {
          sendJson(res, 400, { ok: false, error: '要填那台电脑的口令（在它的「手机遥控」设置里能复制到）。' })
          return
        }
        const answer = await callRemote(baseUrl, '/mini-remote/pair', { body: { token: given } })
        if (!answer.ok) {
          // **一个字都不落盘**：这一次没换成凭据，就地结束。
          // 状态用 502：出错的是"网关那一头"（对面），不是本机这次调用不合规矩。
          sendJson(res, 502, { ok: false, error: answer.error })
          return
        }
        const added = remotes.add({
          name: want?.name,
          baseUrl,
          credential: typeof answer.body?.credential === 'string' ? answer.body.credential : '',
        })
        if (!added.ok) {
          // 走到这儿只剩一种可能：对面回了个 `ok:true`，里面那枚凭据却不像话
          //（地址和口令在上面都验过了）。
          sendJson(res, 502, { ok: false, error: added.error })
          return
        }
        // 只记 id 和地址：**不记口令、不记凭据**（和 devices 那几条日志同一条规矩）。
        console.log(`[dsh-mini-remote] 添加了一台电脑（${added.remote.id}），地址 ${baseUrl}`)
        sendJson(res, 200, { ok: true, remote: added.remote })
      },
    })

    /**
     * ③ 取票：**拿自己存的那枚凭据，去那台电脑换一张带票的地址**。
     *
     * 这是这一族唯一会用到凭据的地方，也是"凭据只活在宿主进程里"这句话的落点：
     * 凭据从 `remotes.secret(id)` 出来、直接进 `X-Mini-Device` 请求头，**从头到尾
     * 不经过界面**。界面拿到的是 A 回的那条 `{url}`（里面只有一张 30 秒、一次性的票）。
     *
     * 成功之后记一次 `lastOk`（列表上"最近成功连接"那句话就是它）。
     *
     * **重连没有单独一条路由**：再调一次这一条就是重连。
     */
    const offRemotesWindow = mountRoute({
      kind: 'exact',
      path: '/mini-remote/remotes/window',
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
        const id = typeof want?.id === 'string' ? want.id : ''
        if (!id) {
          sendJson(res, 400, { ok: false, error: '要连哪一台？请求里没有 id。' })
          return
        }
        const secret = remotes.secret(id)
        if (!secret) {
          // 另一个标签页刚断开过它——如实说，别假装还在。
          sendJson(res, 404, { ok: false, error: '这台电脑已经不在列表里了，刷新看看。' })
          return
        }
        // ⚠️ 凭据**只走请求头**：进了地址就会留在浏览历史、中间代理和对面日志里。
        const answer = await callRemote(secret.baseUrl, '/mini-remote/remote/window', {
          headers: { 'x-mini-device': secret.credential },
        })
        if (!answer.ok) {
          // 401 单独说：那多半是"对面把这条记录撤销了"，而用户能做的只有重新配对一次。
          sendJson(res, 502, { ok: false, error: answer.status === 401 ? REMOTE_REVOKED_HINT : answer.error })
          return
        }
        const url = typeof answer.body?.url === 'string' ? answer.body.url : ''
        if (!url) {
          sendJson(res, 502, { ok: false, error: '那台电脑回了话，但里面没有地址。过几秒再试一次。' })
          return
        }
        remotes.markOk(id)
        // 只记 id：**不记凭据、不记那条地址**（里面那张票够开一扇窗）。
        console.log(`[dsh-mini-remote] 从「我能连的电脑」里换了一张票（${id}）`)
        sendJson(res, 200, { ok: true, url, expiresIn: Number(answer.body?.expiresIn) || 0 })
      },
    })

    /**
     * ④ 断开：**只从 B 本地删掉这条记录**（见上面「断开」那一段）。
     *
     * 不碰 A、不给 A 发任何请求——**B 不管理它连的那台 A**。回给界面的 `note` 是要
     * 原样显示给用户的那句话：说清"A 那边还留着这条记录，要彻底收回得去 A 撤销"。
     */
    /**
     * 远程窗口里「挑目录 / 登记工作区」（2026-10-19 加）——**B 这一半**。
     *
     * ## 为什么必须由宿主转一手
     *
     * B 的面板跑在 `dsh-app://app/` 里，而 A 那边的接口**没有发 CORS 头**；跨站直连会被
     * 浏览器拦掉。所以面板调这里、这里带着 A 的设备凭据去调 A。
     *
     * ## 为什么要有这一组（A 侧那段有完整来龙去脉）
     *
     * 远程窗口嵌的是 A 的官方界面，它那个「新建工作区」走官方 `directoryPicker/pick`——
     * **在 A 的屏幕上弹系统对话框**，用户在 B 前面点不到（实测报 HTTP 502）。
     * 这三条让 B 能列 A 的目录、让 A 登记工作区，绕开那个够不着的对话框。
     */
    const offRemotesBrowseRoots = mountRoute({
      kind: 'exact',
      path: '/mini-remote/remotes/browse/roots',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 GET。' })
          return
        }
        const id = new URL(req.url ?? '/', 'http://placeholder').searchParams.get('id') ?? ''
        const secret = id ? remotes.secret(id) : null
        if (!secret) {
          sendJson(res, 404, { ok: false, error: '这台电脑已经不在列表里了，刷新看看。' })
          return
        }
        const answer = await callRemote(secret.baseUrl, '/mini-remote/remote/browse/roots', {
          method: 'GET',
          headers: { 'x-mini-device': secret.credential },
        })
        if (!answer.ok) {
          sendJson(res, 502, {
            ok: false,
            error: answer.status === 401 ? REMOTE_REVOKED_HINT : answer.error,
          })
          return
        }
        sendJson(res, 200, answer.body ?? { ok: false, error: '对面没有回数据。' })
      },
    })

    const offRemotesBrowse = mountRoute({
      kind: 'exact',
      path: '/mini-remote/remotes/browse',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 GET。' })
          return
        }
        const q = new URL(req.url ?? '/', 'http://placeholder').searchParams
        const id = q.get('id') ?? ''
        const at = q.get('path') ?? ''
        if (!at) {
          sendJson(res, 400, { ok: false, error: '要带 path 参数。' })
          return
        }
        const secret = id ? remotes.secret(id) : null
        if (!secret) {
          sendJson(res, 404, { ok: false, error: '这台电脑已经不在列表里了，刷新看看。' })
          return
        }
        const answer = await callRemote(
          secret.baseUrl,
          `/mini-remote/remote/browse?path=${encodeURIComponent(at)}`,
          { method: 'GET', headers: { 'x-mini-device': secret.credential } },
        )
        if (!answer.ok) {
          sendJson(res, 502, {
            ok: false,
            error: answer.status === 401 ? REMOTE_REVOKED_HINT : answer.error,
          })
          return
        }
        sendJson(res, 200, answer.body ?? { ok: false, error: '对面没有回数据。' })
      },
    })

    const offRemotesBrowseMkdir = mountRoute({
      kind: 'exact',
      path: '/mini-remote/remotes/browse/mkdir',
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
        const id = typeof want?.id === 'string' ? want.id : ''
        const secret = id ? remotes.secret(id) : null
        if (!secret) {
          sendJson(res, 404, { ok: false, error: '这台电脑已经不在列表里了，刷新看看。' })
          return
        }
        const answer = await callRemote(secret.baseUrl, '/mini-remote/remote/browse/mkdir', {
          body: { path: want?.path, name: want?.name },
          headers: { 'x-mini-device': secret.credential },
        })
        if (!answer.ok) {
          sendJson(res, 502, {
            ok: false,
            error: answer.status === 401 ? REMOTE_REVOKED_HINT : answer.error,
          })
          return
        }
        sendJson(res, 200, answer.body ?? { ok: false, error: '对面没有回数据。' })
      },
    })

    const offRemotesWorkspaces = mountRoute({
      kind: 'exact',
      path: '/mini-remote/remotes/workspaces',
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
        const id = typeof want?.id === 'string' ? want.id : ''
        const at = typeof want?.path === 'string' ? want.path : ''
        const secret = id ? remotes.secret(id) : null
        if (!secret) {
          sendJson(res, 404, { ok: false, error: '这台电脑已经不在列表里了，刷新看看。' })
          return
        }
        const answer = await callRemote(secret.baseUrl, '/mini-remote/remote/workspaces', {
          body: { path: at },
          headers: { 'x-mini-device': secret.credential },
        })
        if (!answer.ok) {
          sendJson(res, 502, {
            ok: false,
            error: answer.status === 401 ? REMOTE_REVOKED_HINT : answer.error,
          })
          return
        }
        sendJson(res, 200, answer.body ?? { ok: false, error: '对面没有回数据。' })
      },
    })

    const offRemotesForget = mountRoute({
      kind: 'exact',
      path: '/mini-remote/remotes/forget',
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
        const id = typeof want?.id === 'string' ? want.id : ''
        if (!id) {
          sendJson(res, 400, { ok: false, error: '要断开哪一台？请求里没有 id。' })
          return
        }
        if (!remotes.forget(id)) {
          // 另一个标签页刚断开过：如实说"它已经不在列表里了"，别假装成功。
          sendJson(res, 404, { ok: false, error: '这台电脑已经不在列表里了，刷新看看。' })
          return
        }
        // 只记 id、只说明"本地删了"：**不写"已撤销"**——我们没去 A 那边撤销。
        console.log(`[dsh-mini-remote] 断开了一台电脑（${id}）：只删了本地这一条`)
        sendJson(res, 200, { ok: true, id, note: REMOTE_FORGOTTEN_NOTE })
      },
    })

    /**
     * 「自检」：**这台电脑到底在跑什么**（2026-10-17）。
     *
     * ## 为什么要有它（两个真真的教训）
     *
     * 那天排一台真机上的故障花掉很久，根因有两条，而两条都是**"看不见那台机器在跑什么"
     * 造成的**：A 那台的桌面端连开了二十四小时，加载的是"新功能写下来之前"的旧代码；
     * B 那台装的插件是旧版本，新接口根本没出现。当时只能靠用户来回反馈、一个个地址去敲、
     * 靠猜——而这两条各自用一句话就能定位（进程比代码旧 / 接口清单里少一条）。
     *
     * 所以它回答的就是那几个问题：这份插件是哪一版、宿主进程什么时候起的、我们注册了
     * 哪些 `/mini-remote/*`、跨机那个总开关开没开、手机服务在听哪个端口绑了哪些地址、
     * 数据目录在哪、两份名册各有多少条。
     *
     * ## 只给本机看（和别的 `/mini-remote/*` 同一条规矩）
     *
     * 它摆的是这台电脑的底细（路径、端口、名册条数、进程何时起的）。**不调 `localOnly`
     * 的两条是例外**（`pair` / `remote/window`），理由写在它们那儿——这一条没有那个理由。
     *
     * ## 一个字节的凭据都不许进这个返回值
     *
     * 自检是**给人看**的，不是给机器用的：口令、设备密钥哈希、`remotes.json` 里那枚
     * 长期凭据、飞书的 appSecret，一个都不出现。所以下面**只数条数、不摆记录**
     * （`devices.list()` / `remotes.list()` 回来的记录里带着 id、名字、时间——那些也不必要）。
     *
     * ## 拿不到就说「未知」，它自己不能成为新的故障点
     *
     * 手机服务还没起来（`server` 为 null）、`package.json` 读不到、名册读不出来——
     * 每一种都对应一个 `null`/空列表，**不抛错**。一条诊断路由要是在被诊断的东西坏掉时
     * 跟着坏掉，那它就白写了。
     */
    function selfcheckPayload() {
      const startedAtMs = Date.now() - Math.round(process.uptime() * 1000)
      const newest = newestSource()
      const verdict = staleCodeVerdict(startedAtMs, newest)
      // 只数条数。这两份名册一个是"谁连得上我"、一个是"我连得上谁"，
      // 内容一个字段都不往这儿搬（见上面那段）。
      const countOf = (fn) => {
        try {
          const rows = fn()
          return Array.isArray(rows) ? rows.length : null
        } catch {
          return null
        }
      }
      return {
        ok: true,
        /** `package.json` 里的 version；读不到是 null。 */
        version: pluginVersion(),
        process: {
          pid: process.pid,
          startedAtMs,
          /** ISO 时刻，给 curl 的人看；界面自己按本地时区格式化那个毫秒值。 */
          startedAt: new Date(startedAtMs).toISOString(),
          uptimeSec: Math.round(process.uptime()),
        },
        /**
         * 「进程比代码旧」那一条（见 `staleCodeVerdict`）。
         * `stale` 三态：`true` 旧了 / `false` 不是 / `null` 拿不到、不知道。
         */
        code: {
          file: verdict.file,
          modifiedAtMs: Number.isFinite(newest?.at) ? newest.at : null,
          stale: verdict.stale,
          message: verdict.message,
        },
        /** 我们注册过的 `/mini-remote/*`：`mounted` 说的是"现在仍挂着"。 */
        routes: [...routeBook.entries()].map(([path, one]) => ({
          path,
          kind: one.kind,
          mounted: one.mounted,
        })),
        /** 「允许别的电脑连接」那个总开关（默认关）。 */
        allowRemoteComputers: Boolean(settings.allowRemoteComputers),
        /** 手机服务那一半：只报"在不在听、听哪儿"，不报任何凭据。 */
        phoneService: {
          listening: Boolean(server),
          port: server?.port ?? null,
          addresses: server ? [...server.addresses] : [],
          // 起不来时把原因（端口被占之类）原样说一句，这比一个光秃秃的 false 有用。
          error: server ? null : (serverError ? String(serverError) : null),
          /**
           * 跨机那两条在**手机服务那一半**也有挂载点（见 `hostHalfRoutes`）。
           * 它们决定"B 只填一条地址"能不能成——所以两半的状态都要看得见。
           */
          hostHalf: {
            pair: Boolean(hostHalfRoutes.pair),
            remoteWindow: Boolean(hostHalfRoutes.remoteWindow),
          },
        },
        dataDir: dir,
        rosters: {
          devices: countOf(() => devices.list()),
          remotes: countOf(() => remotes.list()),
        },
        /**
         * 最近出的错，**最新在前**，最多 20 条（见上面 `recentErrors` 那段）。
         *
         * 为什么把 `message` 直接摆出来而不是给个错误码：这几块错误（端口被占、隧道连不上、
         * 飞书断开、跨机不通）本来就是"一句话就能说清"的东西，码表只会多一层翻译。
         * 消息已经过 `redact`，不会有凭据。
         *
         * 空数组是正常的：那是"这次开机以来没出过错"，不是"取不到"。
         */
        errors: recentErrors.slice().reverse(),
      }
    }

    const offSelfcheck = mountRoute({
      kind: 'exact',
      path: '/mini-remote/selfcheck',
      handler: (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 GET。' })
          return
        }
        try {
          sendJson(res, 200, selfcheckPayload())
        } catch (err) {
          // 兜底：这一段本该一步都不会抛（每一项各自拿不到就说"未知"）。
          // 真抛了也不许把自检变成一个报错页面——如实说哪一步没读出来。
          // `ok:false` 是有意的：界面那一头照别的失败一样把那句原因摆出来，
          // 而不是拿到一份缺胳膊少腿的"正常"数据。
          sendJson(res, 200, { ok: false, error: `自检读不出来：${err?.message ?? err}` })
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
     * 2026-10-15 加「远程窗口」那条：六条注册，六条注销。
     * 2026-10-16 加「设备名册」那三条（列出/改名/撤销）：**九条注册，九条注销**。
     * 2026-10-16 加「配对」那一条：**十条注册，十条注销**。
     * 2026-10-16 加「跨机取票」和「允许别的电脑连接」那两条：**十二条注册，十二条注销**。
     * 2026-10-16 加「我能连的电脑」那四条（B 侧：列出/添加/取票/断开）：**十六条注册，
     * 十六条注销**。
     * 2026-10-17 加「跨机那两条在手机服务上再挂一份」：注册数没变（那两条不是新的
     * `webServer.register`，是同一个处理函数的第二个挂载点），但**两处挂载点都得摘**。
     * 2026-10-17 加「自检」那一条：**十七条注册，十七条注销**。
     * 2026-10-22 加 B 端执行那三条（允许接入/配对码/撤销）、B 端执行端那三条
     * （状态/配对/开关/能力）和设置页用的 B 名单快照：**三十二条注册，三十二条注销**。
     *   （这些现在都走 `mountRoute`——它就是我们这一处的登记口，注册和注销同一个门。）
     */
    return () => {
      offGet?.()
      offTunnel?.()
      offServe?.()
      offToken?.()
      offFeishu?.()
      offWindow?.()
      offDevices?.()
      offDeviceRename?.()
      offDeviceRevoke?.()
      offPair?.()
      offRemoteWindow?.()
      offRemoteAccess?.()
      offAgentAccess?.()
      offAgentList?.()
      offAgentCode?.()
      offAgentRevoke?.()
      offBAgentStatus?.()
      offBAgentPair?.()
      offBAgentMode?.()
      offBAgentOptions?.()
      offBProjects?.()
      offBProjectFiles?.()
      offBBrowse?.()
      offRemotesList?.()
      offRemotesAdd?.()
      offRemotesWindow?.()
      offRemotesBrowseRoots?.()
      offRemotesBrowse?.()
      offRemotesBrowseMkdir?.()
      offRemotesWorkspaces?.()
      offRemotesForget?.()
      offSelfcheck?.()
      // 手机服务那一半那两个挂载点（见 hostHalfRoutes）：那条服务活得比这份 disposer
      // 久是可能的（先摘路由、后关服务），留着就是两个指向死闭包的口子。
      hostHalfRoutes.pair = null
      hostHalfRoutes.remoteWindow = null
    }
  })
}
