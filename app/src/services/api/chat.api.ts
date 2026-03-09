import { apiClient } from './client'
import type { RoomEntity, MessageEntity } from '../../types/domain'
import {
  ensureArray,
  ensureBoolean,
  ensureNumber,
  ensureObject,
  ensureString,
  parseApiEnvelope
} from './guard'
import { ApiError } from '../../types/api'

export interface PagedResult<T> {
  list: T[]
  nextCursor?: string
  hasMore: boolean
}

export interface SendMessageResult {
  message: MessageEntity
  aiMessage?: MessageEntity
}

type HistoryItem = {
  id: number
  question: string
  answer: string
  createdAt: string
}

const DEVICE_ID_KEY = 'baby_device_id'
const MVP_ROOM_ID = 'r_mvp_main'
const MVP_ROOM_NAME = 'AI 助手'
let memoryDeviceId = ''

function getStorage() {
  if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
    return globalThis.localStorage
  }
  return null
}

function getOrCreateDeviceId(): string {
  const storage = getStorage()
  const cached = storage ? storage.getItem(DEVICE_ID_KEY) : memoryDeviceId
  if (cached && cached.trim()) return cached
  const generated =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `dev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  if (storage) {
    storage.setItem(DEVICE_ID_KEY, generated)
  } else {
    memoryDeviceId = generated
  }
  return generated
}

function withActorHeaders() {
  return { headers: { 'x-user-id': getOrCreateDeviceId() } }
}

async function ensureUser(deviceId: string) {
  await apiClient.post('/user', { deviceId }, withActorHeaders())
}

function parseRoomEntity(raw: unknown, index: number): RoomEntity {
  const row = ensureObject(raw, `conversations.list[${index}]`)
  return {
    roomId: ensureString(row.roomId, `conversations.list[${index}].roomId`),
    roomName: ensureString(row.roomName, `conversations.list[${index}].roomName`),
    roomType:
      row.roomType === 'group' || row.roomType === 'dm' || row.roomType === 'ai_dm' || row.roomType === 'mentor_room'
        ? row.roomType
        : 'ai_dm',
    users: [],
    unreadCount: typeof row.unreadCount === 'number' ? row.unreadCount : 0,
    lastActiveAt:
      typeof row.lastActiveAt === 'string' && row.lastActiveAt.trim()
        ? row.lastActiveAt
        : new Date().toISOString(),
    lastMessage: undefined
  }
}

function parseMessageEntity(raw: unknown, index: number): MessageEntity {
  const row = ensureObject(raw, `messages.list[${index}]`)
  return {
    _id: ensureString(row._id, `messages.list[${index}]._id`),
    roomId: ensureString(row.roomId, `messages.list[${index}].roomId`),
    senderId: ensureString(row.senderId, `messages.list[${index}].senderId`),
    senderType:
      row.senderType === 'ai' || row.senderType === 'system' || row.senderType === 'user'
        ? row.senderType
        : 'user',
    messageType:
      typeof row.messageType === 'string' && row.messageType.trim()
        ? (row.messageType as MessageEntity['messageType'])
        : 'text',
    content: typeof row.content === 'string' ? row.content : '',
    createdAt:
      typeof row.createdAt === 'string' && row.createdAt.trim()
        ? row.createdAt
        : new Date().toISOString(),
    status:
      row.status === 'local' || row.status === 'sending' || row.status === 'delivered' || row.status === 'seen' || row.status === 'failed'
        ? row.status
        : 'delivered',
    files: Array.isArray(row.files) ? (row.files as MessageEntity['files']) : undefined,
    meta: row.meta && typeof row.meta === 'object' ? (row.meta as MessageEntity['meta']) : undefined
  }
}

function parseHistory(raw: unknown): HistoryItem[] {
  const obj = ensureObject(raw, 'history.data')
  const items = ensureArray(obj.items, 'history.data.items')
  return items.map((item, index) => {
    const row = ensureObject(item, `history.data.items[${index}]`)
    return {
      id: ensureNumber(row.id, `history.data.items[${index}].id`),
      question: ensureString(row.question, `history.data.items[${index}].question`),
      answer: ensureString(row.answer, `history.data.items[${index}].answer`),
      createdAt: ensureString(row.createdAt, `history.data.items[${index}].createdAt`)
    }
  })
}

function roomsFromHistoryItems(items: HistoryItem[]): PagedResult<RoomEntity> {
  const messages = mapHistoryToMessages(items)
  const lastMessage = messages.length ? messages[messages.length - 1] : undefined
  const room: RoomEntity = {
    roomId: MVP_ROOM_ID,
    roomName: MVP_ROOM_NAME,
    roomType: 'ai_dm',
    users: [],
    unreadCount: 0,
    lastActiveAt: lastMessage?.createdAt || new Date().toISOString(),
    lastMessage
  }
  return { list: [room], hasMore: false, nextCursor: undefined }
}

function mapHistoryToMessages(items: HistoryItem[]): MessageEntity[] {
  const asc = [...items].reverse()
  const list: MessageEntity[] = []
  asc.forEach(row => {
    list.push({
      _id: `q_${row.id}`,
      roomId: MVP_ROOM_ID,
      senderId: 'u_current',
      senderType: 'user',
      messageType: 'text',
      content: row.question,
      createdAt: row.createdAt,
      status: 'delivered'
    })
    list.push({
      _id: `a_${row.id}`,
      roomId: MVP_ROOM_ID,
      senderId: 'u_ai',
      senderType: 'ai',
      messageType: 'text',
      content: row.answer,
      createdAt: row.createdAt,
      status: 'delivered'
    })
  })
  return list
}

async function getHistory(limit = 20): Promise<HistoryItem[]> {
  const deviceId = getOrCreateDeviceId()
  await ensureUser(deviceId)
  const res = await apiClient.get('/history', { params: { deviceId, limit }, ...withActorHeaders() })
  const body = parseApiEnvelope<unknown>(res.data)
  return parseHistory(body.data)
}

async function listRoomsFallback(): Promise<PagedResult<RoomEntity>> {
  const history = await getHistory(20)
  const messages = mapHistoryToMessages(history)
  const lastMessage = messages.length ? messages[messages.length - 1] : undefined
  const room: RoomEntity = {
    roomId: MVP_ROOM_ID,
    roomName: MVP_ROOM_NAME,
    roomType: 'ai_dm',
    users: [],
    unreadCount: 0,
    lastActiveAt: lastMessage?.createdAt || new Date().toISOString(),
    lastMessage
  }
  return { list: [room], hasMore: false, nextCursor: undefined }
}

export const chatApi = {
  async createSession(payload: { roomType: RoomEntity['roomType']; targetId?: string; topicId?: string }) {
    const deviceId = getOrCreateDeviceId()
    await ensureUser(deviceId)

    const roomType = payload.roomType === 'dm' || payload.roomType === 'ai_dm' ? 'private' : 'group'
    const groupId = typeof payload.topicId === 'string' ? payload.topicId.trim() : ''
    const participantIds = payload.targetId
      ? [payload.targetId]
      : payload.roomType === 'ai_dm'
        ? ['u_ai']
        : []

    try {
      const res = await apiClient.post(
        '/v1/conversations',
        {
          type: roomType,
          groupId: groupId || undefined,
          participantIds
        },
        withActorHeaders()
      )
      const body = parseApiEnvelope<unknown>(res.data)
      const data = ensureObject(body.data, 'createSession.data')
      const roomId =
        (typeof data.roomId === 'string' && data.roomId.trim()) ||
        (typeof data.conversationId === 'string' && data.conversationId.trim()) ||
        ''

      if (!roomId) {
        throw new ApiError('INVALID_RESPONSE', 'Missing roomId in createSession response', {
          path: '/v1/conversations',
          method: 'POST'
        })
      }

      const sessionRes = await apiClient.post('/chat/sessions', { roomId }, withActorHeaders())
      const sessionBody = parseApiEnvelope<unknown>(sessionRes.data)
      const sessionData = ensureObject(sessionBody.data, 'createSession.session.data')
      const sessionId = ensureString(sessionData.sessionId, 'createSession.session.data.sessionId')

      return {
        sessionId,
        roomId
      }
    } catch (_error) {
      const roomId = payload.targetId || payload.topicId || MVP_ROOM_ID
      return {
        sessionId: `s_${roomId}_${Date.now()}`,
        roomId
      }
    }
  },

  async listRooms(cursor?: string): Promise<PagedResult<RoomEntity>> {
    const deviceId = getOrCreateDeviceId()
    await ensureUser(deviceId)

    try {
      const res = await apiClient.get('/v1/conversations', {
        params: { cursor, limit: 20 },
        ...withActorHeaders()
      })
      const body = parseApiEnvelope<unknown>(res.data)
      const data = ensureObject(body.data, 'conversations.data')

      // Compatibility: when backend still returns history-like shape.
      if (Array.isArray(data.items)) {
        const history = parseHistory(data)
        return roomsFromHistoryItems(history)
      }

      const listRaw = ensureArray(data.list, 'conversations.data.list')
      const list = listRaw.map(parseRoomEntity)
      const hasMore = ensureBoolean(data.hasMore, 'conversations.data.hasMore')
      const nextCursor = typeof data.nextCursor === 'string' ? data.nextCursor : undefined
      return { list, hasMore, nextCursor }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INVALID_RESPONSE') {
        throw error
      }
      return listRoomsFallback()
    }
  },

  async listMessages(roomId: string, cursor?: string): Promise<PagedResult<MessageEntity>> {
    if (!roomId) {
      return { list: [], hasMore: false, nextCursor: undefined }
    }

    try {
      const res = await apiClient.get(`/v1/conversations/${encodeURIComponent(roomId)}/messages`, {
        params: { cursor, limit: 50 },
        ...withActorHeaders()
      })
      const body = parseApiEnvelope<unknown>(res.data)
      const data = ensureObject(body.data, 'messages.data')
      const listRaw = ensureArray(data.list, 'messages.data.list')
      const list = listRaw.map(parseMessageEntity)
      const hasMore = ensureBoolean(data.hasMore, 'messages.data.hasMore')
      const nextCursor = typeof data.nextCursor === 'string' ? data.nextCursor : undefined
      return { list, hasMore, nextCursor }
    } catch (_error) {
      if (roomId !== MVP_ROOM_ID) {
        return { list: [], hasMore: false, nextCursor: undefined }
      }
      const history = await getHistory(50)
      return { list: mapHistoryToMessages(history), hasMore: false, nextCursor: undefined }
    }
  },

  async sendMessage(payload: {
    roomId: string
    clientMessageId: string
    messageType: MessageEntity['messageType']
    content: string
    files?: MessageEntity['files']
    meta?: MessageEntity['meta']
  }): Promise<SendMessageResult> {
    const deviceId = getOrCreateDeviceId()
    await ensureUser(deviceId)

    try {
      const res = await apiClient.post(
        `/v1/conversations/${encodeURIComponent(payload.roomId)}/messages`,
        {
          clientMessageId: payload.clientMessageId,
          type: payload.messageType,
          content: payload.content,
          files: payload.files,
          meta: payload.meta
        },
        withActorHeaders()
      )
      const body = parseApiEnvelope<unknown>(res.data)
      const data = ensureObject(body.data, 'sendMessage.data')
      const message = parseMessageEntity(ensureObject(data.message, 'sendMessage.data.message'), 0)
      const aiMessage = data.aiMessage && typeof data.aiMessage === 'object' ? parseMessageEntity(data.aiMessage, 1) : null
      if (aiMessage?.content) {
        message.meta = {
          ...(message.meta || {}),
          aiAnswer: aiMessage.content
        }
      }
      return { message, aiMessage: aiMessage || undefined }
    } catch (_error) {
      const res = await apiClient.post('/chat', {
        deviceId,
        message: payload.content
      }, withActorHeaders())
      const body = parseApiEnvelope<Record<string, unknown>>(res.data)
      const data = ensureObject(body.data, 'sendMessage.data')
      const answer = ensureString(data.answer, 'sendMessage.data.answer')
      const userMessage: MessageEntity = {
        _id: payload.clientMessageId,
        roomId: payload.roomId || MVP_ROOM_ID,
        senderId: 'u_current',
        senderType: 'user',
        messageType: payload.messageType,
        content: payload.content,
        createdAt: ensureString(data.createdAt, 'sendMessage.data.createdAt'),
        status: 'delivered',
        files: payload.files,
        meta: { ...(payload.meta || {}), aiAnswer: answer }
      }
      const aiMessage: MessageEntity | undefined = answer
        ? {
            _id: `ai_${payload.clientMessageId}`,
            roomId: payload.roomId || MVP_ROOM_ID,
            senderId: 'u_ai',
            senderType: 'ai',
            messageType: 'text',
            content: answer,
            createdAt: userMessage.createdAt,
            status: 'delivered'
          }
        : undefined
      return { message: userMessage, aiMessage }
    }
  }
}
