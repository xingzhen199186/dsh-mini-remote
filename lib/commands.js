/**
 * 斜杠指令：手机作为一个「发起指令的界面」，问 DSH 自己的指令账本。
 *
 * 为什么不是自己实现一套：指令是别的插件注册到宿主上的（`ctx.commands.register`），
 * 手机端不该也不可能重写它们。DSH 把「注册 / 列出 / 执行」放在 `ctx.commands` 服务里，
 * 电脑上的网页端走的是同一个服务（它经过 remote 那一层），所以这里**照抄 DSH 的语义**，
 * 只是换了调用它的地方——手机上装了新插件带来的指令，会自动出现在手机列表里。
 *
 * 这个文件里放的都是**纯逻辑**（`test/commands.test.mjs` 直接测），
 * 真正碰服务的地方在 index.js。
 *
 * 三条来自 DSH 文档与类型定义的事实（不要自己发明）：
 *   ① 指令行的语法：**第 0 个字节必须是斜杠**，接着是小写名字（字母、数字、`_`、`-`），
 *      再往后要么结束、要么是空白；名字之后的每个字节（**包括那个分隔空格**）都是
 *      `rawInput`，由指令自己解释。不满足这个形状、或者名字不认识的，**拒绝，不当成提示词**。
 *   ② 执行会往会话记录里追加一对日志事件：`command/run`（`commandId`、`name`、`args`）
 *      和 `command/done`（`commandId`、`kind`、`text`），靠 `commandId` 配对。
 *      指令**不产生模型消息**——所以它既不该长成用户气泡，也不该被当成 AI 的回答。
 *   ③ 描述符（`list()` 的返回）是「给发现界面看的」：`name`、`description`，
 *      外加可选的 `input.hint`（要参数时给用户看的一句话）和 `input.attachments`。
 */

/**
 * DSH 自己的指令行正则——**逐字照抄** dsh-commands 里 `parseCommand` 用的那条
 * （`/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u`）。
 *
 * 照抄而不是"写个差不多的"：名字必须以**小写字母**开头（`/9x`、`/_x` 都不是指令），
 * 后面的空白集是 `\t\n\r ` 这四个（不是 `\s`）。差一个字符，手机和电脑就会对
 * "这行算不算指令"给出不同答案，而这种分歧极难被发现。
 */
const COMMAND_RE = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u

/**
 * 按 DSH 的语法拆一行指令。
 *
 * @param {unknown} line
 * @returns {{name:string, rawInput:string}|null} 不是指令行 → null
 */
export function parseSlashLine(line) {
  if (typeof line !== 'string') return null
  const m = COMMAND_RE.exec(line)
  if (!m) return null
  // 名字之后**原样**保留，包括那个分隔空格——这是 DSH 的口径（`rawInput` 含前导空白），
  // 指令自己拥有这段语法，我们不许替它 trim。
  return { name: m[1], rawInput: line.slice(m[0].length) }
}

/**
 * 电脑网页端专有、宿主**根本没有**注册的两条指令。
 *
 * 这不是我们编的：`/model` 和 `/file` 是浏览器端自己的贡献（`ctx.commandUi.register`），
 * 宿主目录里没有它们（2026-09-25 查证）。手机上打这两条，`find()` 必然落空——
 * 如果只说一句「没有这条指令」，用户会以为是自己打错了，可电脑上明明有。
 */
const BROWSER_ONLY = {
  model: '这是电脑网页端专有的指令。手机上是点顶栏那一行换模型。',
  file: '这是电脑网页端专有的指令。手机上用输入框旁边的回形针传文件。',
}

/** 这行连指令的形状都不是（比如 `/9x`、`/Model`——DSH 的名字必须以小写字母开头）。 */
export function invalidCommandMessage() {
  return '这不是一条指令。指令要以 / 开头，名字只能用小写字母、数字、- 和 _。'
}

/** 形状对，但账本里没有这个名字。 */
export function unknownCommandMessage(name) {
  const special = BROWSER_ONLY[name]
  if (special) return `/${name} 不是这台电脑上的指令：${special}`
  return `没有 /${name} 这条指令。`
}

/**
 * 把 `list()` 给的描述符翻成手机要的那几样，并按名字排序。
 *
 * 只搬手机用得上的字段：多搬字段等于替未来的自己许下承诺，DSH 那边加字段就会漂。
 *
 * @param {unknown} descriptors
 */
export function describeCommands(descriptors) {
  const rows = []
  for (const d of Array.isArray(descriptors) ? descriptors : []) {
    const name = typeof d?.name === 'string' ? d.name : ''
    if (!name) continue
    const hint = typeof d?.input?.hint === 'string' && d.input.hint ? d.input.hint : null
    rows.push({
      name,
      description: typeof d?.description === 'string' ? d.description : '',
      hint,
      // 「这条指令收不收附件」。手机这一版不带附件执行，但把实情告诉用户，
      // 总比让他对着一条声明了要附件的指令发呆强。
      attachments: d?.input?.attachments === true,
    })
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return rows
}

/**
 * `command/run` → 一条「正在执行」的记录。
 *
 * 时间戳用**事件自己的 `time`**，不用 `Date.now()`：手机上那份历史和硬盘重放出来的
 * 那份要靠时间戳合成（见 store.js 的 mergeHistory），两边用同一个钟才不会接重。
 */
export function commandRow(event) {
  const data = event?.data
  if (!data || typeof data.commandId !== 'string' || typeof data.name !== 'string') return null
  return {
    role: 'command',
    commandId: data.commandId,
    name: data.name,
    args: typeof data.args === 'string' ? data.args : '',
    kind: 'running',
    text: null,
    timestamp: typeof event?.time === 'number' ? event.time : null,
  }
}

/** `command/done` → 用来给上面那条收尾的那几个字段。 */
export function commandPatch(event) {
  const data = event?.data
  if (!data || typeof data.commandId !== 'string') return null
  return {
    commandId: data.commandId,
    kind: data.kind === 'error' ? 'error' : 'success',
    text: typeof data.text === 'string' && data.text ? data.text : null,
  }
}

/**
 * 把两个指令事件折进一串记录里——**重放和实时共用这一个映射**。
 *
 * 和 events.js 的提取器是同一个道理：两条路各写一套配对逻辑的话，
 * 迟早一边显示「执行中」、一边显示结果，或者干脆配对错行。
 *
 * @param {Array<object>} rows 就地修改
 * @param {{type?:string, time?:number, data?:any}} event
 * @returns {boolean} 这个事件是不是指令事件（是就表示已被处理）
 */
export function foldCommandEvent(rows, event) {
  if (event?.type === 'command/run') {
    const row = commandRow(event)
    if (row) rows.push(row)
    return true
  }
  if (event?.type === 'command/done') {
    const patch = commandPatch(event)
    if (!patch) return true
    // 从后往前找：一次会话里同时跑两条同名指令也可能，认 commandId 才稳。
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]?.role === 'command' && rows[i].commandId === patch.commandId) {
        rows[i].kind = patch.kind
        rows[i].text = patch.text
        return true
      }
    }
    // 只看见 done、没看见 run（窗口从中间截断、或者插件是中途起来的）：
    // 补一条没有名字的记录，**不能丢**——用户会看到结果却不知道是哪条指令。
    // name 留空，界面按「指令」显示即可。这条只在重放里可能出现。
    rows.push({
      role: 'command', commandId: patch.commandId, name: '', args: '',
      kind: patch.kind, text: patch.text, timestamp: typeof event?.time === 'number' ? event.time : null,
    })
    return true
  }
  return false
}
