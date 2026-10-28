import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { handleRequest } from '../src/index.js'
import { CloudflareError } from '../src/cloudflare.js'

const migration = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8')

class Statement {
  constructor(db, sql) {
    this.db = db
    this.sql = sql
  }

  bind(...params) {
    const statement = this.db.prepare(this.sql)
    return {
      run: () => {
        const result = statement.run(...params)
        return { meta: { changes: Number(result.changes) } }
      },
      first: async () => statement.get(...params) ?? null,
      all: async () => ({ results: statement.all(...params) }),
      runAsync: async () => {
        const result = statement.run(...params)
        return { meta: { changes: Number(result.changes) } }
      },
    }
  }
}

export function createD1() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(migration)
  return {
    db,
    prepare(sql) {
      const statement = new Statement(db, sql)
      return {
        bind(...params) {
          const bound = statement.bind(...params)
          return { run: bound.runAsync, first: bound.first, all: bound.all }
        },
      }
    },
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

export class FakeCloudflare {
  constructor() {
    this.tunnels = new Map()
    this.dnsRecords = new Map()
    this.calls = []
    this.failures = []
    this.createdTunnelCount = 0
    this.createTunnelCalls = 0
    this.sequence = 0
  }

  failNext(method, phase = 'before') {
    this.failures.push({ method, phase })
  }

  check(method, phase) {
    const index = this.failures.findIndex((failure) => failure.method === method && failure.phase === phase)
    if (index >= 0) {
      this.failures.splice(index, 1)
      throw new CloudflareError(500)
    }
  }

  record(method) {
    this.calls.push(method)
    this.check(method, 'before')
  }

  async findTunnel(name) {
    this.record('findTunnel')
    const tunnel = [...this.tunnels.values()].find((item) => item.name === name)
    this.check('findTunnel', 'after')
    return tunnel
  }

  async createTunnel(name) {
    this.record('createTunnel')
    this.createTunnelCalls += 1
    const id = 'tunnel-' + String(++this.sequence)
    const tunnel = { id, name }
    this.tunnels.set(id, tunnel)
    this.createdTunnelCount += 1
    this.check('createTunnel', 'after')
    return tunnel
  }

  async putTunnelConfiguration(id, ingress) {
    this.record('putTunnelConfiguration')
    this.tunnels.get(id).ingress = ingress
    this.check('putTunnelConfiguration', 'after')
  }

  async findDnsRecords(name) {
    this.record('findDnsRecords')
    const records = [...this.dnsRecords.values()].filter((record) => record.name === name)
    this.check('findDnsRecords', 'after')
    return records
  }

  async createDnsRecord(record) {
    this.record('createDnsRecord')
    const created = { ...record, id: 'dns-' + String(++this.sequence) }
    this.dnsRecords.set(created.id, created)
    this.check('createDnsRecord', 'after')
    return created
  }

  async updateDnsRecord(id, record) {
    this.record('updateDnsRecord')
    this.dnsRecords.set(id, { ...record, id })
    this.check('updateDnsRecord', 'after')
    return this.dnsRecords.get(id)
  }

  async deleteDnsRecord(id) {
    this.record('deleteDnsRecord')
    this.dnsRecords.delete(id)
    this.check('deleteDnsRecord', 'after')
  }

  async getTunnelToken(id) {
    this.record('getTunnelToken')
    const token = 'test-tunnel-token:' + id
    this.check('getTunnelToken', 'after')
    return token
  }

  async deleteTunnel(id) {
    this.record('deleteTunnel')
    this.tunnels.delete(id)
    this.check('deleteTunnel', 'after')
  }
}

export function createEnv() {
  const d1 = createD1()
  const cf = new FakeCloudflare()
  const env = {
    DB: d1,
    CF_RELAY_API: cf,
    B_PEPPER: 'test-pepper',
    ADMIN_TOKEN: 'test-admin-token',
    B_SUFFIX: 'dsh-everywhere.com',
    B_CONTROL_HOST: 'control.dsh-everywhere.com',
    B_ACCOUNT_ID: 'test-account',
    B_ZONE_ID: 'test-zone',
  }
  return { env, d1, cf, db: d1.db }
}

export async function request(env, method, path, body, { admin = false, ip = '203.0.113.10' } = {}) {
  const response = await handleRequest(new Request('https://control.dsh-everywhere.com' + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
      ...(admin ? { authorization: 'Bearer test-admin-token' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env)
  return { response, status: response.status, body: await response.json() }
}

export async function invite(env, extra = {}) {
  const result = await request(env, 'POST', '/admin/b/v1/invites', { note: 'offline test', expiresInDays: 7, ...extra }, { admin: true })
  if (!result.body.ok) throw new Error('invite failed: ' + JSON.stringify(result.body))
  return result.body
}

export const CLIENT_SECRET = 'a'.repeat(43)
export const OTHER_SECRET = 'b'.repeat(43)
export const CLAIM_ID = 'claim-request-0001'

export function claimBody(code, extra = {}) {
  return { activationCode: code, clientSecret: CLIENT_SECRET, claimRequestId: CLAIM_ID, originPort: 3090, ...extra }
}

export async function activate(env) {
  const invitation = await invite(env)
  const claim = await request(env, 'PUT', '/api/b/v1/claim', claimBody(invitation.code))
  if (!claim.body.ok) throw new Error('claim failed: ' + JSON.stringify(claim.body))
  return { invitation, claim, id: invitation.id, hostname: invitation.hostname }
}
