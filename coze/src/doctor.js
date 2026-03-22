const { loadRegistry } = require('./registry')
const { getCozeEnv, hasCozeEnv } = require('./executors/coze')

function diagnose() {
  let registryOk = false
  let registryError = ''
  try {
    loadRegistry()
    registryOk = true
  } catch (error) {
    registryError = error instanceof Error ? error.message : String(error)
  }

  const env = getCozeEnv()
  const cozeEnv = {
    COZE_API_BASE_URL: Boolean(env.apiBaseUrl),
    COZE_API_TOKEN: Boolean(env.apiToken),
    COZE_BOT_ID: Boolean(env.botId),
    ready: hasCozeEnv()
  }

  return {
    ok: registryOk,
    registryOk,
    registryError,
    cozeEnv
  }
}

module.exports = {
  diagnose
}

