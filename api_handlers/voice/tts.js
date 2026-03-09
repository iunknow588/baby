import { fail, methodNotAllowed, ok, readJson } from '../_lib/http.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res)

  const body = await readJson(req)
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) {
    return fail(res, 400, 'INVALID_TEXT', 'text is required')
  }

  return ok(res, {
    audioUrl: `https://example.com/tts/${Date.now()}.mp3`,
    duration: Math.max(1, Math.min(10, Math.ceil(text.length / 12)))
  })
}
