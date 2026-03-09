import { fail, methodNotAllowed, ok, readJson, resolveCurrentUserId } from '../_lib/http.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res)

  try {
    const userId = resolveCurrentUserId(req)
    const body = await readJson(req)
    const roomId = typeof body.roomId === 'string' && body.roomId.trim() ? body.roomId.trim() : 'r_mvp_main'
    const sessionId = `session_${roomId}`

    return ok(res, {
      sessionId,
      roomId,
      userId,
      status: 'open',
      expiresInSec: 3600
    })
  } catch (error) {
    return fail(res, 500, 'SESSION_CREATE_FAILED', error.message || 'create session failed')
  }
}
