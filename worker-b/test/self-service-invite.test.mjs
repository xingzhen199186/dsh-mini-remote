import test from 'node:test'
import assert from 'node:assert/strict'
import { claimBody, createEnv, request } from './helpers.mjs'

const REQUEST_PATH = '/api/b/v1/invite-request'
const VERIFY_PATH = '/api/b/v1/invite-verify'

function mailRecorder() {
  const mails = []
  return {
    mails,
    async send(message) {
      mails.push(message)
      return { ok: true }
    },
  }
}

function codeFrom(mail) {
  const match = /\b(\d{6})\b/.exec(mail?.text || '')
  assert.ok(match, '验证码邮件里要有 6 位数字')
  return match[1]
}

test('自助申请：一个邮箱只能申请一次，验证后能拿到邀请码并 claim', async () => {
  const { env, db } = createEnv()
  const mail = mailRecorder()
  env.MAIL_SEND = mail.send

  const first = await request(env, 'POST', REQUEST_PATH, { email: 'Alice+test@gmail.com' }, { ip: '198.51.100.10' })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(mail.mails.length, 1)
  const requestId = first.body.applicationId
  const code = codeFrom(mail.mails[0])

  const wrong = await request(env, 'POST', VERIFY_PATH, { requestId, code: '000000' }, { ip: '198.51.100.10' })
  assert.equal(wrong.status, 403)
  assert.equal(wrong.body.code, 'invalid_code')

  const verified = await request(env, 'POST', VERIFY_PATH, { requestId, code }, { ip: '198.51.100.10' })
  assert.equal(verified.status, 200, JSON.stringify(verified.body))
  assert.equal(verified.body.ok, true)
  assert.match(verified.body.code, /^[A-Za-z0-9_-]{43}$/)
  assert.match(verified.body.hostname, /\.dsh-everywhere\.com$/)

  const row = db.prepare('SELECT * FROM b_invite_requests').get()
  assert.equal(row.state, 'fulfilled')
  assert.equal(JSON.stringify(row).includes('Alice'), false, '不能存明文邮箱')
  assert.equal(JSON.stringify(row).includes('198.51.100.10'), false, '不能存明文 IP')

  const claimed = await request(env, 'PUT', '/api/b/v1/claim', claimBody(verified.body.code))
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body))
  assert.equal(claimed.body.ok, true)
  assert.equal(claimed.body.state, 'active')

  const again = await request(env, 'POST', REQUEST_PATH, { email: 'alice@gmail.com' }, { ip: '198.51.100.11' })
  assert.equal(again.status, 409)
  assert.equal(again.body.code, 'already_requested')
})

test('自助申请：同一 IP 换邮箱也不能重复申请', async () => {
  const { env } = createEnv()
  env.MAIL_SEND = async () => ({ ok: true })
  const first = await request(env, 'POST', REQUEST_PATH, { email: 'one@example.com' }, { ip: '198.51.100.20' })
  assert.equal(first.status, 200)
  const second = await request(env, 'POST', REQUEST_PATH, { email: 'two@example.com' }, { ip: '198.51.100.20' })
  assert.equal(second.status, 409)
  assert.equal(second.body.code, 'already_requested')
})

test('自助申请：一次性邮箱被拒绝', async () => {
  const { env } = createEnv()
  env.MAIL_SEND = async () => ({ ok: true })
  const result = await request(env, 'POST', REQUEST_PATH, { email: 'x@mailinator.com' }, { ip: '198.51.100.30' })
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'invalid_email')
})

test('自助申请：邮件服务未配置时明确失败，不留下申请记录', async () => {
  const { env, db } = createEnv()
  const result = await request(env, 'POST', REQUEST_PATH, { email: 'no-mail@example.com' }, { ip: '198.51.100.40' })
  assert.equal(result.status, 503)
  assert.equal(result.body.code, 'mail_not_configured')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_invite_requests').get().n, 0)
})

test('自助申请页和申请管理接口', async () => {
  const { env, db } = createEnv()
  env.MAIL_SEND = async () => ({ ok: true })
  const page = await (await import('../src/index.js')).handleRequest(new Request('https://control.dsh-everywhere.com/request'), env)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /申请固定地址邀请码/)
  assert.match(html, /invite-request/)
  assert.match(html, /invite-verify/)

  const first = await request(env, 'POST', REQUEST_PATH, { email: 'admin-list@example.com' }, { ip: '198.51.100.50' })
  assert.equal(first.status, 200)
  const listed = await request(env, 'GET', '/admin/b/v1/requests', undefined, { admin: true })
  assert.equal(listed.status, 200)
  assert.equal(listed.body.requests.length, 1)
  assert.equal(listed.body.requests[0].email, 'a***@example.com')

  const removed = await request(env, 'DELETE', '/admin/b/v1/requests/' + first.body.applicationId, undefined, { admin: true })
  assert.equal(removed.status, 200)
  assert.equal(removed.body.deleted, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM b_invite_requests').get().n, 0)
})
