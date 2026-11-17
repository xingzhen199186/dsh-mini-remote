import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * phone_fs_* 的返回契约（2026-11-17）。
 *
 * 钉住两件事：
 *   1. 返回必须带 scope / scanned / truncated / complete，不能把"只看了 app:/work:"或"达到上限"表达成完整结果；
 *   2. phone_fs_read 对二进制文件必须明确拒绝，不能返回乱码 + ok:true。
 */

const nativeFiles = readFileSync(
  new URL('../android/app/src/main/java/com/dsh/miniremote/NativeFiles.java', import.meta.url),
  'utf8'
)

const indexJs = readFileSync(
  new URL('../lib/index.js', import.meta.url),
  'utf8'
)

const bridgeJs = readFileSync(
  new URL('../lib/bridge.js', import.meta.url),
  'utf8'
)

const bridgePoller = readFileSync(
  new URL('../android/app/src/main/java/com/dsh/miniremote/BridgePoller.java', import.meta.url),
  'utf8'
)

test('phone_fs_list 返回带 scope / scanned / truncated / complete', () => {
  assert.match(nativeFiles, /put\("scope", target\.getString\("kind"\)\)/, 'list 要带 scope')
  assert.match(nativeFiles, /put\("scanned", scanned\)/, 'list 要带 scanned')
  assert.match(nativeFiles, /put\("truncated", truncated\)/, 'list 要带 truncated')
  assert.match(nativeFiles, /put\("complete", !truncated\)/, 'list 要带 complete')
})

test('phone_fs_read 返回带 scope / truncated / complete，且拒绝二进制文件', () => {
  assert.match(nativeFiles, /put\("scope", target\.getString\("kind"\)\)/, 'read 要带 scope')
  assert.match(nativeFiles, /put\("truncated", truncated\)/, 'read 要带 truncated')
  assert.match(nativeFiles, /put\("complete", !truncated && to >= lines\.size\(\)\)/, 'read 要带 complete')
  assert.match(nativeFiles, /isBinaryPath/, 'read 要检查二进制文件')
  assert.match(nativeFiles, /这是二进制文件/, 'read 对二进制要明确拒绝')
})

test('phone_fs_glob 返回带 scope / scanned / truncated / complete', () => {
  assert.match(nativeFiles, /put\("scope", target\.getString\("kind"\)\)/, 'glob 要带 scope')
  assert.match(nativeFiles, /put\("scanned", scanned\[0\]\)/, 'glob 要带 scanned')
  assert.match(nativeFiles, /put\("truncated", truncated\)/, 'glob 要带 truncated')
  assert.match(nativeFiles, /put\("complete", !truncated\)/, 'glob 要带 complete')
})

test('phone_fs_grep 返回带 scope / scanned / truncated / complete', () => {
  assert.match(nativeFiles, /put\("scope", target\.getString\("kind"\)\)/, 'grep 要带 scope')
  assert.match(nativeFiles, /put\("scanned", scanned\[0\]\)/, 'grep 要带 scanned')
  assert.match(nativeFiles, /put\("truncated", truncated\)/, 'grep 要带 truncated')
  assert.match(nativeFiles, /put\("complete", !truncated\)/, 'grep 要带 complete')
})

test('lib/index.js 工具描述说明范围与限制', () => {
  assert.match(indexJs, /phone_fs_list.*scope.*scanned.*truncated.*complete/s, 'phone_fs_list 描述要带范围与截断信息')
  assert.match(indexJs, /phone_fs_read.*二进制文件.*明确拒绝/s, 'phone_fs_read 描述要说明二进制拒绝')
  assert.match(indexJs, /phone_fs_glob.*scope.*scanned.*truncated.*complete/s, 'phone_fs_glob 描述要带范围与截断信息')
  assert.match(indexJs, /phone_fs_grep.*scope.*scanned.*truncated.*complete/s, 'phone_fs_grep 描述要带范围与截断信息')
  assert.match(indexJs, /phone_sh.*看不到公共目录里的普通文件/s, 'phone_sh 描述要说明公共目录限制')
})

test('phone_storage_status 注册并免确认', () => {
  assert.match(indexJs, /name: 'phone_storage_status'/, 'phone_storage_status 要注册')
  assert.match(indexJs, /phone_storage_status.*只读探测/s, 'phone_storage_status 描述要说明只读')
  assert.match(bridgeJs, /phone_storage_status/, 'bridge.js 免确认白名单要包含 phone_storage_status')
})

test('phone_storage_status 三种状态能区分', () => {
  // 未选文件夹 / 已选但失效 / 已选可读 三种状态要能区分，且不会把"未知"当"可用"。
  assert.match(bridgePoller, /workGranted.*workReadable/s, '要区分 workGranted 和 workReadable')
  assert.match(bridgePoller, /!workGranted.*next.*工作文件夹/s, '未选文件夹时要提示选文件夹')
  assert.match(bridgePoller, /!workReadable.*next.*重新选择/s, '已选但失效时要提示重新选择')
  assert.match(bridgePoller, /termuxStorage.*termux-setup-storage/s, 'Termux 存储不可用时提示 termux-setup-storage')
})

test('深度上限与任一通道可用都不能被说成完整', () => {
  assert.match(nativeFiles, /depth > MAX_DEPTH\) return true/, '目录深度到顶要标成未搜完')
  assert.match(bridgePoller, /out\.put\("complete", false\)/, '能力探测不能把任一通道可用说成完整')
  assert.match(bridgePoller, /publicDocuments", false/, '要明确公共文档仍不可见')
})

test('Termux 存储探针必须强制走 Termux，不能被 ADB 家目录误导', () => {
  assert.match(bridgePoller, /TermuxRun\.exec\(context,[\s\S]*?test -d ~\/storage/, '探针要直接调 Termux')
  assert.doesNotMatch(bridgePoller, /ShellBackend\.exec\(context, "test -d ~\/storage/, '不能走会自动选 ADB 的 exec')
})
