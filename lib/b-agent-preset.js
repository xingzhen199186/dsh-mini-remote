/**
 * 「B 端执行」预设。
 *
 * 这个文件既是预设的定义，也是预设里那一个守卫插件的入口。预设里只放守卫，
 * 不放主插件：b_* 工具是全局注册的，预设要做的只是把**其它工具**从这一支
 * 代理的视野里拿掉，让模型没有本地 read/write/bash 可用。
 *
 * 两层一起上：
 *   · restrict({ allow: [...] })：把全局工具裁到只剩四个 b_*；
 *   · guard(...)：连 scoped 工具或以后新加的工具也一并拒绝，只放 b_*。
 *
 * 注意：guard 只认 b_ 前缀，不认具体四个名字；以后新增 b_* 工具不用改这里。
 */
export const B_AGENT_TOOL_NAMES = [
  'b_list', 'b_read', 'b_write', 'b_shell', 'b_subagent',
  'b_glob', 'b_grep', 'b_mkdir', 'b_copy', 'b_move', 'b_delete',
  'b_terminal_open', 'b_terminal_send', 'b_terminal_read', 'b_terminal_close', 'b_terminal_list',
]

export const B_AGENT_PRESET = {
  id: 'b-agent',
  name: 'B 端执行',
  description: '只保留 b_* 工具：读、写、执行都落在配对的 B 端电脑上，不碰 A 本地文件。',
  order: 45,
  plugins: [
    { name: 'dsh-mini-remote/b-agent-preset' },
  ],
}

export const name = 'dsh-mini-remote-b-agent-preset'
export const inject = ['tools']

export function apply(ctx) {
  ctx.effect(() => ctx.tools.restrict({ allow: B_AGENT_TOOL_NAMES }))
  ctx.effect(() => ctx.tools.guard((exec) => {
    if (typeof exec?.name === 'string' && exec.name.startsWith('b_')) return undefined
    return '「B 端执行」预设只允许 b_* 工具；本地文件和命令工具在这支代理里是关闭的。'
  }))
}
