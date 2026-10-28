const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

export class CloudflareError extends Error {
  constructor(httpStatus) {
    super('Cloudflare API request failed')
    this.name = 'CloudflareError'
    this.httpStatus = httpStatus
  }
}

async function cfCall(config, method, path, body) {
  let response
  try {
    response = await fetch(CF_API_BASE + path, {
      method,
      headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new CloudflareError()
  }
  const payload = await response.json().catch(() => undefined)
  if (!response.ok || !payload || payload.success === false) throw new CloudflareError(response.status)
  return payload.result
}

export function createCloudflareRelayApi(config) {
  const account = '/accounts/' + config.accountId
  const zone = '/zones/' + config.zoneId
  return {
    async findTunnel(name) {
      const result = await cfCall(config, 'GET', account + '/cfd_tunnel?name=' + encodeURIComponent(name) + '&is_deleted=false&per_page=100')
      const matches = Array.isArray(result)
        ? result.filter((tunnel) => tunnel && tunnel.name === name && !tunnel.deleted_at)
        : []
      if (matches.length > 1) throw new CloudflareError()
      return matches[0]
    },
    async createTunnel(name) {
      return await cfCall(config, 'POST', account + '/cfd_tunnel', { name, config_src: 'cloudflare' })
    },
    /** 只读列出一页 Tunnel；对账只观察，不在这里做任何变更。 */
    async listTunnels() {
      const result = await cfCall(config, 'GET', account + '/cfd_tunnel?is_deleted=false&per_page=100')
      return Array.isArray(result) ? result.filter((tunnel) => tunnel && !tunnel.deleted_at) : []
    },
    async putTunnelConfiguration(tunnelId, ingress) {
      return await cfCall(config, 'PUT', account + '/cfd_tunnel/' + encodeURIComponent(tunnelId) + '/configurations', { config: { ingress } })
    },
    async findDnsRecords(name) {
      const result = await cfCall(config, 'GET', zone + '/dns_records?name=' + encodeURIComponent(name) + '&per_page=100')
      return Array.isArray(result) ? result.filter((record) => record && record.name === name) : []
    },
    async createDnsRecord(record) {
      return await cfCall(config, 'POST', zone + '/dns_records', record)
    },
    async updateDnsRecord(recordId, record) {
      return await cfCall(config, 'PUT', zone + '/dns_records/' + encodeURIComponent(recordId), record)
    },
    async deleteDnsRecord(recordId) {
      try {
        return await cfCall(config, 'DELETE', zone + '/dns_records/' + encodeURIComponent(recordId))
      } catch (error) {
        if (error instanceof CloudflareError && error.httpStatus === 404) return undefined
        throw error
      }
    },
    async getTunnelToken(tunnelId) {
      const result = await cfCall(config, 'GET', account + '/cfd_tunnel/' + encodeURIComponent(tunnelId) + '/token')
      return typeof result === 'string' ? result : result?.token
    },
    async deleteTunnel(tunnelId) {
      try {
        return await cfCall(config, 'DELETE', account + '/cfd_tunnel/' + encodeURIComponent(tunnelId))
      } catch (error) {
        if (error instanceof CloudflareError && error.httpStatus === 404) return undefined
        throw error
      }
    },
  }
}

export function cloudflareApiOf(env) {
  if (env.CF_RELAY_API) return env.CF_RELAY_API
  if (!env.CF_API_TOKEN || !env.B_ACCOUNT_ID || !env.B_ZONE_ID) return undefined
  return createCloudflareRelayApi({ token: env.CF_API_TOKEN, accountId: env.B_ACCOUNT_ID, zoneId: env.B_ZONE_ID })
}
