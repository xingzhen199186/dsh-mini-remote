import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeManualPublicUrl } from '../lib/manual-url.js'

test('手动公网地址：完整 https 地址只保留 origin', () => {
  assert.equal(normalizeManualPublicUrl('https://machine.tailnet.ts.net:8443'), 'https://machine.tailnet.ts.net:8443')
  assert.equal(normalizeManualPublicUrl('https://machine.tailnet.ts.net:8443/mini?token=x'), 'https://machine.tailnet.ts.net:8443')
})

test('手动公网地址：非法输入返回 null', () => {
  assert.equal(normalizeManualPublicUrl('8443'), null)
  assert.equal(normalizeManualPublicUrl('http://machine.tailnet.ts.net'), null)
  assert.equal(normalizeManualPublicUrl('https://user:pass@machine.tailnet.ts.net'), null)
  assert.equal(normalizeManualPublicUrl(''), '')
})
