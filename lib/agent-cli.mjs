#!/usr/bin/env node
/**
 * B 端执行端的命令行入口（开发/自测用）。
 *
 * 正式形态是插件里的「作为 B 端执行端」开关；这个命令只是让我们在接设置页之前
 * 先把配对和只读链路跑通。两者共用 lib/agent-client.js，不是两套实现。
 *
 * 用法：
 *   dsh-mini-remote-agent pair --url http://A:3090 --code 123456 --root D:\work
 *   dsh-mini-remote-agent run
 *   dsh-mini-remote-agent status
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAgentClient, loadAgentConfig, normalizeRoots, pairAgent, saveAgentConfig } from './agent-client.js'

const DEFAULT_CONFIG = join(homedir(), '.dsh-mini-remote-agent.json')

function parse(argv) {
  const out = { _: [], root: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const key = a.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) { out[key] = true; continue }
    if (key === 'root') out.root.push(value)
    else out[key] = value
    i += 1
  }
  return out
}

function configPath(args) {
  return args.config ? String(args.config) : DEFAULT_CONFIG
}

async function main() {
  const args = parse(process.argv.slice(2))
  const cmd = args._[0] || 'help'
  if (cmd === 'help' || cmd === '--help') {
    console.log('用法：dsh-mini-remote-agent pair --url <A> --code <配对码> --root <文件夹> [--root ...]')
    console.log('      dsh-mini-remote-agent run [--config <文件>]')
    console.log('      dsh-mini-remote-agent status [--config <文件>]')
    return
  }
  if (cmd === 'pair') {
    if (!args.url || !args.code || !args.root.length) throw new Error('pair 需要 --url、--code 和至少一个 --root')
    const roots = normalizeRoots(args.root)
    const out = await pairAgent({
      url: args.url,
      code: args.code,
      name: args.name || 'B 端电脑',
      platform: process.platform,
      roots,
      allowWrite: false,
      allowShell: false,
    })
    const file = configPath(args)
    saveAgentConfig(file, {
      url: out.url,
      token: out.token,
      agentId: out.agentId,
      roots,
      allowWrite: false,
      allowShell: false,
    })
    console.log(`配对成功，凭据已写到 ${file}`)
    console.log('这一版只读；写文件和命令还没开。')
    return
  }
  if (cmd === 'run') {
    const file = configPath(args)
    const cfg = loadAgentConfig(file)
    if (!cfg || !cfg.url || !cfg.token) throw new Error(`没有配对凭据：先运行 pair，或检查 ${file}`)
    const client = createAgentClient({
      url: cfg.url,
      token: cfg.token,
      roots: cfg.roots,
      allowWrite: false,
      allowShell: false,
    })
    const ac = new AbortController()
    const stop = () => { ac.abort(); client.stop() }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    console.log(`已连上 A：${cfg.url}；授权 ${client.roots.length} 个文件夹。等待任务…`)
    await client.run({ signal: ac.signal })
    return
  }
  if (cmd === 'status') {
    const file = configPath(args)
    const cfg = loadAgentConfig(file)
    if (!cfg) { console.log(`还没有配对凭据：${file}`); return }
    console.log(JSON.stringify({ url: cfg.url, agentId: cfg.agentId, roots: cfg.roots, readOnly: true }, null, 2))
    return
  }
  throw new Error(`不认识的命令：${cmd}`)
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err))
  process.exitCode = 1
})
