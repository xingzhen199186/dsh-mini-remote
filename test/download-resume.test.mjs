import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const net = read('android/app/src/main/java/com/dsh/miniremote/Net.java')
const activity = read('android/app/src/main/java/com/dsh/miniremote/MainActivity.java')

test('下载：整块传读超时 45 秒，连接超时不动', () => {
  assert.match(net, /WHOLE_READ_TIMEOUT_MS = 45_000/)
  assert.match(net, /connection\.setReadTimeout\(WHOLE_READ_TIMEOUT_MS\)/)
  // 连接超时保持原来的常量，不许被顺手改掉。
  assert.match(net, /connection\.setConnectTimeout\(CONNECT_TIMEOUT_MS\)/)
})

test('下载：整块传断在尾部时从已有字节续，不从 0 重来', () => {
  assert.match(net, /long offset = total > 0 \? whole\.written : 0/)
  assert.match(net, /for \(int round = 1; round <= RESUME_ROUNDS; round\+\+\)/)
  assert.match(net, /RESUME_ROUNDS = 3/)
  // 续传必须用 Range 指定起点。
  assert.match(net, /"bytes=" \+ offset \+ "-" \+ end/)
})

test('下载：分段每段失败按当前断点重试，三次才放弃', () => {
  assert.match(net, /SEGMENT_RETRIES = 3/)
  assert.match(net, /for \(int attempt = 1; attempt <= Math\.max\(1, segmentRetries\); attempt\+\+\)/)
  // 断点续写：从 offset 而不是 segmentStart 再要，避免写重、整包错位。
  assert.match(net, /connection\.setRequestProperty\("Range", "bytes=" \+ offset \+ "-" \+ end\)/)
  assert.doesNotMatch(net, /"bytes=" \+ segmentStart \+ "-" \+ end/)
})

test('下载：服务端不认 Range 时宁可失败，也不写重', () => {
  // 起点一旦不是 0，200 就是「整份从头给」，续写会错位，只能如实失败。
  assert.match(net, /status == 200 && offset > 0/)
  assert.match(net, /服务器不支持断点续传/)
})

test('下载：重试之间留间隔，不会立刻连着撞三次', () => {
  assert.match(net, /Thread\.sleep\(400L \* attempt\)/)
})

test('下载：失败提示区分「连不上」与「下到一半断了」', () => {
  assert.match(activity, /Net\.DownloadOutcome outcome = Net\.downloadPreferWhole/)
  assert.match(activity, /if \(!outcome\.connected\)/)
  assert.match(activity, /连不上电脑/)
  // 失败信息要落到更新那一行（2026-11-11）：带已收/共多少 KB，并且明确"再点会接着下"。
  assert.match(activity, /下载没完成（已收 /)
  assert.match(activity, /再点一次会接着下/)
  assert.match(activity, /__miniUpdateFail/)
})
