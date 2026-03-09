import { defineStore } from 'pinia'
import { chatApi } from '../services/api/chat.api'
import { voiceApi } from '../services/api/voice.api'
import { ChatSseClient, type SseEventPayload } from '../services/realtime/sseClient'
import { toUserError } from '../services/api/errorMap'
import { ApiError } from '../types/api'
import {
  getSseAutoRecoverCooldownMs,
  getRealtimeEnabled,
  getSseReconnectMs,
  getSseStaleMs,
  getSseWatchdogMs
} from '../platform/env'
import type { MessageEntity, RoomEntity } from '../types/domain'

const sseClient = new ChatSseClient()
const ttsAudio = typeof Audio !== 'undefined' ? new Audio() : null

const STATUS_SET = new Set<MessageEntity['status']>(['local', 'sending', 'delivered', 'seen', 'failed'])

function upsertMessage(list: MessageEntity[], message: MessageEntity): MessageEntity[] {
  const index = list.findIndex(item => item._id === message._id)
  if (index === -1) return [...list, message]
  const next = [...list]
  next[index] = message
  return next
}

function mergeUniqueByKey<T>(base: T[], incoming: T[], keyGetter: (item: T) => string): T[] {
  const map = new Map<string, T>()
  base.forEach(item => map.set(keyGetter(item), item))
  incoming.forEach(item => map.set(keyGetter(item), item))
  return [...map.values()]
}

function resolveEventData(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {}
  const obj = input as Record<string, unknown>
  if (obj.data && typeof obj.data === 'object') {
    return obj.data as Record<string, unknown>
  }
  return obj
}

function resolveStatus(value: unknown): MessageEntity['status'] | undefined {
  if (typeof value !== 'string') return undefined
  return STATUS_SET.has(value as MessageEntity['status']) ? (value as MessageEntity['status']) : undefined
}

function withFeatureError(feature: string, error: unknown): string {
  if (error instanceof ApiError && error.meta) {
    const parts: string[] = []
    if (error.meta.method && error.meta.path) {
      parts.push(`${error.meta.method} ${error.meta.path}`)
    } else if (error.meta.path) {
      parts.push(error.meta.path)
    }
    if (typeof error.meta.status === 'number') {
      parts.push(`HTTP ${error.meta.status}`)
    }
    if (parts.length) {
      return `[${feature}] (${parts.join(' | ')}) ${toUserError(error)}`
    }
  }
  return `[${feature}] ${toUserError(error)}`
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    rooms: [] as RoomEntity[],
    roomsCursor: '' as string | undefined,
    messages: [] as MessageEntity[],
    messagesCursorByRoom: {} as Record<string, string | undefined>,
    roomId: '',
    sessionId: '',
    loadingRooms: false,
    loadingMoreRooms: false,
    loadingMessages: false,
    loadingMoreMessages: false,
    roomsLoaded: true,
    messagesLoaded: true,
    streamConnecting: false,
    streamConnected: false,
    streamLastConnectedAt: '',
    streamLastEventAt: '',
    streamReconnectCount: 0,
    streamStale: false,
    streamRecovering: false,
    streamLastRecoverAt: '',
    streamWatchdogTimerId: 0,
    sessionError: '',
    streamError: '',
    realtimeUnsupported: !getRealtimeEnabled(),
    ttsLoading: false,
    ttsPlaying: false,
    ttsAudioUrl: '',
    streamDrafts: {} as Record<string, string>,
    lastError: ''
  }),
  getters: {
    connectionHint(state): string {
      if (state.streamConnected) return ''
      if (state.streamConnecting) return '正在建立实时连接...'
      if (state.realtimeUnsupported) return '当前版本未启用实时通道，消息通过普通接口发送与刷新。'
      if (state.sessionError) return `会话创建失败: ${state.sessionError}`
      if (state.streamError) return `实时通道异常: ${state.streamError}`
      return state.roomId ? '实时连接未建立，可点击“立即重连”。' : '当前没有可用聊天房间。'
    }
  },
  actions: {
    async fetchRooms(reset = true) {
      this.loadingRooms = true
      try {
        const result = await chatApi.listRooms(reset ? undefined : this.roomsCursor)
        this.rooms = reset
          ? result.list
          : mergeUniqueByKey(this.rooms, result.list, item => item.roomId)
        this.roomsCursor = result.nextCursor
        this.roomsLoaded = !result.hasMore
      } catch (error) {
        this.lastError = withFeatureError('聊天房间加载', error)
        if (reset) {
          this.rooms = []
          this.roomsCursor = undefined
          this.roomsLoaded = true
        }
      } finally {
        this.loadingRooms = false
        if (!this.roomId && this.rooms.length) {
          this.roomId = this.rooms[0].roomId
        }
      }
    },

    async fetchMoreRooms() {
      if (this.loadingMoreRooms || this.roomsLoaded) return
      this.loadingMoreRooms = true
      try {
        await this.fetchRooms(false)
      } finally {
        this.loadingMoreRooms = false
      }
    },

    async fetchMessages(roomId: string, reset = true) {
      const changedRoom = this.roomId && this.roomId !== roomId
      this.roomId = roomId
      if (changedRoom) {
        this.closeStream()
        this.sessionId = ''
      }

      if (reset) {
        this.loadingMessages = true
      } else {
        this.loadingMoreMessages = true
      }
      try {
        const cursor = reset ? undefined : this.messagesCursorByRoom[roomId]
        const result = await chatApi.listMessages(roomId, cursor)
        this.messages = reset
          ? result.list
          : mergeUniqueByKey([...result.list, ...this.messages], [], item => item._id)
        this.messagesCursorByRoom[roomId] = result.nextCursor
        this.messagesLoaded = !result.hasMore
      } catch (error) {
        this.lastError = withFeatureError('聊天消息加载', error)
        if (reset) {
          this.messages = []
        }
        this.messagesCursorByRoom[roomId] = undefined
        this.messagesLoaded = true
      } finally {
        if (reset) {
          this.loadingMessages = false
        } else {
          this.loadingMoreMessages = false
        }
      }
    },

    async fetchMoreMessages(roomId: string) {
      if (this.loadingMoreMessages || this.messagesLoaded) return
      await this.fetchMessages(roomId, false)
    },

    async ensureSession() {
      if (this.sessionId || !this.roomId || this.realtimeUnsupported) return
      try {
        const room = this.rooms.find(item => item.roomId === this.roomId)
        if (!room) return
        const created = await chatApi.createSession({
          roomType: room.roomType,
          topicId: room.roomId
        })
        this.sessionId = created.sessionId
        this.sessionError = ''
        this.openStream()
      } catch (error) {
        this.sessionError = withFeatureError('会话创建', error)
        this.lastError = this.sessionError
        if (this.sessionError.includes('404')) {
          this.realtimeUnsupported = true
          this.streamConnecting = false
          this.streamConnected = false
        }
      }
    },

    openStream() {
      if (!this.sessionId) return
      this.streamConnecting = true
      this.streamStale = false
      this.streamError = ''
      this.startStreamWatchdog()
      sseClient.connect(this.sessionId, payload => this.onSseEvent(payload), {
        reconnectDelayMs: getSseReconnectMs(),
        onOpen: () => {
          this.streamConnecting = false
          this.streamConnected = true
          this.streamError = ''
          const nowAt = new Date().toISOString()
          this.streamLastConnectedAt = nowAt
          this.streamLastEventAt = nowAt
        },
        onError: () => {
          this.streamConnected = false
          this.streamError = 'SSE 建连失败或连接中断'
        },
        onReconnect: () => {
          this.streamReconnectCount += 1
          this.streamConnecting = true
        }
      })
    },

    async reconnectStream() {
      if (this.streamRecovering || this.realtimeUnsupported) return
      this.streamRecovering = true
      this.sessionError = ''
      this.streamError = ''
      this.closeStream()
      if (!this.sessionId) {
        await this.ensureSession()
      } else {
        this.openStream()
      }
      this.streamLastRecoverAt = new Date().toISOString()
      this.streamRecovering = false
    },

    closeStream() {
      sseClient.close()
      this.streamConnecting = false
      this.streamConnected = false
      this.streamStale = false
      this.streamRecovering = false
      this.stopStreamWatchdog()
    },

    onSseEvent(payload: SseEventPayload) {
      this.streamLastEventAt = new Date().toISOString()
      this.streamStale = false
      const data = resolveEventData(payload.data)

      if (payload.type === 'heartbeat') {
        return
      }

      if (payload.type === 'message.delta') {
        const messageId = String(data.messageId || '')
        if (!messageId) return
        const delta = String(data.delta || '')
        const roomId = String(data.roomId || this.roomId)
        const existing = this.messages.find(item => item._id === messageId)
        const mergedContent = `${existing?.content || this.streamDrafts[messageId] || ''}${delta}`
        this.streamDrafts[messageId] = mergedContent

        const streamMessage: MessageEntity = {
          _id: messageId,
          roomId,
          senderId: String(data.senderId || 'u_ai_stream'),
          senderType: 'ai',
          messageType: 'text',
          content: mergedContent,
          createdAt: String(data.createdAt || new Date().toISOString()),
          status: 'sending'
        }
        this.messages = upsertMessage(this.messages, streamMessage)
        return
      }

      if (payload.type === 'message.done' || payload.type === 'message') {
        const doneMessage = (data.message as MessageEntity | undefined) || (data as MessageEntity)
        if (doneMessage && doneMessage._id) {
          this.messages = upsertMessage(this.messages, {
            ...doneMessage,
            status: doneMessage.status || 'delivered'
          })
          delete this.streamDrafts[doneMessage._id]
          return
        }

        const doneMessageId = String(data.messageId || '')
        if (doneMessageId) {
          this.messages = this.messages.map(item =>
            item._id === doneMessageId ? { ...item, status: 'delivered' } : item
          )
          delete this.streamDrafts[doneMessageId]
        }
        return
      }

      if (payload.type === 'message.status') {
        const messageId = String(data.messageId || '')
        if (!messageId) return
        const status = resolveStatus(data.status)
        if (!status) return
        this.messages = this.messages.map(msg => (msg._id === messageId ? { ...msg, status } : msg))
      }
    },

    async sendText(content: string) {
      if (!this.roomId || !content.trim()) return

      const clientMessageId = `cm_${Date.now()}`
      const localMessage: MessageEntity = {
        _id: clientMessageId,
        roomId: this.roomId,
        senderId: 'u_current',
        senderType: 'user',
        messageType: 'text',
        content,
        createdAt: new Date().toISOString(),
        status: 'sending'
      }

      this.messages = [...this.messages, localMessage]
      await this.persistMessage(localMessage)
    },

    async retryMessage(messageId: string) {
      const target = this.messages.find(item => item._id === messageId)
      if (!target || target.status !== 'failed') return

      const retrying = { ...target, status: 'sending' as const }
      this.messages = this.messages.map(item => (item._id === messageId ? retrying : item))
      await this.persistMessage(retrying)
    },

    async persistMessage(message: MessageEntity) {
      try {
        const result = await chatApi.sendMessage({
          roomId: message.roomId,
          clientMessageId: message._id,
          messageType: message.messageType,
          content: message.content,
          files: message.files,
          meta: message.meta
        })
        const saved = result.message
        this.messages = this.messages.map(item => (item._id === message._id ? saved : item))
        if (result.aiMessage) {
          this.messages = upsertMessage(this.messages, result.aiMessage)
        }
      } catch (error) {
        this.messages = this.messages.map(item =>
          item._id === message._id ? { ...item, status: 'failed' } : item
        )
        this.lastError = withFeatureError('消息发送', error)
      }
    },

    async requestTtsAndPlay(text: string) {
      if (!text.trim()) return
      this.lastError = ''
      this.ttsLoading = true
      try {
        const result = await voiceApi.tts(text)
        this.ttsAudioUrl = result.audioUrl
        await this.playTts(result.audioUrl)
      } catch (error) {
        this.lastError = withFeatureError('TTS 请求', error)
      } finally {
        this.ttsLoading = false
      }
    },

    async playTts(url: string) {
      if (!ttsAudio) return
      this.stopTts()
      ttsAudio.src = url
      ttsAudio.onended = () => {
        this.ttsPlaying = false
      }
      ttsAudio.onerror = () => {
        this.ttsPlaying = false
        this.lastError = 'TTS 播放失败'
      }

      try {
        await ttsAudio.play()
        this.ttsPlaying = true
      } catch (error) {
        this.ttsPlaying = false
        this.lastError = withFeatureError('TTS 播放', error)
      }
    },

    stopTts() {
      if (!ttsAudio) return
      ttsAudio.pause()
      ttsAudio.currentTime = 0
      this.ttsPlaying = false
    },

    startStreamWatchdog() {
      this.stopStreamWatchdog()
      this.streamWatchdogTimerId = window.setInterval(() => {
        if (!this.streamConnected || !this.streamLastEventAt) return
        const staleMs = Date.now() - new Date(this.streamLastEventAt).getTime()
        if (staleMs > getSseStaleMs()) {
          this.streamStale = true
          this.streamConnected = false
          const lastRecoverTs = this.streamLastRecoverAt
            ? new Date(this.streamLastRecoverAt).getTime()
            : 0
          const nowTs = Date.now()
          if (nowTs - lastRecoverTs >= getSseAutoRecoverCooldownMs()) {
            this.reconnectStream()
          }
        }
      }, getSseWatchdogMs())
    },

    stopStreamWatchdog() {
      if (!this.streamWatchdogTimerId) return
      window.clearInterval(this.streamWatchdogTimerId)
      this.streamWatchdogTimerId = 0
    }
  }
})
