import { afterEach, describe, expect, it, vi } from 'vitest'
import { voiceApi } from '../voice.api.ts'
import { apiClient } from '../client.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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

  it('parses asrByAudio success payload', async () => {
    class FileReaderMock {
      result: string | ArrayBuffer | null = null
      error: Error | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL(_blob: Blob) {
        this.result = 'data:audio/webm;base64,Zm9v'
        this.onload?.()
      }
    }
    vi.stubGlobal('FileReader', FileReaderMock as unknown as typeof FileReader)

    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          text: '你好',
          language: 'zh',
          confidence: 0.96
        },
        error: null,
        traceId: 'trc_5'
      }
    } as never)

    const result = await voiceApi.asrByAudio(new Blob(['x'], { type: 'audio/webm' }), 'r_1')
    expect(result.text).toBe('你好')
    expect(postSpy).toHaveBeenCalledWith('/voice/asr', {
      roomId: 'r_1',
      audioBase64: 'Zm9v',
      mimeType: 'audio/webm'
    })
  })
})
