import { fail, methodNotAllowed, ok, readJson } from '../_lib/http.js'
import { addRoomMember, getActorId, listRoomsByUser, makeId, nowIso } from '../_lib/platform-chat.js'
import { supabaseInsert } from '../_lib/supabase.js'

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const userId = getActorId(req)
      const list = await listRoomsByUser(userId)
      return ok(res, { list, hasMore: false, nextCursor: null })
    } catch (error) {
      return fail(res, 500, 'ROOMS_LIST_FAILED', error.message || 'list rooms failed')
    }
  }

  if (req.method === 'POST') {
    try {
      const userId = getActorId(req)
      const body = await readJson(req)
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : '未命名群聊'
      const type = typeof body.type === 'string' && body.type.trim() ? body.type.trim() : 'group'
      const roomId = makeId('g')
      const createdAt = nowIso()

      await supabaseInsert('chat_rooms', {
        id: roomId,
        name,
        type,
        last_active_at: createdAt
      }, 'minimal')

      await addRoomMember(roomId, userId)
      await addRoomMember(roomId, 'u_ai')

      return ok(res, {
        groupId: roomId,
        roomId,
        roomName: name,
        roomType: type,
        createdAt
      })
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      return fail(res, status, 'GROUP_CREATE_FAILED', error.message || 'create group failed')
    }
  }

  return methodNotAllowed(res)
}
