const { readJson, rootPath } = require('./utils')
const ALLOWED_EXECUTION_TYPES = new Set(['direct_reply', 'requires_user_interaction'])

function validateRegistry(registry) {
  if (!registry || typeof registry !== 'object') {
    throw new Error('workflow registry is empty')
  }
  if (!Array.isArray(registry.workflows) || registry.workflows.length === 0) {
    throw new Error('workflow registry has no workflows')
  }

  const routeSet = new Set()
  for (const wf of registry.workflows) {
    if (!wf.id || !wf.route || !wf.provider || !wf.version) {
      throw new Error(`invalid workflow item: ${JSON.stringify(wf)}`)
    }
    const executionType = typeof wf.executionType === 'string' ? wf.executionType : ''
    if (!ALLOWED_EXECUTION_TYPES.has(executionType)) {
      throw new Error(`invalid executionType for route ${wf.route}: ${executionType}`)
    }
    if (routeSet.has(wf.route)) {
      throw new Error(`duplicate route in registry: ${wf.route}`)
    }
    routeSet.add(wf.route)
  }

  if (!registry.defaultRoute || !routeSet.has(registry.defaultRoute)) {
    throw new Error('defaultRoute missing or not found in workflows')
  }
}

function loadRegistry() {
  const registryPath = rootPath('registry', 'workflows.json')
  const registry = readJson(registryPath)
  validateRegistry(registry)
  return registry
}

function findWorkflowByRoute(registry, route) {
  return registry.workflows.find((wf) => wf.route === route) || null
}

function findWorkflowById(registry, workflowId) {
  if (!workflowId || typeof workflowId !== 'string') return null
  const id = workflowId.trim()
  if (!id) return null
  return registry.workflows.find((wf) => wf.id === id) || null
}

module.exports = {
  loadRegistry,
  findWorkflowByRoute,
  findWorkflowById
}
