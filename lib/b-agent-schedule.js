/**
 * B 端执行预设里的「日程」工具。
 *
 * 为什么不在主插件里注册：DSH 的 schedule_* 工具是**会话/代理作用域**的，
 * B 预设是另一支代理组合，继承不到。这里在预设自己的作用域里再注册一份，
 * 直接调宿主的 schedule 服务。
 *
 * 2026-11-16 适配 DSH 0.2.2：工具改为 create/list/view/edit 四个；
 * 创建接收 RRULE，服务改为 create(request, actorSessionId) 与 edit(request, …)。
 * 日程是 Host 级资源，列表不再按调用会话过滤，与官方工具的作用范围一致。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-mini-remote-b-agent-schedule'
export const inject = ['tools']

function sessionOf(exec) {
  const id = exec && exec.agent && exec.agent.id
  if (!id) throw new Error('当前工具调用没有会话身份')
  return id
}

function text(value) {
  return JSON.stringify(value, null, 2)
}

function targetOf(target, sessionId) {
  if (target === 'this_session') return { kind: 'session', sessionId }
  if (target === 'new_once') return { kind: 'new_once' }
  if (target === 'new') return { kind: 'new' }
  throw new Error('target 只支持 this_session、new_once 或 new')
}

export function apply(ctx) {
  // schedule 服务可能比这个预设行晚就绪；用 inject 等它，而不是在 apply 时 get 一次。
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
    description: 'Create a scheduled task. rrule contains one DTSTART line and one RRULE line; target is this_session, new_once, or new.',
    parameters: {
      title: { type: 'string', required: true, description: '任务短标题。' },
      prompt: { type: 'string', required: true, description: '每次到点时发送的指令。' },
      rrule: { type: 'string', required: true, description: '一行 DTSTART 加一行 RRULE。' },
      target: { type: 'string', required: true, description: 'this_session、new_once 或 new。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const request = {
        title: String(args.title || '').trim(),
        prompt: String(args.prompt || ''),
        timing: { kind: 'rrule', rrule: String(args.rrule || '') },
        target: targetOf(args.target, sessionId),
      }
      if (!request.title) throw new Error('title 不能为空')
      if (!request.prompt) throw new Error('prompt 不能为空')
      const record = await schedule.create(request, sessionId, exec.signal)
      return text(record)
    },
  }))

  tools.register(defineTool({
    name: 'schedule_list',
    description: 'List one page of scheduled tasks across the Host, optionally filtering by active status.',
    parameters: {
      active: { type: 'boolean', description: 'true 只看活动任务；false 只看暂停和已结束任务。' },
      limit: { type: 'number', description: '每页数量，1–500。' },
      offset: { type: 'number', description: '跳过前多少条。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const request = {
        ...(args.active !== undefined ? { active: args.active } : {}),
        ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
        ...(args.offset !== undefined ? { offset: Number(args.offset) } : {}),
      }
      return text(await schedule.list(request))
    },
  }))

  tools.register(defineTool({
    name: 'schedule_view',
    description: 'View one scheduled task by id.',
    parameters: { id: { type: 'string', required: true, description: '任务 id。' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      return text(await schedule.view({ id: String(args.id) }))
    },
  }))

  tools.register(defineTool({
    name: 'schedule_edit',
    description: 'Update, pause, resume, or delete one scheduled task by id. Deleting does not retract queued messages.',
    parameters: {
      id: { type: 'string', required: true, description: '任务 id。' },
      action: { type: 'string', required: true, description: 'update 或 delete。' },
      title: { type: 'string', description: '新标题。' },
      prompt: { type: 'string', description: '新指令。' },
      rrule: { type: 'string', description: '新的一行 DTSTART 加一行 RRULE。' },
      target: { type: 'string', description: 'this_session、new_once 或 new。' },
      active: { type: 'boolean', description: 'false 暂停；true 恢复。' },
      expectedUpdatedAt: { type: 'string', description: '用于避免覆盖别人刚刚修改的内容。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const id = String(args.id || '')
      const sessionId = sessionOf(exec)
      const revision = args.expectedUpdatedAt !== undefined
        ? { expectedUpdatedAt: String(args.expectedUpdatedAt) }
        : {}
      if (args.action === 'delete') {
        return text(await schedule.edit({ id, action: 'delete', ...revision }, sessionId, exec.signal))
      }
      if (args.action !== 'update') throw new Error('action 只支持 update 或 delete')
      const patch = {
        ...(args.title !== undefined ? { title: String(args.title) } : {}),
        ...(args.prompt !== undefined ? { prompt: String(args.prompt) } : {}),
        ...(args.rrule !== undefined ? { timing: { kind: 'rrule', rrule: String(args.rrule) } } : {}),
        ...(args.target !== undefined ? { target: targetOf(args.target, sessionId) } : {}),
        ...(args.active !== undefined ? { active: args.active } : {}),
      }
      if (!Object.keys(patch).length) throw new Error('update 至少要带一项修改')
      return text(await schedule.edit({ id, action: 'update', patch, ...revision }, sessionId, exec.signal))
    },
  }))
}
