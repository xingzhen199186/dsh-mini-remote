/**
 * 手工端到端验证：真隧道 + 真服务 + 限速分桶。**不在 npm test 里**，要联网、约两分钟。
 *
 *   node tools/e2e-tunnel.mjs
 *
 * 要证明的核心一件事：公网上的攻击者试错 5 次密码，**不能**把本机直连
 * （或者别的公网用户）一起锁掉。隧道进来的请求源地址全是 127.0.0.1，
 * 如果分桶按源地址做，这一条就必然失败。
 *
 * 另外它顺带验证了「负缓存」那个坑：拿到网址后必须**先等 40 秒**再查 DNS，
 * 否则太早的 NXDOMAIN 会被上游 DNS 缓存住，之后记录建好了也一直解析不了。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/store.js'
import { createMiniServer } from '../lib/server.js'
import { ensureCloudflared } from '../lib/cloudflared.js'
import { startTunnel } from '../lib/tunnel.js'

const dir = mkdtempSync(join(tmpdir(), 'mini-e2e-'))
const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const log = { info: (m) => console.log(`  ${m}`), warn: (m) => console.log(`  ! ${m}`) }

const store = createStore({ file: join(dir, 'state.json'), maxHistory: 5 })
let publicHost = null
const server = await createMiniServer({
  store,
  config: { port: 0, defaultMode: 'minimal' },
  token,
  bindAddresses: ['127.0.0.1'],
  tunnelHost: () => publicHost,
  onInstruction: async () => ({ ok: true }),
  log,
})
const local = `http://127.0.0.1:${server.port}`
console.log(`本机服务: ${local}`)

const found = await ensureCloudflared({ dataDir: dir, log })
if (!found.path) { console.error('没有 cloudflared:', found.error); process.exit(1) }

// 和 lib/index.js 的 bringTunnelUp 一样重试：向 api.trycloudflare.com 注册会
// 偶发超时或被 RST，实测一次成功的概率只有一半上下。
let tunnel = null
for (let attempt = 1; attempt <= 4 && !tunnel; attempt += 1) {
  try {
    tunnel = await startTunnel({ binPath: found.path, port: server.port, log })
  } catch (err) {
    console.log(`  第 ${attempt} 次没起来：${String(err.message).split('\n').pop().slice(0, 120)}`)
    if (attempt < 4) await new Promise((r) => setTimeout(r, 2000))
  }
}
if (!tunnel) { console.error('4 次都没起来'); await server.close(); process.exit(1) }
publicHost = new URL(tunnel.url).hostname
console.log(`公网地址: ${tunnel.url}\n`)

let bad = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) bad += 1
}

// 关键：先等 40 秒再查第一次。Cloudflare 是隧道连上之后才建 DNS 记录的，
// 太早查会拿到 NXDOMAIN，被上游按负缓存记下来，之后记录建好了也照样失败。
console.log('  等 40 秒让 Cloudflare 把 DNS 记录建好（太早查会把 NXDOMAIN 缓存住）…')
await new Promise((r) => setTimeout(r, 40_000))

let reachable = false
let lastWhy = ''
for (let i = 0; i < 20 && !reachable; i += 1) {
  try {
    const r = await fetch(`${tunnel.url}/mini/api/state?token=${token}`, { signal: AbortSignal.timeout(8000) })
    reachable = true
    console.log(`  第 ${i + 1} 次访问通了，HTTP ${r.status}`)
  } catch (err) {
    lastWhy = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err)
    if (i % 5 === 4) console.log(`  第 ${i + 1} 次仍失败：${lastWhy}`)
    await new Promise((r) => setTimeout(r, 3000))
  }
}
check('公网地址能访问', reachable, lastWhy)
if (!reachable) { tunnel.stop(); await server.close(); process.exit(1) }

// 1. 带对密码 → 通
const okRes = await fetch(`${tunnel.url}/mini/api/state?token=${token}`)
check('公网带对密码能读到状态', okRes.status === 200, `HTTP ${okRes.status}`)

// 2. 不带密码 → 401
const anon = await fetch(`${tunnel.url}/mini/api/state`)
check('公网不带密码被拒', anon.status === 401, `HTTP ${anon.status}`)

// 3. 从公网错 5 次密码 → 触发封禁
for (let i = 0; i < 5; i += 1) {
  await fetch(`${tunnel.url}/mini/api/state?token=${'0'.repeat(32)}`)
}
const after5 = await fetch(`${tunnel.url}/mini/api/state?token=${token}`)
check('公网连错 5 次后，公网这条路被挡住', after5.status === 429, `HTTP ${after5.status}`)

// 4. 关键：本机直连不受影响
const localRes = await fetch(`${local}/mini/api/state?token=${token}`)
check('★ 本机直连不受公网试错影响（分桶生效）', localRes.status === 200, `HTTP ${localRes.status}`)

// 5. 匿名请求不消耗额度
const anon2 = await fetch(`${tunnel.url}/mini/api/state`)
check('匿名请求不算试错、不额外触发封禁', anon2.status === 429 || anon2.status === 401, `HTTP ${anon2.status}`)

tunnel.stop()
await server.close()
console.log(bad === 0 ? '\n结论：端到端全部通过' : `\n结论：${bad} 项失败`)
process.exit(bad === 0 ? 0 : 1)
