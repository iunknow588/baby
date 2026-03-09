import { fail, methodNotAllowed, ok } from '../../../_lib/http.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res)
  const requestId = typeof req.query?.requestId === 'string' ? req.query.requestId.trim() : ''
  if (!requestId) {
    return fail(res, 400, 'INVALID_REQUEST_ID', 'requestId is required')
  }
  return ok(res, { ok: true, requestId })
}
