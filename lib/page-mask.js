/**
 * 凭据遮挡（2026-11-14）。
 *
 * 为什么必须做：手机上的对话记录会被截图、会被转发，而一条消息里常常带着
 * 刚配好的 Key。**默认只显示前八位**，要看成全文得点一下——这样"不小心截屏"
 * 不再等于"把钥匙交出去"。
 *
 * 只认**形状明确**的凭据（`sk-`、`ghp_`、`AKIA`、JWT、`Bearer …` 这些），
 * 不做"凡是长字符串就遮"的那种粗暴规则——那会把提交号、哈希、路径一起糊掉，
 * 而它们本来无害。
 */

/** 认得出的凭据形状。顺序有意义：先长后短，避免被短的先吃掉。 */
const PATTERNS = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-[A-Za-z0-9_\-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_\-]{30,}/g,
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}/g,
  /\bBearer\s+[A-Za-z0-9._\-]{20,}/g,
]

/** 给 JSON / 配置里那种 `"apiKey": "…"` 留的形状。 */
const ASSIGNED = /((["']?)(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|password|passwd|token)\2\s*[:=]\s*["']?)([A-Za-z0-9._\-+/=]{12,})/gi

/**
 * 把文本里的凭据换成占位符。
 *
 * @param {string} text
 * @returns {{text: string, secrets: string[]}}
 */
function maskSecrets(text) {
  const secrets = []
  let out = String(text == null ? '' : text)
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (hit) => {
      secrets.push(hit)
      return `@@SEC${secrets.length - 1}@@`
    })
  }
  out = out.replace(ASSIGNED, (hit, head, _quote, value) => {
    secrets.push(value)
    return `${head}@@SEC${secrets.length - 1}@@`
  })
  return { text: out, secrets }
}

/** 遮住之后给人看的形状：前八位 + 圆点。太短的干脆全遮。 */
function maskLabel(full) {
  const text = String(full || '')
  if (text.length <= 8) return '••••••'
  return text.slice(0, 8) + '••••'
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * 把渲染好的 HTML 里的占位符换成可点的小块。
 *
 * 点一下展开全文，再点收回去；`data-full` 里存原文，展开时不需要再问电脑。
 */
function paintSecrets(html, secrets) {
  if (!secrets || !secrets.length) return html
  return String(html).replace(/@@SEC(\d+)@@/g, (_, index) => {
    const full = secrets[Number(index)]
    if (full === undefined) return ''
    return '<span class="secret" data-full="' + escapeHtml(full) + '" role="button" tabindex="0" title="点一下看全文">'
      + escapeHtml(maskLabel(full)) + '</span>'
  })
}

/** 文本 → 带遮挡的 HTML。渲染路径都走它，免得各处自己拼。 */
function renderMasked(text, toHtml) {
  const { text: masked, secrets } = maskSecrets(text)
  return paintSecrets(toHtml(masked), secrets)
}

/** 点一下展开 / 收起。整页只绑一次。 */
function initSecrets() {
  if (typeof document === 'undefined' || document.__miniSecretsBound) return
  document.__miniSecretsBound = true
  document.addEventListener('click', (event) => {
    const hit = event.target && event.target.closest ? event.target.closest('.secret') : null
    if (!hit) return
    const full = hit.getAttribute('data-full') || ''
    const shown = hit.getAttribute('data-open') === '1'
    hit.textContent = shown ? maskLabel(full) : full
    hit.setAttribute('data-open', shown ? '0' : '1')
    event.stopPropagation()
  })
}
