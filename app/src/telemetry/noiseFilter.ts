import { logInfo } from './logger'

const NOISE_MESSAGE_PATTERNS = [
  'Cannot redefine property: ethereum',
  'Cannot set property chainId of #<r> which has only a getter'
]

const NOISE_STACK_PATTERNS = ['chrome-extension://', 'inpage.js', 'evmAsk.js', 'refresh.js']

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
      const stack = `${asText(event.error)}\n${asText(event.filename)}`
      if (!isExtensionNoise(message, stack)) return
      event.preventDefault()
      logInfo('ignore_extension_noise:error', { message, stack })
    },
    true
  )

  window.addEventListener('unhandledrejection', event => {
    const reasonText = asText(event.reason)
    const stack = event.reason instanceof Error ? asText(event.reason.stack) : ''
    if (!isExtensionNoise(reasonText, stack)) return
    event.preventDefault()
    logInfo('ignore_extension_noise:unhandledrejection', { reason: reasonText })
  })
}
