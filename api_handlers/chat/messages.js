import { deprecatedEndpoint } from '../_lib/legacy.js'

export default async function handler(req, res) {
  return deprecatedEndpoint(res, `${req.method || 'UNKNOWN'} /api/chat/messages`)
}
