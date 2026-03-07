import { afterEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import { cozeApi } from '../coze.api.ts'
import { ApiError } from '../../../types/api.ts'

vi.mock('axios')
const mockedAxios = vi.mocked(axios, true)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cozeApi', () => {
  it('parses coze chat response', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          chatId: 'chat_1',
          conversationId: 'conv_1',
          answer: '你好，我是AI老师'
        },
        error: null,
        traceId: 'trc_1'
      }
    } as never)

    const result = await cozeApi.chat({ message: '你好' })
    expect(result.chatId).toBe('chat_1')
    expect(result.conversationId).toBe('conv_1')
    expect(result.answer).toContain('AI老师')
  })

  it('throws INVALID_RESPONSE when answer is missing', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          chatId: 'chat_2',
          conversationId: 'conv_2'
        },
        error: null,
        traceId: 'trc_2'
      }
    } as never)

    await expect(cozeApi.chat({ message: '测试' })).rejects.toMatchObject<ApiError>({
      code: 'INVALID_RESPONSE'
    })
  })
})
