/**
 * 「B 端执行」预设（混合）。
 *
 * 目标不是“只剩 b_*”，而是：
 *   · B 的文件、命令、终端：只能走 b_*，走 B；
 *   · A 的联网、浏览器、画图、会话搜索、日程、团队、顾问等**不碰本地文件/命令**的
 *     工具：保留原样，继续在 A 上执行；
 *   · A 本地的 read/write/edit/bash/terminal 等：从这支代理里移除并拒绝，
 *     避免它把 B 任务顺手做到 A 上。
 *
 * 两层一起上：
 *   · restrict({ deny: [...] })：只把**当前确实存在**的本地工具从视野里拿掉；
 *   · guard(...)：执行时再按同一个名单拒绝一次，scoped 工具和以后新加的同名工具
 *     也过不去。
 *
 * 这里**不能**用“标准预设的工具清单”做白名单：工具是各插件全局注入的，顾问、
 * 浏览器、搜索、记忆、日程这些并不属于标准预设本身。所以用黑名单：只禁本地
 * 物理动作；其它插件注入的非物理工具自动保留。
 *
 * 代价：某个插件以后新增一个“本地文件/命令”工具、名字又不在下面，它不会被拦。
 * 那种情况需要在下面补名字，或者给工具加来源/能力标记（插件层无法通用识别）。
 *
 * `run_code` 本身不在这里禁：它是不是安全取决于工具呈现方式。B 项目会话会先尝试
 * 改成原生呈现；成功后由主插件在那支 Agent 的作用域里再把 run_code 收走。
 *
 * 以后新增 b_* 工具不用改这里；只有新增“本地物理动作”工具时才需要补名单。
 */
export const B_AGENT_BLOCKED_TOOLS = [
  'read', 'write', 'edit', 'glob', 'grep', 'bash', 'shell',
  'apply_patch', 'multi_edit', 'ls', 'find', 'search',
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_close', 'terminal_list',
  'working_directory', 'create_worktree', 'read_image',
  'job_list', 'job_output', 'job_kill', 'win_bash',
  'subagent', 'subagent_fork', 'subagent_claude_code', 'subagent_codex', 'ralph', 'task_board_run',
]

const BLOCKED = new Set(B_AGENT_BLOCKED_TOOLS)

export const B_AGENT_PRESET = {
  id: 'b-agent',
  name: 'B 端执行',
  description: 'B 的文件/命令走 b_*；A 的联网、浏览器、画图、会话、团队、顾问等全局工具保留；A 本地文件/命令工具移除。个人日程由预设内的一份副本提供。',
  order: 45,
  plugins: [
    { name: 'dsh-mini-remote/b-agent-preset' },
    { name: 'dsh-mini-remote/b-agent-schedule' },
  ],
}

export const name = 'dsh-mini-remote-b-agent-preset'
export const inject = ['tools']

export function apply(ctx) {
  const visible = typeof ctx.tools.schemas === 'function' ? ctx.tools.schemas() : []
  const names = new Set((Array.isArray(visible) ? visible : []).map((t) => t && t.name).filter(Boolean))
  const deny = B_AGENT_BLOCKED_TOOLS.filter((n) => names.has(n))
  if (deny.length) ctx.effect(() => ctx.tools.restrict({ deny }))
  ctx.effect(() => ctx.tools.guard((exec) => {
    if (!exec || !BLOCKED.has(exec.name)) return undefined
    return '「B 端执行」预设移除了 A 本地文件和命令工具；B 的文件/命令请用 b_*，A 的联网/浏览器/画图/会话/日程/团队/顾问仍可用。'
  }))
}
