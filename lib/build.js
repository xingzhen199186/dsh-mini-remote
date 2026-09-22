/**
 * 构建指纹：把插件几个源文件的内容揉成一个短哈希。
 *
 * 为什么需要它：这个插件是「改完重启 DSH 才生效」的，而重启期间**旧进程还在应答**。
 * 于是「以为在验新代码，其实在验旧的」这件事已经发生过两次——把等待条件写成
 * 「某个接口返回 200」是不够的，因为那个接口很可能上一轮就已经部署了。
 *
 * 指纹能一句话回答那个问题：现在应答我的，是不是我改的那份代码。
 *
 * 注意用 fileURLToPath 而不是 URL.pathname——后者会把非 ASCII 路径编码坏掉，
 * 这个项目在工作目录里已经踩过一次。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 参与计算的文件：插件端的 lib/*，客户端那半边（改它同样要重启才生效），
 * 以及 lib/art 下的立绘——换了图，指纹就该跟着变。
 */
function sources() {
  const files = []
  try {
    for (const f of readdirSync(HERE).sort()) {
      if (f.endsWith('.js') || f.endsWith('.html')) files.push(join(HERE, f))
    }
  } catch {
    // 目录读不到就退化成空指纹，不该让插件起不来。
  }
  files.push(join(HERE, '..', 'client', 'client.js'))
  try {
    for (const f of readdirSync(join(HERE, 'art')).sort()) {
      if (f.endsWith('.webp')) files.push(join(HERE, 'art', f))
    }
  } catch {
    // 没有 art 目录（比如只拷了 .js 的旧安装）就当没有立绘，照常起。
  }
  return files
}

/**
 * 算一次指纹。**只在插件加载时调用一次**——它代表的是「这份代码被加载的时刻」，
 * 每次请求重算反而会把运行期改动也算进去，那就不叫构建指纹了。
 */
export function buildId() {
  const hash = createHash('sha256')
  for (const file of sources()) {
    hash.update(file)
    try {
      hash.update(readFileSync(file))
    } catch {
      hash.update('(读不到)')
    }
  }
  return hash.digest('hex').slice(0, 12)
}
