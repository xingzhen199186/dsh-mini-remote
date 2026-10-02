/**
 * live-check 里那几段「给几个值、判一个结论」的纯判断，抽出来只为一件事：**能单测**。
 *
 * `tools/live-check.mjs` 是个从头顶到尾都是副作用的脚本——读 token、打真接口、往终端
 * 打结果，`import` 一下就等于跑一遍活体检查。所以放在它里面的判据永远测不到，
 * 只能靠「跑一遍看看」来验，而「跑一遍」还得有台活着的宿主。
 *
 * 这里放的都是不需要宿主就能判的东西：脚本 import 它、测试也 import 它，判据只有一份。
 */

/**
 * DSH 自己那台 web 服务可能蹲的端口，按「先试哪个」的顺序排。
 *
 * 3080 是 `dsh web` 的默认口，19387 是桌面端应用的默认口（2026-10 换成桌面端之后
 * 才多出这一档）。顺序不是随意的：先把最老、最常见的那条路试掉。
 */
export const ADMIN_PORT_CANDIDATES = [3080, 19387]

/**
 * 找出 DSH 自己的 web 服务现在在哪个端口。
 *
 * 为什么要探测：设置页那几个接口（`/mini-remote/*`）挂在 **DSH 自己的 web 服务**上，
 * 而它的端口跟着**宿主形态**走。写死一个数的后果不是「这条检查失败」，而是
 * **对着一扇没人听的窗户说话**：fetch 直接抛，连带下面「拿到的确实是配对信息」那条
 * 也一起判空——两项红，全是这一个数造成的。
 *
 * 判据是「答得上话 **而且** 正文是配对信息（带 entries 数组）」，不只是「这个端口有人听」：
 * 3080 上完全可能蹲着别的东西，那种情况要接着往下试，而不是认定它就是我们等的那台。
 *
 * @param {{candidates?: number[], fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{port: number, tried: Array<{port: number, status: number, pairing: boolean, error?: string}>}>}
 *   `port` 为 0 表示一个都没答上——调用方该如实报出来，不要装作没这回事。
 */
export async function pickAdminPort({ candidates = ADMIN_PORT_CANDIDATES, fetchImpl = fetch } = {}) {
  const tried = []
  for (const port of candidates) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/mini-remote/pairing`)
      const body = await res.json().catch(() => null)
      const pairing = Boolean(body && Array.isArray(body.entries))
      tried.push({ port, status: res.status, pairing })
      if (pairing) return { port, tried }
    } catch (err) {
      tried.push({ port, status: 0, pairing: false, error: String((err && err.message) || err) })
    }
  }
  return { port: 0, tried }
}

/**
 * 把探测过程写成一句人话，好让人一眼看出这次连的是哪个端口、为什么是它。
 *
 * 明确写出「试过哪些、每个答了什么」：探测失败时最容易被写成一句含糊的「连不上」，
 * 而真正要回答的问题恰恰是「你连的是哪个口」。端口不对，下面每一条结论都不算数。
 */
export function describeAdminPort({ port, tried }) {
  const parts = (tried ?? []).map((t) => (t.status
    ? `${t.port} 应答（HTTP ${t.status}${t.pairing ? '，是配对信息' : '，但不是配对信息'}）`
    : `${t.port} 无人应答（${t.error}）`))
  const head = port ? `admin 端口 ${port}` : 'admin 端口没探到'
  return parts.length ? `${head}（依次试：${parts.join(' → ')}）` : head
}

/**
 * 宿主自己插进来、**不算「配置里的档位」**的保留档位名。
 *
 * `auto`（桌面端叫 Auto review）由宿主的实验组合 `@deepseek-ai/dsh-experimental-auto-review`
 * 注册进来，`PermissionPresetService.names` 把它排在配置档位之后；没装那个组合就没有它。
 * 它的沙箱是按协议写死的完全放开（`AUTO_PRESET_SPEC.sandbox` 就是 `danger-full-access`），
 * 所以它天生带危险标记——手机点它同样要过那一次二次确认。
 */
export const HOST_RESERVED_PRESETS = ['auto']

/**
 * 把权限档位盘拆成两摞：**配置里的档位**和**宿主保留档**。
 *
 * 为什么非得拆：「危险的档位恰好一个」这条判据，在桌面端形态下会**必然报红**——
 * 档位从三个变四个（多出 auto），而 auto 的沙箱就是完全放开，于是危险的变成两个。
 * 但那个红不是错，是宿主形态变了。
 *
 * 真正的错是**配置档位里**危险的不是恰好一个：比如「完全权限」那一档的危险标记丢了，
 * 手机上点一下就直接提权、中间那道二次确认没了。所以判据只数配置档位，
 * 保留档单独看，各管各的：
 *
 *   - `danger`：配置档位里带危险标记的。要求恰好一个，且必须落在完全权限那一档上。
 *   - `reservedMissed`：保留档里**没带**危险标记的。要求为空——它的沙箱按协议就是
 *     完全放开，不标等于放它进来不用确认。
 *
 * 拆开而不是删掉：把 auto 排除出「恰好一个」之后，如果没人接着看它，
 * 这条判据就从「多标少标都等于确认失效」退化成「不看了」。
 */
export function splitPresets(options) {
  const list = Array.isArray(options) ? options : []
  const isReserved = (o) => HOST_RESERVED_PRESETS.includes(o?.value)
  const configured = list.filter((o) => !isReserved(o))
  const reserved = list.filter(isReserved)
  return {
    configured,
    reserved,
    danger: configured.filter((o) => o.dangerous),
    reservedMissed: reserved.filter((o) => !o.dangerous),
  }
}
