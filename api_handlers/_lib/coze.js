const DEFAULT_COZE_MAX_WAIT_MS = 25000
const HARD_COZE_MAX_WAIT_MS = 28000

function getCozeEnv() {
  return {
    apiBaseUrl: (process.env.COZE_API_BASE_URL || '').replace(/\/+$/, ''),
    apiToken: process.env.COZE_API_TOKEN || '',
    botId: (process.env.COZE_BOT_ID || '').trim()
  }
}

function resolveCozeMaxWaitMs() {
  const raw = Number(process.env.COZE_MAX_WAIT_MS || DEFAULT_COZE_MAX_WAIT_MS)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_COZE_MAX_WAIT_MS
  return Math.min(Math.max(1000, Math.floor(raw)), HARD_COZE_MAX_WAIT_MS)
}

export function assertCozeEnv() {
  const env = getCozeEnv()
  if (!env.apiBaseUrl || !env.apiToken || !env.botId) {
    throw new Error('COZE_API_BASE_URL or COZE_API_TOKEN or COZE_BOT_ID is missing')
  }
  return env
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
    const messageText =
      typeof data?.error?.message === 'string'
        ? data.error.message
        : typeof data?.msg === 'string' && data.msg
          ? data.msg
          : typeof data?.detail === 'string'
            ? data.detail
            : `Coze request failed: ${res.status}`
    const error = new Error(messageText)
    error.status = res.status
    throw error
  }
  return data
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isToolCallPayload(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false
  try {
    const obj = JSON.parse(trimmed)
    if (!obj || typeof obj !== 'object') return false
    const hasApiMarker =
      typeof obj.api_name === 'string' ||
      typeof obj.plugin_id === 'number' ||
      typeof obj.plugin_name === 'string' ||
      typeof obj.name === 'string'
    const hasArguments = Object.prototype.hasOwnProperty.call(obj, 'arguments')
    return hasApiMarker && hasArguments
  } catch {
    return false
  }
}

function unwrapCodeFence(text) {
  if (typeof text !== 'string') return ''
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1].trim() : trimmed
}

function parseJsonObject(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

function renderStructuredAnswer(obj) {
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  const summary = typeof obj.content === 'string' ? obj.content.trim() : ''
  const example = typeof obj.example === 'string' ? obj.example.trim() : ''
  const question = typeof obj.question === 'string' ? obj.question.trim() : ''
  const encourage = typeof obj.encourage === 'string' ? obj.encourage.trim() : ''
  const lines = []
  if (title) lines.push(`【${title}】`)
  if (summary) lines.push(summary)
  if (example) lines.push(`示例：${example}`)
  if (question) lines.push(`练习：${question}`)
  if (encourage) lines.push(encourage)
  return lines.join('\n\n').trim()
}

function normalizeAssistantAnswer(content) {
  if (typeof content !== 'string') return ''
  const normalized = unwrapCodeFence(content)
  if (!normalized) return ''
  if (isToolCallPayload(normalized)) return ''

  const parsed = parseJsonObject(normalized)
  if (!parsed) return normalized
  if (isToolCallPayload(normalized)) return ''

  const structured = renderStructuredAnswer(parsed)
  return structured || normalized
}

function extractAnswerFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : Array.isArray(messages?.messages) ? messages.messages : []
  for (const msg of list) {
    const role = typeof msg?.role === 'string' ? msg.role : ''
    if (role && role !== 'assistant') continue
    const content = typeof msg?.content === 'string' ? msg.content : ''
    const normalized = normalizeAssistantAnswer(content)
    if (normalized) {
      return normalized
    }
  }
  return ''
}

async function cozeV3Complete({ message, conversationId }) {
  const env = assertCozeEnv()
  const cozeMaxWaitMs = resolveCozeMaxWaitMs()
  const createBody = {
    bot_id: env.botId,
    user_id: `baby_${Date.now()}`,
    stream: false,
    additional_messages: [
      {
        role: 'user',
        content: message,
        content_type: 'text'
      }
    ]
  }
  if (conversationId) createBody.conversation_id = conversationId

  const created = await cozeFetch('/v3/chat', env, {
    method: 'POST',
    body: JSON.stringify(createBody)
  })
  const chatId = typeof created?.data?.id === 'string' ? created.data.id : ''
  const convId = typeof created?.data?.conversation_id === 'string' ? created.data.conversation_id : ''
  if (!chatId || !convId) {
    throw new Error('Coze v3 chat created but missing chat_id or conversation_id')
  }

  let status = typeof created?.data?.status === 'string' ? created.data.status : 'in_progress'
  let lastListed = null
  const started = Date.now()
  while (Date.now() - started < cozeMaxWaitMs) {
    await sleep(1000)
    const polled = await cozeFetch(
      `/v3/chat/retrieve?chat_id=${encodeURIComponent(chatId)}&conversation_id=${encodeURIComponent(convId)}`,
      env
    )
    status = typeof polled?.data?.status === 'string' ? polled.data.status : status
    lastListed = await cozeFetch(
      `/v3/chat/message/list?chat_id=${encodeURIComponent(chatId)}&conversation_id=${encodeURIComponent(convId)}`,
      env
    )
    const answer = extractAnswerFromMessages(lastListed?.data)
    if (answer) {
      return {
        chatId,
        conversationId: convId,
        answer,
        raw: lastListed
      }
    }
    if (status === 'failed' || status === 'canceled') break
  }

  // Final attempt before downgrade to reduce false-negative in-progress cases.
  try {
    lastListed = await cozeFetch(
      `/v3/chat/message/list?chat_id=${encodeURIComponent(chatId)}&conversation_id=${encodeURIComponent(convId)}`,
      env
    )
    const finalAnswer = extractAnswerFromMessages(lastListed?.data)
    if (finalAnswer) {
      return {
        chatId,
        conversationId: convId,
        answer: finalAnswer,
        raw: lastListed
      }
    }
  } catch {
    // keep original timeout/cancel reason
  }

  throw new Error(`Coze v3 returned empty answer (status=${status})`)
}

export async function cozeComplete({ message, conversationId }) {
  return cozeV3Complete({ message, conversationId })
}
