import axios from 'axios'
import { getCozeApiUri } from '../../platform/env'
import { ensureObject, ensureString, parseApiEnvelope } from './guard'

export interface CozeChatRequest {
  message: string
  conversationId?: string
}

export interface CozeChatReply {
  chatId: string
  conversationId: string
  answer: string
  raw?: Record<string, unknown>
}

function resolveEndpoint(path: string): string {
  const base = getCozeApiUri()
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${base}${normalized}`
}

export const cozeApi = {
  async chat(payload: CozeChatRequest): Promise<CozeChatReply> {
    const legacyBody = {
      message: payload.message,
      conversationId: payload.conversationId
    }

    const legacyRes = await axios.post(resolveEndpoint('/chat'), legacyBody, { timeout: 20000 })
    const envelope = parseApiEnvelope<unknown>(legacyRes.data)
    const data = ensureObject(envelope.data, 'coze.chat.data')

    return {
      chatId: ensureString(data.chatId, 'coze.chat.data.chatId'),
      conversationId: ensureString(data.conversationId, 'coze.chat.data.conversationId'),
      answer: ensureString(data.answer, 'coze.chat.data.answer'),
      raw: typeof data.raw === 'object' && data.raw ? (data.raw as Record<string, unknown>) : undefined
    }
  }
}
