import type { MessageEntity, RoomEntity } from '../types/domain'

export interface VacRoom {
  roomId: string
  roomName: string
  avatar?: string
  users: Array<{ _id: string; username: string; avatar?: string; status?: { state: 'online' | 'offline' } }>
  unreadCount: number
  lastMessage?: {
    _id: string
    content: string
    senderId: string
    username?: string
    timestamp: string
    files?: MessageEntity['files']
    saved?: boolean
    distributed?: boolean
    seen?: boolean
  }
}

export interface VacMessage {
  _id: string
  content: string
  senderId: string
  username?: string
  date: string
  timestamp: string
  saved?: boolean
  distributed?: boolean
  seen?: boolean
  files?: MessageEntity['files']
  disableActions?: boolean
}

export const chatAdapter = {
  toVacRooms(rooms: RoomEntity[]): VacRoom[] {
    return rooms.map(room => ({
      roomId: room.roomId,
      roomName: room.roomName,
      users: room.users,
      unreadCount: room.unreadCount,
      lastMessage: room.lastMessage
        ? {
            _id: room.lastMessage._id,
            content: room.lastMessage.content,
            senderId: room.lastMessage.senderId,
            timestamp: room.lastMessage.createdAt,
            files: room.lastMessage.files,
            saved: room.lastMessage.status !== 'failed',
            distributed: room.lastMessage.status === 'delivered' || room.lastMessage.status === 'seen',
            seen: room.lastMessage.status === 'seen'
          }
        : undefined
    }))
  },

  toVacMessages(messages: MessageEntity[]): VacMessage[] {
    return messages.map(msg => ({
      _id: msg._id,
      content: msg.content,
      senderId: msg.senderId,
      date: msg.createdAt,
      timestamp: msg.createdAt,
      files: msg.files,
      saved: msg.status !== 'failed',
      distributed: msg.status === 'delivered' || msg.status === 'seen',
      seen: msg.status === 'seen',
      disableActions: msg.messageType === 'mentor_card'
    }))
  }
}
