/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_COZE_API_URI?: string
  readonly VITE_CHAT_REALTIME_ENABLED?: string
  readonly VITE_SSE_RECONNECT_MS?: string
  readonly VITE_SSE_MAX_RECONNECT_ATTEMPTS?: string
  readonly VITE_SSE_MAX_RECONNECT_DELAY_MS?: string
  readonly VITE_SSE_STALE_MS?: string
  readonly VITE_SSE_WATCHDOG_MS?: string
  readonly VITE_SSE_AUTO_RECOVER_COOLDOWN_MS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
