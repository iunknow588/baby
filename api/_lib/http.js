function makeTraceId() {
  return `trc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

export function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8')
  res.send(JSON.stringify(payload))
}

export function ok(res, data, traceId = makeTraceId()) {
  return json(res, 200, { success: true, data, error: null, traceId })
}

export function fail(res, status, code, message, traceId = makeTraceId()) {
  return json(res, status, {
    success: false,
    data: null,
    error: { code, message },
    traceId
  })
}

export async function readJson(req) {
  if (!req.body) return {}
  if (typeof req.body === 'object') return req.body
  if (typeof req.body === 'string' && req.body.trim()) {
    return JSON.parse(req.body)
  }
  return {}
}

export function methodNotAllowed(res) {
  return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
}

export function resolveCurrentUserId(req) {
  const headerUserId = req.headers['x-user-id']
  if (typeof headerUserId === 'string' && headerUserId.trim()) return headerUserId.trim()

  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim()
    if (token.startsWith('u_')) return token
  }
  return 'u_current'
}
