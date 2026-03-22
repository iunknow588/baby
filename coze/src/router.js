function detectRoute(message, registry) {
  const text = `${message || ''}`.toLowerCase()

  for (const wf of registry.workflows) {
    if (!Array.isArray(wf.keywords) || wf.keywords.length === 0) continue
    for (const kw of wf.keywords) {
      if (text.includes(String(kw).toLowerCase())) {
        return wf.route
      }
    }
  }

  return registry.defaultRoute
}

function normalizeWorkflowAction(raw) {
  const action = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (action === 'continue' || action === 'switch' || action === 'auto') return action
  return 'auto'
}

function canPreviousWorkflowHandleMessage(previousWorkflow, message, registry) {
  if (!previousWorkflow) return false
  const text = `${message || ''}`.trim().toLowerCase()
  if (!text) return true
  if (previousWorkflow.route === registry.defaultRoute) return true

  const keywords = Array.isArray(previousWorkflow.keywords) ? previousWorkflow.keywords : []
  if (keywords.length === 0) return false
  return keywords.some((kw) => text.includes(String(kw).toLowerCase()))
}

function resolveRouteDecision({ message, registry, previousWorkflow, workflowAction }) {
  const action = normalizeWorkflowAction(workflowAction)
  const detected = detectRoute(message, registry)

  if ((action === 'auto' || action === 'continue') && previousWorkflow) {
    const canHandle = canPreviousWorkflowHandleMessage(previousWorkflow, message, registry)
    if (canHandle) {
      return {
        route: previousWorkflow.route,
        reason:
          action === 'continue'
            ? 'workflowAction=continue 且原工作流可处理，继续 previousWorkflowId'
            : 'workflowAction=auto 且原工作流可处理当前文本，继续 previousWorkflowId',
        usedPreviousWorkflow: true
      }
    }
    return {
      route: detected,
      reason:
        action === 'continue'
          ? 'workflowAction=continue 但原工作流不可处理，自动切换最合适新工作流'
          : 'workflowAction=auto 且原工作流不可处理，选择最合适新工作流',
      usedPreviousWorkflow: false
    }
  }

  return {
    route: detected,
    reason: action === 'switch' ? 'workflowAction=switch，按当前输入重新路由' : '按当前输入路由',
    usedPreviousWorkflow: false
  }
}

module.exports = {
  detectRoute,
  resolveRouteDecision
}
