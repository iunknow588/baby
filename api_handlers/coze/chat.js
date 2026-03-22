import { cozeComplete } from '../_lib/coze.js'
import { fail, methodNotAllowed, ok, readJson } from '../_lib/http.js'

const DEFAULT_TOPIC_ID = 'topic_default'

function buildFallbackAnswer(message) {
  const preview = message.length > 80 ? `${message.slice(0, 80)}...` : message
  return `已收到你的输入：${preview}\n\n当前 Coze 服务响应较慢，已触发降级回复。请稍后重试获取完整回答。`
}

function buildProcessingFlow({ message, result, degraded, degradedReason }) {
  const steps = [
    {
      id: 'input_normalize',
      status: 'done',
      detail: `已接收输入，文本长度=${message.length}`
    },
    {
      id: 'agent_route',
      status: degraded ? 'fallback' : 'done',
      detail: degraded
        ? `Coze 调用降级：${degradedReason || 'unknown'}`
        : `已完成 Agent 路由（renderType=${result?.renderType || 'general_chat'}）`
    },
    {
      id: 'response_finalize',
      status: 'done',
      detail: '已生成最终可展示响应'
    }
  ]

  return {
    route: (typeof result?.renderType === 'string' && result.renderType) || 'general_chat',
    degraded: Boolean(degraded),
    steps
  }
}

function resolveInteractionMode(processingFlow) {
  const route = typeof processingFlow?.route === 'string' ? processingFlow.route : ''
  return route && route !== 'general_chat' ? 'flow_first' : 'direct'
}

function resolveExecutionType(processingFlow) {
  const route = typeof processingFlow?.route === 'string' ? processingFlow.route : ''
  return route && route !== 'general_chat' ? 'requires_user_interaction' : 'direct_reply'
}

function resolveWorkflowId(route) {
  const normalized = typeof route === 'string' && route.trim() ? route.trim() : 'general_chat'
  return `wf_${normalized}_v1`
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res)
  let fallbackMessage = ''
  let fallbackTopicId = DEFAULT_TOPIC_ID
  let fallbackConversationId = ''
  try {
    const body = await readJson(req)
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    fallbackMessage = message
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : ''
    fallbackConversationId = conversationId
    const topicId = typeof body.topicId === 'string' && body.topicId.trim() ? body.topicId.trim() : DEFAULT_TOPIC_ID
    fallbackTopicId = topicId
    const previousWorkflowId =
      typeof body.previousWorkflowId === 'string' && body.previousWorkflowId.trim()
        ? body.previousWorkflowId.trim()
        : ''
    const workflowActionRaw = typeof body.workflowAction === 'string' ? body.workflowAction.trim().toLowerCase() : ''
    const workflowAction =
      workflowActionRaw === 'continue' || workflowActionRaw === 'switch' || workflowActionRaw === 'auto'
        ? workflowActionRaw
        : 'auto'

    if (!message) {
      return fail(res, 400, 'INVALID_PARAMS', 'message is required')
    }

    const result = await cozeComplete({
      message,
      conversationId: conversationId || undefined
    })
    const processingFlow = buildProcessingFlow({
      message,
      result,
      degraded: false,
      degradedReason: ''
    })
    const interactionMode = resolveInteractionMode(processingFlow)
    const executionType = resolveExecutionType(processingFlow)
    const workflowId = resolveWorkflowId(processingFlow.route)
    const workflowVersion = 'v1'
    const executionContract = {
      route: processingFlow.route,
      executionType,
      workflowId,
      workflowVersion,
      previousWorkflowId,
      workflowAction
    }

    return ok(res, {
      chatId: result.chatId,
      conversationId: result.conversationId,
      topicId,
      previousWorkflowId,
      workflowAction,
      answer: result.answer,
      structuredData: result.structuredData || null,
      renderType: typeof result.renderType === 'string' ? result.renderType : '',
      renderVersion: typeof result.renderVersion === 'string' ? result.renderVersion : '',
      executionType,
      workflowId,
      workflowVersion,
      executionContract,
      processingFlow,
      interactionMode,
      raw: result.raw,
      degraded: false,
      degradedReason: ''
    })
  } catch (error) {
    const processingFlow = buildProcessingFlow({
      message: fallbackMessage,
      result: null,
      degraded: true,
      degradedReason: error?.message || 'Coze request failed'
    })
    const interactionMode = resolveInteractionMode(processingFlow)
    const executionType = resolveExecutionType(processingFlow)
    const workflowId = resolveWorkflowId(processingFlow.route)
    const workflowVersion = 'v1'
    const executionContract = {
      route: processingFlow.route,
      executionType,
      workflowId,
      workflowVersion,
      previousWorkflowId: '',
      workflowAction: 'auto'
    }
    return ok(res, {
      chatId: '',
      conversationId: fallbackConversationId,
      topicId: fallbackTopicId,
      answer: buildFallbackAnswer(fallbackMessage),
      structuredData: null,
      renderType: '',
      renderVersion: '',
      executionType,
      workflowId,
      workflowVersion,
      executionContract,
      processingFlow,
      interactionMode,
      raw: null,
      degraded: true,
      degradedReason: error?.message || 'Coze request failed'
    })
  }
}
