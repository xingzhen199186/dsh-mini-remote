/**
 * 把单文件移动端页面读进来，注入两个启动常量；另外负责读立绘。
 *
 * 页面之所以放独立 .html 而不是塞进 JS 模板字符串：省掉满屏的反引号和 ${} 转义，
 * 编辑器也能正常高亮。对外仍然是一个文件。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE_PATH = join(HERE, 'page.html')
const ART_DIR = join(HERE, 'art')

let template = null

export function renderPage({ defaultMode = 'minimal', needsToken = false, build = '', maxUpload = 0 } = {}) {
  if (template === null) template = readFileSync(PAGE_PATH, 'utf8')
  return template
    .replace('__DEFAULT_MODE__', defaultMode === 'chat' ? 'chat' : 'minimal')
    .replace('__NEEDS_TOKEN__', needsToken ? 'true' : 'false')
    // 立绘地址带上构建指纹（页面自己拼 ?v=__BUILD__），换了图浏览器就不会一直
    // 拿缓存里那张。只留字母数字，别让它有机会往 HTML 里塞东西。
    .replace('__BUILD__', String(build).replace(/[^a-zA-Z0-9]/g, ''))
    // 上传的体积上限由服务端注入，页面里不再写第二份。两处各写一个数迟早会不一致，
    // 而那时候的表现是「页面让你传，服务端拒绝」——最难查的那种不一致。
    .replace('__MAX_UPLOAD__', String(Number(maxUpload) > 0 ? Math.floor(maxUpload) : 0))
}

/** 立绘文件名长这样：work-3-typing.webp。 */
const ART_NAME = /^[a-z0-9-]+\.webp$/

/**
 * 读一张立绘，读不到返回 null。
 *
 * 名字用白名单卡死形状——不能只靠调用方过滤。这是唯一一处把请求里的字符串
 * 拼进文件路径的地方，`../` 这类穿越必须在这里就堵死。
 */
export function readArt(name) {
  if (typeof name !== 'string' || !ART_NAME.test(name)) return null
  try {
    return readFileSync(join(ART_DIR, name))
  } catch {
    return null
  }
}
