import { fail, methodNotAllowed, ok } from './_lib/http.js'
import { ensureUserByDeviceId, isValidDeviceId, normalizeDeviceId } from './_lib/mvp-user.js'
import { supabaseGet } from './_lib/supabase.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res)

  try {
    const deviceId = normalizeDeviceId(req.query.deviceId)
    const rawLimit = req.query.limit
    const parsedLimit = Number(rawLimit ?? 20)

    if (!isValidDeviceId(deviceId)) {
      return fail(res, 400, 'INVALID_DEVICE_ID', 'deviceId is required and must be 8-128 chars')
    }
    if (!Number.isFinite(parsedLimit) || !Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
      return fail(res, 400, 'INVALID_LIMIT', 'limit must be an integer between 1 and 50')
    }
    const limit = parsedLimit

    let user
    try {
      user = await ensureUserByDeviceId(deviceId)
    } catch (error) {
      return fail(res, 500, 'USER_UPSERT_FAILED', error.message || 'user upsert failed')
    }

    try {
      const rows = await supabaseGet(
        'conversations',
        `select=id,question,answer,created_at&user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&limit=${limit}`
      )
      const items = Array.isArray(rows)
        ? rows.map(row => ({
            id: row.id,
            question: row.question,
            answer: row.answer,
            createdAt: row.created_at
          }))
        : []
      return ok(res, { items, nextCursor: null })
    } catch (error) {
      return fail(res, 500, 'HISTORY_QUERY_FAILED', error.message || 'history query failed')
    }
  } catch (error) {
    return fail(res, 500, 'INTERNAL_ERROR', error.message || 'internal error')
  }
}
