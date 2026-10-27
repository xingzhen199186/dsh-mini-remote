import test from 'node:test'
import assert from 'node:assert/strict'

import { isSecureRequest } from '../lib/server.js'

test('Cloudflare 固定域名：x-forwarded-proto=https 算安全请求', () => {
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https' } }), true)
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https, http' } }), true)
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'http' } }), false)
})

test('本机直连：socket 加密或未加密分别判断', () => {
  assert.equal(isSecureRequest({ headers: {}, socket: { encrypted: true } }), true)
  assert.equal(isSecureRequest({ headers: {}, socket: { encrypted: false } }), false)
  assert.equal(isSecureRequest({}), false)
})
