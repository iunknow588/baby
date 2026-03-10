import { methodNotAllowed, ok } from './_lib/http.js'

function isSet(name) {
  const value = process.env[name]
  return typeof value === 'string' && value.trim().length > 0
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res)

  const checks = {
    SUPABASE_URL: isSet('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: isSet('SUPABASE_SERVICE_ROLE_KEY'),
    COZE_API_BASE_URL: isSet('COZE_API_BASE_URL'),
    COZE_API_TOKEN: isSet('COZE_API_TOKEN'),
    COZE_BOT_ID: isSet('COZE_BOT_ID'),
    OPENAI_API_KEY: isSet('OPENAI_API_KEY')
  }
  const missing = Object.entries(checks)
    .filter(([, ready]) => !ready)
    .map(([name]) => name)

  return ok(res, {
    service: 'baby-api',
    ready: missing.length === 0,
    checks,
    missing
  })
}
