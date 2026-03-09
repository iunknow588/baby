import { fail, methodNotAllowed, ok, readJson } from '../../_lib/http.js'
import { makeId, nowIso } from '../../_lib/platform-chat.js'
import { supabaseInsert } from '../../_lib/supabase.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res)

  try {
    const body = await readJson(req)
    const conversationId = typeof body.conversationId === 'string' && body.conversationId.trim()
      ? body.conversationId.trim()
      : ''
    const fileName = typeof body.fileName === 'string' && body.fileName.trim() ? body.fileName.trim() : 'attachment.bin'
    const mediaType = typeof body.mediaType === 'string' && body.mediaType.trim() ? body.mediaType.trim() : 'application/octet-stream'
    const size = Number(body.size || 0)
    const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : ''

    if (!conversationId) {
      return fail(res, 400, 'INVALID_CONVERSATION_ID', 'conversationId is required')
    }

    const assetId = makeId('asset')
    const createdAt = nowIso()

    // Best-effort persistence. If table is not created yet, keep API usable.
    try {
      await supabaseInsert(
        'uploaded_assets',
        {
          id: assetId,
          conversation_id: conversationId,
          file_name: fileName,
          media_type: mediaType,
          size: Number.isFinite(size) ? size : 0,
          url: url || null,
          created_at: createdAt
        },
        'minimal'
      )
    } catch (_error) {
      // ignore
    }

    return ok(res, {
      assetId,
      conversationId,
      fileName,
      mediaType,
      size: Number.isFinite(size) ? size : 0,
      url,
      createdAt
    })
  } catch (error) {
    return fail(res, 500, 'ASSET_UPLOAD_FAILED', error.message || 'asset upload failed')
  }
}
