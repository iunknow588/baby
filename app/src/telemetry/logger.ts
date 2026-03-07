export function logInfo(event: string, payload?: unknown) {
  console.info(`[baby] ${event}`, payload)
}

export function logError(event: string, payload?: unknown) {
  console.error(`[baby] ${event}`, payload)
}
