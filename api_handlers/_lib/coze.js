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

function renderJsonErrorAnswer(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const msg = typeof obj.msg === 'string' ? obj.msg.trim() : ''
  const code = typeof obj.code === 'number' || typeof obj.code === 'string' ? String(obj.code).trim() : ''
  if (!msg) return ''
  if (code) return `服务调用失败（${code}）：${msg}`
  return `服务调用失败：${msg}`
}

function detectRenderMeta(obj) {
  const renderType = typeof obj.renderType === 'string' ? obj.renderType.trim() : ''
  const renderVersion = typeof obj.renderVersion === 'string' ? obj.renderVersion.trim() : ''
  if (renderType) {
    return { renderType, renderVersion: renderVersion || 'v1' }
  }

  const hasCalligraphyShape =
    Array.isArray(obj.characters) &&
    (Object.prototype.hasOwnProperty.call(obj, 'overall_grade') ||
      Object.prototype.hasOwnProperty.call(obj, 'overallGrade') ||
      Object.prototype.hasOwnProperty.call(obj, 'feedback'))
  if (hasCalligraphyShape) {
    return { renderType: 'calligraphy_scoring', renderVersion: 'v1' }
  }

  return { renderType: '', renderVersion: '' }
}

function renderCalligraphySummary(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const overall = typeof obj.overall_grade === 'string'
    ? obj.overall_grade.trim()
    : typeof obj.overallGrade === 'string'
      ? obj.overallGrade.trim()
      : ''
  const feedback = typeof obj.feedback === 'string' ? obj.feedback.trim() : ''
  const count = Array.isArray(obj.characters) ? obj.characters.length : 0
  if (!overall && !feedback && count <= 0) return ''

  const lines = ['【书法评分结果】']
  if (overall) lines.push(`总体等级：${overall}`)
  if (count > 0) lines.push(`识别字数：${count}`)
  if (feedback) lines.push(feedback)
  return lines.join('\n')
}

function normalizeAssistantPayload(content) {
  if (typeof content !== 'string') return null
  const normalized = unwrapCodeFence(content)
  if (!normalized) return null
  if (isToolCallPayload(normalized)) return null

  const parsed = parseJsonObject(normalized)
  if (!parsed) {
    return {
      answer: normalized,
      structuredData: null,
      renderType: '',
      renderVersion: ''
    }
  }
  if (isToolCallPayload(normalized)) return null

  const errorText = renderJsonErrorAnswer(parsed)
  if (errorText) {
    return {
      answer: errorText,
      structuredData: null,
      renderType: '',
      renderVersion: ''
    }
  }

  const renderMeta = detectRenderMeta(parsed)
  const structuredAnswer = renderStructuredAnswer(parsed) || renderCalligraphySummary(parsed)
  return {
    answer: structuredAnswer || normalized,
    structuredData: renderMeta.renderType ? parsed : null,
    renderType: renderMeta.renderType,
    renderVersion: renderMeta.renderVersion
  }
}

function extractAnswerFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : Array.isArray(messages?.messages) ? messages.messages : []
  for (const msg of list) {
    const role = typeof msg?.role === 'string' ? msg.role : ''
    if (role && role !== 'assistant') continue
    const content = typeof msg?.content === 'string' ? msg.content : ''
    const normalized = normalizeAssistantPayload(content)
    if (normalized?.answer) return normalized
  }
  return null
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
    const payload = extractAnswerFromMessages(lastListed?.data)
    if (payload?.answer) {
      return {
        chatId,
        conversationId: convId,
        answer: payload.answer,
        structuredData: payload.structuredData,
        renderType: payload.renderType,
        renderVersion: payload.renderVersion,
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
    const finalPayload = extractAnswerFromMessages(lastListed?.data)
    if (finalPayload?.answer) {
      return {
        chatId,
        conversationId: convId,
        answer: finalPayload.answer,
        structuredData: finalPayload.structuredData,
        renderType: finalPayload.renderType,
        renderVersion: finalPayload.renderVersion,
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
