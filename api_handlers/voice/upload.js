import { methodNotAllowed, ok } from '../_lib/http.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res)

  const fileId = `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return ok(res, {
    fileId,
    duration: 1.2,
    codec: 'audio/webm'
  })
}
