import { fail, methodNotAllowed, ok } from './_lib/http.js'
import { ensureUserByDeviceId, isValidDeviceId, normalizeDeviceId } from './_lib/mvp-user.js'
import { supabaseDelete, supabaseGet } from './_lib/supabase.js'

function isToolCallPayload(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false
  try {
    const obj = JSON.parse(trimmed)
    if (!obj || typeof obj !== 'object') return false
    const hasApiMarker =
      typeof obj.api_name === 'string' ||
      typeof obj.plugin_id === 'number' ||
      typeof obj.plugin_name === 'string' ||
      typeof obj.name === 'string'
    const hasArguments = Object.prototype.hasOwnProperty.call(obj, 'arguments')
    return hasApiMarker && hasArguments
  } catch {
    return false
  }
}

function isValidHistoryRow(row) {
  const question = typeof row?.question === 'string' ? row.question.trim() : ''
  const answer = typeof row?.answer === 'string' ? row.answer.trim() : ''
  if (!question || !answer) return false
  if (answer === '正在联网检索，请稍候...') return false
  if (isToolCallPayload(answer)) return false
  return true
}

async function cleanupInvalidRows(rows) {
  const invalidIds = Array.isArray(rows)
    ? rows
        .filter(row => !isValidHistoryRow(row))
        .map(row => Number(row?.id))
        .filter(id => Number.isFinite(id) && id > 0)
    : []
  if (!invalidIds.length) return
  const uniqueIds = [...new Set(invalidIds)]
  const idList = uniqueIds.join(',')
  await supabaseDelete('conversations', `id=in.(${idList})`)
}

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
      try {
        await cleanupInvalidRows(rows)
      } catch {
        // Best-effort cleanup; keep history query successful.
      }
      const items = Array.isArray(rows)
        ? rows.filter(isValidHistoryRow).map(row => ({
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
