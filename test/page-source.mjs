/**
 * 测试用：把「手机页」拼成一份完整源码。
 *
 * 页面从 2026-11-03 起拆成几份：page.html（结构）+ page.css（样式）+
 * page-core/render/nav/ui/app.js（脚本，按这个顺序拼回同一个 <script>）。
 * 2026-11-05 把 core 与 nav 又各切一刀，拼回去的顺序和原来完全一致。
 * 各测试都在整份源码上按锚点切片，所以先在这里拼回去，别在测试里各写一份。
 */
import { readFileSync } from 'node:fs'

const read = (f) => readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8')

// 拼接顺序是硬约束：这五份本来是同一个 IIFE，顺序错了就是这个页面坏了。
const JS_PARTS = ['page-core.js', 'page-mask.js', 'page-search.js', 'page-math.js', 'page-diff.js', 'page-scrollprobe.js', 'page-markdown.js', 'page-render.js', 'page-trajectory.js', 'page-nav.js', 'page-ui.js', 'page-files.js', 'page-app.js']

/** 只要脚本那五份拼好的整段 JS（不含 HTML/CSS），给结构检查用。 */
export function pageScript() {
  return JS_PARTS.map(read).join('\n')
}

export function pageSource() {
  return read('page.html')
    .replace('__PAGE_CSS__', () => read('page.css'))
    .replace('__PAGE_JS__', () => pageScript())
}
