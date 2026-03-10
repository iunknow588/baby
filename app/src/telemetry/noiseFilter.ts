import { logInfo } from './logger'

const NOISE_MESSAGE_PATTERNS = [
  'Cannot redefine property: ethereum',
  'Cannot set property chainId of #<r> which has only a getter',
  "WebSocket connection to 'ws://localhost:8081/' failed",
  'Failed to load resource: net::ERR_FILE_NOT_FOUND',
  'Failed to load resource: net::ERR_FAILED'
]

const NOISE_STACK_PATTERNS = [
  'chrome-extension://',
  'inpage.js',
  'evmAsk.js',
  'refresh.js',
  'ws://localhost:8081/'
]

function asText(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.message}\n${value.stack || ''}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function containsAny(input: string, patterns: string[]): boolean {
  return patterns.some(pattern => input.includes(pattern))
}

function isExtensionNoise(message: string, stack: string): boolean {
  return containsAny(message, NOISE_MESSAGE_PATTERNS) || containsAny(stack, NOISE_STACK_PATTERNS)
}

export function installGlobalNoiseFilter() {
  if (typeof window === 'undefined') return

  window.addEventListener(
    'error',
    event => {
      const message = asText(event.message)
      const target = event.target as { src?: string; href?: string } | null
      const targetRef = target?.src || target?.href || ''
      const stack = `${asText(event.error)}\n${asText(event.filename)}\n${targetRef}`
      if (!isExtensionNoise(message, stack)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      logInfo('ignore_extension_noise:error', { message, stack, targetRef })
    },
    true
  )

  window.addEventListener('unhandledrejection', event => {
    const reasonText = asText(event.reason)
    const reasonMessage =
      event.reason && typeof event.reason === 'object' ? asText((event.reason as { message?: unknown }).message) : ''
    const reasonStack =
      event.reason && typeof event.reason === 'object' ? asText((event.reason as { stack?: unknown }).stack) : ''
    const stack = `${reasonMessage}\n${reasonStack}`
    if (!isExtensionNoise(reasonText, stack)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    logInfo('ignore_extension_noise:unhandledrejection', { reason: reasonText })
  })
}
