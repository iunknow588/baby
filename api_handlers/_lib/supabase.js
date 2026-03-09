const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

export function assertSupabaseEnv() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing')
  }
}

function buildHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra
  }
}

export async function supabaseGet(path, query = '') {
  assertSupabaseEnv()
  const url = `${SUPABASE_URL}/rest/v1/${path}${query ? `?${query}` : ''}`
  const res = await fetch(url, { headers: buildHeaders() })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message = typeof data?.message === 'string' ? data.message : `Supabase GET failed: ${res.status}`
    const error = new Error(message)
    error.status = res.status
    throw error
  }
  return data
}

export async function supabaseInsert(path, payload, returning = 'representation') {
  assertSupabaseEnv()
  const url = `${SUPABASE_URL}/rest/v1/${path}`
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders({
      'Content-Type': 'application/json',
      Prefer: `return=${returning}`
    }),
    body: JSON.stringify(payload)
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message = typeof data?.message === 'string' ? data.message : `Supabase INSERT failed: ${res.status}`
    const error = new Error(message)
    error.status = res.status
    throw error
  }
  return data
}

export async function supabasePatch(path, query, payload, returning = 'minimal') {
  assertSupabaseEnv()
  const url = `${SUPABASE_URL}/rest/v1/${path}?${query}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: buildHeaders({
      'Content-Type': 'application/json',
      Prefer: `return=${returning}`
    }),
    body: JSON.stringify(payload)
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message = typeof data?.message === 'string' ? data.message : `Supabase PATCH failed: ${res.status}`
    const error = new Error(message)
    error.status = res.status
    throw error
  }
  return data
}

export async function supabaseDelete(path, query, returning = 'minimal') {
  assertSupabaseEnv()
  const url = `${SUPABASE_URL}/rest/v1/${path}?${query}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: buildHeaders({
      Prefer: `return=${returning}`
    })
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message = typeof data?.message === 'string' ? data.message : `Supabase DELETE failed: ${res.status}`
    const error = new Error(message)
    error.status = res.status
    throw error
  }
  return data
}
