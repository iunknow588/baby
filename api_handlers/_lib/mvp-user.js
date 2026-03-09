import { supabaseGet, supabaseInsert, supabasePatch } from './supabase.js'

function mapUser(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    createdAt: row.created_at,
    lastActive: row.last_active || row.created_at || new Date().toISOString()
  }
}

function isMissingLastActiveError(error) {
  if (typeof error?.message !== 'string') return false
  return (
    error.message.includes('column users.last_active does not exist') ||
    (error.message.includes('last_active') && error.message.includes('schema cache'))
  )
}

export function normalizeDeviceId(raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim()
}

export function isValidDeviceId(deviceId) {
  return typeof deviceId === 'string' && deviceId.length >= 8 && deviceId.length <= 128
}

export async function getUserByDeviceId(deviceId) {
  let rows
  try {
    rows = await supabaseGet(
      'users',
      `select=id,device_id,created_at,last_active&device_id=eq.${encodeURIComponent(deviceId)}&limit=1`
    )
  } catch (error) {
    if (!isMissingLastActiveError(error)) throw error
    rows = await supabaseGet(
      'users',
      `select=id,device_id,created_at&device_id=eq.${encodeURIComponent(deviceId)}&limit=1`
    )
  }
  if (!Array.isArray(rows) || !rows[0]) return null
  return mapUser(rows[0])
}

export async function touchUserLastActive(userId) {
  try {
    await supabasePatch('users', `id=eq.${encodeURIComponent(userId)}`, {
      last_active: new Date().toISOString()
    })
  } catch (error) {
    if (!isMissingLastActiveError(error)) throw error
  }
}

export async function ensureUserByDeviceId(deviceId) {
  const existing = await getUserByDeviceId(deviceId)
  if (existing) {
    await touchUserLastActive(existing.id)
    return existing
  }

  const inserted = await supabaseInsert(
    'users',
    { device_id: deviceId },
    'representation'
  )
  const row = Array.isArray(inserted) ? inserted[0] : inserted
  return mapUser(row)
}
