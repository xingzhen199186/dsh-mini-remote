import { inflateRawSync } from 'node:zlib'

/**
 * 从 Office 文件里取出文字（2026-11-12）。
 *
 * 为什么要在**电脑这侧**做：手机浏览器里解 docx 要靠 `DecompressionStream`，
 * 老一点的 WebView 没有；xlsx 还要拼共享字符串表，手机上做又慢又容易失败。
 * 电脑这侧 Node 自带 zlib，几十行就够，手机只管显示文字。
 *
 * 只做**取字**，不做排版：段落之间换行，表格一行一条、用制表符分开。
 * 目标是"看得清内容"，不是还原版式。
 */

const MAX_ENTRY = 32 * 1024 * 1024

/** 最小的 zip 读取：找到中央目录，按名字取一条，需要时解压。 */
function readZipEntry(buf, wanted) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) return null
    const method = view.getUint16(p + 10, true)
    const csize = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const localOff = view.getUint32(p + 42, true)
    const entry = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    if (entry === wanted) {
      if (csize > MAX_ENTRY) return null
      const start = localOff + 30 + view.getUint16(localOff + 26, true) + view.getUint16(localOff + 28, true)
      const data = buf.subarray(start, start + csize)
      if (method === 0) return data
      if (method === 8) {
        try { return inflateRawSync(data) } catch { return null }
      }
      return null
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}

/** 列出 zip 里所有条目的名字（xlsx 要按顺序找 sheet1.xml 之类）。 */
function listZipEntries(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return []
  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)
  const names = []
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'))
    p += 46 + nameLen + extraLen + commentLen
  }
  return names
}

function unescapeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

/** word/document.xml → 纯文字：段落换行，制表保留。 */
function docxXmlToText(xml) {
  return unescapeXml(String(xml)
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function docxText(buf) {
  const xml = readZipEntry(buf, 'word/document.xml')
  if (!xml) return null
  return docxXmlToText(xml.toString('utf8'))
}

/**
 * xlsx → 一行一行的文字，单元格之间用制表符。
 *
 * 只读第一张表：用户的期望是"先看看里面写了什么"，
 * 把全部工作表都倒出来反而更难读。
 */
export function xlsxText(buf) {
  const shared = readZipEntry(buf, 'xl/sharedStrings.xml')
  const strings = []
  if (shared) {
    const xml = shared.toString('utf8')
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1]))
      strings.push(parts.join(''))
    }
  }
  const names = listZipEntries(buf)
  const sheetName = names.find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
  if (!sheetName) return null
  const sheet = readZipEntry(buf, sheetName)
  if (!sheet) return null
  const xml = sheet.toString('utf8')
  const lines = []
  for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = []
    for (const cell of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1]
      const inner = cell[2]
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1]
      let value = ''
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)
      if (type === 's') {
        value = v ? (strings[Number(v[1])] || '') : ''
      } else if (type === 'inlineStr') {
        const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)
        value = t ? unescapeXml(t[1]) : ''
      } else {
        value = v ? unescapeXml(v[1]) : ''
      }
      cells.push(value)
    }
    while (cells.length && cells[cells.length - 1] === '') cells.pop()
    lines.push(cells.join('\t'))
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text || null
}

/** 按扩展名挑一个解析器；不认识的返回 null。 */
export function officeText(buf, ext) {
  const e = String(ext || '').toLowerCase()
  if (e === '.docx') return { kind: 'docx', text: docxText(buf) }
  if (e === '.xlsx') return { kind: 'xlsx', text: xlsxText(buf) }
  return null
}
