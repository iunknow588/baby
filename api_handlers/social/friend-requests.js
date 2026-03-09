import { fail, methodNotAllowed, ok, readJson, resolveCurrentUserId } from '../_lib/http.js'

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const self = resolveCurrentUserId(req)
    return ok(res, [
      {
        requestId: 'fr_demo_001',
        fromUserId: 'u_parent_demo',
        fromUsername: '家长示例',
        createdAt: new Date().toISOString(),
        toUserId: self
      }
    ])
  }

  if (req.method === 'POST') {
    try {
      const body = await readJson(req)
      const targetUserId = typeof body.targetUserId === 'string' ? body.targetUserId.trim() : ''
      if (!targetUserId) {
        return fail(res, 400, 'INVALID_TARGET_USER', 'targetUserId is required')
      }
      const requestId = `fr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      return ok(res, { requestId })
    } catch (error) {
      return fail(res, 500, 'SOCIAL_REQUEST_CREATE_FAILED', error.message || 'send friend request failed')
    }
  }

  return methodNotAllowed(res)
}
