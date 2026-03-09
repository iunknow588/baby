import { fail, methodNotAllowed, ok, readJson } from '../_lib/http.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res)

  const body = await readJson(req)
  const fileId = typeof body.fileId === 'string' ? body.fileId.trim() : ''
  if (!fileId) {
    return fail(res, 400, 'INVALID_FILE_ID', 'fileId is required')
  }

  return ok(res, {
    text: '这是语音转写示例结果。',
    language: 'zh',
    confidence: 0.98
  })
}
