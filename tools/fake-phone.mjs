// 假装成手机，验证「提问推得出去、答案收得回来」。**这是回归工具，不是日常测试。**
//
// 什么时候用它：动了提问那条回路之后——`lib/index.js` 里的钩子、`server.js` 里的
// `askPhone` 与 `POST /mini/api/answer`、页面上的答题卡片。`npm test` 里那 7 条只验
// 钩子的判断逻辑（在假 ctx 里直接调），**验不到 SSE 推、POST 收这条真通道**。
//
// 为什么要真往返一次：这条回路坏起来是**静默的**——钩子挂错了不报错，只是手机永远
// 收不到问题（排查时在这上面绕过好几圈）。所以判据只有一个：真跑一次。
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
