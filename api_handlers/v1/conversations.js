import { fail, methodNotAllowed, ok, readJson } from '../_lib/http.js'
import {
  addRoomMember,
  ensureRoomMember,
  getActorId,
  listRoomsByUser,
  makeId,
  nowIso
} from '../_lib/platform-chat.js'
import { supabaseInsert } from '../_lib/supabase.js'

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const userId = getActorId(req)
      const list = await listRoomsByUser(userId)
      return ok(res, { list, hasMore: false, nextCursor: null })
    } catch (error) {
      return fail(res, 500, 'CONVERSATIONS_LIST_FAILED', error.message || 'list conversations failed')
    }
  }

  if (req.method === 'POST') {
    try {
      const userId = getActorId(req)
      const body = await readJson(req)
      const type = typeof body.type === 'string' ? body.type.trim() : 'group'
      const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : ''

      if (groupId) {
        await ensureRoomMember(groupId, userId)
        return ok(res, { conversationId: groupId, roomId: groupId, status: 'open' })
      }

      const participantIds = Array.isArray(body.participantIds)
        ? body.participantIds.filter(item => typeof item === 'string' && item.trim())
        : []
      const targetId = participantIds.find(id => id !== userId) || 'u_ai'
      const roomId = makeId(type === 'private' ? 'dm' : 'cv')
      const roomName = type === 'private' ? '私聊会话' : '群聊会话'

      await supabaseInsert(
        'chat_rooms',
        {
          id: roomId,
          name: roomName,
          type: type === 'private' ? 'dm' : 'group',
          last_active_at: nowIso()
        },
        'minimal'
      )

      await addRoomMember(roomId, userId)
      await addRoomMember(roomId, targetId)

      return ok(res, { conversationId: roomId, roomId, status: 'open' })
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      return fail(res, status, 'CONVERSATION_CREATE_FAILED', error.message || 'create conversation failed')
    }
  }

  return methodNotAllowed(res)
}
