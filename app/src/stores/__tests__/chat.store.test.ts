import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
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
  getSseReconnectMs: () => 5000,
  getSseStaleMs: () => 15000,
  getSseWatchdogMs: () => 3000
}))

describe('chat store state machine', () => {
  beforeEach(() => {
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
      ...failed,
      _id: 'm_1',
      status: 'delivered'
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
})
