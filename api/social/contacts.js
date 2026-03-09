import { methodNotAllowed, ok, fail, resolveCurrentUserId } from '../_lib/http.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res)

  try {
    const self = resolveCurrentUserId(req)
    const cursor = typeof req.query?.cursor === 'string' ? req.query.cursor : ''
    const limitRaw = Number(req.query?.limit ?? 20)
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 20

    const base = [
      { userId: 'u_ai', username: 'AI 主持人', relation: 'friend' },
      { userId: 'u_parent_demo', username: '家长示例', relation: 'friend' },
      { userId: 'u_teacher_demo', username: '老师示例', relation: 'pending' },
      { userId: self, username: '我', relation: 'friend' }
    ]

    const start = cursor ? Number(cursor) || 0 : 0
    const list = base.slice(start, start + limit)
    const next = start + list.length < base.length ? String(start + list.length) : null

    return ok(res, {
      list,
      hasMore: Boolean(next),
      nextCursor: next
    })
  } catch (error) {
    return fail(res, 500, 'SOCIAL_CONTACTS_FAILED', error.message || 'list contacts failed')
  }
}
