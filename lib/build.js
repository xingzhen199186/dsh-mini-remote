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
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 参与计算的文件：插件端的 lib/*，客户端那半边（改它同样要重启才生效），
 * 以及 lib/art 下的立绘——换了图，指纹就该跟着变。
 *
 * **哈希里放的是文件名，不是路径。** 插件平时是被 DSH 通过一条目录链接
 * （`profiles/web/node_modules/dsh-mini-remote` → 工作副本）加载的，
 * `import.meta.url` 拿到的于是是**链接那条**路径。早先这里把绝对路径也揉进哈希，
 * 结果同一份代码经链接和经真实路径是两个数，「现在应答我的，是不是我改的那份代码」
 * 这条检查永远报红。文件名加内容足够认人——路径是环境，不是代码。
 */
function sources() {
  const files = []
  try {
    for (const f of readdirSync(HERE).sort()) {
      if (f.endsWith('.js') || f.endsWith('.html')) files.push([f, join(HERE, f)])
    }
  } catch {
    // 目录读不到就退化成空指纹，不该让插件起不来。
  }
  files.push(['client/client.js', join(HERE, '..', 'client', 'client.js')])
  try {
    for (const f of readdirSync(join(HERE, 'art')).sort()) {
      // `out-` 开头的是给手机看图用的展示图（.gitignore 里专门让路的那批），随时会增删替换，
      // 不是这份代码的一部分。把它们算进指纹的后果是：每贴一张看图指纹就变一次，重启校验
      // 会因此白报一次红——2026-09-28 连着踩了两回。
      if (f.endsWith('.webp') && !f.startsWith('out-')) files.push(['art/' + f, join(HERE, 'art', f)])
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
  for (const [name, file] of sources()) {
    hash.update(name)
    try {
      hash.update(readFileSync(file))
    } catch {
      hash.update('(读不到)')
    }
  }
  return hash.digest('hex').slice(0, 12)
}

/**
 * 参与指纹的那几个文件里，**最后被改动的是什么、什么时候**。
 *
 * 为什么要它（2026-10-17）：这份代码是「改完重启 DSH 才生效」的，而重启之前旧进程
 * 照旧应答。把这份时刻和进程的启动时刻比一下，就能一句话回答「现在跑的是不是最新那份」
 * ——那天真机上那件怪事（桌面端连开一天，新功能一个都没出现）就是这么来的：
 * **进程比代码旧**。
 *
 * 和 `buildId()` 是同一份文件清单（`sources()`），所以"哪几个文件算这份代码"只有一处定义。
 *
 * 返回 `{ file, at }`：`file` 是相对插件根目录的路径（好认），`at` 是毫秒时间戳。
 * 一个文件都读不到时回 `null`——调用方（自检）宁可说「未知」，也不抛错。
 */
export function newestSource() {
  let newest = null
  for (const [name, file] of sources()) {
    try {
      // `mtimeMs` 是浮点（带小数），摆进接口里难看也没必要：毫秒取整就够用。
      const at = Math.round(statSync(file).mtimeMs)
      if (!newest || at > newest.at) {
        // sources() 里 lib 下那几个只记了光名字（指纹里也是这么用的），
        // 摆给用户看时补上目录，他才知道改的是哪一份。
        newest = { file: name.includes('/') ? name : `lib/${name}`, at }
      }
    } catch {
      // 读不到就跳过：这正是"这份安装少了一部分文件"时该有的样子。
    }
  }
  return newest
}
