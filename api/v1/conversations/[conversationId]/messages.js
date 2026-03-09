import { cozeComplete } from '../../../_lib/coze.js'
import { fail, methodNotAllowed, ok, readJson } from '../../../_lib/http.js'
import { ensureRoomMember, getActorId, listMessages, makeId, nowIso, toMessageEntity } from '../../../_lib/platform-chat.js'
import { supabaseInsert, supabasePatch } from '../../../_lib/supabase.js'

function normalizeContent(body) {
  if (typeof body.content === 'string') return body.content.trim()
  if (typeof body.text === 'string') return body.text.trim()
  return ''
}

export default async function handler(req, res) {
  const conversationId = typeof req.query?.conversationId === 'string' ? req.query.conversationId.trim() : ''
  if (!conversationId) {
    return fail(res, 400, 'INVALID_CONVERSATION_ID', 'conversationId is required')
  }

  if (req.method === 'GET') {
    try {
      const userId = getActorId(req)
      await ensureRoomMember(conversationId, userId)
      const limit = Math.max(1, Math.min(Number(req.query?.limit || 20), 100))
      const cursor = typeof req.query?.cursor === 'string' && req.query.cursor.trim() ? req.query.cursor.trim() : ''
      const list = await listMessages(conversationId, limit, cursor || undefined)
      const nextCursor = list.length >= limit ? list[0]?.createdAt || null : null
      return ok(res, {
        list,
        hasMore: Boolean(nextCursor),
        nextCursor
      })
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      const code = status === 403 ? 'PERMISSION_DENIED' : 'MESSAGES_LIST_FAILED'
      return fail(res, status, code, error.message || 'list messages failed')
    }
  }

  if (req.method === 'POST') {
    try {
      const userId = getActorId(req)
      await ensureRoomMember(conversationId, userId)
      const body = await readJson(req)

      const messageType = typeof body.type === 'string' && body.type.trim()
        ? body.type.trim()
        : typeof body.messageType === 'string' && body.messageType.trim()
          ? body.messageType.trim()
          : 'text'
      const content = normalizeContent(body)
      const files = Array.isArray(body.files) ? body.files : undefined
      const clientMessageId = typeof body.clientMessageId === 'string' && body.clientMessageId.trim()
        ? body.clientMessageId.trim()
        : makeId('cm')

      if (!content && (!files || files.length === 0)) {
        return fail(res, 400, 'INVALID_MESSAGE_PAYLOAD', 'content or files is required')
      }

      const createdAt = nowIso()
      const userRow = {
        id: clientMessageId,
        room_id: conversationId,
        sender_id: userId,
        sender_type: 'user',
        message_type: messageType,
        content,
        status: 'delivered',
        files: files || null,
        meta: body.meta || null,
        created_at: createdAt
      }

      await supabaseInsert('chat_messages', userRow, 'minimal')
      await supabasePatch(
        'chat_rooms',
        `id=eq.${encodeURIComponent(conversationId)}`,
        { last_active_at: createdAt },
        'minimal'
      )

      let aiMessage = null
      let aiAnswer = ''

      if (content) {
        try {
          const coze = await cozeComplete({ message: content })
          aiAnswer = typeof coze.answer === 'string' ? coze.answer.trim() : ''
        } catch (error) {
          aiAnswer = ''
        }
      }

      if (aiAnswer) {
        const aiRow = {
          id: makeId('ai'),
          room_id: conversationId,
          sender_id: 'u_ai',
          sender_type: 'ai',
          message_type: 'text',
          content: aiAnswer,
          status: 'delivered',
          files: null,
          meta: null,
          created_at: nowIso()
        }
        await supabaseInsert('chat_messages', aiRow, 'minimal')
        aiMessage = toMessageEntity(aiRow)
      }

      const userMessage = toMessageEntity({
        ...userRow,
        meta: aiAnswer ? { ...(body.meta || {}), aiAnswer } : body.meta || null
      })

      return ok(res, {
        message: userMessage,
        aiMessage
      })
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      const code = status === 403 ? 'PERMISSION_DENIED' : 'MESSAGE_SEND_FAILED'
      return fail(res, status, code, error.message || 'send message failed')
    }
  }

  return methodNotAllowed(res)
}
