import { fail, methodNotAllowed, ok, readJson } from '../../../_lib/http.js'
import { addRoomMember, getActorId, removeRoomMember } from '../../../_lib/platform-chat.js'

export default async function handler(req, res) {
  const groupId = typeof req.query?.groupId === 'string' ? req.query.groupId.trim() : ''
  if (!groupId) {
    return fail(res, 400, 'INVALID_GROUP_ID', 'groupId is required')
  }

  if (req.method === 'POST') {
    try {
      const _operatorId = getActorId(req)
      const body = await readJson(req)
      const userId = typeof body.userId === 'string' && body.userId.trim() ? body.userId.trim() : ''
      if (!userId) {
        return fail(res, 400, 'INVALID_USER_ID', 'userId is required')
      }
      await addRoomMember(groupId, userId)
      return ok(res, { memberId: `${groupId}:${userId}`, groupId, userId })
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      return fail(res, status, 'GROUP_MEMBER_ADD_FAILED', error.message || 'add member failed')
    }
  }

  if (req.method === 'DELETE') {
    try {
      const _operatorId = getActorId(req)
      const body = await readJson(req)
      const memberId = typeof req.query?.memberId === 'string' ? req.query.memberId : ''
      const userId =
        (typeof body.userId === 'string' && body.userId.trim()) ||
        (typeof memberId === 'string' && memberId.trim()) ||
        ''
      if (!userId) {
        return fail(res, 400, 'INVALID_USER_ID', 'userId or memberId is required')
      }
      await removeRoomMember(groupId, userId)
      return ok(res, { removed: true, groupId, userId })
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      return fail(res, status, 'GROUP_MEMBER_REMOVE_FAILED', error.message || 'remove member failed')
    }
  }

  return methodNotAllowed(res)
}
