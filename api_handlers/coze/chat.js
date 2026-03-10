import { cozeComplete } from '../_lib/coze.js'
import { fail, methodNotAllowed, ok, readJson } from '../_lib/http.js'

function buildFallbackAnswer(message) {
  const preview = message.length > 80 ? `${message.slice(0, 80)}...` : message
  return `已收到你的输入：${preview}\n\n当前 Coze 服务响应较慢，已触发降级回复。请稍后重试获取完整回答。`
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res)
  let fallbackMessage = ''
  try {
    const body = await readJson(req)
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    fallbackMessage = message
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : ''

    if (!message) {
      return fail(res, 400, 'INVALID_PARAMS', 'message is required')
    }

    const result = await cozeComplete({
      message,
      conversationId: conversationId || undefined
    })

    return ok(res, {
      chatId: result.chatId,
      conversationId: result.conversationId,
      answer: result.answer,
      raw: result.raw,
      degraded: false,
      degradedReason: ''
    })
  } catch (error) {
    return ok(res, {
      chatId: '',
      conversationId: '',
      answer: buildFallbackAnswer(fallbackMessage),
      raw: null,
      degraded: true,
      degradedReason: error?.message || 'Coze request failed'
    })
  }
}
