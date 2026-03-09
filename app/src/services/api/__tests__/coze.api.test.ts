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
  it('parses /chat envelope payload', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          chatId: 'chat_1',
          conversationId: 'conv_1',
          answer: 'legacy ok'
        },
        error: null,
        traceId: 'trc_1'
      }
    } as never)

    const result = await cozeApi.chat({ message: '你好' })
    expect(result.chatId).toBe('chat_1')
    expect(result.conversationId).toBe('conv_1')
    expect(result.answer).toBe('legacy ok')
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/chat'),
      expect.objectContaining({ message: '你好' }),
      expect.objectContaining({ timeout: 20000 })
    )
  })

  it('throws INVALID_RESPONSE when /chat envelope answer is missing', async () => {
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
