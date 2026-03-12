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

export interface BackendReadinessResult {
  aiReplyReady: boolean
  missing: string[]
}

export interface UploadedAsset {
  assetId: string
  conversationId: string
  fileName: string
  mediaType: string
  size: number
  url: string
  createdAt: string
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
const MVP_CHAT_TIMEOUT_MS = 30000
const MVP_CHAT_RETRY_COUNT = 1
let memoryDeviceId = ''
let platformMessagePathUnavailable = false

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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('read blob failed'))
    reader.onload = () => {
      const raw = typeof reader.result === 'string' ? reader.result : ''
      const encoded = raw.includes(',') ? raw.split(',')[1] : raw
      resolve(encoded || '')
    }
    reader.readAsDataURL(blob)
  })
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

async function getBackendReadiness(): Promise<BackendReadinessResult> {
  const res = await apiClient.get('/diagnostics', withActorHeaders())
  const body = parseApiEnvelope<unknown>(res.data)
  const data = ensureObject(body.data, 'diagnostics.data')
  const missingRaw = Array.isArray(data.missing) ? data.missing : []
  const missing = missingRaw
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
  const requiredForAi = ['COZE_API_BASE_URL', 'COZE_API_TOKEN', 'COZE_BOT_ID']
  const missingCritical = requiredForAi.filter(name => missing.includes(name))
  return {
    aiReplyReady: missingCritical.length === 0,
    missing: missingCritical
  }
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
    const fallbackRoomId = payload.targetId || payload.topicId || MVP_ROOM_ID

    if (fallbackRoomId === MVP_ROOM_ID || payload.roomType === 'ai_dm') {
      const sessionRes = await apiClient.post('/chat/sessions', { roomId: fallbackRoomId }, withActorHeaders())
      const sessionBody = parseApiEnvelope<unknown>(sessionRes.data)
      const sessionData = ensureObject(sessionBody.data, 'createSession.session.data')
      const sessionId = ensureString(sessionData.sessionId, 'createSession.session.data.sessionId')
      return { sessionId, roomId: fallbackRoomId }
    }

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
    } catch {
      const sessionRes = await apiClient.post('/chat/sessions', { roomId: fallbackRoomId }, withActorHeaders())
      const sessionBody = parseApiEnvelope<unknown>(sessionRes.data)
      const sessionData = ensureObject(sessionBody.data, 'createSession.session.data')
      const sessionId = ensureString(sessionData.sessionId, 'createSession.session.data.sessionId')
      return { sessionId, roomId: fallbackRoomId }
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
    if (roomId === MVP_ROOM_ID || platformMessagePathUnavailable) {
      const history = await getHistory(50)
      return { list: mapHistoryToMessages(history), hasMore: false, nextCursor: undefined }
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
    const sendViaMvpChat = async (): Promise<SendMessageResult> => {
      let res: Awaited<ReturnType<typeof apiClient.post>> | null = null
      let lastError: unknown = null

      for (let attempt = 0; attempt <= MVP_CHAT_RETRY_COUNT; attempt += 1) {
        try {
          res = await apiClient.post(
            '/chat',
            {
              deviceId,
              message: payload.content,
              files: payload.files || []
            },
            {
              ...withActorHeaders(),
              timeout: MVP_CHAT_TIMEOUT_MS
            }
          )
          lastError = null
          break
        } catch (error) {
          lastError = error
          const code = error instanceof ApiError ? error.code : ''
          const timeoutLike = code === 'ECONNABORTED' || String(code).toUpperCase().includes('TIMEOUT')
          const canRetry = timeoutLike && attempt < MVP_CHAT_RETRY_COUNT
          if (!canRetry) {
            throw error
          }
          await sleep(400)
        }
      }

      if (!res) {
        throw (lastError instanceof Error ? lastError : new Error('MVP chat request failed'))
      }
      const body = parseApiEnvelope<Record<string, unknown>>(res.data)
      const data = ensureObject(body.data, 'sendMessage.data')
      const answer = ensureString(data.answer, 'sendMessage.data.answer')
      const degraded = typeof data.degraded === 'boolean' ? data.degraded : false
      const degradedReason = typeof data.degradedReason === 'string' ? data.degradedReason : ''
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
        meta: { ...(payload.meta || {}), aiAnswer: answer, degraded, degradedReason }
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
            status: 'delivered',
            meta: { degraded, degradedReason }
          }
        : undefined
      return { message: userMessage, aiMessage }
    }

    if (payload.roomId === MVP_ROOM_ID || platformMessagePathUnavailable) {
      return sendViaMvpChat()
    }

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
      // Platform messages table is currently unavailable in production; switch to MVP path.
      platformMessagePathUnavailable = true
      return sendViaMvpChat()
    }
  },

  async getBackendReadiness(): Promise<BackendReadinessResult> {
    return getBackendReadiness()
  },

  async uploadAsset(payload: {
    conversationId: string
    file: Blob
    fileName: string
    mediaType?: string
    size?: number
  }): Promise<UploadedAsset> {
    const mediaType = payload.mediaType || payload.file.type || 'application/octet-stream'
    const size = Number.isFinite(Number(payload.size)) ? Number(payload.size) : payload.file.size || 0
    const fileBase64 = await blobToBase64(payload.file)
    const res = await apiClient.post(
      '/v1/assets/upload',
      {
        conversationId: payload.conversationId,
        fileName: payload.fileName,
        mediaType,
        size,
        fileBase64
      },
      withActorHeaders()
    )
    const body = parseApiEnvelope<unknown>(res.data)
    const data = ensureObject(body.data, 'uploadAsset.data')
    return {
      assetId: ensureString(data.assetId, 'uploadAsset.data.assetId'),
      conversationId: ensureString(data.conversationId, 'uploadAsset.data.conversationId'),
      fileName: ensureString(data.fileName, 'uploadAsset.data.fileName'),
      mediaType: ensureString(data.mediaType, 'uploadAsset.data.mediaType'),
      size: ensureNumber(data.size, 'uploadAsset.data.size'),
      url: ensureString(data.url, 'uploadAsset.data.url'),
      createdAt: ensureString(data.createdAt, 'uploadAsset.data.createdAt')
    }
  }
}
