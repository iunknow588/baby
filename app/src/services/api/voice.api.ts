import { apiClient } from './client'
import { ensureNumber, ensureObject, ensureString, parseApiEnvelope } from './guard'

export const voiceApi = {
  async uploadAudio(file: Blob): Promise<{ fileId: string; duration: number; codec: string }> {
    const form = new FormData()
    form.append('file', file, 'voice.webm')
    const res = await apiClient.post('/voice/upload', form)
    const body = parseApiEnvelope<unknown>(res.data)
    const data = ensureObject(body.data, 'voice.upload.data')
    return {
      fileId: ensureString(data.fileId, 'voice.upload.data.fileId'),
      duration: ensureNumber(data.duration, 'voice.upload.data.duration'),
      codec: ensureString(data.codec, 'voice.upload.data.codec')
    }
  },

  async asr(fileId: string, roomId: string): Promise<{ text: string; language: string; confidence: number }> {
    const res = await apiClient.post('/voice/asr', { fileId, roomId })
    const body = parseApiEnvelope<unknown>(res.data)
    const data = ensureObject(body.data, 'voice.asr.data')
    return {
      text: ensureString(data.text, 'voice.asr.data.text'),
      language: ensureString(data.language, 'voice.asr.data.language'),
      confidence: ensureNumber(data.confidence, 'voice.asr.data.confidence')
    }
  },

  async tts(text: string): Promise<{ audioUrl: string; duration: number }> {
    const res = await apiClient.post('/voice/tts', {
      text,
      voice: 'female_01',
      speed: 1.0
    })
    const body = parseApiEnvelope<unknown>(res.data)
    const data = ensureObject(body.data, 'voice.tts.data')
    return {
      audioUrl: ensureString(data.audioUrl, 'voice.tts.data.audioUrl'),
      duration: ensureNumber(data.duration, 'voice.tts.data.duration')
    }
  }
}
