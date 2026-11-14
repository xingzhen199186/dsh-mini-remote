import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

/**
 * docx 预览（2026-11-12）。
 *
 * 之前上传前的预览不分类型一律 readAsText，Word 文档本质是压缩包，
 * 于是手机上显示满屏 PK 和乱码。现在按类型走：docx 先把 zip 拆开、
 * 读 word/document.xml、去掉标签，只留文字。
 *
 * 这里用真的（最小的）zip 验一遍，不是只 grep 代码。
 */

const SRC = readFileSync(new URL('../lib/page-files.js', import.meta.url), 'utf8')

function sliceFunctions() {
  const start = SRC.indexOf('  async function docxToText(')
  // 拆出 page-files.js 之后，docx 解析后面接的是附件助手，不再是 dropUpload。
  // 文件树那一块（2026-11-14）夹在中间，它要 document，不属于解析器切片。
  const end = SRC.indexOf('  document.addEventListener(')
  assert.ok(start > 0 && end > start, '找不到 docx 解析那一段')
  return SRC.slice(start, end)
}

/** 造一个最小 zip（不压缩），够 docx 解析器认就行。 */
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
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)          // 存储方式：不压缩
    local.writeUInt32LE(dataBuf.length, 18)
    local.writeUInt32LE(dataBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, dataBuf)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10)            // 存储方式：不压缩
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
  return new Uint8Array(Buffer.concat([...chunks, cdBuf, eocd]))
}

function loadParser() {
  // xmlToText 已经并进 docxToText（2026-11-12 压行数），这里只导出前者。
  const factory = new Function('inflateRaw', sliceFunctions() + '\nreturn { docxToText }')
  return factory(async (data) => new Uint8Array(inflateRawSync(Buffer.from(data))))
}

const DOCUMENT_XML = '<?xml version="1.0"?>'
  + '<w:document><w:body>'
  + '<w:p><w:r><w:t>第一段：采访开始</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>第二段 &amp; 有个符号 &lt;就这样&gt;</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>第三段</w:t></w:r><w:r><w:tab/><w:t>带制表</w:t></w:r></w:p>'
  + '</w:body></w:document>'

test('从 docx 里取出正文，而不是显示压缩包的字节', async () => {
  const { docxToText } = loadParser()
  const bytes = makeZip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': DOCUMENT_XML,
  })
  const file = { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
  const text = await docxToText(file)
  assert.match(text, /第一段：采访开始/)
  assert.match(text, /第二段 & 有个符号 <就这样>/)
  assert.match(text, /带制表/)
  // 三行都在，段与段之间是换行，不是挤成一行。
  assert.equal(text.split('\n').filter(Boolean).length, 3)
  // 不许把 XML 或压缩包痕迹漏出来。
  assert.doesNotMatch(text, /<w:|PK\u0003/)
})

test('不是 docx 的东西要明确报错，不要硬解析', async () => {
  const { docxToText } = loadParser()
  const file = { arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5]).buffer }
  await assert.rejects(() => docxToText(file), /不是有效的 docx/)
})

test('预览前先判类型：只有认识的文本格式才按文本读', () => {
  const start = SRC.indexOf('  function previewUpload(i) {')
  const end = SRC.indexOf('  function showFileText(')
  const fn = SRC.slice(start, end)
  // docx 走专用解析。
  assert.match(fn, /previewDocx\(f\)/)
  // 其它不认识的格式要拒绝，而不是一律 readAsText。
  assert.match(fn, /ATTACH_TEXT_NAME\.test\(name\)/)
  assert.match(fn, /不能预览/)
})
