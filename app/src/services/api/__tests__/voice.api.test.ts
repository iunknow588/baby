import { afterEach, describe, expect, it, vi } from 'vitest'
import { voiceApi } from '../voice.api.ts'
import { apiClient } from '../client.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('voiceApi', () => {
  it('parses uploadAudio success payload', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          fileId: 'f_1',
          duration: 1.2,
          codec: 'audio/webm'
        },
        error: null,
        traceId: 'trc_3'
      }
    } as never)

    const result = await voiceApi.uploadAudio(new Blob(['x'], { type: 'audio/webm' }))
    expect(result.fileId).toBe('f_1')
    expect(result.duration).toBe(1.2)
  })

  it('throws when duration is invalid type', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          fileId: 'f_1',
          duration: '1.2',
          codec: 'audio/webm'
        },
        error: null,
        traceId: 'trc_4'
      }
    } as never)

    await expect(voiceApi.uploadAudio(new Blob(['x']))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
  })
})
