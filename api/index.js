import { fail } from '../api_handlers/_lib/http.js'
import healthHandler from '../api_handlers/health.js'
import diagnosticsHandler from '../api_handlers/diagnostics.js'
import userHandler from '../api_handlers/user.js'
import chatHandler from '../api_handlers/chat.js'
import historyHandler from '../api_handlers/history.js'
import cozeChatHandler from '../api_handlers/coze/chat.js'
import chatMessagesLegacyHandler from '../api_handlers/chat/messages.js'
import chatRoomsLegacyHandler from '../api_handlers/chat/rooms.js'
import chatRoomMessagesLegacyHandler from '../api_handlers/chat/rooms/[roomId]/messages.js'
import chatSessionsHandler from '../api_handlers/chat/sessions.js'
import chatStreamHandler from '../api_handlers/chat/stream.js'
import socialContactsHandler from '../api_handlers/social/contacts.js'
import socialFriendRequestsHandler from '../api_handlers/social/friend-requests.js'
import socialRequestAcceptHandler from '../api_handlers/social/friend-requests/[requestId]/accept.js'
import socialRequestRejectHandler from '../api_handlers/social/friend-requests/[requestId]/reject.js'
import voiceUploadHandler from '../api_handlers/voice/upload.js'
import voiceAsrHandler from '../api_handlers/voice/asr.js'
import voiceTtsHandler from '../api_handlers/voice/tts.js'
import v1GroupsHandler from '../api_handlers/v1/groups.js'
import v1GroupMembersHandler from '../api_handlers/v1/groups/[groupId]/members.js'
import v1GroupMemberHandler from '../api_handlers/v1/groups/[groupId]/members/[memberId].js'
import v1ConversationsHandler from '../api_handlers/v1/conversations.js'
import v1ConversationMessagesHandler from '../api_handlers/v1/conversations/[conversationId]/messages.js'
import v1AssetsUploadHandler from '../api_handlers/v1/assets/upload.js'
import v1CapabilitiesExecuteHandler from '../api_handlers/v1/capabilities/execute.js'

function toPathname(req) {
  const rawUrl = typeof req.url === 'string' ? req.url : '/api'
  try {
    return new URL(rawUrl, 'http://localhost').pathname
  } catch {
    const idx = rawUrl.indexOf('?')
    return idx >= 0 ? rawUrl.slice(0, idx) : rawUrl
  }
}

function parseQuery(req, pathParams) {
  const rawUrl = typeof req.url === 'string' ? req.url : '/api'
  const url = new URL(rawUrl, 'http://localhost')
  const query = {}
  for (const [key, value] of url.searchParams.entries()) {
    if (Object.prototype.hasOwnProperty.call(query, key)) {
      const existing = query[key]
      query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value]
    } else {
      query[key] = value
    }
  }
  Object.assign(query, pathParams)
  return query
}

function match(pathname, pattern) {
  const m = pathname.match(pattern)
  return m || null
}

const exactRoutes = new Map([
  ['/api', healthHandler],
  ['/api/health', healthHandler],
  ['/api/diagnostics', diagnosticsHandler],
  ['/api/user', userHandler],
  ['/api/chat', chatHandler],
  ['/api/history', historyHandler],
  ['/api/coze/chat', cozeChatHandler],
  ['/api/chat/messages', chatMessagesLegacyHandler],
  ['/api/chat/rooms', chatRoomsLegacyHandler],
  ['/api/chat/sessions', chatSessionsHandler],
  ['/api/chat/stream', chatStreamHandler],
  ['/api/social/contacts', socialContactsHandler],
  ['/api/social/friend-requests', socialFriendRequestsHandler],
  ['/api/voice/upload', voiceUploadHandler],
  ['/api/voice/asr', voiceAsrHandler],
  ['/api/voice/tts', voiceTtsHandler],
  ['/api/v1/groups', v1GroupsHandler],
  ['/api/v1/conversations', v1ConversationsHandler],
  ['/api/v1/assets/upload', v1AssetsUploadHandler],
  ['/api/v1/capabilities/execute', v1CapabilitiesExecuteHandler]
])

const dynamicRoutes = [
  {
    pattern: /^\/api\/chat\/rooms\/([^/]+)\/messages$/,
    params: m => ({ roomId: decodeURIComponent(m[1]) }),
    handler: chatRoomMessagesLegacyHandler
  },
  {
    pattern: /^\/api\/social\/friend-requests\/([^/]+)\/accept$/,
    params: m => ({ requestId: decodeURIComponent(m[1]) }),
    handler: socialRequestAcceptHandler
  },
  {
    pattern: /^\/api\/social\/friend-requests\/([^/]+)\/reject$/,
    params: m => ({ requestId: decodeURIComponent(m[1]) }),
    handler: socialRequestRejectHandler
  },
  {
    pattern: /^\/api\/v1\/groups\/([^/]+)\/members$/,
    params: m => ({ groupId: decodeURIComponent(m[1]) }),
    handler: v1GroupMembersHandler
  },
  {
    pattern: /^\/api\/v1\/groups\/([^/]+)\/members\/([^/]+)$/,
    params: m => ({ groupId: decodeURIComponent(m[1]), memberId: decodeURIComponent(m[2]) }),
    handler: v1GroupMemberHandler
  },
  {
    pattern: /^\/api\/v1\/conversations\/([^/]+)\/messages$/,
    params: m => ({ conversationId: decodeURIComponent(m[1]) }),
    handler: v1ConversationMessagesHandler
  }
]

export default async function handler(req, res) {
  try {
    const pathname = toPathname(req)

    const exact = exactRoutes.get(pathname)
    if (exact) {
      req.query = parseQuery(req, {})
      return exact(req, res)
    }

    for (const route of dynamicRoutes) {
      const matched = match(pathname, route.pattern)
      if (!matched) continue
      const params = route.params(matched)
      req.query = parseQuery(req, params)
      return route.handler(req, res)
    }

    return fail(res, 404, 'NOT_FOUND', `Route not found: ${pathname}`)
  } catch (error) {
    return fail(res, 500, 'ROUTER_FAILED', error?.message || 'router failed')
  }
}
