export function trackMetric(name: string, value = 1, tags: Record<string, string> = {}) {
  console.debug('[metric]', { name, value, tags })
}
