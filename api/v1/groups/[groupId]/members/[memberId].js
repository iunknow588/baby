import { fail, methodNotAllowed, ok } from '../../../../_lib/http.js'
import { getActorId, removeRoomMember } from '../../../../_lib/platform-chat.js'

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return methodNotAllowed(res)

  const groupId = typeof req.query?.groupId === 'string' ? req.query.groupId.trim() : ''
  const memberId = typeof req.query?.memberId === 'string' ? req.query.memberId.trim() : ''
  if (!groupId) {
    return fail(res, 400, 'INVALID_GROUP_ID', 'groupId is required')
  }
  if (!memberId) {
    return fail(res, 400, 'INVALID_MEMBER_ID', 'memberId is required')
  }

  try {
    const _operatorId = getActorId(req)
    await removeRoomMember(groupId, memberId)
    return ok(res, { removed: true, groupId, userId: memberId })
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 500
    return fail(res, status, 'GROUP_MEMBER_REMOVE_FAILED', error.message || 'remove member failed')
  }
}
