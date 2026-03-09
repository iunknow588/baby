import { apiClient } from './client'
import type { RoomEntity, MessageEntity } from '../../types/domain'
import {
  ensureArray,
  ensureNumber,
  ensureObject,
  ensureString,
  parseApiEnvelope
} from './guard'

export interface PagedResult<T> {
  list: T[]
  nextCursor?: string
  hasMore: boolean
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

async function ensureUser(deviceId: string) {
  await apiClient.post('/user', { deviceId })
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

async function getHistory(limit = 20): Promise<HistoryItem[]> {
  const deviceId = getOrCreateDeviceId()
  await ensureUser(deviceId)
  const res = await apiClient.get('/history', { params: { deviceId, limit } })
  const body = parseApiEnvelope<unknown>(res.data)
  return parseHistory(body.data)
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

export const chatApi = {
  async createSession(payload: { roomType: RoomEntity['roomType']; targetId?: string; topicId?: string }) {
    const _ = payload
    return {
      sessionId: `s_mvp_${Date.now()}`,
      roomId: MVP_ROOM_ID
    }
  },

  async listRooms(cursor?: string): Promise<PagedResult<RoomEntity>> {
    const _ = cursor
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
  },

  async listMessages(roomId: string, cursor?: string): Promise<PagedResult<MessageEntity>> {
    const _ = cursor
    if (roomId !== MVP_ROOM_ID) {
      return { list: [], hasMore: false, nextCursor: undefined }
    }
    const history = await getHistory(50)
    const list = mapHistoryToMessages(history)
    return { list, hasMore: false, nextCursor: undefined }
  },

  async sendMessage(payload: {
    roomId: string
    clientMessageId: string
    messageType: MessageEntity['messageType']
    content: string
    files?: MessageEntity['files']
    meta?: MessageEntity['meta']
  }): Promise<MessageEntity> {
    if (payload.roomId !== MVP_ROOM_ID) {
      throw new Error(`roomId ${payload.roomId} is invalid for MVP mode`)
    }
    const deviceId = getOrCreateDeviceId()
    await ensureUser(deviceId)
    const res = await apiClient.post('/chat', {
      deviceId,
      message: payload.content
    })
    const body = parseApiEnvelope<Record<string, unknown>>(res.data)
    const data = ensureObject(body.data, 'sendMessage.data')
    const answer = ensureString(data.answer, 'sendMessage.data.answer')
    return {
      _id: payload.clientMessageId,
      roomId: payload.roomId,
      senderId: 'u_current',
      senderType: 'user',
      messageType: payload.messageType,
      content: payload.content,
      createdAt: ensureString(data.createdAt, 'sendMessage.data.createdAt'),
      status: 'delivered',
      files: payload.files,
      meta: { ...(payload.meta || {}), aiAnswer: answer }
    }
  }
}
