import { resolveCurrentUserId } from './http.js'
import { supabaseDelete, supabaseGet, supabaseInsert } from './supabase.js'

const DEFAULT_ROOM_ID = 'r_mvp_main'
const DEFAULT_ROOM_NAME = 'AI 助手'

function fallbackDefaultRoom() {
  return {
    roomId: DEFAULT_ROOM_ID,
    roomName: DEFAULT_ROOM_NAME,
    roomType: 'ai_dm',
    users: [],
    unreadCount: 0,
    lastActiveAt: nowIso()
  }
}

function isPlatformSchemaMissing(error) {
  const status = typeof error?.status === 'number' ? error.status : 0
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : ''
  if (status === 404) return true
  return (
    message.includes('relation') ||
    message.includes('schema cache') ||
    message.includes('chat_rooms') ||
    message.includes('chat_room_members') ||
    message.includes('chat_messages')
  )
}

export function nowIso() {
  return new Date().toISOString()
}

export function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function getActorId(req) {
  return resolveCurrentUserId(req)
}

function toRoomEntity(row, lastMessage) {
  return {
    roomId: row.id,
    roomName: row.name,
    roomType: row.type === 'group' ? 'group' : row.type === 'dm' ? 'dm' : 'ai_dm',
    users: [],
    unreadCount: 0,
    lastActiveAt: row.last_active_at || nowIso(),
    ...(lastMessage ? { lastMessage } : {})
  }
}

export function toMessageEntity(row) {
  return {
    _id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    senderType: row.sender_type === 'ai' ? 'ai' : row.sender_type === 'system' ? 'system' : 'user',
    messageType: row.message_type,
    content: row.content || '',
    createdAt: row.created_at,
    status: row.status || 'delivered',
    files: row.files || undefined,
    meta: row.meta || undefined
  }
}

export async function ensureDefaultRoomForUser(userId) {
  try {
    const memberRows = await supabaseGet(
      'chat_room_members',
      `select=room_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`
    )
    if (Array.isArray(memberRows) && memberRows.length > 0) {
      return
    }

    const roomRows = await supabaseGet('chat_rooms', `select=id,name,type,last_active_at&id=eq.${DEFAULT_ROOM_ID}&limit=1`)
    if (!Array.isArray(roomRows) || roomRows.length === 0) {
      await supabaseInsert('chat_rooms', {
        id: DEFAULT_ROOM_ID,
        name: DEFAULT_ROOM_NAME,
        type: 'ai_dm',
        last_active_at: nowIso()
      }, 'minimal')
    }

    await supabaseInsert('chat_room_members', {
      room_id: DEFAULT_ROOM_ID,
      user_id: userId
    }, 'minimal')
  } catch (error) {
    if (!isPlatformSchemaMissing(error)) throw error
  }
}

export async function listRoomsByUser(userId) {
  try {
    await ensureDefaultRoomForUser(userId)

    const memberRows = await supabaseGet('chat_room_members', `select=room_id&user_id=eq.${encodeURIComponent(userId)}&limit=200`)
    const roomIds = Array.isArray(memberRows)
      ? [...new Set(memberRows.map(row => row.room_id).filter(Boolean))]
      : []

    if (roomIds.length === 0) {
      return [fallbackDefaultRoom()]
    }

    const inFilter = roomIds.map(id => `"${String(id).replace(/"/g, '""')}"`).join(',')
    const rooms = await supabaseGet(
      'chat_rooms',
      `select=id,name,type,last_active_at&id=in.(${encodeURIComponent(inFilter)})&order=last_active_at.desc`
    )

    const roomList = Array.isArray(rooms) ? rooms : []
    const mapped = []
    for (const room of roomList) {
      let lastMessage
      try {
        const msgRows = await supabaseGet(
          'chat_messages',
          `select=id,room_id,sender_id,sender_type,message_type,content,status,meta,files,created_at&room_id=eq.${encodeURIComponent(room.id)}&order=created_at.desc&limit=1`
        )
        if (Array.isArray(msgRows) && msgRows[0]) {
          lastMessage = toMessageEntity(msgRows[0])
        }
      } catch (_error) {
        // Ignore last message failure to keep room list available.
      }
      mapped.push(toRoomEntity(room, lastMessage))
    }
    return mapped.length ? mapped : [fallbackDefaultRoom()]
  } catch (error) {
    if (!isPlatformSchemaMissing(error)) throw error
    return [fallbackDefaultRoom()]
  }
}

export async function getRoomById(roomId) {
  const rows = await supabaseGet(
    'chat_rooms',
    `select=id,name,type,last_active_at&id=eq.${encodeURIComponent(roomId)}&limit=1`
  )
  if (!Array.isArray(rows) || !rows[0]) return null
  return rows[0]
}

export async function ensureRoomMember(roomId, userId) {
  try {
    const rows = await supabaseGet(
      'chat_room_members',
      `select=room_id,user_id&room_id=eq.${encodeURIComponent(roomId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`
    )
    if (!Array.isArray(rows) || rows.length === 0) {
      const error = new Error('Not a room member')
      error.status = 403
      throw error
    }
  } catch (error) {
    if (isPlatformSchemaMissing(error)) return
    throw error
  }
}

export async function addRoomMember(roomId, userId) {
  try {
    return await supabaseInsert('chat_room_members', {
      room_id: roomId,
      user_id: userId
    }, 'minimal')
  } catch (error) {
    if (isPlatformSchemaMissing(error)) return null
    throw error
  }
}

export async function removeRoomMember(roomId, userId) {
  try {
    return await supabaseDelete(
      'chat_room_members',
      `room_id=eq.${encodeURIComponent(roomId)}&user_id=eq.${encodeURIComponent(userId)}`,
      'minimal'
    )
  } catch (error) {
    if (isPlatformSchemaMissing(error)) return null
    throw error
  }
}

export async function listMessages(roomId, limit = 20, cursor) {
  const queryParts = [
    'select=id,room_id,sender_id,sender_type,message_type,content,status,meta,files,created_at',
    `room_id=eq.${encodeURIComponent(roomId)}`,
    'order=created_at.desc',
    `limit=${Math.max(1, Math.min(limit, 100))}`
  ]
  if (cursor) {
    queryParts.splice(2, 0, `created_at=lt.${encodeURIComponent(cursor)}`)
  }
  try {
    const rows = await supabaseGet('chat_messages', queryParts.join('&'))
    const list = Array.isArray(rows) ? rows.map(toMessageEntity).reverse() : []
    return list
  } catch (error) {
    if (isPlatformSchemaMissing(error)) return []
    throw error
  }
}

export async function listMessagesSince(roomId, sinceIso, limit = 20) {
  const queryParts = [
    'select=id,room_id,sender_id,sender_type,message_type,content,status,meta,files,created_at',
    `room_id=eq.${encodeURIComponent(roomId)}`,
    'order=created_at.asc',
    `limit=${Math.max(1, Math.min(limit, 100))}`
  ]
  if (sinceIso) {
    queryParts.splice(2, 0, `created_at=gt.${encodeURIComponent(sinceIso)}`)
  }
  try {
    const rows = await supabaseGet('chat_messages', queryParts.join('&'))
    return Array.isArray(rows) ? rows.map(toMessageEntity) : []
  } catch (error) {
    if (isPlatformSchemaMissing(error)) return []
    throw error
  }
}
