/**
 * B 端执行预设里的「日程」工具。
 *
 * 为什么不在主插件里注册：DSH 的 `schedule_create` 等工具是**会话/代理作用域**
 * 的工具，B 预设是另一支代理组合，继承不到。这里在预设自己的作用域里再注册一份，
 * 直接调宿主的 `schedule` 服务，把提醒绑到当前会话。
 *
 * 这些工具只在 A 端的 B 预设里加载；B 自己那台不会注册这个预设（allowAgent 关着），
 * 所以这个文件里的 `@deepseek-ai/dsh-tools` 只会在 A 上解析。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-mini-remote-b-agent-schedule'
export const inject = ['tools']

const TIMING_KEYS = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron']

function timingFrom(args) {
  const present = TIMING_KEYS.filter((k) => args && args[k] !== undefined && args[k] !== null)
  if (present.length > 1) throw new Error(`一次只能选一种时间规则：${present.join('、')}`)
  if (!present.length) return undefined
  const key = present[0]
  if (key === 'after_seconds') return { kind: 'after', after_seconds: Number(args.after_seconds) }
  if (key === 'every_seconds') return { kind: 'every', every_seconds: Number(args.every_seconds) }
  if (key === 'at') return { kind: 'at', at: args.at }
  if (key === 'daily') return { kind: 'daily', daily: args.daily }
  if (key === 'weekly') return { kind: 'weekly', weekly: args.weekly }
  return { kind: 'cron', cron: args.cron }
}

function createRequest(args) {
  const timing = timingFrom(args)
  const request = {
    title: String(args.title || '').trim(),
    prompt: String(args.prompt || ''),
    ...(timing && timing.kind === 'after' ? { after_seconds: timing.after_seconds } : {}),
    ...(timing && timing.kind === 'every' ? { every_seconds: timing.every_seconds } : {}),
    ...(timing && timing.kind === 'at' ? { at: timing.at } : {}),
    ...(timing && timing.kind === 'daily' ? { daily: timing.daily } : {}),
    ...(timing && timing.kind === 'weekly' ? { weekly: timing.weekly } : {}),
    ...(timing && timing.kind === 'cron' ? { cron: timing.cron } : {}),
  }
  if (!request.title) throw new Error('title 不能为空')
  if (!request.prompt) throw new Error('prompt 不能为空')
  return request
}

function sessionOf(exec) {
  const id = exec && exec.agent && exec.agent.id
  if (!id) throw new Error('当前工具调用没有会话身份')
  return id
}

function text(value) {
  return JSON.stringify(value, null, 2)
}

export function apply(ctx) {
  // schedule 服务可能比这个预设行晚就绪；用 inject 等它，而不是在 apply 时 get 一次。
  // 之前用 ctx.get：服务没到时直接 return，工具就永远不会注册。
  ctx.inject(['schedule'], (regCtx) => {
    const schedule = regCtx.schedule
    if (!schedule || typeof schedule.create !== 'function') return
    if (!regCtx.tools || typeof regCtx.tools.register !== 'function') return
    registerTools(regCtx.tools, schedule)
  })
}

function registerTools(tools, schedule) {

  tools.register(defineTool({
    name: 'schedule_create',
    description: 'Create a reminder bound to the current A-side session. This is the B-preset copy of the standard schedule tool; it does not touch B files or commands.',
    parameters: {
      title: { type: 'string', required: true, description: '提醒的短标题。' },
      prompt: { type: 'string', required: true, description: '到点时发送给当前会话的内容。' },
      after_seconds: { type: 'number', description: '多少秒后触发。' },
      at: {
        type: 'object',
        description: '绝对时间；date/time/time_zone 三个字段。',
        additionalProperties: false,
        properties: {
          date: { type: 'string' },
          time: { type: 'string' },
          time_zone: { type: 'string' },
        },
      },
      every_seconds: { type: 'number', description: '每隔多少秒重复。' },
      daily: {
        type: 'object',
        description: '每天固定时间。',
        additionalProperties: false,
        properties: { time: { type: 'string' }, time_zone: { type: 'string' } },
      },
      weekly: {
        type: 'object',
        description: '每周固定时间。',
        additionalProperties: false,
        properties: {
          time: { type: 'string' },
          time_zone: { type: 'string' },
          weekdays: { type: 'array', items: { type: 'number' }, description: '周一=1，周日=7。' },
        },
      },
      cron: {
        type: 'object',
        description: '五段 cron 表达式。',
        additionalProperties: false,
        properties: { expression: { type: 'string' }, time_zone: { type: 'string' } },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const record = await schedule.create(sessionOf(exec), createRequest(args), exec.signal)
      return text(record)
    },
  }))

  tools.register(defineTool({
    name: 'schedule_list',
    description: 'List reminders bound to the current A-side session.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(_args, exec) {
      const list = await schedule.list({ sessionId: sessionOf(exec) })
      if (!list.length) return '（当前会话没有日程）'
      return list.map((r) => `${r.id}\t${r.kind}\t${r.title}\t${r.scheduledAt}`).join('\n')
    },
  }))

  tools.register(defineTool({
    name: 'schedule_delete',
    description: 'Delete one reminder from the current A-side session. This cannot be undone.',
    parameters: { id: { type: 'string', required: true, description: '日程 id。' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const out = await schedule.delete({ sessionId: sessionOf(exec), id: String(args.id) }, exec.signal)
      return text(out)
    },
  }))

  tools.register(defineTool({
    name: 'schedule_update',
    description: 'Update a reminder bound to the current A-side session. Omitted fields stay unchanged; one timing field may be supplied.',
    parameters: {
      id: { type: 'string', required: true, description: '日程 id。' },
      title: { type: 'string', description: '新标题。' },
      prompt: { type: 'string', description: '新内容。' },
      after_seconds: { type: 'number' },
      at: {
        type: 'object',
        additionalProperties: false,
        properties: { date: { type: 'string' }, time: { type: 'string' }, time_zone: { type: 'string' } },
      },
      every_seconds: { type: 'number' },
      daily: {
        type: 'object',
        additionalProperties: false,
        properties: { time: { type: 'string' }, time_zone: { type: 'string' } },
      },
      weekly: {
        type: 'object',
        additionalProperties: false,
        properties: {
          time: { type: 'string' },
          time_zone: { type: 'string' },
          weekdays: { type: 'array', items: { type: 'number' } },
        },
      },
      cron: {
        type: 'object',
        additionalProperties: false,
        properties: { expression: { type: 'string' }, time_zone: { type: 'string' } },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const list = await schedule.list({ sessionId })
      const expected = list.find((r) => r.id === String(args.id))
      if (!expected) throw new Error('这个会话里没有这条日程')
      const change = timingFrom(args)
      const out = await schedule.update({
        sessionId,
        id: String(args.id),
        expected,
        ...(args.title !== undefined ? { title: String(args.title) } : {}),
        ...(args.prompt !== undefined ? { prompt: String(args.prompt) } : {}),
        ...(change ? { change } : {}),
      }, exec.signal)
      return text(out)
    },
  }))
}
