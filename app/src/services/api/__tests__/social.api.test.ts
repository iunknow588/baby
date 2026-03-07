import { afterEach, describe, expect, it, vi } from 'vitest'
import { socialApi } from '../social.api.ts'
import { apiClient } from '../client.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('socialApi', () => {
  it('parses sendFriendRequest success payload', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      data: {
        success: true,
        data: { requestId: 'fr_1' },
        error: null,
        traceId: 'trc_5'
      }
    } as never)

    const result = await socialApi.sendFriendRequest('u_1001')
    expect(result.requestId).toBe('fr_1')
  })

  it('maps business error from envelope', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      data: {
        success: false,
        data: null,
        error: {
          code: 'RATE_LIMITED',
          message: 'too many requests'
        },
        traceId: 'trc_6'
      }
    } as never)

    await expect(socialApi.sendFriendRequest('u_1001')).rejects.toMatchObject({
      code: 'RATE_LIMITED'
    })
  })
})
