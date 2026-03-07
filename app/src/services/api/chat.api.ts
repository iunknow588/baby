import { apiClient } from './client'
import type { RoomEntity, MessageEntity } from '../../types/domain'
import {
  ensureArray,
  ensureBoolean,
  ensureObject,
  ensureString,
  parseApiEnvelope
} from './guard'

export interface PagedResult<T> {
  list: T[]
  nextCursor?: string
  hasMore: boolean
}

function parsePaged<T>(raw: unknown, name: string): PagedResult<T> {
  const obj = ensureObject(raw, name)
  return {
    list: ensureArray(obj.list, `${name}.list`) as T[],
    nextCursor: typeof obj.nextCursor === 'string' ? obj.nextCursor : undefined,
    hasMore: ensureBoolean(obj.hasMore, `${name}.hasMore`)
  }
}

export const chatApi = {
  async createSession(payload: { roomType: RoomEntity['roomType']; targetId?: string; topicId?: string }) {
    const res = await apiClient.post('/chat/sessions', payload)
    const body = parseApiEnvelope<Record<string, unknown>>(res.data)
    const data = ensureObject(body.data, 'createSession.data')
    return {
      sessionId: ensureString(data.sessionId, 'createSession.data.sessionId'),
      roomId: ensureString(data.roomId, 'createSession.data.roomId')
    }
  },

  async listRooms(cursor?: string): Promise<PagedResult<RoomEntity>> {
    const res = await apiClient.get('/chat/rooms', {
      params: { cursor, limit: 20 }
    })
    const body = parseApiEnvelope<unknown>(res.data)
    return parsePaged<RoomEntity>(body.data, 'listRooms.data')
  },

  async listMessages(roomId: string, cursor?: string): Promise<PagedResult<MessageEntity>> {
    const res = await apiClient.get(`/chat/rooms/${roomId}/messages`, {
      params: { cursor, limit: 20 }
    })
    const body = parseApiEnvelope<unknown>(res.data)
    return parsePaged<MessageEntity>(body.data, 'listMessages.data')
  },

  async sendMessage(payload: {
    roomId: string
    clientMessageId: string
    messageType: MessageEntity['messageType']
    content: string
    files?: MessageEntity['files']
    meta?: MessageEntity['meta']
  }): Promise<MessageEntity> {
    const res = await apiClient.post('/chat/messages', payload)
    const body = parseApiEnvelope<Record<string, unknown>>(res.data)
    const data = ensureObject(body.data, 'sendMessage.data')
    return ensureObject(data.message, 'sendMessage.data.message') as MessageEntity
  }
}
