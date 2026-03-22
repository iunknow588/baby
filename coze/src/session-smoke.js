const { runInSession, getSessionView, switchTopic } = require('./session-pipeline')

async function runSessionSmoke() {
  const first = await runInSession({ message: '请帮我批改作文' })
  const convId = first.conversationId
  const topic1 = first.topicId

  const second = await runInSession({
    conversationId: convId,
    newTopic: true,
    topicTitle: '书法评测',
    message: '请帮我给这份书法练习打分'
  })
  const topic2 = second.topicId

  await switchTopic(convId, topic1)

  const third = await runInSession({
    conversationId: convId,
    topicId: topic1,
    previousWorkflowId: first.workflowId,
    workflowAction: 'continue',
    message: '请继续上一条作文建议，给出3个改写句子'
  })

  const fourth = await runInSession({
    conversationId: convId,
    topicId: topic1,
    previousWorkflowId: first.workflowId,
    workflowAction: 'switch',
    message: '改为书法评测'
  })

  const view = getSessionView(convId)
  const t1 = view.topics.find((t) => t.id === topic1)
  const t2 = view.topics.find((t) => t.id === topic2)

  const ok = Boolean(
    convId &&
      topic1 &&
      topic2 &&
      topic1 !== topic2 &&
      t1 &&
      t2 &&
      t1.messageCount >= 4 &&
      t2.messageCount >= 2 &&
      third.topicId === topic1 &&
      third.workflowId === first.workflowId &&
      fourth.route === 'calligraphy_scoring'
  )

  return {
    ok,
    conversationId: convId,
    topic1,
    topic2,
    activeTopicId: view.activeTopicId,
    topic1Messages: t1 ? t1.messageCount : 0,
    topic2Messages: t2 ? t2.messageCount : 0,
    detail: {
      first,
      second,
      third,
      fourth
    }
  }
}

module.exports = {
  runSessionSmoke
}
