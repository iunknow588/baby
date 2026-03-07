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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function upgradeInsecureHttpIfHttpsPage(value: string): string {
  if (typeof window === 'undefined') return value
  if (window.location.protocol !== 'https:') return value
  if (!value.startsWith('http://')) return value
  return `https://${value.slice('http://'.length)}`
}

export function getApiBaseUrl(): string {
  const raw = toNonEmptyString(import.meta.env.VITE_API_BASE_URL, '/api')
  return trimTrailingSlash(upgradeInsecureHttpIfHttpsPage(raw))
}

export function getCozeApiUri(): string {
  const raw = toNonEmptyString(import.meta.env.VITE_COZE_API_URI, '/api/coze')
  return trimTrailingSlash(upgradeInsecureHttpIfHttpsPage(raw))
}

export function getSseReconnectMs(): number {
  return toPositiveInt(import.meta.env.VITE_SSE_RECONNECT_MS, 5000)
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
