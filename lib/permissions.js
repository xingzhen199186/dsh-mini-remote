/**
 * 手机端切换权限档位。
 *
 * ## 为什么做这个
 *
 * 在它之前，README 里有一条硬要求：「要在移动端使用该插件，请将 PC 端 DSH 会话
 * 页面切换到【完全权限】」——因为审批弹窗长在电脑屏幕上，手机上点不着。
 *
 * 那条要求等于**逼着用户把电脑永久钉在最高权限上**。这是个很糟的默认值：
 * 他一天里可能只有十分钟需要 Agent 动文件，剩下时间电脑都敞着。
 *
 * 有了这个之后，电脑可以长期停在「仅可查看」，需要的时候从手机上抬上去。
 *
 * ## 代价（必须说清楚，不许粉饰）
 *
 * **手机从此能指挥 Agent 把电脑提到完全权限。** 也就是说，PC 端那道授权闸门
 * 被搬到了手机上——闸门还在（要 token / 密码），但它守的那扇门换了一扇。
 * 拿到手机的人，等于拿到了这台电脑的写权限。这是功能本身的代价，不是实现瑕疵。
 *
 * ## 和 DSH 的关系
 *
 * 我们不自己管权限，只是把 DSH 的 `PermissionPresetService` 接到手机上。
 * 它按会话生效（`set(session, name)`），所以作用域天然就是「当前绑定的那个会话」。
 *
 * 档位名和标签**一律运行时读**（`names` / `optionOf`），一个都不写死：
 * 这台机器的配置里到底两个档位还是三个、中文叫什么，只有跑起来才知道。
 */

/** 档位表里的保留名，代表「当前旋钮值不匹配任何档位」。它不是一个切换目标。 */
export const CUSTOM_PRESET = 'custom'

/**
 * 沙箱模式里最放开的那一档。
 *
 * 判断「哪个档位要额外确认」用的是**这个协议常量**，不是档位名。
 * 档位名是这台机器的配置（可能是 `danger-full-access`，也可能被人改叫别的），
 * 猜名字一定会错；而 `sandbox` 这个旋钮的取值是 DSH 自己的协议，稳定。
 */
export const FULL_ACCESS_MODE = 'danger-full-access'

/**
 * 档位标识符 → 中文标签。
 *
 * ## 为什么这张表在我们这儿，而不在服务里
 *
 * `PermissionPresetService.optionOf()` 只在**配置里定义过 `name`** 时才给标签。
 * 本机没定义，于是它退回了键名——手机上就会显示 `read-only` /
 * `workspace-write` / `danger-full-access` 三串英文。
 *
 * 那么三个中文（仅可查看 / 工作区内修改 / 完全权限）在哪？在 **DSH 自己的网页
 * 界面**里，是客户端那侧的翻译，服务里没有。所以只能我们这一侧补一份。
 *
 * 标识符本身是稳定的（它们是 DSH 的档位键名，不是这台机器的自定义名字），
 * 可以放心当键。真正会变的是**配置里给的自定义标签**——见 labelOf。
 */
export const PRESET_LABELS = {
  'read-only': '仅可查看',
  'workspace-write': '工作区内修改',
  'danger-full-access': '完全权限',
}

/**
 * 决定一个档位显示成什么。
 *
 * 优先级：
 *   1. 配置里明确给了标签（且跟键名不一样）——**尊重这台机器主人的命名**。
 *      他在配置里写了「只读模式」，我们不该拿一张通用表把它盖回去。
 *   2. 我们的映射表。
 *   3. 原始标识符。
 *
 * 第 3 条是给未来留的：DSH 哪天加了个新档位，界面上会显示它的标识符——
 * 不好看，但那是个**真名字**，不至于变成空白或者「未知」。
 */
export function labelOf(value, configured) {
  if (typeof configured === 'string' && configured && configured !== value) return configured
  return PRESET_LABELS[value] ?? value
}

/** 服务是不是真的能用。拿不到（headless 组合里就没有）时整块不显示。 */
export function available(service) {
  return Boolean(service) && Array.isArray(service.names)
}

/** 这个档位是不是「完全权限」——切到它要一次显式确认。 */
function dangerousOf(service, name) {
  try {
    return service.resolve(name)?.sandbox === FULL_ACCESS_MODE
  } catch (err) {
    // resolve 对表外的名字会抛。表里列了却 resolve 不了，当作不危险：
    // 宁可少问一次，也不要因为一个读不到的值把整个界面卡死。
    return false
  }
}

/**
 * 当前会话的档位盘：有哪些档位、现在在哪一档。
 *
 * 返回 `{ ok:false, reason:'no-service' }` 时，调用方应当**整块不显示**，
 * 遥控本身照常——它是个附加能力，缺了不该影响发指令。
 */
export function listPresets({ service, session }) {
  if (!available(service)) return { ok: false, reason: 'no-service' }
  if (!session) return { ok: false, reason: 'no-session' }

  const options = []
  for (const name of service.names) {
    try {
      const option = service.optionOf(name)
      options.push({
        value: option.value,
        // 服务给的是标识符（本机没配中文），中文在这一侧映射；
        // 映射不到就用原始标识符，不留空。
        name: labelOf(name, option.name),
        description: option.description ?? '',
        dangerous: dangerousOf(service, name),
      })
    } catch (err) {
      // 表里列了这个档位、optionOf 却不认——跳过这一个，别把整盘弄没。
    }
  }

  let currentValue = ''
  try {
    currentValue = service.current(session)
  } catch (err) {
    currentValue = ''
  }
  // `custom` 只在它真的生效时补一格，用来**显示**（不匹配任何档位，
  // 比如有人在电脑上手动调过旋钮）。它永远不是切换目标。
  if (currentValue === CUSTOM_PRESET && !options.some((o) => o.value === CUSTOM_PRESET)) {
    try {
      const option = service.optionOf(CUSTOM_PRESET)
      options.push({
        value: option.value,
        name: labelOf(CUSTOM_PRESET, option.name),
        description: option.description ?? '',
        dangerous: false,
      })
    } catch (err) { /* 拿不到就不要这一格，反正 currentValue 会显示出来 */ }
  }

  return { ok: true, options, currentValue }
}

/**
 * 换一档。
 *
 * **手机传来的档位名当不可信输入**：只接受 `names` 里真实存在的那几个，
 * 绝不直接透传给 `set()`。`set()` 对未知名字是**抛错**，不是默默忽略——
 * 透传的话，一个拼错的名字会变成一条 500，而用户看到的是一句看不懂的话。
 */
export function setPreset({ service, session, name }) {
  if (!available(service)) return { ok: false, reason: 'no-service' }
  if (!session) return { ok: false, reason: 'no-session' }
  if (typeof name !== 'string' || !service.names.includes(name)) {
    return { ok: false, reason: 'unknown-preset' }
  }
  try {
    // set() 是同步的：它记一条 preset 事件，再把变了的旋钮各自写一遍。
    service.set(session, name)
  } catch (err) {
    return { ok: false, reason: 'failed', error: String(err?.message ?? err) }
  }
  return { ok: true, name }
}
