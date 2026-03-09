import { cozeComplete } from './_lib/coze.js'
import { fail, methodNotAllowed, ok, readJson } from './_lib/http.js'
import { ensureUserByDeviceId, isValidDeviceId, normalizeDeviceId } from './_lib/mvp-user.js'
import { supabaseInsert } from './_lib/supabase.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res)

  try {
    const body = await readJson(req)
    const deviceId = normalizeDeviceId(body.deviceId)
    const message = typeof body.message === 'string' ? body.message.trim() : ''

    if (!isValidDeviceId(deviceId) || !message) {
      return fail(res, 400, 'INVALID_CHAT_PAYLOAD', 'deviceId and message are required')
    }

    let user
    try {
      user = await ensureUserByDeviceId(deviceId)
    } catch (error) {
      return fail(res, 500, 'USER_UPSERT_FAILED', error.message || 'user upsert failed')
    }

    let coze
    try {
      coze = await cozeComplete({ message })
    } catch (error) {
      const status = typeof error?.status === 'number' && error.status >= 400 ? 502 : 500
      return fail(res, status, 'COZE_REQUEST_FAILED', error.message || 'Coze request failed')
    }

    if (!coze.answer || !coze.answer.trim()) {
      return fail(res, 502, 'COZE_REQUEST_FAILED', 'Coze returned empty answer')
    }

    try {
      const inserted = await supabaseInsert(
        'conversations',
        {
          user_id: user.id,
          question: message,
          answer: coze.answer
        },
        'representation'
      )
      const row = Array.isArray(inserted) ? inserted[0] : inserted
      return ok(res, {
        conversationId: row.id,
        answer: row.answer,
        createdAt: row.created_at
      })
    } catch (error) {
      return fail(res, 500, 'CONVERSATION_INSERT_FAILED', error.message || 'conversation insert failed')
    }
  } catch (error) {
    return fail(res, 500, 'INTERNAL_ERROR', error.message || 'internal error')
  }
}
