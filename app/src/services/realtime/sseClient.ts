import { getApiBaseUrl } from '../../platform/env'

export interface SseEventPayload {
  type: string
  data: unknown
}

export interface SseConnectionCallbacks {
  onOpen?: () => void
  onError?: () => void
  onReconnect?: (attempt: number, delayMs: number) => void
  onHalt?: (attempt: number) => void
  shouldReconnect?: (nextAttempt: number) => boolean
  reconnectDelayMs?: number
  maxReconnectDelayMs?: number
}

export class ChatSseClient {
  private es?: EventSource
  private reconnectTimer?: number
  private reconnectAttempts = 0
  private closedManually = false

  connect(
    sessionId: string,
    onEvent: (payload: SseEventPayload) => void,
    callbacks: SseConnectionCallbacks = {}
  ) {
    this.close()
    this.closedManually = false
    this.reconnectAttempts = 0
    this.openConnection(sessionId, onEvent, callbacks)
  }

  private openConnection(
    sessionId: string,
    onEvent: (payload: SseEventPayload) => void,
    callbacks: SseConnectionCallbacks
  ) {
    const token = localStorage.getItem('baby_token') || ''
    const actorId = localStorage.getItem('baby_device_id') || ''
    const qs = new URLSearchParams({ sessionId })
    if (token) qs.set('token', token)
    if (actorId) qs.set('actorId', actorId)
    const base = getApiBaseUrl().replace(/\/+$/, '')
    this.es = new EventSource(`${base}/chat/stream?${qs.toString()}`)

    this.es.onopen = () => {
      this.reconnectAttempts = 0
      callbacks.onOpen?.()
    }

    this.es.onmessage = event => {
      onEvent({ type: 'message', data: this.safeParse(event.data) })
    }

    const namedEvents = [
      'message.delta',
      'message.done',
      'message.status',
      'room.typing',
      'room.read',
      'heartbeat'
    ]
    namedEvents.forEach(eventName => {
      this.es?.addEventListener(eventName, event => {
        const msg = event as MessageEvent
        onEvent({ type: eventName, data: this.safeParse(msg.data) })
      })
    })

    this.es.onerror = () => {
      callbacks.onError?.()
      if (this.es) {
        this.es.close()
        this.es = undefined
      }
      if (this.closedManually) return

      const nextAttempt = this.reconnectAttempts + 1
      if (callbacks.shouldReconnect && !callbacks.shouldReconnect(nextAttempt)) {
        callbacks.onHalt?.(nextAttempt)
        return
      }

      this.reconnectAttempts = nextAttempt
      const baseDelayMs = callbacks.reconnectDelayMs ?? 5000
      const maxDelayMs = callbacks.maxReconnectDelayMs ?? 30000
      const reconnectDelayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, nextAttempt - 1))

      this.reconnectTimer = window.setTimeout(() => {
        callbacks.onReconnect?.(nextAttempt, reconnectDelayMs)
        this.openConnection(sessionId, onEvent, callbacks)
      }, reconnectDelayMs)
    }
  }

  close() {
    this.closedManually = true
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.es) {
      this.es.close()
      this.es = undefined
    }
  }

  private safeParse(data: string): unknown {
    try {
      return JSON.parse(data)
    } catch {
      return data
    }
  }
}
