#!/usr/bin/env node
const { runOnce } = require('./src/pipeline')
const { runRegression } = require('./src/regression')
const { diagnose } = require('./src/doctor')
const {
  runInSession,
  getSessionView,
  switchTopic,
  createSessionTopic,
  listSessionConversations
} = require('./src/session-pipeline')
const { runSessionSmoke } = require('./src/session-smoke')
const { runCreatePreflight } = require('./src/create-preflight')

function getArgValue(flag, fallback = '') {
  const idx = process.argv.indexOf(flag)
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback
  return process.argv[idx + 1]
}

function hasFlag(flag) {
  return process.argv.includes(flag)
}

function printHelp() {
  console.log('Coze automation CLI')
  console.log('Usage:')
  console.log('  node coze/cli.js run --message "请帮我给书法打分"')
  console.log('  node coze/cli.js regress')
  console.log('  node coze/cli.js check')
  console.log('  node coze/cli.js doctor')
  console.log('  node coze/cli.js session-send --message "..." [--conversationId conv_x] [--topicId topic_x] [--newTopic] [--topicTitle "..."] [--previousWorkflowId wf_x] [--workflowAction auto|continue|switch]')
  console.log('  node coze/cli.js session-view --conversationId conv_x')
  console.log('  node coze/cli.js session-topic-new --conversationId conv_x --topicTitle "..."')
  console.log('  node coze/cli.js session-switch --conversationId conv_x --topicId topic_x')
  console.log('  node coze/cli.js session-conversations')
  console.log('  node coze/cli.js session-smoke')
  console.log('  node coze/cli.js create-preflight')
}

async function main() {
  const cmd = process.argv[2]

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp()
    return
  }

  if (cmd === 'run') {
    const message = getArgValue('--message', '你好')
    const out = await runOnce(message)
    console.log(JSON.stringify(out, null, 2))
    return
  }

  if (cmd === 'regress') {
    const out = await runRegression()
    console.log(JSON.stringify(out, null, 2))
    if (out.fail > 0) {
      process.exitCode = 1
    }
    return
  }

  if (cmd === 'check') {
    const out = await runOnce('可以帮我对书法练习打分吗')
    const ok = Boolean(out.route && out.workflowId && out.traceId && out.processingFlow)
    console.log(JSON.stringify({ ok, route: out.route, workflowId: out.workflowId, traceId: out.traceId }, null, 2))
    if (!ok) process.exitCode = 1
    return
  }

  if (cmd === 'doctor') {
    const out = diagnose()
    console.log(JSON.stringify(out, null, 2))
    if (!out.ok) process.exitCode = 1
    return
  }

  if (cmd === 'session-send') {
    const message = getArgValue('--message', '')
    const conversationId = getArgValue('--conversationId', '')
    const topicId = getArgValue('--topicId', '')
    const topicTitle = getArgValue('--topicTitle', '')
    const previousWorkflowId = getArgValue('--previousWorkflowId', '')
    const workflowAction = getArgValue('--workflowAction', 'auto')
    const newTopic = hasFlag('--newTopic')
    const out = await runInSession({
      message,
      conversationId,
      topicId,
      newTopic,
      topicTitle,
      previousWorkflowId,
      workflowAction
    })
    console.log(JSON.stringify(out, null, 2))
    return
  }

  if (cmd === 'session-view') {
    const conversationId = getArgValue('--conversationId', '')
    if (!conversationId) throw new Error('conversationId is required')
    const out = getSessionView(conversationId)
    console.log(JSON.stringify(out, null, 2))
    return
  }

  if (cmd === 'session-topic-new') {
    const conversationId = getArgValue('--conversationId', '')
    const topicTitle = getArgValue('--topicTitle', '')
    if (!conversationId) throw new Error('conversationId is required')
    const out = createSessionTopic(conversationId, topicTitle)
    console.log(JSON.stringify(out, null, 2))
    return
  }

  if (cmd === 'session-switch') {
    const conversationId = getArgValue('--conversationId', '')
    const topicId = getArgValue('--topicId', '')
    if (!conversationId || !topicId) throw new Error('conversationId and topicId are required')
    const out = switchTopic(conversationId, topicId)
    console.log(JSON.stringify(out, null, 2))
    return
  }

  if (cmd === 'session-conversations') {
    const out = listSessionConversations()
    console.log(JSON.stringify(out, null, 2))
    return
  }

  if (cmd === 'session-smoke') {
    const out = await runSessionSmoke()
    console.log(JSON.stringify(out, null, 2))
    if (!out.ok) process.exitCode = 1
    return
  }

  if (cmd === 'create-preflight') {
    const out = await runCreatePreflight()
    console.log(JSON.stringify(out, null, 2))
    if (!out.ok) process.exitCode = 1
    return
  }

  printHelp()
  process.exitCode = 1
}

main().catch((err) => {
  console.error('CLI failed:', err.message)
  process.exit(1)
})
