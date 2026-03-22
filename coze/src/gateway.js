const { executeLocal } = require('./executors/local')
const { executeCoze } = require('./executors/coze')

async function executeWorkflow(workflow, message) {
  if (workflow.provider === 'local') {
    return executeLocal(workflow, message)
  }
  if (workflow.provider === 'coze') {
    return executeCoze(workflow, message)
  }
  return {
    degraded: true,
    degradedReason: 'UNKNOWN_PROVIDER',
    answer: `降级回复：未识别的 provider=${workflow.provider}`,
    structuredData: null
  }
}

module.exports = {
  executeWorkflow
}
