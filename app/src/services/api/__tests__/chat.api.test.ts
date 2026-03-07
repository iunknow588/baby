import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatApi } from '../chat.api.ts'
import { apiClient } from '../client.ts'
import { ApiError } from '../../../types/api.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('chatApi', () => {
  it('parses listRooms success payload', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: {
        success: true,
        data: {
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
          hasMore: false,
          nextCursor: ''
        },
        error: null,
        traceId: 'trc_1'
      }
    } as never)

    const result = await chatApi.listRooms()
    expect(result.list).toHaveLength(1)
    expect(result.hasMore).toBe(false)
  })

  it('throws INVALID_RESPONSE when hasMore is missing', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          list: []
        },
        error: null,
        traceId: 'trc_2'
      }
    } as never)

    await expect(chatApi.listRooms()).rejects.toMatchObject<ApiError>({
      code: 'INVALID_RESPONSE'
    })
  })
})
