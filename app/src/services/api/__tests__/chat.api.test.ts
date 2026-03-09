import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatApi } from '../chat.api.ts'
import { apiClient } from '../client.ts'
import { ApiError } from '../../../types/api.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('chatApi', () => {
  it('creates realtime session via conversations + chat/sessions', async () => {
    const postSpy = vi.spyOn(apiClient, 'post')
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            id: 'u_1',
            deviceId: 'dev_1',
            createdAt: '2026-03-09T00:00:00.000Z',
            lastActive: '2026-03-09T00:00:00.000Z'
          },
          error: null,
          traceId: 'trc_0'
        }
      } as never)
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            roomId: 'r_1'
          },
          error: null,
          traceId: 'trc_1'
        }
      } as never)
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            sessionId: 'session_r_1',
            roomId: 'r_1'
          },
          error: null,
          traceId: 'trc_2'
        }
      } as never)

    const result = await chatApi.createSession({ roomType: 'group', topicId: 'r_1' })

    expect(result).toEqual({ sessionId: 'session_r_1', roomId: 'r_1' })
    expect(postSpy).toHaveBeenNthCalledWith(2, '/v1/conversations', expect.any(Object), expect.any(Object))
    expect(postSpy).toHaveBeenNthCalledWith(3, '/chat/sessions', { roomId: 'r_1' }, expect.any(Object))
  })

  it('falls back to local session id when conversations endpoint fails', async () => {
    vi.spyOn(apiClient, 'post')
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            id: 'u_1',
            deviceId: 'dev_1',
            createdAt: '2026-03-09T00:00:00.000Z',
            lastActive: '2026-03-09T00:00:00.000Z'
          },
          error: null,
          traceId: 'trc_0'
        }
      } as never)
      .mockRejectedValueOnce(new Error('network fail'))

    const result = await chatApi.createSession({ roomType: 'group', topicId: 'r_1' })

    expect(result.roomId).toBe('r_1')
    expect(result.sessionId.startsWith('s_r_1_')).toBe(true)
  })

  it('returns single MVP room from history', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          id: 'u_1',
          deviceId: 'dev_1',
          createdAt: '2026-03-09T00:00:00.000Z',
          lastActive: '2026-03-09T00:00:00.000Z'
        },
        error: null,
        traceId: 'trc_0'
      }
    } as never)
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          items: [
            {
              id: 1,
              question: 'Q1',
              answer: 'A1',
              createdAt: '2026-03-09T00:00:00.000Z'
            }
          ],
          nextCursor: null
        },
        error: null,
        traceId: 'trc_1'
      }
    } as never)

    const result = await chatApi.listRooms()
    expect(result.list).toHaveLength(1)
    expect(result.list[0].roomId).toBe('r_mvp_main')
    expect(result.hasMore).toBe(false)
  })

  it('parses listRooms success payload', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          id: 'u_1',
          deviceId: 'dev_1',
          createdAt: '2026-03-09T00:00:00.000Z',
          lastActive: '2026-03-09T00:00:00.000Z'
        },
        error: null,
        traceId: 'trc_0'
      }
    } as never)
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          items: [],
          nextCursor: null
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
    vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          id: 'u_1',
          deviceId: 'dev_1',
          createdAt: '2026-03-09T00:00:00.000Z',
          lastActive: '2026-03-09T00:00:00.000Z'
        },
        error: null,
        traceId: 'trc_0'
      }
    } as never)
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          items: [
            {
              id: 'bad',
              question: 'x',
              answer: 'y',
              createdAt: '2026-03-09T00:00:00.000Z'
            }
          ]
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
