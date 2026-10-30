import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMultiRelayTicket } from '../lib/multi-relay-ticket.js'

function ticket(payload) {
  return 'relay1.' + Buffer.from(JSON.stringify(payload)).toString('base64url')
}

test('邀请票拆出控制台地址、邀请码和有效期', () => {
  const parsed = parseMultiRelayTicket(ticket({
    v: 1,
    u: 'https://admin.relay.example.com',
    c: 'a'.repeat(43),
    e: Date.now() + 60_000,
  }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.controlUrl, 'https://admin.relay.example.com')
  assert.equal(parsed.inviteCode, 'a'.repeat(43))
})

test('拒绝过期票、坏地址和非 https', () => {
  assert.equal(parseMultiRelayTicket(ticket({
    v: 1, u: 'https://admin.relay.example.com', c: 'a'.repeat(43), e: Date.now() - 1,
  })).code, 'ticket_expired')
  assert.equal(parseMultiRelayTicket(ticket({
    v: 1, u: 'http://admin.relay.example.com', c: 'a'.repeat(43), e: Date.now() + 60_000,
  })).code, 'ticket_invalid')
  assert.equal(parseMultiRelayTicket('not-a-ticket').code, 'ticket_invalid')
})


test('邀请链接拆出控制台地址和邀请码', async () => {
  const { parseMultiRelayJoinUrl } = await import('../lib/multi-relay-ticket.js')
  const parsed = parseMultiRelayJoinUrl('https://admin.relay.example.com/join/' + 'b'.repeat(43))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.controlUrl, 'https://admin.relay.example.com')
  assert.equal(parsed.inviteCode, 'b'.repeat(43))
  assert.equal(parseMultiRelayJoinUrl('https://admin.relay.example.com/other/' + 'b'.repeat(43)).ok, false)
})
