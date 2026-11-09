import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBridge } from '../lib/bridge.js'
import { createDevices } from '../lib/devices.js'
import { createMiniServer } from '../lib/server.js'

const TOKEN = 'testtoken0123456789abcdef012345'

async function boot(t) {
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-mini-bridge-route-')), 'devices.json')
  const devices = createDevices({ file })
  const credential = devices.register({ name: 'Android', kind: 'phone' }).credential
  const bridge = createBridge()
  const instance = await createMiniServer({
    store: { snapshot: () => ({}), state: {} },
    config: { port: 0, defaultMode: 'minimal' },
    token: TOKEN,
    bindAddresses: ['127.0.0.1'],
    devices,
    bridge,
    log: { info: () => {}, warn: () => {} },
    build: 'test',
  })
  t.after(async () => {
    bridge.close()
    await instance.close()
  })
  return { base: `http://127.0.0.1:${instance.port}`, credential }
}

test('手机桥路由：Cookie 不能冒充原生 App，设备请求头才有效', async (t) => {
  const { base, credential } = await boot(t)
  const path = '/mini/api/bridge/poll?wait=0&protocol=1'
  const byCookie = await fetch(base + path, {
    headers: { Cookie: `dsh_mini_device=${credential}` },
  })
  assert.equal(byCookie.status, 403, '同源网页手里的 Cookie 不能进入桥控制面')

  const byHeader = await fetch(base + path, {
    headers: { 'X-Mini-Device': credential },
  })
  assert.equal(byHeader.status, 200)
  const body = await byHeader.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.calls, [])
})

test('手机桥：核验接口只读，不会取走队列里的动作', async (t) => {
  const { base, credential } = await boot(t)
  const headers = { 'X-Mini-Device': credential }
  assert.equal((await fetch(base + '/mini/api/bridge/arm', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ armed: true }),
  })).status, 200)

  const verify = await fetch(base + '/mini/api/bridge/verify', { headers })
  assert.equal(verify.status, 200)
  assert.equal((await verify.json()).armed, true)

  const byCookie = await fetch(base + '/mini/api/bridge/verify', {
    headers: { Cookie: `dsh_mini_device=${credential}` },
  })
  assert.equal(byCookie.status, 403, '核验也只认原生请求头')
})

test('手机桥结果：坏请求与无人认领的结果都明确失败', async (t) => {
  const { base, credential } = await boot(t)
  const malformed = await fetch(base + '/mini/api/bridge/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mini-Device': credential },
    body: '{',
  })
  assert.equal(malformed.status, 400)

  const stale = await fetch(base + '/mini/api/bridge/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mini-Device': credential },
    body: JSON.stringify({ id: 'not-a-live-call', ok: true, result: 'old' }),
  })
  assert.equal(stale.status, 409)
  const body = await stale.json()
  assert.equal(body.ok, false)
  assert.equal(body.accepted, false)
})
