import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatMock = vi.fn()

vi.mock('../../services/api/coze.api', () => ({
  cozeApi: {
    chat: chatMock
  }
}))

vi.mock('../../platform/env', () => ({
  getCozeApiUri: () => '/api/coze',
  getCozeUserId: () => 'user_demo'
}))

describe('mentor store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    chatMock.mockReset()
  })

  it('stores conversation and reply on success', async () => {
    const { useMentorStore } = await import('../mentor')
    const store = useMentorStore()

    chatMock.mockResolvedValueOnce({
      chatId: 'chat_1',
      conversationId: 'conv_1',
      answer: '建议你先打个招呼'
    })

    const answer = await store.askTeacher('怎么开启社交话题')
    expect(answer).toContain('招呼')
    expect(store.conversationId).toBe('conv_1')
    expect(store.lastReply).toContain('招呼')
  })

  it('keeps store stable on api failure', async () => {
    const { useMentorStore } = await import('../mentor')
    const store = useMentorStore()

    chatMock.mockRejectedValueOnce(new Error('network down'))

    const answer = await store.askTeacher('test')
    expect(answer).toBe('')
    expect(store.lastError).toBeTruthy()
    expect(store.asking).toBe(false)
  })
})
