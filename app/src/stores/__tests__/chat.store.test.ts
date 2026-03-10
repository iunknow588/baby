import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ApiError } from '../../types/api'
import type { MessageEntity } from '../../types/domain'

const sendMessageMock = vi.fn()
const listRoomsMock = vi.fn()
const listMessagesMock = vi.fn()
const createSessionMock = vi.fn()

vi.mock('../../services/api/chat.api', () => ({
  chatApi: {
    sendMessage: sendMessageMock,
    listRooms: listRoomsMock,
    listMessages: listMessagesMock,
    createSession: createSessionMock
  }
}))

vi.mock('../../services/api/voice.api', () => ({
  voiceApi: {
    uploadAudio: vi.fn(),
    asr: vi.fn(),
    tts: vi.fn()
  }
}))

vi.mock('../../platform/env', () => ({
  getRealtimeEnabled: () => false,
  getSseReconnectMs: () => 5000,
  getSseStaleMs: () => 15000,
  getSseWatchdogMs: () => 3000,
  getSseAutoRecoverCooldownMs: () => 8000
}))

describe('chat store state machine', () => {
  beforeEach(() => {
    vi.useRealTimers()
    setActivePinia(createPinia())
    sendMessageMock.mockReset()
    listRoomsMock.mockReset()
    listMessagesMock.mockReset()
    createSessionMock.mockReset()
  })

  it('marks failed message as delivered after retry success', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()

    const failed: MessageEntity = {
      _id: 'cm_1',
      roomId: 'r_1',
      senderId: 'u_current',
      senderType: 'user',
      messageType: 'text',
      content: 'hello',
      createdAt: '2026-03-07T00:00:00.000Z',
      status: 'failed'
    }

    store.messages = [failed]

    sendMessageMock.mockResolvedValueOnce({
      message: {
        ...failed,
        _id: 'm_1',
        status: 'delivered'
      }
    })

    await store.retryMessage('cm_1')

    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    expect(store.messages[0]._id).toBe('m_1')
    expect(store.messages[0].status).toBe('delivered')
  })

  it('applies SSE delta and status updates', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    store.roomId = 'r_1'

    store.onSseEvent({
      type: 'message.delta',
      data: {
        messageId: 'm_stream_1',
        roomId: 'r_1',
        delta: 'Hello '
      }
    })

    store.onSseEvent({
      type: 'message.delta',
      data: {
        messageId: 'm_stream_1',
        roomId: 'r_1',
        delta: 'World'
      }
    })

    store.onSseEvent({
      type: 'message.status',
      data: {
        messageId: 'm_stream_1',
        status: 'delivered'
      }
    })

    const message = store.messages.find(item => item._id === 'm_stream_1')
    expect(message?.content).toBe('Hello World')
    expect(message?.status).toBe('delivered')
  })

  it('deduplicates rooms when loading more pages', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()

    listRoomsMock.mockResolvedValueOnce({
      list: [
        {
          roomId: 'r_1',
          roomName: 'Room 1',
          roomType: 'dm',
          users: [],
          unreadCount: 0,
          lastActiveAt: '2026-03-07T00:00:00.000Z'
        }
      ],
      nextCursor: 'cursor_1',
      hasMore: true
    })

    listRoomsMock.mockResolvedValueOnce({
      list: [
        {
          roomId: 'r_1',
          roomName: 'Room 1 updated',
          roomType: 'dm',
          users: [],
          unreadCount: 1,
          lastActiveAt: '2026-03-07T00:00:00.000Z'
        },
        {
          roomId: 'r_2',
          roomName: 'Room 2',
          roomType: 'group',
          users: [],
          unreadCount: 0,
          lastActiveAt: '2026-03-07T00:00:00.000Z'
        }
      ],
      nextCursor: undefined,
      hasMore: false
    })

    await store.fetchRooms(true)
    await store.fetchMoreRooms()

    expect(store.rooms).toHaveLength(2)
    expect(store.rooms.find(item => item.roomId === 'r_1')?.roomName).toBe('Room 1 updated')
  })

  it('heals MVP send timeout by refreshing history and clears lastError', async () => {
    vi.useFakeTimers()
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    store.roomId = 'r_mvp_main'

    sendMessageMock.mockRejectedValueOnce(new ApiError('ECONNABORTED', 'timeout', undefined, {
      method: 'POST',
      path: '/chat'
    }))
    listMessagesMock.mockResolvedValueOnce({
      list: [
        {
          _id: 'm_user_1',
          roomId: 'r_mvp_main',
          senderId: 'u_current',
          senderType: 'user',
          messageType: 'text',
          content: 'hello',
          createdAt: '2026-03-10T00:00:00.000Z',
          status: 'delivered'
        }
      ],
      nextCursor: undefined,
      hasMore: false
    })

    const pending = store.sendText('hello')
    await vi.advanceTimersByTimeAsync(1300)
    await pending

    expect(listMessagesMock).toHaveBeenCalledWith('r_mvp_main')
    expect(store.lastError).toBe('')
    expect(store.messages.some(item => item.content === 'hello' && item.status === 'delivered')).toBe(true)
  })

  it('keeps error state when MVP reconciliation cannot find delivered message', async () => {
    vi.useFakeTimers()
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    store.roomId = 'r_mvp_main'

    sendMessageMock.mockRejectedValueOnce(new ApiError('ECONNABORTED', 'timeout', undefined, {
      method: 'POST',
      path: '/chat'
    }))
    listMessagesMock.mockResolvedValue({
      list: [],
      nextCursor: undefined,
      hasMore: false
    })

    const pending = store.sendText('still failing')
    await vi.advanceTimersByTimeAsync(4000)
    await pending

    expect(listMessagesMock).toHaveBeenCalledTimes(2)
    expect(store.lastError).toContain('[消息发送]')
    expect(store.messages).toHaveLength(1)
    expect(store.messages[0].status).toBe('failed')
  })
})
