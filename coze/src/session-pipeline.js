const { runOnce } = require('./pipeline')
const {
  readState,
  writeState,
  ensureConversation,
  createTopic,
  getTopic,
  setActiveTopic,
  appendMessage,
  listConversations,
  listTopics
} = require('./context-store')

async function runInSession({
  message,
  conversationId,
  topicId,
  newTopic = false,
  topicTitle = '',
  previousWorkflowId = '',
  workflowAction = 'auto'
}) {
  if (!message || !String(message).trim()) {
    throw new Error('MESSAGE_REQUIRED')
  }

  const state = readState()
  const conv = ensureConversation(state, conversationId)

  let topic = null
  if (newTopic) {
    topic = createTopic(state, conv.id, topicTitle)
  } else if (topicId) {
    topic = getTopic(conv, topicId)
    if (!topic) {
      throw new Error(`TOPIC_NOT_FOUND(${topicId})`)
    }
    setActiveTopic(state, conv.id, topic.id)
  } else if (conv.activeTopicId) {
    topic = getTopic(conv, conv.activeTopicId)
  }

  if (!topic) {
    topic = createTopic(state, conv.id, topicTitle)
  }

  const resolvedPreviousWorkflowId =
    typeof previousWorkflowId === 'string' && previousWorkflowId.trim()
      ? previousWorkflowId.trim()
      : topic.workflowId || ''

  appendMessage(topic, 'user', String(message).trim(), {
    previousWorkflowId: resolvedPreviousWorkflowId,
    workflowAction
  })
  const result = await runOnce({
    message,
    previousWorkflowId: resolvedPreviousWorkflowId,
    workflowAction
  })

  topic.executionType = result.executionType
  topic.route = result.route
  topic.workflowId = result.workflowId
  topic.status = result.executionType === 'requires_user_interaction' ? 'waiting_user' : 'active'

  appendMessage(topic, 'ai', result.answer, {
    executionType: result.executionType,
    interactionMode: result.interactionMode,
    route: result.route,
    workflowId: result.workflowId,
    workflowVersion: result.workflowVersion,
    processingFlow: result.processingFlow,
    traceId: result.traceId,
    degraded: result.degraded,
    degradedReason: result.degradedReason
  })

  writeState(state)

  return {
    conversationId: conv.id,
    topicId: topic.id,
    topicStatus: topic.status,
    executionType: result.executionType,
    interactionMode: result.interactionMode,
    route: result.route,
    workflowId: result.workflowId,
    workflowVersion: result.workflowVersion,
    previousWorkflowId: result.previousWorkflowId || '',
    workflowAction: result.workflowAction || 'auto',
    traceId: result.traceId,
    answer: result.answer,
    processingFlow: result.processingFlow
  }
}

function getSessionView(conversationId) {
  const state = readState()
  const conv = ensureConversation(state, conversationId)
  writeState(state)

  return {
    conversationId: conv.id,
    activeTopicId: conv.activeTopicId || '',
    topics: listTopics(conv)
  }
}

function switchTopic(conversationId, topicId) {
  const state = readState()
  const topic = setActiveTopic(state, conversationId, topicId)
  writeState(state)
  return {
    conversationId,
    activeTopicId: topic.id,
    title: topic.title,
    status: topic.status
  }
}

function createSessionTopic(conversationId, title = '') {
  const state = readState()
  const conv = ensureConversation(state, conversationId)
  const topic = createTopic(state, conv.id, title)
  writeState(state)
  return {
    conversationId: conv.id,
    topicId: topic.id,
    title: topic.title,
    status: topic.status
  }
}

function listSessionConversations() {
  const state = readState()
  return {
    conversations: listConversations(state)
  }
}

module.exports = {
  runInSession,
  getSessionView,
  switchTopic,
  createSessionTopic,
  listSessionConversations
}
