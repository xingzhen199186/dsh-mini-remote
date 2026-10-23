/**
 * A 端给模型的 B 端工具。
 *
 * 只注册**新名字**（b_ 前缀），不替换 A 本地的 read/edit/bash——
 * 那一层 DSH 没有“把执行改到远端”的合法缝（tools/execute 只能包本地执行），
 * 硬换会破坏策略、日志和审批。新工具没有这个负担：模型明确知道自己在动 B。
 *
 * 子代理默认继承父级的工具和预设，所以这组工具注册在全局后子代理也看得到。
 * 工具描述里写死“只用于 B 端任务、本地工具动的是 A”，主模型派活时应当把这句
 * 带进子代理的提示；更严格的“只含 b_* 的预设”是下一步。
 */
export async function registerAgentTools(ctx, { hub, log = console, defineTool: injected } = {}) {
  let defineTool = injected
  if (!defineTool) {
    try {
      ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
    } catch (err) {
      const message = `B 端工具没有注册：拿不到 @deepseek-ai/dsh-tools（${err && err.message ? err.message : err}）`
      log.warn?.(message)
      return { ok: false, error: message }
    }
  }
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    const message = 'B 端工具没有注册：当前组合没有 tools 服务'
    log.warn?.(message)
    return { ok: false, error: message }
  }

  const agentParam = {
    type: 'string',
    description: '可选：指定哪一台 B 端电脑（用设置页里显示的 id）。只有一台在线时可以省略。',
  }

  ctx.tools.register(defineTool({
    name: 'b_list',
    description: 'List a directory on the paired remote B computer (not this computer). Use this and b_read for B-side files; the local read/glob/glob tools operate on the A computer. Returns up to 500 entries.',
    parameters: {
      path: { type: 'string', required: true, description: 'B 端目录路径；相对路径按 B 端第一个授权文件夹展开。' },
      agent: agentParam,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const result = await hub.call('list', { path: args.path }, {
        agentId: args.agent, signal: exec && exec.signal,
      })
      const rows = Array.isArray(result && result.entries) ? result.entries : []
      const lines = rows.map((e) => `${e.type === 'dir' ? 'dir ' : e.type === 'link' ? 'link' : 'file'}\t${e.size == null ? '-' : e.size}\t${e.name}`)
      return `${result.path}\n${lines.join('\n')}${result.truncated ? '\n…（超过 500 条，已截断）' : ''}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'b_shell',
    description: 'Run a shell command on the paired remote B computer (not this computer). The B user must have granted command permission; that is full user-level control of B, not limited to the authorized folders. Use b_shell only when the B user explicitly asked for a command; local bash runs on A.',
    parameters: {
      command: { type: 'string', required: true, description: '要在 B 上执行的命令。' },
      cwd: { type: 'string', description: '工作目录；默认 B 的第一个授权文件夹。' },
      agent: agentParam,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const result = await hub.call('shell', {
        command: args.command, cwd: args.cwd,
      }, { agentId: args.agent, signal: exec && exec.signal, timeoutMs: 45 * 1000 })
      const parts = [`退出码：${result.code == null ? '（被终止）' : result.code}`]
      if (result.cwd) parts.push(`目录：${result.cwd}`)
      if (result.stdout) parts.push(`stdout:\n${result.stdout}`)
      if (result.stderr) parts.push(`stderr:\n${result.stderr}`)
      if (result.timedOut) parts.push('（超时，已终止）')
      if (result.truncated) parts.push('（输出超过 64KB，已截断）')
      return parts.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'b_write',
    description: 'Write a text file on the paired remote B computer (not this computer). The B user must have granted write permission for the folder. Use b_read/b_list to inspect, b_write only for B-side files; local edit/write tools affect the A computer.',
    parameters: {
      path: { type: 'string', required: true, description: 'B 端文件路径。' },
      content: { type: 'string', required: true, description: '完整文件内容（整份写入，不是追加）。' },
      agent: agentParam,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const result = await hub.call('write', {
        path: args.path, content: args.content,
      }, { agentId: args.agent, signal: exec && exec.signal })
      return `已写入 ${result.path}（${result.bytes} 字节）`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'b_read',
    description: 'Read a text file on the paired remote B computer (not this computer). Use this and b_list for B-side files; the local read tool reads the A computer. Returns up to 2000 lines.',
    parameters: {
      path: { type: 'string', required: true, description: 'B 端文件路径。' },
      offset: { type: 'number', description: '从第几行开始，1 起。' },
      limit: { type: 'number', description: '最多读多少行，默认 400。' },
      agent: agentParam,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const result = await hub.call('read', {
        path: args.path, offset: args.offset, limit: args.limit,
      }, { agentId: args.agent, signal: exec && exec.signal })
      return `${result.path}（第 ${result.offset} 行起，共 ${result.totalLines} 行${result.truncated ? '，已截断' : ''}）\n${result.content}`
    },
  }))
  return { ok: true, tools: ['b_list', 'b_read', 'b_write', 'b_shell'] }
}
