import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDevices } from '../lib/devices.js'

function fileFor(name) {
  return join(mkdtempSync(join(tmpdir(), 'dsh-mini-devices-')), name)
}

test('设备名册最多 5 台，超过时淘汰创建最早的一台', () => {
  const file = fileFor('devices.json')
  const devices = createDevices({ file })
  const ids = []
  for (let index = 0; index < 6; index += 1) {
    ids.push(devices.register({ name: `设备${index}` }).id)
  }
  const list = devices.list()
  assert.equal(list.length, 5)
  assert.equal(list.some((device) => device.id === ids[0]), false)
})

test('设备 30 天没有活动会被自动删除', () => {
  const file = fileFor('devices.json')
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000
  writeFileSync(file, JSON.stringify({
    version: 1,
    devices: [{
      id: 'a'.repeat(32),
      name: '旧手机',
      kind: 'phone',
      keyHash: 'b'.repeat(64),
      createdAt: old,
      lastSeen: old,
    }],
  }))
  const devices = createDevices({ file })
  assert.deepEqual(devices.list(), [])
})
