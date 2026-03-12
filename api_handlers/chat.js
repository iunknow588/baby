import { cozeComplete } from './_lib/coze.js'
import { fail, methodNotAllowed, ok, readJson } from './_lib/http.js'
import { ensureUserByDeviceId, isValidDeviceId, normalizeDeviceId } from './_lib/mvp-user.js'
import { supabaseInsert } from './_lib/supabase.js'

function isHttpUrl(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  return /^https?:\/\/.+/i.test(text)
}

function normalizeIncomingFiles(rawFiles) {
  if (!Array.isArray(rawFiles)) return []
  return rawFiles
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      name: typeof item.name === 'string' ? item.name.trim() : '',
      type: typeof item.type === 'string' ? item.type.trim() : '',
      size: Number.isFinite(Number(item.size)) ? Number(item.size) : 0,
      url: isHttpUrl(item.url) ? String(item.url).trim() : ''
    }))
    .filter(item => item.name || item.url)
}

function buildMessageWithFiles(message, files) {
  if (!Array.isArray(files) || files.length === 0) return message
  const lines = files.map((file, index) => {
    const name = file.name || `附件${index + 1}`
    const type = file.type || 'unknown'
    const size = Number.isFinite(file.size) && file.size > 0 ? `${file.size} bytes` : 'size unknown'
    const urlPart = file.url ? `, url=${file.url}` : ''
    return `- ${name} (${type}, ${size}${urlPart})`
  })
  return `${message}\n\n[附件信息]\n${lines.join('\n')}`
}

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

function parseJsonObject(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

function renderJsonErrorAnswer(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const msg = typeof obj.msg === 'string' ? obj.msg.trim() : ''
  const code = typeof obj.code === 'number' || typeof obj.code === 'string' ? String(obj.code).trim() : ''
  if (!msg) return ''
  if (code) return `服务调用失败（${code}）：${msg}`
  return `服务调用失败：${msg}`
}

function sanitizeAnswer(answer, message) {
  const text = typeof answer === 'string' ? answer.trim() : ''
  if (!text) return buildFallbackAnswer(message)
  if (isToolCallPayload(text)) return buildFallbackAnswer(message)
  if (text === '正在联网检索，请稍候...') return buildFallbackAnswer(message)
  const parsed = parseJsonObject(text)
  if (parsed) {
    const errorText = renderJsonErrorAnswer(parsed)
    if (errorText) return errorText
  }
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
    const files = normalizeIncomingFiles(body.files)
    const messageWithFiles = buildMessageWithFiles(message, files)

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
      coze = await cozeComplete({ message: messageWithFiles })
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
