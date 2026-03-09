import { ok, methodNotAllowed } from './_lib/http.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res)
  return ok(res, { status: 'ok', service: 'baby-api', time: new Date().toISOString() })
}
