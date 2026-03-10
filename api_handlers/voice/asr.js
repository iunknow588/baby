import { fail, methodNotAllowed, ok, readJson } from '../_lib/http.js'

const OPENAI_ASR_BASE_URL = (process.env.OPENAI_API_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '')
const OPENAI_ASR_API_KEY = (process.env.OPENAI_API_KEY || '').trim()
const OPENAI_ASR_MODEL = (process.env.OPENAI_ASR_MODEL || 'whisper-1').trim()

function resolveAudioExtension(mimeType) {
  if (mimeType === 'audio/mpeg') return 'mp3'
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') return 'wav'
  if (mimeType === 'audio/mp4' || mimeType === 'audio/aac') return 'm4a'
  if (mimeType === 'audio/ogg' || mimeType === 'audio/opus') return 'ogg'
  return 'webm'
}

function decodeBase64Audio(input) {
  try {
    return Buffer.from(input, 'base64')
  } catch {
    return null
  }
}

async function transcribeViaOpenAI({ audioBuffer, mimeType }) {
  const fileExt = resolveAudioExtension(mimeType)
  const form = new FormData()
  form.append('model', OPENAI_ASR_MODEL)
  form.append('language', 'zh')
  form.append('response_format', 'verbose_json')
  form.append('file', new Blob([audioBuffer], { type: mimeType || 'audio/webm' }), `voice.${fileExt}`)

  const res = await fetch(`${OPENAI_ASR_BASE_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_ASR_API_KEY}`
    },
    body: form
  })

  const text = await res.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = {}
  }

  if (!res.ok) {
    const message =
      (typeof data?.error?.message === 'string' && data.error.message) ||
      (typeof data?.message === 'string' && data.message) ||
      `ASR provider request failed: ${res.status}`
    const error = new Error(message)
    error.status = res.status
    throw error
  }

  const transcribed = typeof data?.text === 'string' ? data.text.trim() : ''
  if (!transcribed) {
    throw new Error('ASR provider returned empty text')
  }

  return {
    text: transcribed,
    language: typeof data?.language === 'string' ? data.language : 'zh',
    confidence: 0.9
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res)

  const body = await readJson(req)
  const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64.trim() : ''
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim() : 'audio/webm'

  if (!audioBase64) {
    return fail(res, 400, 'INVALID_AUDIO_PAYLOAD', 'audioBase64 is required')
  }

  if (!OPENAI_ASR_API_KEY) {
    return fail(res, 501, 'ASR_NOT_CONFIGURED', 'OPENAI_API_KEY is missing')
  }

  const audioBuffer = decodeBase64Audio(audioBase64)
  if (!audioBuffer || !audioBuffer.length) {
    return fail(res, 400, 'INVALID_AUDIO_PAYLOAD', 'audioBase64 is invalid')
  }

  try {
    const result = await transcribeViaOpenAI({ audioBuffer, mimeType })
    return ok(res, result)
  } catch (error) {
    const status = Number(error?.status) || 502
    return fail(res, status, 'ASR_FAILED', error?.message || 'asr failed')
  }
}
