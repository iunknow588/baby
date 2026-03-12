import { fail, methodNotAllowed, ok, readJson } from '../../_lib/http.js'
import { makeId, nowIso } from '../../_lib/platform-chat.js'
import { supabaseInsert } from '../../_lib/supabase.js'

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ASSET_BUCKET = process.env.SUPABASE_ASSET_BUCKET || 'chat-assets'

function hasSupabaseStorageEnv() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
}

function storageHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra
  }
}

async function ensureBucketExists(bucket) {
  const url = `${SUPABASE_URL}/storage/v1/bucket`
  const res = await fetch(url, {
    method: 'POST',
    headers: storageHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      id: bucket,
      name: bucket,
      public: true
    })
  })
  if (res.ok || res.status === 409) return
  const text = await res.text()
  throw new Error(`storage bucket ensure failed: ${res.status} ${text}`)
}

function decodeBase64(input) {
  if (typeof input !== 'string' || !input.trim()) return null
  const normalized = input.includes(',') ? input.split(',').pop() || '' : input
  try {
    return Buffer.from(normalized, 'base64')
  } catch {
    return null
  }
}

async function uploadAssetBinary({ bucket, key, mediaType, bytes }) {
  const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: storageHeaders({
      'Content-Type': mediaType || 'application/octet-stream',
      'x-upsert': 'true'
    }),
    body: bytes
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`storage upload failed: ${res.status} ${text}`)
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${key}`
}

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
    const rawUrl = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : ''
    const fileBase64 = typeof body.fileBase64 === 'string' ? body.fileBase64.trim() : ''

    if (!conversationId) {
      return fail(res, 400, 'INVALID_CONVERSATION_ID', 'conversationId is required')
    }

    const assetId = makeId('asset')
    const createdAt = nowIso()
    let url = rawUrl

    if (!url && fileBase64) {
      if (!hasSupabaseStorageEnv()) {
        return fail(res, 500, 'ASSET_STORAGE_NOT_CONFIGURED', 'SUPABASE storage env is missing')
      }
      const bytes = decodeBase64(fileBase64)
      if (!bytes || bytes.length === 0) {
        return fail(res, 400, 'INVALID_FILE_BASE64', 'fileBase64 is invalid')
      }
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
      const key = `${conversationId}/${assetId}/${safeName}`
      try {
        await ensureBucketExists(ASSET_BUCKET)
        url = await uploadAssetBinary({
          bucket: ASSET_BUCKET,
          key,
          mediaType,
          bytes
        })
      } catch (error) {
        return fail(res, 500, 'ASSET_STORAGE_UPLOAD_FAILED', error.message || 'asset upload failed')
      }
    }

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
