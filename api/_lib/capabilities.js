import { cozeComplete } from './coze.js'

function resolveInputText(inputEnvelope) {
  if (!inputEnvelope || typeof inputEnvelope !== 'object') return ''
  if (typeof inputEnvelope.text === 'string') return inputEnvelope.text.trim()
  if (typeof inputEnvelope.content === 'string') return inputEnvelope.content.trim()
  return ''
}

async function runGenericAssistant(inputEnvelope, context) {
  const text = resolveInputText(inputEnvelope)
  if (!text) {
    const error = new Error('inputEnvelope.text is required')
    error.code = 'CAPABILITY_INPUT_INVALID'
    error.status = 400
    throw error
  }

  const result = await cozeComplete({ message: text })
  return {
    type: 'text',
    content: result.answer || '',
    conversationId: result.conversationId || context.conversationId || ''
  }
}

async function runEduLite(inputEnvelope) {
  const text = resolveInputText(inputEnvelope)
  return {
    type: 'text',
    content: text
      ? `我先帮你梳理这段内容：${text.slice(0, 80)}。接下来我会给你一个变式小问题。`
      : '请先输入题目或学习内容，我会进行简要讲解并给出练习。'
  }
}

const CAPABILITY_REGISTRY = {
  'generic-assistant': runGenericAssistant,
  'edu-lite': runEduLite
}

export function listCapabilities() {
  return Object.keys(CAPABILITY_REGISTRY)
}

export async function runCapability(capabilityKey, inputEnvelope, context = {}) {
  const handler = CAPABILITY_REGISTRY[capabilityKey]
  if (!handler) {
    const error = new Error(`capability not bound: ${capabilityKey}`)
    error.code = 'CAPABILITY_NOT_BOUND'
    error.status = 400
    throw error
  }
  return handler(inputEnvelope, context)
}
