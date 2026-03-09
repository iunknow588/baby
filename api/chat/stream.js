import { fail, resolveCurrentUserId } from '../_lib/http.js'
import { ensureRoomMember, listMessages, listMessagesSince } from '../_lib/platform-chat.js'

function toRoomId(sessionId) {
  if (!sessionId) return ''
  if (sessionId.startsWith('session_')) {
    return sessionId.slice('session_'.length)
  }
  if (sessionId.startsWith('s_')) {
    const tail = sessionId.slice(2)
    const idx = tail.lastIndexOf('_')
    return idx > 0 ? tail.slice(0, idx) : tail
  }
  return ''
}

function writeEvent(res, event, payload) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed')

  const sessionId = typeof req.query?.sessionId === 'string' ? req.query.sessionId.trim() : ''
  if (!sessionId) return fail(res, 400, 'INVALID_SESSION_ID', 'sessionId is required')

  const roomId = toRoomId(sessionId) || 'r_mvp_main'
  const actorId = typeof req.query?.actorId === 'string' ? req.query.actorId.trim() : ''
  const rawToken = typeof req.query?.token === 'string' ? req.query.token.trim() : ''
  const tokenUserId = rawToken.startsWith('u_') ? rawToken : ''
  const userId = actorId || tokenUserId || resolveCurrentUserId(req)

  try {
    await ensureRoomMember(roomId, userId)
  } catch (error) {
    return fail(res, 403, 'PERMISSION_DENIED', 'Not a room member')
  }

  const now = new Date().toISOString()

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })

  writeEvent(res, 'heartbeat', { data: { sessionId, roomId, ts: now } })

  let lastSeenAt = now
  try {
    const latest = await listMessages(roomId, 1)
    if (latest[0]?.createdAt) {
      lastSeenAt = latest[0].createdAt
    }
  } catch (_error) {
    // Keep stream alive even when initial message lookup fails.
  }

  const heartbeatTimer = setInterval(() => {
    writeEvent(res, 'heartbeat', { data: { sessionId, roomId, ts: new Date().toISOString() } })
  }, 15000)

  const pollTimer = setInterval(async () => {
    try {
      const incoming = await listMessagesSince(roomId, lastSeenAt, 20)
      for (const message of incoming) {
        if (message.createdAt) {
          lastSeenAt = message.createdAt
        }
        writeEvent(res, 'message', { data: { message } })
        writeEvent(res, 'message.status', {
          data: { messageId: message._id, status: message.status || 'delivered' }
        })
      }
    } catch (_error) {
      // Keep stream alive and wait for next poll cycle.
    }
  }, 2500)

  const closeTimer = setTimeout(() => {
    clearInterval(heartbeatTimer)
    clearInterval(pollTimer)
    res.end()
  }, 55000)

  req.on('close', () => {
    clearInterval(heartbeatTimer)
    clearInterval(pollTimer)
    clearTimeout(closeTimer)
  })
}
