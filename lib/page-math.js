/**
 * 公式渲染（2026-11-14）。
 *
 * 为什么打包 KaTeX 而不是用现成的在线服务：手机经常在内网或热点里，
 * 外面的地址不一定通；而且公式跟在回答里，**等它渲染完再闪一下**比不渲染更难看。
 *
 * 这里做两件事：
 *   1. 把 Markdown 里的 `$…$` 和 `$$…$$` 抠出来，换成占位符（**先抠再转义**，
 *      否则反斜杠会被 Markdown 吃掉）；
 *   2. 等 HTML 进到页面以后，再把占位符换成真正的公式——KaTeX 那 270KB
 *      第一次遇到公式才加载，不拖慢首屏。
 */

/** 从文本里抠出公式，占位符形如 `@@MATH0@@`。 */
function extractMath(text) {
  var items = []
  var src = String(text || '')
  var put = function (tex, display) {
    items.push({ tex: tex, display: display })
    return '@@MATH' + (items.length - 1) + '@@'
  }
  // 先认块级 `$$…$$`，再认行内 `$…$`；两段正则都要求成对出现，
  // 落单的 `$` 原样留着（价格、变量名里常有，不能当公式）。
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, function (_, tex) { return put(tex.trim(), true) })
  src = src.replace(/(^|[^\\$])\$([^$\n]*?)\$/g, function (all, before, tex) {
    // 公式内容**紧贴着美元符号**才是公式：`$x$` 是，`5$ 那个 8$` 不是。
    // 少了这一条，一句"这个 5$ 那个 8$"会把中间的字排版成公式。
    if (!tex.trim() || /^\s/.test(tex) || /\s$/.test(tex)) return all
    return before + put(tex.trim(), false)
  })
  return { text: src, items: items }
}

/** 把占位符换成待渲染的容器；真正的排版在页面里做。 */
function mathPlaceholders(html, items) {
  if (!items || !items.length) return html
  return String(html).replace(/@@MATH(\d+)@@/g, function (_, index) {
    var one = items[Number(index)]
    if (!one) return ''
    return '<span class="math' + (one.display ? ' math-block' : '') + '" data-tex="'
      + escapeHtmlForAttr(one.tex) + '"></span>'
  })
}

function escapeHtmlForAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

var katexPromise = null
/** KaTeX 只取一次；第一次遇到公式才加载（连样式一起）。 */
function loadKatex() {
  if (katexPromise) return katexPromise
  katexPromise = new Promise(function (resolve, reject) {
    var link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/mini/vendor/katex/katex.min.css'
    document.head.appendChild(link)
    var script = document.createElement('script')
    script.src = '/mini/vendor/katex/katex.min.js'
    script.onload = function () { resolve(window.katex || null) }
    script.onerror = function () { reject(new Error('取不到公式渲染器')) }
    document.head.appendChild(script)
  })
  return katexPromise
}

/** 把这一页里所有还没渲染的公式排出来。 */
function typesetMath(root) {
  var nodes = (root || document).querySelectorAll('.math[data-tex]:not([data-done])')
  if (!nodes.length) return
  for (var i = 0; i < nodes.length; i++) nodes[i].setAttribute('data-done', '1')
  loadKatex().then(function (katex) {
    if (!katex) return
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      if (!el.isConnected) continue
      try {
        katex.render(el.getAttribute('data-tex') || '', el, {
          displayMode: el.className.indexOf('math-block') >= 0,
          throwOnError: false,
        })
      } catch (err) {
        el.textContent = el.getAttribute('data-tex') || ''
      }
    }
  }).catch(function () {
    // 取不到就把源码原样显示——**源码也是能读的**，总比一片空白强。
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = nodes[i].getAttribute('data-tex') || ''
  })
}

/** 新内容进来就排一次（回答是流式追加的，不可能每次改完都记得调）。 */
function watchMath() {
  if (typeof MutationObserver !== 'function' || document.__miniMathWatching) return
  document.__miniMathWatching = true
  var timer = null
  var observer = new MutationObserver(function () {
    if (timer) return
    timer = setTimeout(function () { timer = null; typesetMath(document) }, 120)
  })
  observer.observe(document.body, { childList: true, subtree: true })
}
