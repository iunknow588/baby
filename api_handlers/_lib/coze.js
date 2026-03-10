const COZE_API_BASE_URL = (process.env.COZE_API_BASE_URL || '').replace(/\/+$/, '')
const COZE_API_TOKEN = process.env.COZE_API_TOKEN || ''
const COZE_BOT_ID = (process.env.COZE_BOT_ID || '').trim()
const DEFAULT_COZE_MAX_WAIT_MS = 20000
const HARD_COZE_MAX_WAIT_MS = 25000

function resolveCozeMaxWaitMs() {
  const raw = Number(process.env.COZE_MAX_WAIT_MS || DEFAULT_COZE_MAX_WAIT_MS)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_COZE_MAX_WAIT_MS
  return Math.min(Math.max(1000, Math.floor(raw)), HARD_COZE_MAX_WAIT_MS)
}

const COZE_MAX_WAIT_MS = resolveCozeMaxWaitMs()

export function assertCozeEnv() {
  if (!COZE_API_BASE_URL || !COZE_API_TOKEN || !COZE_BOT_ID) {
    throw new Error('COZE_API_BASE_URL or COZE_API_TOKEN or COZE_BOT_ID is missing')
  }
}

async function cozeFetch(path, init = {}) {
  const res = await fetch(`${COZE_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${COZE_API_TOKEN}`,
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

function extractAnswerFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : Array.isArray(messages?.messages) ? messages.messages : []
  for (const msg of list) {
    const role = typeof msg?.role === 'string' ? msg.role : ''
    if (role && role !== 'assistant') continue
    if (typeof msg?.content === 'string' && msg.content.trim()) {
      return msg.content.trim()
    }
  }
  return ''
}

async function cozeV3Complete({ message, conversationId }) {
  const createBody = {
    bot_id: COZE_BOT_ID,
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

  const created = await cozeFetch('/v3/chat', {
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
  while (Date.now() - started < COZE_MAX_WAIT_MS) {
    await sleep(1000)
    const polled = await cozeFetch(
      `/v3/chat/retrieve?chat_id=${encodeURIComponent(chatId)}&conversation_id=${encodeURIComponent(convId)}`
    )
    status = typeof polled?.data?.status === 'string' ? polled.data.status : status
    lastListed = await cozeFetch(
      `/v3/chat/message/list?chat_id=${encodeURIComponent(chatId)}&conversation_id=${encodeURIComponent(convId)}`
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
  throw new Error(`Coze v3 returned empty answer (status=${status})`)
}

export async function cozeComplete({ message, conversationId }) {
  assertCozeEnv()
  return cozeV3Complete({ message, conversationId })
}
