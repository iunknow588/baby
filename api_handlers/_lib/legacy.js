import { fail } from './http.js'

export function deprecatedEndpoint(res, endpoint) {
  return fail(
    res,
    410,
    'LEGACY_API_DEPRECATED',
    `Legacy endpoint deprecated: ${endpoint}. Use MVP APIs: POST /api/user, POST /api/chat, GET /api/history`
  )
}
