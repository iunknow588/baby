import { cozeComplete } from '../../../_lib/coze.js'
import { fail, methodNotAllowed, ok, readJson } from '../../../_lib/http.js'
import { ensureRoomMember, getActorId, listMessages, makeId, nowIso, toMessageEntity } from '../../../_lib/platform-chat.js'
import { supabaseInsert, supabasePatch } from '../../../_lib/supabase.js'

const DEFAULT_TOPIC_ID = 'topic_default'

function normalizeContent(body) {
  if (typeof body.content === 'string') return body.content.trim()
  if (typeof body.text === 'string') return body.text.trim()
  return ''
}

function normalizeTopicId(value) {
  if (typeof value !== 'string') return ''
  const topicId = value.trim()
  if (!topicId) return ''
  if (topicId.length > 128) return ''
  return topicId
}

function resolveTopicId({ req, body }) {
  const bodyTopic = normalizeTopicId(body?.topicId)
  if (bodyTopic) return bodyTopic
  const queryTopic = normalizeTopicId(req.query?.topicId)
  if (queryTopic) return queryTopic
  return DEFAULT_TOPIC_ID
}

function extractTopicIdFromMessage(message) {
  const topicId = message?.meta?.topicId
  if (typeof topicId !== 'string') return ''
  return normalizeTopicId(topicId)
}

function messageBelongsToTopic(message, topicId) {
  const messageTopicId = extractTopicIdFromMessage(message)
  if (!messageTopicId) {
    return topicId === DEFAULT_TOPIC_ID
  }
  return messageTopicId === topicId
}

function buildProcessingFlow({ content, files, renderType, degraded, degradedReason }) {
  const fileCount = Array.isArray(files) ? files.length : 0
  const steps = [
    {
      id: 'input_normalize',
      status: 'done',
      detail: `已接收输入，文本长度=${content.length}，附件数量=${fileCount}`
    },
    {
      id: 'agent_route',
      status: degraded ? 'fallback' : 'done',
      detail: degraded
        ? `Coze 调用降级：${degradedReason || 'unknown'}`
        : `已完成 Agent 路由（renderType=${renderType || 'general_chat'}）`
    },
    {
      id: 'response_finalize',
      status: 'done',
      detail: '已生成并回写消息结果'
    }
  ]
  return {
    route: renderType || 'general_chat',
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
  const conversationId = typeof req.query?.conversationId === 'string' ? req.query.conversationId.trim() : ''
  if (!conversationId) {
    return fail(res, 400, 'INVALID_CONVERSATION_ID', 'conversationId is required')
  }

  if (req.method === 'GET') {
    try {
      const userId = getActorId(req)
      await ensureRoomMember(conversationId, userId)
      const topicId = resolveTopicId({ req, body: null })
      if (!topicId) {
        return fail(res, 400, 'INVALID_TOPIC_ID', 'topicId is required')
      }
      const limit = Math.max(1, Math.min(Number(req.query?.limit || 20), 100))
      const cursor = typeof req.query?.cursor === 'string' && req.query.cursor.trim() ? req.query.cursor.trim() : ''
      const fetchedLimit = Math.max(limit, Math.min(limit * 3, 200))
      const rawList = await listMessages(conversationId, fetchedLimit, cursor || undefined)
      const filtered = rawList.filter((item) => messageBelongsToTopic(item, topicId))
      const list = filtered.slice(-limit)
      const nextCursor = list.length >= limit ? list[0]?.createdAt || null : null
      return ok(res, {
        conversationId,
        topicId,
        list,
        hasMore: Boolean(nextCursor),
        nextCursor
      })
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      const code = status === 403 ? 'PERMISSION_DENIED' : 'MESSAGES_LIST_FAILED'
      return fail(res, status, code, error.message || 'list messages failed')
    }
  }

  if (req.method === 'POST') {
    try {
      const userId = getActorId(req)
      await ensureRoomMember(conversationId, userId)
      const body = await readJson(req)
      const topicId = resolveTopicId({ req, body })
      if (!topicId) {
        return fail(res, 400, 'INVALID_TOPIC_ID', 'topicId is required')
      }
      const previousWorkflowId =
        typeof body.previousWorkflowId === 'string' && body.previousWorkflowId.trim()
          ? body.previousWorkflowId.trim()
          : ''
      const workflowActionRaw = typeof body.workflowAction === 'string' ? body.workflowAction.trim().toLowerCase() : ''
      const workflowAction =
        workflowActionRaw === 'continue' || workflowActionRaw === 'switch' || workflowActionRaw === 'auto'
          ? workflowActionRaw
          : 'auto'

      const messageType = typeof body.type === 'string' && body.type.trim()
        ? body.type.trim()
        : typeof body.messageType === 'string' && body.messageType.trim()
          ? body.messageType.trim()
          : 'text'
      const content = normalizeContent(body)
      const files = Array.isArray(body.files) ? body.files : undefined
      const clientMessageId = typeof body.clientMessageId === 'string' && body.clientMessageId.trim()
        ? body.clientMessageId.trim()
        : makeId('cm')

      if (!content && (!files || files.length === 0)) {
        return fail(res, 400, 'INVALID_MESSAGE_PAYLOAD', 'content or files is required')
      }

      const createdAt = nowIso()
      const userRow = {
        id: clientMessageId,
        room_id: conversationId,
        sender_id: userId,
        sender_type: 'user',
        message_type: messageType,
        content,
        status: 'delivered',
        files: files || null,
        meta: {
          ...(body.meta && typeof body.meta === 'object' ? body.meta : {}),
          conversationId,
          topicId,
          previousWorkflowId,
          workflowAction
        },
        created_at: createdAt
      }

      await supabaseInsert('chat_messages', userRow, 'minimal')
      await supabasePatch(
        'chat_rooms',
        `id=eq.${encodeURIComponent(conversationId)}`,
        { last_active_at: createdAt },
        'minimal'
      )

      let aiMessage = null
      let aiAnswer = ''
      let aiStructuredData = null
      let aiRenderType = ''
      let aiRenderVersion = ''
      let aiDegraded = false
      let aiDegradedReason = ''

      if (content) {
        try {
          const coze = await cozeComplete({ message: content })
          aiAnswer = typeof coze.answer === 'string' ? coze.answer.trim() : ''
          aiStructuredData = coze.structuredData && typeof coze.structuredData === 'object' ? coze.structuredData : null
          aiRenderType = typeof coze.renderType === 'string' ? coze.renderType : ''
          aiRenderVersion = typeof coze.renderVersion === 'string' ? coze.renderVersion : ''
        } catch (error) {
          aiDegraded = true
          aiDegradedReason = error?.message || 'Coze request failed'
        }
      }
      const processingFlow = buildProcessingFlow({
        content,
        files,
        renderType: aiRenderType,
        degraded: aiDegraded,
        degradedReason: aiDegradedReason
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

      if (aiAnswer) {
        const aiRow = {
          id: makeId('ai'),
          room_id: conversationId,
          sender_id: 'u_ai',
          sender_type: 'ai',
          message_type: 'text',
          content: aiAnswer,
          status: 'delivered',
          files: null,
          meta: {
            conversationId,
            topicId,
            previousWorkflowId,
            workflowAction,
            executionType,
            workflowId,
            workflowVersion,
            ...(aiStructuredData
              ? {
                  structuredData: aiStructuredData,
                  renderType: aiRenderType,
                  renderVersion: aiRenderVersion
                }
              : {}),
            processingFlow,
            interactionMode
          },
          created_at: nowIso()
        }
        await supabaseInsert('chat_messages', aiRow, 'minimal')
        aiMessage = toMessageEntity(aiRow)
      }

      const userMessage = toMessageEntity({
        ...userRow,
        meta: aiAnswer
          ? {
              ...(body.meta || {}),
              aiAnswer,
              ...(aiStructuredData
                ? {
                    structuredData: aiStructuredData,
                    renderType: aiRenderType,
                    renderVersion: aiRenderVersion
                  }
                : {}),
              conversationId,
              topicId,
              previousWorkflowId,
              workflowAction,
              executionType,
              workflowId,
              workflowVersion,
              executionContract,
              processingFlow,
              interactionMode
            }
          : {
              ...(body.meta && typeof body.meta === 'object' ? body.meta : {}),
              conversationId,
              topicId
            }
      })

      return ok(res, {
        conversationId,
        topicId,
        executionContract,
        message: userMessage,
        aiMessage
      })
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      const code = status === 403 ? 'PERMISSION_DENIED' : 'MESSAGE_SEND_FAILED'
      return fail(res, status, code, error.message || 'send message failed')
    }
  }

  return methodNotAllowed(res)
}
