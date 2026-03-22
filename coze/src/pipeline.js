const { loadRegistry, findWorkflowByRoute, findWorkflowById } = require('./registry')
const { resolveRouteDecision } = require('./router')
const { buildPlan } = require('./planner')
const { executeWorkflow } = require('./gateway')
const { nowIso, newTraceId } = require('./utils')

function normalizeInput(input) {
  if (typeof input === 'string') {
    return {
      message: input,
      previousWorkflowId: '',
      workflowAction: 'auto'
    }
  }
  return {
    message: typeof input?.message === 'string' ? input.message : '',
    previousWorkflowId: typeof input?.previousWorkflowId === 'string' ? input.previousWorkflowId.trim() : '',
    workflowAction: typeof input?.workflowAction === 'string' ? input.workflowAction : 'auto'
  }
}

async function runOnce(input) {
  const normalized = normalizeInput(input)
  const registry = loadRegistry()
  const previousWorkflow = findWorkflowById(registry, normalized.previousWorkflowId)
  const routeDecision = resolveRouteDecision({
    message: normalized.message,
    registry,
    previousWorkflow,
    workflowAction: normalized.workflowAction
  })
  const route = routeDecision.route
  const workflow = findWorkflowByRoute(registry, route)
  if (!workflow) {
    throw new Error(`route not found in registry: ${route}`)
  }

  const processingFlow = buildPlan(workflow, normalized.message)
  processingFlow.routeDecision = {
    reason: routeDecision.reason,
    usedPreviousWorkflow: routeDecision.usedPreviousWorkflow,
    previousWorkflowId: normalized.previousWorkflowId || '',
    workflowAction: normalized.workflowAction || 'auto'
  }
  const interactionMode = workflow.interactionMode === 'flow_first' ? 'flow_first' : 'direct'
  const executionType =
    workflow.executionType === 'requires_user_interaction' ? 'requires_user_interaction' : 'direct_reply'
  const startedAt = Date.now()
  const exec = await executeWorkflow(workflow, normalized.message)

  return {
    answer: exec.answer,
    structuredData: exec.structuredData || null,
    executionType,
    interactionMode,
    processingFlow,
    route,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    previousWorkflowId: normalized.previousWorkflowId || '',
    workflowAction: normalized.workflowAction || 'auto',
    traceId: newTraceId(),
    degraded: Boolean(exec.degraded),
    degradedReason: exec.degradedReason || '',
    timing: {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: nowIso(),
      elapsedMs: Math.max(0, Date.now() - startedAt)
    }
  }
}

module.exports = {
  runOnce
}
