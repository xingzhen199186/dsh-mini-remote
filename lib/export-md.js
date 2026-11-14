/**
 * 导出的 Markdown（2026-11-14）。
 *
 * 为什么导出成 Markdown 而不是压缩包：手机上下载一个 zip 再解压，等于把麻烦
 * 转手给用户；`.md` 任何编辑器、任何记事本都能开，微信里也能直接预览。
 *
 * 这里只管"把记录排成文字"，取数在插件那侧——分开才好单测。
 */

const WHO = { user: '我', assistant: 'AI', notice: '通知' }

/**
 * @param {{title:string, at:string, entries:Array<{role:string,text:string,timestamp?:number}>}} out
 * @returns {string}
 */
export function exportMarkdown(out) {
  const entries = Array.isArray(out?.entries) ? out.entries : []
  const lines = [`# ${String(out?.title || '未命名会话')}`, '', `导出时间：${out?.at || ''}`, `共 ${entries.length} 条`, '']
  for (const one of entries) {
    const who = WHO[one?.role] || '记录'
    const when = one?.timestamp ? new Date(one.timestamp).toLocaleString('zh-CN') : ''
    lines.push(`## ${who}${when ? '　' + when : ''}`, '', String(one?.text || '').trim(), '')
  }
  return lines.join('\n')
}

/** 文件名：去掉系统不认的字符，太长就截断（手机文件管理器会被长名搞吐）。 */
export function exportFileName(title) {
  const safe = String(title || '会话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  return `${safe || '会话'}.md`
}
