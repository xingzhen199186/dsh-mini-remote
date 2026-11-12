import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { docxText, xlsxText, officeText } from '../lib/office-text.js'

/**
 * 电脑这侧从 Office 文件里取字（2026-11-12）。
 *
 * 手机上解不动 docx/xlsx：一个要 DecompressionStream（老 WebView 没有），
 * 一个还要拼共享字符串表。所以放到 Node 里做，手机只管显示。
 */

/** 造最小 zip（存储方式，够解析器认就行）。 */
function makeZip(files) {
  const chunks = []
  const central = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const dataBuf = Buffer.from(content, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(dataBuf.length, 18)
    local.writeUInt32LE(dataBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, dataBuf)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt32LE(dataBuf.length, 20)
    cd.writeUInt32LE(dataBuf.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += local.length + nameBuf.length + dataBuf.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cdBuf, eocd])
}

test('docx 取出段落文字', () => {
  const buf = makeZip({
    'word/document.xml': '<w:document><w:body>'
      + '<w:p><w:r><w:t>第一段 &amp; 符号</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>第二段</w:t></w:r></w:p>'
      + '</w:body></w:document>',
  })
  const text = docxText(buf)
  assert.equal(text.split('\n').filter(Boolean).length, 2)
  assert.match(text, /第一段 & 符号/)
  assert.doesNotMatch(text, /<w:/)
})

test('xlsx 取出单元格，一行一条、制表符分隔', () => {
  const buf = makeZip({
    'xl/sharedStrings.xml': '<sst><si><t>姓名</t></si><si><t>张远</t></si>'
      + '<si><r><t>备</t></r><r><t>注</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
      + '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c><v>42</v></c></row>'
      + '<row><c t="s"><v>2</v></c></row>'
      + '</sheetData></worksheet>',
  })
  const text = xlsxText(buf)
  const lines = text.split('\n')
  assert.equal(lines.length, 2)
  assert.equal(lines[0], '姓名\t张远\t42')
  assert.equal(lines[1], '备注')
})

test('老格式和不认识的文件如实返回空，不瞎猜', () => {
  assert.equal(officeText(Buffer.from('not a zip'), '.docx').text, null)
  assert.equal(officeText(makeZip({ 'other.xml': '<a/>' }), '.docx').text, null)
  assert.equal(officeText(Buffer.from('x'), '.txt'), null)
})

test('聊天里点开的文件认得 docx/xlsx/pdf', () => {
  const page = readFileSync(new URL('../lib/page.js', import.meta.url), 'utf8')
  assert.match(page, /ext === '\.docx' \|\| ext === '\.xlsx' \|\| ext === '\.pdf'/)
  // 直接当文本读会得到乱码，必须走取字。
  assert.match(page, /officeText\(readFileSync\(file\)/)
})

test('PDF 三条路都要能渲染，不许再被拦下', () => {
  const files = readFileSync(new URL('../lib/page-files.js', import.meta.url), 'utf8')
  // 发送前预览：本地 PDF 直接交给 PDF.js（2026-11-12 真机报"这个格式手机上不能预览"）。
  assert.match(files, /previewPdf\(f\)/)
  assert.match(files, /renderPdfInto\(body, \{ data: buf \}/)
  // 聊天里点开的文件、发送后的附件：都走同一个渲染器。
  assert.match(files, /renderPdfInto\(body, \{ url: '\/mini\/file\?raw=1/)
  assert.match(files, /renderPdfInto\(body, \{ url: attachmentUrl\(id\)/)
  // 不许再出现“手机上不能看”的旧说法。
  assert.doesNotMatch(files, /PDF 手机上不能直接看/)
})

test('PDF 按设备像素密度画，否则在手机上一定糊', () => {
  const files = readFileSync(new URL('../lib/page-files.js', import.meta.url), 'utf8')
  // 2026-11-12 用户反馈：第一版只按 CSS 宽度画，2~3 倍屏上看着糊。
  assert.match(files, /devicePixelRatio/)
  // 而且要点一下能放大重画：整页压到屏幕宽时字必然小到看不清。
  assert.match(files, /pdf-zoom/)
  assert.match(files, /scrollIntoView/)
})

test('页面脚本的缓存要跟着文件变，否则改了页面必须重启才生效', () => {
  const page = readFileSync(new URL('../lib/page.js', import.meta.url), 'utf8')
  // 2026-11-12 踩过：jsText/cssText 只读一次，改完页面刷新一百次还是旧的。
  assert.match(page, /function filesStamp\(\)/)
  assert.match(page, /if \(stamp !== cacheStamp\)/)
  assert.match(page, /cacheStamp = stamp/)
})
