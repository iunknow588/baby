const fs = require('fs')
const path = require('path')

const REQUIRED_CHAT_VARS = ['COZE_API_BASE_URL', 'COZE_API_TOKEN', 'COZE_BOT_ID']
const REQUIRED_CREATE_VARS = [
  'COZELOOP_WORKSPACE_ID',
  'COZELOOP_JWT_OAUTH_CLIENT_ID',
  'COZELOOP_JWT_OAUTH_PRIVATE_KEY',
  'COZELOOP_JWT_OAUTH_PUBLIC_KEY_ID'
]

function isPemPrivateKey(content) {
  return (
    typeof content === 'string' &&
    content.includes('-----BEGIN') &&
    content.includes('PRIVATE KEY-----')
  )
}

function resolvePrivateKeyInput(rawValue) {
  const value = (rawValue || '').trim()
  if (!value) {
    return { ok: false, mode: 'missing', reason: 'empty' }
  }

  if (isPemPrivateKey(value)) {
    return { ok: true, mode: 'inline_pem' }
  }

  const normalized = value.replace(/^['"]|['"]$/g, '')
  const projectRoot = path.resolve(__dirname, '../..')
  const candidates = [normalized, path.resolve(process.cwd(), normalized), path.resolve(projectRoot, normalized)]

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) continue
    const content = fs.readFileSync(filePath, 'utf8').trim()
    if (!isPemPrivateKey(content)) {
      return {
        ok: false,
        mode: 'file_path',
        reason: 'file_exists_but_not_pem',
        resolvedPath: filePath
      }
    }
    return { ok: true, mode: 'file_path', resolvedPath: filePath }
  }

  return { ok: false, mode: 'file_path', reason: 'file_not_found' }
}

function collectEnvStatus(keys, options = {}) {
  const privateKeyValue = options.privateKeyValue || ''
  const out = {}
  let privateKeyDetail = null
  for (const key of keys) {
    if (key === 'COZELOOP_JWT_OAUTH_PRIVATE_KEY') {
      privateKeyDetail = resolvePrivateKeyInput(privateKeyValue)
      out[key] = Boolean(privateKeyDetail.ok)
      continue
    }
    out[key] = Boolean(process.env[key] && String(process.env[key]).trim())
  }
  return { status: out, privateKeyDetail }
}

function allSet(statusMap) {
  return Object.values(statusMap).every(Boolean)
}

async function probeCozeChat() {
  const apiBaseUrl = (process.env.COZE_API_BASE_URL || '').replace(/\/+$/, '')
  const apiToken = process.env.COZE_API_TOKEN || ''
  const botId = (process.env.COZE_BOT_ID || '').trim()
  if (!apiBaseUrl || !apiToken || !botId) {
    return { ok: false, skipped: true, reason: 'chat env missing' }
  }

  try {
    const res = await fetch(`${apiBaseUrl}/v3/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        bot_id: botId,
        user_id: 'create_preflight_probe',
        stream: false,
        additional_messages: [
          {
            role: 'user',
            content: 'ping',
            content_type: 'text'
          }
        ]
      })
    })
    const text = await res.text()
    let code = null
    let msg = ''
    try {
      const data = text ? JSON.parse(text) : {}
      code = typeof data.code === 'number' || typeof data.code === 'string' ? data.code : null
      msg = typeof data.msg === 'string' ? data.msg : ''
    } catch {
      // keep null
    }

    return {
      ok: res.ok && (code === 0 || code === '0' || code === null),
      skipped: false,
      httpStatus: res.status,
      code,
      msg
    }
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

function buildSuggestion(chatReady, createReady) {
  const tips = []
  if (!chatReady) {
    tips.push('先补齐 COZE_API_BASE_URL/COZE_API_TOKEN/COZE_BOT_ID 并验证 /v3/chat 连通。')
  }
  if (!createReady) {
    tips.push('补齐 COZELOOP_WORKSPACE_ID 与 COZELOOP_JWT_OAUTH_* 四项后再实现自动创建。')
  }
  if (chatReady && createReady) {
    tips.push('前置凭证已齐，可开始实现 Coze 平台工作流创建/发布脚本。')
  }
  return tips
}

async function runCreatePreflight() {
  const privateKeyValue = process.env.COZELOOP_JWT_OAUTH_PRIVATE_KEY || ''
  const chatEnvInfo = collectEnvStatus(REQUIRED_CHAT_VARS)
  const createEnvInfo = collectEnvStatus(REQUIRED_CREATE_VARS, { privateKeyValue })
  const chatEnv = chatEnvInfo.status
  const createEnv = createEnvInfo.status
  const chatEnvReady = allSet(chatEnv)
  const createEnvReady = allSet(createEnv)
  const chatProbe = await probeCozeChat()

  return {
    ok: chatEnvReady && createEnvReady && chatProbe.ok,
    chatEnv,
    createEnv,
    createEnvMeta: {
      privateKey: createEnvInfo.privateKeyDetail || { ok: false, mode: 'missing', reason: 'empty' }
    },
    chatEnvReady,
    createEnvReady,
    chatProbe,
    suggestions: buildSuggestion(chatEnvReady, createEnvReady)
  }
}

module.exports = {
  runCreatePreflight
}
