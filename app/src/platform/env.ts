export function isMobile(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

function toNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function toPositiveInt(value: unknown, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0') return false
  }
  return fallback
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function upgradeInsecureHttpIfHttpsPage(value: string): string {
  if (typeof window === 'undefined') return value
  if (window.location.protocol !== 'https:') return value
  if (!value.startsWith('http://')) return value
  return `https://${value.slice('http://'.length)}`
}

function readRawEnv(name: string): string {
  const value = import.meta.env[name]
  return typeof value === 'string' ? value.trim() : ''
}

export function getApiBaseUrl(): string {
  const raw = toNonEmptyString(import.meta.env.VITE_API_BASE_URL, '/api')
  return trimTrailingSlash(upgradeInsecureHttpIfHttpsPage(raw))
}

export function getCozeApiUri(): string {
  const raw = toNonEmptyString(import.meta.env.VITE_COZE_API_URI, '/api/coze')
  return trimTrailingSlash(upgradeInsecureHttpIfHttpsPage(raw))
}

export function getMixedContentRiskHint(): string {
  if (typeof window === 'undefined') return ''
  if (window.location.protocol !== 'https:') return ''
  const rawApi = readRawEnv('VITE_API_BASE_URL')
  const rawCoze = readRawEnv('VITE_COZE_API_URI')
  if (rawApi.startsWith('http://') || rawCoze.startsWith('http://')) {
    return '检测到 HTTP 接口配置，HTTPS 页面下会被浏览器拦截，请改为 HTTPS 或相对路径 /api。'
  }
  return ''
}

export function getSseReconnectMs(): number {
  return toPositiveInt(import.meta.env.VITE_SSE_RECONNECT_MS, 5000)
}

export function getSseMaxReconnectAttempts(): number {
  return toPositiveInt(import.meta.env.VITE_SSE_MAX_RECONNECT_ATTEMPTS, 6)
}

export function getSseMaxReconnectDelayMs(): number {
  return toPositiveInt(import.meta.env.VITE_SSE_MAX_RECONNECT_DELAY_MS, 30000)
}

export function getSseStaleMs(): number {
  return toPositiveInt(import.meta.env.VITE_SSE_STALE_MS, 15000)
}

export function getSseWatchdogMs(): number {
  return toPositiveInt(import.meta.env.VITE_SSE_WATCHDOG_MS, 3000)
}

export function getSseAutoRecoverCooldownMs(): number {
  return toPositiveInt(import.meta.env.VITE_SSE_AUTO_RECOVER_COOLDOWN_MS, 8000)
}

export function getRealtimeEnabled(): boolean {
  return toBoolean(import.meta.env.VITE_CHAT_REALTIME_ENABLED, true)
}
