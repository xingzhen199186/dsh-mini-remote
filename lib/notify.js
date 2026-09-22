/**
 * L3 外部推送：手机锁屏 / 浏览器被挂起时，WebSocket 和 SSE 都靠不住，
 * 只有走系统级推送通道才叫得醒人。
 *
 * 支持 Bark（iOS 首选）、ntfy（跨平台、可自托管）、Telegram Bot。
 * 全部用全局 fetch，不引任何依赖。
 */

const TIMEOUT_MS = 8000

function truncate(text, maxLength) {
  const max = Number.isFinite(maxLength) && maxLength > 0 ? maxLength : 200
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

async function post(url, { headers, body, method = 'POST' } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`)
  }
  return res
}

/**
 * 按配置发一条外部推送。
 * @returns {Promise<{ok: boolean, error?: string}>} 永不抛出——推送失败不该影响 agent。
 */
export async function sendExternalNotification(notify, text) {
  if (!notify?.enabled || notify.channel === 'none') return { ok: false, error: 'disabled' }

  const body = truncate(text, notify.maxLength)
  const title = 'DSH 任务完成'

  try {
    switch (notify.channel) {
      case 'bark': {
        if (!notify.barkUrl) throw new Error('barkUrl 未配置')
        const base = notify.barkUrl.replace(/\/+$/, '')
        const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`
          + `?group=dsh&sound=${encodeURIComponent(notify.sound || 'default')}`
        await post(url, { method: 'GET' })
        break
      }

      case 'ntfy': {
        if (!notify.ntfyTopic) throw new Error('ntfyTopic 未配置')
        const base = (notify.ntfyUrl || 'https://ntfy.sh').replace(/\/+$/, '')
        await post(`${base}/${encodeURIComponent(notify.ntfyTopic)}`, {
          headers: { Title: title, Priority: 'high', Tags: 'robot' },
          body,
        })
        break
      }

      case 'telegram': {
        if (!notify.telegramBotToken || !notify.telegramChatId) {
          throw new Error('telegramBotToken / telegramChatId 未配置')
        }
        await post(`https://api.telegram.org/bot${notify.telegramBotToken}/sendMessage`, {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: notify.telegramChatId,
            text: `${title}\n${body}`,
          }),
        })
        break
      }

      default:
        return { ok: false, error: `未知通道 ${notify.channel}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) }
  }
}
