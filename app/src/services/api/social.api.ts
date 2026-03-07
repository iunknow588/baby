import { apiClient } from './client'
import { ensureArray, ensureBoolean, ensureObject, ensureString, parseApiEnvelope } from './guard'

export interface ContactItem {
  userId: string
  username: string
  relation: 'friend' | 'pending' | 'blocked'
}

export interface FriendRequestItem {
  requestId: string
  fromUserId: string
  fromUsername: string
  createdAt: string
}

export interface PagedResult<T> {
  list: T[]
  nextCursor?: string
  hasMore: boolean
}

function parseRequestId(data: unknown): { requestId: string } {
  const obj = ensureObject(data, 'social.requestId.data')
  return { requestId: ensureString(obj.requestId, 'social.requestId.data.requestId') }
}

export const socialApi = {
  async listContacts(cursor?: string): Promise<PagedResult<ContactItem>> {
    const res = await apiClient.get('/social/contacts', { params: { cursor, limit: 20 } })
    const body = parseApiEnvelope<unknown>(res.data)
    const data = body.data
    if (Array.isArray(data)) {
      return { list: data as ContactItem[], hasMore: false, nextCursor: undefined }
    }
    const obj = ensureObject(data, 'social.contacts')
    return {
      list: ensureArray(obj.list, 'social.contacts.list') as ContactItem[],
      hasMore: ensureBoolean(obj.hasMore, 'social.contacts.hasMore'),
      nextCursor: typeof obj.nextCursor === 'string' ? obj.nextCursor : undefined
    }
  },

  async listFriendRequests(): Promise<FriendRequestItem[]> {
    const res = await apiClient.get('/social/friend-requests')
    const body = parseApiEnvelope<unknown>(res.data)
    return ensureArray(body.data, 'social.friendRequests') as FriendRequestItem[]
  },

  async sendFriendRequest(targetUserId: string): Promise<{ requestId: string }> {
    const res = await apiClient.post('/social/friend-requests', { targetUserId })
    const body = parseApiEnvelope<unknown>(res.data)
    return parseRequestId(body.data)
  },

  async acceptFriendRequest(requestId: string): Promise<{ ok: true }> {
    const res = await apiClient.post(`/social/friend-requests/${requestId}/accept`)
    const body = parseApiEnvelope<unknown>(res.data)
    const data = ensureObject(body.data, 'social.accept.data')
    ensureBoolean(data.ok, 'social.accept.data.ok')
    return { ok: true }
  },

  async rejectFriendRequest(requestId: string): Promise<{ ok: true }> {
    const res = await apiClient.post(`/social/friend-requests/${requestId}/reject`)
    const body = parseApiEnvelope<unknown>(res.data)
    const data = ensureObject(body.data, 'social.reject.data')
    ensureBoolean(data.ok, 'social.reject.data.ok')
    return { ok: true }
  }
}
