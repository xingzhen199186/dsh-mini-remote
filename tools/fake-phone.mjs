// 临时脚本：假装成手机，验证「提问推得出去、答案收得回来」。验完就删。
//
// 为什么要这么验：真手机上还没有答题界面，而这条回路又不能靠"看日志"判断——
// 必须真往返一次才算数。这个脚本就干手机该干的事：连着、收到提问、答一个。
//
// **故意选第二个选项**：答案回到电脑时，一眼就能认出是手机答的，而不是电脑上
// 浏览器自己弹窗答的。这是这个脚本存在的全部意义。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const token = fs.readFileSync(path.join(os.homedir(), '.dsh', 'dsh-mini-remote', 'token'), 'utf8').trim()
const base = 'http://127.0.0.1:3090'
const log = (...a) => console.log('[假手机]', ...a)

const res = await fetch(`${base}/mini/api/stream?token=${encodeURIComponent(token)}`)
if (!res.ok) {
  log('连不上：HTTP ' + res.status)
  process.exit(1)
}
log('已经连上，等着收提问')

const reader = res.body.getReader()
const dec = new TextDecoder()
let buf = ''

const answerIt = async (pushId, question) => {
  const options = question.options ?? []
  const pick = options[1] ?? options[0]
  log('收到提问：' + JSON.stringify(question.question))
  log('选项有 ' + options.length + ' 个，我选第 ' + (options[1] ? 2 : 1) + ' 个：' + pick?.label)
  const r = await fetch(`${base}/mini/api/answer?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: pushId, answers: [{ id: question.id, selected: [pick.label] }] }),
  })
  log('交答案的结果：HTTP ' + r.status + '  ' + (await r.text()))
  return true
}

while (true) {
  const { value, done } = await reader.read()
  if (done) {
    log('连接被服务端关掉了')
    break
  }
  buf += dec.decode(value, { stream: true })
  let cut
  while ((cut = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, cut)
    buf = buf.slice(cut + 2)
    const ev = /^event: (.+)$/m.exec(frame)?.[1]
    const data = /^data: (.+)$/m.exec(frame)?.[1]
    if (ev === 'question' && data) {
      let d
      try {
        d = JSON.parse(data)
      } catch (err) {
        log('推过来的内容看不懂：' + String(err))
        continue
      }
      const first = (d.questions ?? [])[0]
      if (!first) {
        log('推过来但里面没有题目')
        continue
      }
      await answerIt(d.id, first)
      process.exit(0)
    }
  }
}
