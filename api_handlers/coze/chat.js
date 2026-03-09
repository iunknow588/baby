import { cozeComplete } from '../_lib/coze.js'
import { fail, methodNotAllowed, ok, readJson } from '../_lib/http.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res)
  try {
    const body = await readJson(req)
    const message = typeof body.message === 'string' ? body.message.trim() : ''
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
      raw: result.raw
    })
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 500
    return fail(res, status, 'COZE_REQUEST_FAILED', error.message || 'Coze request failed')
  }
}
