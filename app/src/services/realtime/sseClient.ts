import { getApiBaseUrl } from '../../platform/env'

export interface SseEventPayload {
  type: string
  data: unknown
}

export interface SseConnectionCallbacks {
  onOpen?: () => void
  onError?: () => void
  onReconnect?: () => void
  reconnectDelayMs?: number
}

export class ChatSseClient {
  private es?: EventSource
  private reconnectTimer?: number

  connect(
    sessionId: string,
    onEvent: (payload: SseEventPayload) => void,
    callbacks: SseConnectionCallbacks = {}
  ) {
    this.close()

    const token = localStorage.getItem('baby_token') || ''
    const actorId = localStorage.getItem('baby_device_id') || ''
    const qs = new URLSearchParams({ sessionId, token, actorId })
    const base = getApiBaseUrl().replace(/\/+$/, '')
    this.es = new EventSource(`${base}/chat/stream?${qs.toString()}`)

    this.es.onopen = () => {
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
      this.close()
      const reconnectDelayMs = callbacks.reconnectDelayMs ?? 5000
      this.reconnectTimer = window.setTimeout(() => {
        callbacks.onReconnect?.()
        this.connect(sessionId, onEvent, callbacks)
      }, reconnectDelayMs)
    }
  }

  close() {
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
