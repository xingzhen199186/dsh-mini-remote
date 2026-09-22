/**
 * 找到（或下载）cloudflared 可执行文件。
 *
 * cloudflared 是 Cloudflare 的隧道客户端。它从你的电脑主动连出去，Cloudflare
 * 那头给你一个公网网址，转发回本机的手机服务。好处是电脑不用有公网 IP、不用
 * 在路由器上开端口；代价是那个网址任何人都访问得到——密码和限速是唯一的门。
 *
 * 找的顺序是「能用现成的就不下载」：配置里指定的 → 系统 PATH 里的 → dsh-pocket
 * 已经下过的那份 → 自己下（下过一次就缓存下来）。
 */
import { chmod, mkdir, rename, rm, stat, access } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const BIN_NAME = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'

/**
 * 各系统对应的发布产物名。
 * 注意 linux 是**裸二进制**（没有 .tgz）——dsh-pocket 的注释里记着，早期给
 * linux 拼 `cloudflared-linux-amd64.tgz` 是错的，那个文件根本不存在。这里把
 * .tgz 留在候选里只作回退，万一上游改回打包方式也不会直接躺平。
 */
function assetNames() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  if (process.platform === 'win32') return ['cloudflared-windows-amd64.exe']
  if (process.platform === 'darwin') return [`cloudflared-darwin-${arch}.tgz`]
  return [`cloudflared-linux-${arch}`, `cloudflared-linux-${arch}.tgz`]
}

/**
 * 下载源，按顺序试。前三个是 GitHub 加速代理——国内直连 GitHub 的 release
 * 经常超时。（npmmirror 没有 cloudflared 镜像，实测 404，所以不在列表里。）
 *
 * 这三个加速源和 dsh-pocket（shaobeichen，GPL-2.0）用的是同一批。这类镜像地址是
 * 国内开发者的公共常识，不是谁的独创；这里记一笔，是为了不假装没见过它。
 * 代码本身（这个数组的形状、下载与校验流程）是我们自己写的。
 */
const MIRRORS = [
  (asset) => `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://gh.ddlc.top/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
]

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/**
 * 跑一次 `cloudflared --version` 看能不能用。
 * 比自己在 PATH 里拼路径可靠——PATH 之外还有别名、软链、包管理器装的 shim。
 */
function probe(command) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve(false)
      return
    }
    let out = ''
    const finish = (ok) => {
      clearTimeout(timer)
      try { child.kill() } catch { /* 已经退了 */ }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), 5000)
    timer.unref?.()
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.stderr?.on('data', (chunk) => { out += chunk })
    child.on('error', () => finish(false))
    child.on('close', (code) => finish(code === 0 && /cloudflared/i.test(out)))
  })
}

async function fetchTo(url, file) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (!res.body) throw new Error('响应没有正文')
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file))
  const { size } = await stat(file)
  // 代理挂掉时经常返回一个 HTML 错误页而不是报错，用体积把它挡掉
  if (size < 1_000_000) throw new Error(`文件只有 ${size} 字节，多半下到的是错误页`)
}

function extractTgz(archive, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', dir], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`))))
  })
}

async function download(dataDir, log) {
  const dir = join(dataDir, 'bin')
  await mkdir(dir, { recursive: true })
  const target = join(dir, BIN_NAME)
  const tmp = `${target}.part`
  const failures = []

  for (const asset of assetNames()) {
    for (const mirror of MIRRORS) {
      const url = mirror(asset)
      try {
        log?.info?.('正在下载 cloudflared（约 50MB，国内可能比较慢，只需一次）…')
        await fetchTo(url, tmp)
        if (asset.endsWith('.tgz')) {
          await extractTgz(tmp, dir)
          await rm(tmp, { force: true })
        } else {
          await rename(tmp, target)
        }
        if (process.platform !== 'win32') await chmod(target, 0o755)
        log?.info?.(`cloudflared 已下载到 ${target}`)
        return target
      } catch (err) {
        failures.push(`${new URL(url).host} — ${err?.message ?? err}`)
        await rm(tmp, { force: true })
      }
    }
  }

  throw new Error(`所有下载源都没成功：\n  ${failures.join('\n  ')}`)
}

/**
 * @param {object} opts
 * @param {string} [opts.configuredPath] settings.json 里的 cloudflaredPath
 * @param {string} opts.dataDir 插件数据目录（下载物落在它的 bin/ 下）
 * @returns {Promise<{path: string|null, source?: string, error?: string}>}
 */
export async function ensureCloudflared({ configuredPath, dataDir, log }) {
  if (configuredPath) {
    if (await exists(configuredPath)) return { path: configuredPath, source: 'configured' }
    return { path: null, error: `settings.json 里的 cloudflaredPath 指向的文件不存在：${configuredPath}` }
  }

  if (await probe('cloudflared')) return { path: 'cloudflared', source: 'path' }

  // dsh-pocket 很可能已经下过一份，直接复用，省掉 50MB 下载
  const shared = join(dirname(dataDir), 'dsh-pocket', 'bin', BIN_NAME)
  if (await exists(shared)) return { path: shared, source: 'dsh-pocket' }

  const cached = join(dataDir, 'bin', BIN_NAME)
  if (await exists(cached)) return { path: cached, source: 'cached' }

  try {
    return { path: await download(dataDir, log), source: 'downloaded' }
  } catch (err) {
    return {
      path: null,
      error: `${err?.message ?? err}\n也可以自己装一个（apt/dnf install cloudflared），`
        + '或者在 settings.json 里用 cloudflaredPath 直接指向它。',
    }
  }
}
