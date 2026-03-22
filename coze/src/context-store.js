const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const RUNTIME_DIR = path.resolve(__dirname, '..', 'runtime')
const STATE_FILE = path.resolve(RUNTIME_DIR, 'state.json')

function ensureRuntime() {
  if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ conversations: {}, createdAt: new Date().toISOString() }, null, 2),
      'utf8'
    )
  }
}

function readState() {
  ensureRuntime()
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
}

function writeState(state) {
  ensureRuntime()
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`
}

function now() {
  return new Date().toISOString()
}

function ensureConversation(state, conversationId) {
  const id = conversationId && String(conversationId).trim() ? String(conversationId).trim() : newId('conv')
  if (!state.conversations[id]) {
    state.conversations[id] = {
      id,
      createdAt: now(),
      updatedAt: now(),
      activeTopicId: '',
      topics: {}
    }
  }
  return state.conversations[id]
}

function createTopic(state, conversationId, title = '') {
  const conv = ensureConversation(state, conversationId)
  const topicId = newId('topic')
  conv.topics[topicId] = {
    id: topicId,
    title: title && String(title).trim() ? String(title).trim() : `话题 ${Object.keys(conv.topics).length + 1}`,
    status: 'active',
    executionType: '',
    route: '',
    workflowId: '',
    createdAt: now(),
    updatedAt: now(),
    messages: []
  }
  conv.activeTopicId = topicId
  conv.updatedAt = now()
  return conv.topics[topicId]
}

function getTopic(conv, topicId) {
  if (!conv || !topicId) return null
  return conv.topics[String(topicId).trim()] || null
}

function setActiveTopic(state, conversationId, topicId) {
  const conv = ensureConversation(state, conversationId)
  const topic = getTopic(conv, topicId)
  if (!topic) {
    throw new Error(`TOPIC_NOT_FOUND(${topicId})`)
  }
  conv.activeTopicId = topic.id
  conv.updatedAt = now()
  topic.updatedAt = now()
  return topic
}

function appendMessage(topic, role, content, meta = null) {
  topic.messages.push({
    id: newId(role === 'ai' ? 'ai' : 'msg'),
    role,
    content,
    meta,
    createdAt: now()
  })
  topic.updatedAt = now()
}

function listConversations(state) {
  return Object.values(state.conversations)
    .map((c) => ({
      id: c.id,
      activeTopicId: c.activeTopicId,
      topicCount: Object.keys(c.topics || {}).length,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

function listTopics(conv) {
  if (!conv) return []
  return Object.values(conv.topics || {})
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      executionType: t.executionType,
      route: t.route,
      workflowId: t.workflowId,
      messageCount: Array.isArray(t.messages) ? t.messages.length : 0,
      updatedAt: t.updatedAt,
      isActive: conv.activeTopicId === t.id
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

module.exports = {
  readState,
  writeState,
  ensureConversation,
  createTopic,
  getTopic,
  setActiveTopic,
  appendMessage,
  listConversations,
  listTopics
}
