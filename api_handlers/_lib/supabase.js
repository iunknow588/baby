const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const SUPABASE_RETRY_COUNT = Number(process.env.SUPABASE_RETRY_COUNT || 2)
const SUPABASE_RETRY_DELAY_MS = Number(process.env.SUPABASE_RETRY_DELAY_MS || 250)

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseJsonSafe(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isRetryableError(error) {
  const status = Number(error?.status || 0)
  if (status >= 500 || status === 429) return true
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : ''
  if (!message) return false
  return (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('eai_again')
  )
}

async function requestWithRetry(url, init, methodLabel) {
  let lastError = null
  const retries = Number.isFinite(SUPABASE_RETRY_COUNT) ? Math.max(0, Math.floor(SUPABASE_RETRY_COUNT)) : 2
  const delay = Number.isFinite(SUPABASE_RETRY_DELAY_MS) ? Math.max(50, Math.floor(SUPABASE_RETRY_DELAY_MS)) : 250

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, init)
      const text = await res.text()
      const data = parseJsonSafe(text)
      if (!res.ok) {
        const message = typeof data?.message === 'string' ? data.message : `Supabase ${methodLabel} failed: ${res.status}`
        const error = new Error(message)
        error.status = res.status
        throw error
      }
      return data
    } catch (error) {
      lastError = error
      if (attempt >= retries || !isRetryableError(error)) {
        throw error
      }
      await sleep(delay * (attempt + 1))
    }
  }
  throw lastError || new Error(`Supabase ${methodLabel} failed`)
}

export async function supabaseGet(path, query = '') {
  assertSupabaseEnv()
  const url = `${SUPABASE_URL}/rest/v1/${path}${query ? `?${query}` : ''}`
  return requestWithRetry(url, { headers: buildHeaders() }, 'GET')
}

export async function supabaseInsert(path, payload, returning = 'representation') {
  assertSupabaseEnv()
  const url = `${SUPABASE_URL}/rest/v1/${path}`
  return requestWithRetry(url, {
    method: 'POST',
    headers: buildHeaders({
      'Content-Type': 'application/json',
      Prefer: `return=${returning}`
    }),
    body: JSON.stringify(payload)
  }, 'INSERT')
}

export async function supabasePatch(path, query, payload, returning = 'minimal') {
  assertSupabaseEnv()
  const url = `${SUPABASE_URL}/rest/v1/${path}?${query}`
  return requestWithRetry(url, {
    method: 'PATCH',
    headers: buildHeaders({
      'Content-Type': 'application/json',
      Prefer: `return=${returning}`
    }),
    body: JSON.stringify(payload)
  }, 'PATCH')
}

export async function supabaseDelete(path, query, returning = 'minimal') {
  assertSupabaseEnv()
  const url = `${SUPABASE_URL}/rest/v1/${path}?${query}`
  return requestWithRetry(url, {
    method: 'DELETE',
    headers: buildHeaders({
      Prefer: `return=${returning}`
    })
  }, 'DELETE')
}
