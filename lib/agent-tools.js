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

  /**
   * 文件搜索、目录管理、持久终端这些工具的注册口。它们都只做一件事：
   * 把参数原样交给 B，B 按自己的权限和授权目录执行。格式化的活留在 A。
   */
  function registerB(name, description, parameters, op, format, timeoutMs) {
    ctx.tools.register(defineTool({
      name,
      description,
      parameters,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const { agent, ...payload } = args || {}
        const result = await hub.call(op, payload, {
          agentId: agent, signal: exec && exec.signal,
          ...(timeoutMs ? { timeoutMs } : {}),
        })
        return format(result)
      },
    }))
  }

  registerB('b_glob', 'Find files on the paired remote B computer (not this computer). path is the directory to search; pattern supports **, * and ? (for example **/*.ts). Returns up to 1000 matches.', {
    path: { type: 'string', description: 'B 端搜索起点目录，默认第一个授权根。' },
    pattern: { type: 'string', required: true, description: '相对路径模式，支持 **、*、?。' },
    limit: { type: 'number', description: '最多返回多少条，默认 200。' },
    agent: agentParam,
  }, 'glob', (r) => {
    const rows = (r.matches || []).map((m) => `${m.type === 'dir' ? 'dir ' : 'file'}\t${m.size == null ? '-' : m.size}\t${m.path}`)
    return `${r.path}\n${rows.join('\n')}${r.truncated ? '\n…（已截断）' : ''}`
  })

  registerB('b_grep', 'Search text file contents on the paired remote B computer (not this computer). pattern is a regular expression; glob optionally limits which files are searched. Returns up to 500 matches.', {
    path: { type: 'string', description: 'B 端搜索起点目录，默认第一个授权根。' },
    pattern: { type: 'string', required: true, description: '正则表达式。' },
    glob: { type: 'string', description: '只搜匹配这个 glob 的文件。' },
    limit: { type: 'number', description: '最多返回多少条，默认 100。' },
    ignoreCase: { type: 'boolean', description: '是否忽略大小写，默认 true。' },
    agent: agentParam,
  }, 'grep', (r) => {
    const rows = (r.matches || []).map((m) => `${m.path}:${m.line}: ${m.text}`)
    return `${r.path}\n${rows.join('\n')}${r.truncated ? '\n…（已截断）' : ''}`
  })

  registerB('b_mkdir', 'Create a directory on the paired remote B computer. Requires the B user to have granted folder-management permission.', {
    path: { type: 'string', required: true, description: '要创建的目录。' },
    agent: agentParam,
  }, 'mkdir', (r) => `${r.created ? '已创建' : '已存在'}：${r.path}`)

  registerB('b_copy', 'Copy a file or directory on the paired remote B computer. Requires folder-management permission. If the destination exists, pass confirm: true to overwrite.', {
    from: { type: 'string', required: true, description: '源路径。' },
    to: { type: 'string', required: true, description: '目标路径。' },
    confirm: { type: 'boolean', description: '目标已存在时，必须为 true 才覆盖。' },
    agent: agentParam,
  }, 'copy', (r) => `已复制：${r.from} → ${r.to}`)

  registerB('b_move', 'Move or rename a file or directory on the paired remote B computer. Requires folder-management permission and confirm: true. A move that would overwrite an existing target is refused.', {
    from: { type: 'string', required: true, description: '源路径。' },
    to: { type: 'string', required: true, description: '目标路径。' },
    confirm: { type: 'boolean', required: true, description: '必须为 true；这是移动/改名的二次确认。' },
    agent: agentParam,
  }, 'move', (r) => `已移动：${r.from} → ${r.to}`)

  registerB('b_delete', 'Delete a file or directory on the paired remote B computer. Requires folder-management permission and confirm: true. Deleting a directory additionally requires recursive: true. This cannot be undone.', {
    path: { type: 'string', required: true, description: '要删除的路径。' },
    confirm: { type: 'boolean', required: true, description: '必须为 true；删除不可恢复。' },
    recursive: { type: 'boolean', description: '删除文件夹时必须为 true。' },
    agent: agentParam,
  }, 'delete', (r) => `已删除：${r.path}`)

  registerB('b_terminal_open', 'Open a persistent shell on the paired remote B computer. Requires command permission. Use b_terminal_send/read/close with the returned sessionId.', {
    cwd: { type: 'string', description: '工作目录；默认第一个授权根。' },
    name: { type: 'string', description: '便于识别的名字。' },
    agent: agentParam,
  }, 'terminal_open', (r) => `已打开终端 ${r.id}（${r.cwd}）`)

  registerB('b_terminal_send', 'Send one line to a persistent B terminal and return the output it produced. Requires command permission.', {
    sessionId: { type: 'string', required: true, description: 'b_terminal_open 返回的 id。' },
    text: { type: 'string', required: true, description: '要发送的一行命令。' },
    waitMs: { type: 'number', description: '最多等多久收输出，默认 800 毫秒。' },
    agent: agentParam,
  }, 'terminal_send', (r) => `${r.output}${r.closed ? '\n（终端已关闭）' : ''}${r.timedOut ? '\n（等待超时）' : ''}`, 20 * 1000)

  registerB('b_terminal_read', 'Read retained output from a persistent B terminal. Requires command permission.', {
    sessionId: { type: 'string', required: true, description: '终端 id。' },
    count: { type: 'number', description: '最多读多少行，默认 200。' },
    agent: agentParam,
  }, 'terminal_read', (r) => r.output)

  registerB('b_terminal_close', 'Close a persistent B terminal. Requires command permission.', {
    sessionId: { type: 'string', required: true, description: '终端 id。' },
    agent: agentParam,
  }, 'terminal_close', (r) => `已关闭终端 ${r.id}`)

  registerB('b_terminal_list', 'List persistent B terminals opened by this B agent.', {
    agent: agentParam,
  }, 'terminal_list', (r) => (r.terminals || []).map((t) => `${t.id}\t${t.name || '-'}\t${t.cwd}\t${t.closed ? 'closed' : 'open'}`).join('\n') || '（没有终端）')

  ctx.tools.register(defineTool({
    name: 'b_subagent',
    description: 'Delegate a B-side task to a child agent forced into the「B 端执行」preset, whose only tools are b_list/b_read/b_write/b_shell. Use this for every B-side subagent task; the ordinary subagent tool starts a child without that restriction. The child still runs on A and uses b_* to act on B.',
    parameters: {
      prompt: { type: 'string', required: true, description: '完整、自包含的任务说明；子代理看不到当前对话。' },
      description: { type: 'string', description: '短标题，用于显示。' },
      cwd: { type: 'string', description: '子代理初始工作目录；相对路径按当前目录展开。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const svc = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined
      if (!svc || typeof svc.startActivation !== 'function') throw new Error('subagents 服务不可用，不能派子代理')
      const parent = exec && exec.agent
      if (!parent) throw new Error('当前工具调用没有 Agent 身份，不能派子代理')
      const names = typeof svc.list === 'function' ? svc.list() : []
      const provider = (Array.isArray(names) ? names : []).find((n) => {
        const p = typeof svc.getProvider === 'function' ? svc.getProvider(n) : null
        return p && p.capabilities && p.capabilities.agentPreset === true
      })
      if (!provider) throw new Error('没有支持 agentPreset 的子代理后端')
      const activation = await svc.startActivation({
        provider,
        label: args.description || 'B 端任务',
        request: {
          parent,
          agentPreset: 'b-agent',
          prompt: [{ type: 'text', text: String(args.prompt || '') }],
          ...(args.cwd ? { cwd: args.cwd } : {}),
        },
        signal: exec.signal,
        delivery: 'caller',
      })
      return `已派出 B 端子代理：${activation.childId}（预设 b-agent，只含 b_* 工具）`
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
  return { ok: true, tools: ['b_list', 'b_read', 'b_write', 'b_shell', 'b_subagent', 'b_glob', 'b_grep', 'b_mkdir', 'b_copy', 'b_move', 'b_delete', 'b_terminal_open', 'b_terminal_send', 'b_terminal_read', 'b_terminal_close', 'b_terminal_list'] }
}
