import { fail, methodNotAllowed, ok, readJson } from './_lib/http.js'
import { ensureUserByDeviceId, isValidDeviceId, normalizeDeviceId } from './_lib/mvp-user.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res)

  try {
    const body = await readJson(req)
    const deviceId = normalizeDeviceId(body.deviceId)

    if (!isValidDeviceId(deviceId)) {
      return fail(res, 400, 'INVALID_DEVICE_ID', 'deviceId is required and must be 8-128 chars')
    }

    const user = await ensureUserByDeviceId(deviceId)
    return ok(res, user)
  } catch (error) {
    return fail(res, 500, 'USER_UPSERT_FAILED', error.message || 'user upsert failed')
  }
}
