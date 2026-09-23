/**
 * 电脑目录浏览，给手机挑工作区用。
 *
 * ## 为什么自己用 node:fs 实现，而不是用 DSH 的目录选择器
 *
 * DSH 有 `@deepseek-ai/dsh-host-directory-picker`，能力是分叉的：一种是 native
 * （在**电脑屏幕上**弹系统选择框），一种是 browse（纯数据，什么都不往电脑屏幕上画）。
 * 哪个生效由 `directory-picker-auto` 开机时判：
 *
 *     if (facts.bindHost !== "127.0.0.1") return "browse";
 *     if (facts.ssh)                       return "browse";
 *     if (platform === "darwin" || platform === "win32") return "native";
 *
 * 也就是说：**Windows + 只绑回环地址（大多数人的默认配置）→ 判成 native**。
 * 而 native 模式下 `list` / `createDirectory` 这类动词是**直接被拒绝**的，不是降级
 * 模拟（那套设计明确说 refused verbs are refused, not approximated）。
 * 结果就是：用户坐在电脑前，手机上点「新建工作区」，电脑屏幕上弹出一个框——
 * 而他正在外面用手机。这条路走不通。
 *
 * 所以我们自己读目录。理由不是「更简单」，是**跟绑定地址无关、行为可预测**：
 * 不管 DSH 绑回环还是绑局域网、不管有没有走 SSH，手机看到的都是同一份数据。
 *
 * ## 边界
 *
 * 只列**目录**，绝不列文件、绝不读文件内容。手机上要的是「挑一个文件夹」，
 * 文件既是噪音也是不必要的暴露。
 *
 * ## 关于「手机传来的路径不可信」
 *
 * 手机是网络对面来的输入，所以这里对路径只做两件事：**规范化**（`resolve` 掉
 * `..`、`.`）和**拒绝畸形输入**（空字节、非字符串）。不做白名单式的根限制，
 * 因为「挑一个项目文件夹」本来就要能走到任意盘；真正的闸门是那道 token，
 * 它才是「谁在跟我说话」的判据。这里防的是**畸形路径导致的意外文件操作**，
 * 不是防已通过认证的用户去访问自己的电脑。
 */
import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'

/** 一次最多列多少个子目录。手机上再多也划不动，而且超大目录读起来很慢。 */
export const MAX_DIRS = 300

/** 「最近用过的目录」最多给几个。 */
export const MAX_RECENT = 8

/**
 * 目录名合不合法。口径照 DSH 自己的校验来，只多一条空字节：
 * 空字节在 Windows 上会让底层调用抛一个很难看的错，早点挡住。
 *
 * 注意这里挡的是**名字**（单个目录名），不是路径——路径是另一回事，
 * 它要允许 `I:\a\b` 这种带分隔符的形态。
 */
export function validDirName(name) {
  return typeof name === 'string'
    && name.trim() !== ''
    && name !== '.'
    && name !== '..'
    && !/[/\\]/.test(name)
    && !name.includes('\0')
}

/**
 * 规范化手机传来的路径。
 *
 * `resolve` 会把 `..` 和 `.` 算掉，所以 `I:\a\..\..\Windows` 会变成 `I:\Windows`——
 * 这是**故意的**：我们不去猜用户想干什么，只保证拿去读的是一条干净的绝对路径。
 * 畸形输入（不是字符串、空字节）直接拒绝，不试着修补。
 */
export function normalizePath(input) {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed === '' || trimmed.includes('\0')) return null
  return resolve(trimmed)
}

/**
 * 从根到目标的那一串祖先，做面包屑用。
 *
 * 纯字符串运算，不碰磁盘：面包屑要在目录读失败时照样画得出来，
 * 不然用户会卡在一个空白页面上，连退都退不回去。
 */
export function ancestorsOf(full) {
  const { root } = parse(full)
  const out = [{ name: root, path: root }]
  let cur = root
  for (const part of full.slice(root.length).split(sep)) {
    if (!part) continue
    cur = join(cur, part)
    out.push({ name: part, path: cur })
  }
  return out
}

/**
 * 盘符列表（Windows）。
 *
 * 用 A–Z 逐个 stat 探，不 spawn 任何进程：探测本身很便宜，而且结果缓存一次——
 * 盘符在一个会话里不会变，没必要每次开面板都探 26 次。
 * 非 Windows 上只有一个根 `/`。
 */
let drivesCache = null
async function drivesOf() {
  if (process.platform !== 'win32') return [sep]
  if (drivesCache) return drivesCache
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const found = await Promise.all(letters.map(async (letter) => {
    const root = letter + ':' + sep
    try {
      const info = await stat(root)
      return info.isDirectory() ? root : null
    } catch (err) {
      // 没这个盘、或者是个空的光驱——都当作不存在。
      return null
    }
  }))
  drivesCache = found.filter(Boolean)
  return drivesCache
}

/**
 * 常用位置。手机打开「新建工作区」时看到的第一屏。
 *
 * 起点为什么要给这些、而不是直接甩盘符：这个插件的门槛要低到非技术用户能走通。
 * 从 `C:\` 一层层点进去找一个项目文件夹，是要人自己知道路径长什么样；
 * 而「主目录 / 盘符 / 最近用过的」这三样，大多数时候点两下就到地方了。
 *
 * `recent` 由调用方给（我们拿的是已登记工作区的路径）——那些正是「他用过的目录」，
 * 而且不用我们另外记一份「最近打开过什么」的状态。
 */
export async function listRoots({ recent = [] } = {}) {
  const home = homedir()
  const seen = new Set([home.toLowerCase()])
  const recentOut = []
  for (const p of recent) {
    if (typeof p !== 'string' || !p) continue
    const key = p.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    recentOut.push(p)
    if (recentOut.length >= MAX_RECENT) break
  }
  return { home, drives: await drivesOf(), recent: recentOut }
}

/**
 * 列一个目录下的**子目录**。
 *
 * 读不出来时**如实抛错**，不吞掉当作空目录：空目录和「没有权限读」在界面上
 * 长得一模一样，而后者用户需要知道（他可能是选错了地方，也可能是权限问题）。
 */
export async function listDirectory(input) {
  const full = normalizePath(input)
  if (!full) return { ok: false, reason: 'bad-path' }

  let entries
  try {
    entries = await readdir(full, { withFileTypes: true })
  } catch (err) {
    return { ok: false, reason: 'unreadable', error: String(err?.code ?? err?.message ?? err) }
  }

  const dirs = []
  const links = []
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.push(entry.name)
    // 符号链接 / 目录联接自己不说自己通向哪儿，得问一次 stat。
    // 只对链接做这一步：普通条目已经在 dirent 里带类型了，不必每条都 stat。
    else if (entry.isSymbolicLink()) links.push(entry.name)
  }
  for (const name of links) {
    try {
      const info = await stat(join(full, name))
      if (info.isDirectory()) dirs.push(name)
    } catch (err) {
      // 断掉的链接：跳过，不是错误。
    }
  }

  // 排序要**不区分大小写**：Windows 的文件名本来就不区分大小写，
  // 按码点排会把所有大写开头的目录全排到前面，看起来像乱的。
  dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

  const truncated = dirs.length > MAX_DIRS
  return {
    ok: true,
    path: full,
    ancestors: ancestorsOf(full),
    dirs: dirs.slice(0, MAX_DIRS).map((name) => ({ name, path: join(full, name) })),
    total: dirs.length,
    truncated,
  }
}

/**
 * 在一个目录下新建一个子目录。
 *
 * **`name` 必须是单个合法目录名**（见 validDirName），不接受路径：手机传来的东西
 * 当不可信处理，一个带 `..` 或分隔符的「名字」能让新建落到别的地方去。
 *
 * 不用 `recursive: true`：父目录必须已经存在，那是调用方选中的地方。
 * 加了 recursive 反而会把「父目录没了」这种真实错误悄悄糊过去。
 */
export async function makeDirectory(parentInput, name) {
  if (!validDirName(name)) return { ok: false, reason: 'bad-name' }
  const parent = normalizePath(parentInput)
  if (!parent) return { ok: false, reason: 'bad-path' }

  const target = join(parent, name)
  try {
    await mkdir(target)
  } catch (err) {
    if (err?.code === 'EEXIST') return { ok: false, reason: 'exists' }
    return { ok: false, reason: 'failed', error: String(err?.code ?? err?.message ?? err) }
  }
  return { ok: true, path: target }
}
