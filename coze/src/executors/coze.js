const DEFAULT_COZE_MAX_WAIT_MS = 15000

function getCozeEnv() {
  return {
    apiBaseUrl: (process.env.COZE_API_BASE_URL || '').replace(/\/+$/, ''),
    apiToken: process.env.COZE_API_TOKEN || '',
    botId: (process.env.COZE_BOT_ID || '').trim()
  }
}

function hasCozeEnv() {
  const env = getCozeEnv()
  return Boolean(env.apiBaseUrl && env.apiToken && env.botId)
}

function resolveMode() {
  const raw = String(process.env.BABY_COZE_EXEC_MODE || 'auto').toLowerCase()
  if (raw === 'real' || raw === 'mock' || raw === 'auto') return raw
  return 'auto'
}

function resolveMaxWaitMs() {
  const raw = Number(process.env.COZE_MAX_WAIT_MS || DEFAULT_COZE_MAX_WAIT_MS)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_COZE_MAX_WAIT_MS
  return Math.max(3000, Math.min(28000, Math.floor(raw)))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function cozeFetch(path, env, init = {}) {
  const res = await fetch(`${env.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.apiToken}`,
      ...(init.headers || {})
    }
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (!res.ok) {
    const message =
      (data && data.error && typeof data.error.message === 'string' && data.error.message) ||
      (typeof data.msg === 'string' && data.msg) ||
      `Coze request failed: ${res.status}`
    const err = new Error(message)
    err.status = res.status
    throw err
  }
  return data
}

function extractAssistantAnswer(messages) {
  const list = Array.isArray(messages) ? messages : Array.isArray(messages?.messages) ? messages.messages : []
  for (const msg of list) {
    if (msg && msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim()) {
      return msg.content.trim()
    }
  }
  return ''
}

async function executeCozeReal(workflow, message) {
  const env = getCozeEnv()
  const created = await cozeFetch('/v3/chat', env, {
    method: 'POST',
    body: JSON.stringify({
      bot_id: env.botId,
      user_id: `baby_coze_${Date.now()}`,
      stream: false,
      additional_messages: [
        {
          role: 'user',
          content: String(message || ''),
          content_type: 'text'
        }
      ]
    })
  })

  const chatId = typeof created?.data?.id === 'string' ? created.data.id : ''
  const conversationId = typeof created?.data?.conversation_id === 'string' ? created.data.conversation_id : ''
  if (!chatId || !conversationId) {
    throw new Error('COZE_RESPONSE_INVALID')
  }

  const started = Date.now()
  const maxWaitMs = resolveMaxWaitMs()
  let status = typeof created?.data?.status === 'string' ? created.data.status : 'in_progress'
  while (Date.now() - started < maxWaitMs) {
    await sleep(1000)
    const polled = await cozeFetch(
      `/v3/chat/retrieve?chat_id=${encodeURIComponent(chatId)}&conversation_id=${encodeURIComponent(conversationId)}`,
      env
    )
    status = typeof polled?.data?.status === 'string' ? polled.data.status : status
    const listed = await cozeFetch(
      `/v3/chat/message/list?chat_id=${encodeURIComponent(chatId)}&conversation_id=${encodeURIComponent(conversationId)}`,
      env
    )
    const answer = extractAssistantAnswer(listed?.data)
    if (answer) {
      return {
        degraded: false,
        answer,
        structuredData: {
          provider: 'coze',
          workflow: workflow.id,
          chatId,
          conversationId,
          status
        }
      }
    }
    if (status === 'failed' || status === 'canceled') break
  }
  throw new Error(`COZE_EMPTY_ANSWER(status=${status})`)
}

function executeCozeMock(workflow, message, reason = '') {
  return {
    degraded: true,
    degradedReason: reason || 'COZE_MOCK_MODE',
    answer: `降级回复：当前使用 mock 模式，按 ${workflow.route} 返回模拟结果。输入摘要：${String(message || '').slice(0, 60)}`,
    structuredData: {
      provider: 'coze-mock',
      workflow: workflow.id
    }
  }
}

async function executeCoze(workflow, message) {
  const mode = resolveMode()
  const envReady = hasCozeEnv()
  if (mode === 'mock') return executeCozeMock(workflow, message, 'COZE_MODE_MOCK')
  if (!envReady && mode === 'real') {
    return executeCozeMock(workflow, message, 'COZE_ENV_MISSING_REAL_MODE')
  }
  if (!envReady && mode === 'auto') {
    return executeCozeMock(workflow, message, 'COZE_ENV_MISSING_AUTO_MODE')
  }

  try {
    return await executeCozeReal(workflow, message)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'COZE_REAL_FAILED'
    return executeCozeMock(workflow, message, reason)
  }
}

module.exports = {
  executeCoze,
  hasCozeEnv,
  getCozeEnv
}
