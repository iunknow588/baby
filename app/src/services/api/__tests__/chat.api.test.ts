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

  it('falls back to /chat/sessions when conversations endpoint fails', async () => {
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
      .mockRejectedValueOnce(new Error('network fail'))
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            sessionId: 'session_fallback_r_1'
          },
          error: null,
          traceId: 'trc_fb'
        }
      } as never)

    const result = await chatApi.createSession({ roomType: 'group', topicId: 'r_1' })

    expect(result.roomId).toBe('r_1')
    expect(result.sessionId).toBe('session_fallback_r_1')
    expect(postSpy).toHaveBeenNthCalledWith(3, '/chat/sessions', { roomId: 'r_1' }, expect.any(Object))
  })

  it('creates MVP session directly via /chat/sessions', async () => {
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
            sessionId: 'session_mvp_main'
          },
          error: null,
          traceId: 'trc_1'
        }
      } as never)

    const result = await chatApi.createSession({ roomType: 'ai_dm', topicId: 'r_mvp_main' })

    expect(result).toEqual({ sessionId: 'session_mvp_main', roomId: 'r_mvp_main' })
    expect(postSpy).toHaveBeenNthCalledWith(2, '/chat/sessions', { roomId: 'r_mvp_main' }, expect.any(Object))
    expect(postSpy).not.toHaveBeenCalledWith('/v1/conversations', expect.anything(), expect.anything())
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

  it('sends MVP room message via /chat without calling platform messages path', async () => {
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
            conversationId: 1,
            answer: 'ok',
            structuredData: {
              overallGrade: 'A',
              characters: [{ score: 92 }]
            },
            renderType: 'calligraphy_scoring',
            renderVersion: 'v1',
            interactionMode: 'flow_first',
            processingFlow: {
              route: 'calligraphy_scoring',
              degraded: false,
              steps: [
                { id: 'input_normalize', status: 'done', detail: 'ok' },
                { id: 'agent_route', status: 'done', detail: 'ok' }
              ],
              nextActions: ['继续逐字点评']
            },
            createdAt: '2026-03-09T00:00:00.000Z'
          },
          error: null,
          traceId: 'trc_1'
        }
      } as never)

    const result = await chatApi.sendMessage({
      roomId: 'r_mvp_main',
      clientMessageId: 'cm_1',
      messageType: 'text',
      content: 'hello'
    })

    expect(result.message.status).toBe('delivered')
    expect(result.aiMessage?.content).toBe('ok')
    expect(result.aiMessage?.meta?.renderType).toBe('calligraphy_scoring')
    expect(result.aiMessage?.meta?.structuredData).toMatchObject({
      overallGrade: 'A'
    })
    expect(result.aiMessage?.meta?.processingFlow?.route).toBe('calligraphy_scoring')
    expect(result.aiMessage?.meta?.processingFlow?.steps?.length).toBe(2)
    expect(result.aiMessage?.meta?.interactionMode).toBe('flow_first')
    expect(postSpy).toHaveBeenNthCalledWith(2, '/chat', expect.any(Object), expect.any(Object))
    expect(postSpy).not.toHaveBeenCalledWith(expect.stringContaining('/v1/conversations/'), expect.anything(), expect.anything())
  })

  it('retries /chat once on timeout-like error', async () => {
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
      .mockRejectedValueOnce(new ApiError('ECONNABORTED', 'timeout of 30000ms exceeded'))
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            conversationId: 1,
            answer: 'retry-ok',
            createdAt: '2026-03-09T00:00:00.000Z'
          },
          error: null,
          traceId: 'trc_1'
        }
      } as never)

    const result = await chatApi.sendMessage({
      roomId: 'r_mvp_main',
      clientMessageId: 'cm_retry_1',
      messageType: 'text',
      content: 'hello retry'
    })

    expect(result.aiMessage?.content).toBe('retry-ok')
    expect(postSpy).toHaveBeenCalledTimes(3)
    expect(postSpy).toHaveBeenNthCalledWith(2, '/chat', expect.any(Object), expect.any(Object))
    expect(postSpy).toHaveBeenNthCalledWith(3, '/chat', expect.any(Object), expect.any(Object))
  })

  it('sends files payload to /chat in MVP path', async () => {
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
            conversationId: 1,
            answer: 'ok',
            createdAt: '2026-03-09T00:00:00.000Z'
          },
          error: null,
          traceId: 'trc_1'
        }
      } as never)

    await chatApi.sendMessage({
      roomId: 'r_mvp_main',
      clientMessageId: 'cm_with_file',
      messageType: 'image',
      content: '[附件] demo.png',
      files: [
        {
          name: 'demo.png',
          type: 'image/png',
          size: 123,
          url: 'https://example.com/demo.png'
        }
      ]
    })

    expect(postSpy).toHaveBeenNthCalledWith(
      2,
      '/chat',
      expect.objectContaining({
        message: '[附件] demo.png',
        files: [
          expect.objectContaining({
            name: 'demo.png',
            url: 'https://example.com/demo.png'
          })
        ]
      }),
      expect.any(Object)
    )
  })
})
