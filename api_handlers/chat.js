import { cozeComplete } from './_lib/coze.js'
import { fail, methodNotAllowed, ok, readJson } from './_lib/http.js'
import { ensureUserByDeviceId, isValidDeviceId, normalizeDeviceId } from './_lib/mvp-user.js'
import { supabaseInsert } from './_lib/supabase.js'

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

function sanitizeAnswer(answer, message) {
  const text = typeof answer === 'string' ? answer.trim() : ''
  if (!text) return buildFallbackAnswer(message)
  if (isToolCallPayload(text)) return buildFallbackAnswer(message)
  if (text === '正在联网检索，请稍候...') return buildFallbackAnswer(message)
  return text
}

function buildFallbackAnswer(message) {
  const preview = message.length > 80 ? `${message.slice(0, 80)}...` : message
  return `已收到你的消息：${preview}\n\n当前 AI 服务暂时繁忙，我先帮你记录问题。请稍后再试一次，我会尽快给出完整回复。`
}

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
    let fallbackUsed = false
    let fallbackReason = ''
    try {
      coze = await cozeComplete({ message })
    } catch (error) {
      fallbackUsed = true
      fallbackReason = error?.message || 'Coze request failed'
      coze = { answer: buildFallbackAnswer(message) }
    }

    const normalizedAnswer = sanitizeAnswer(coze.answer, message)
    if (!normalizedAnswer) {
      fallbackUsed = true
      fallbackReason = fallbackReason || 'Coze returned empty answer'
      coze = { answer: buildFallbackAnswer(message) }
    } else if (normalizedAnswer !== coze.answer) {
      fallbackUsed = true
      fallbackReason = fallbackReason || 'Coze returned intermediate tool payload'
      coze = { answer: normalizedAnswer }
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
        createdAt: row.created_at,
        degraded: fallbackUsed,
        degradedReason: fallbackUsed ? fallbackReason : ''
      })
    } catch (error) {
      return fail(res, 500, 'CONVERSATION_INSERT_FAILED', error.message || 'conversation insert failed')
    }
  } catch (error) {
    return fail(res, 500, 'INTERNAL_ERROR', error.message || 'internal error')
  }
}
