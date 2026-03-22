export type RoomType = 'dm' | 'group' | 'ai_dm' | 'mentor_room'
export type MessageType = 'text' | 'audio' | 'image' | 'file' | 'system' | 'mentor_card'
export type MessageStatus = 'local' | 'sending' | 'delivered' | 'seen' | 'failed'

export interface ChatUser {
  _id: string
  username: string
  avatar?: string
  status?: { state: 'online' | 'offline' }
}

export interface ChatFile {
  name?: string
  size?: number
  type?: string
  extension?: string
  url?: string
  audio?: boolean
  duration?: number
}

export interface MessageEntity {
  _id: string
  roomId: string
  senderId: string
  senderType: 'user' | 'ai' | 'system'
  messageType: MessageType
  content: string
  createdAt: string
  status: MessageStatus
  files?: ChatFile[]
  meta?: {
    asrText?: string
    ttsUrl?: string
    aiAnswer?: string
    degraded?: boolean
    degradedReason?: string
    structuredData?: Record<string, unknown>
    renderType?: string
    renderVersion?: string
    interactionMode?: 'direct' | 'flow_first'
    processingFlow?: {
      route?: string
      degraded?: boolean
      steps?: Array<{
        id?: string
        status?: string
        detail?: string
      }>
      nextActions?: string[]
    }
    cardType?: 'advice' | 'task' | 'summary'
    taskId?: string
    traceId?: string
  }
}

export interface RoomEntity {
  roomId: string
  roomName: string
  roomType: RoomType
  users: ChatUser[]
  unreadCount: number
  lastActiveAt: string
  lastMessage?: MessageEntity
}
