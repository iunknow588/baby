function buildPlan(workflow, message) {
  const base = [
    `识别并确认路由：${workflow.route}`,
    `加载工作流：${workflow.id}@${workflow.version}`,
    '执行能力链路并生成结果'
  ]

  if (workflow.route === 'calligraphy_scoring') {
    base[2] = '分析书写质量并生成评分与改进建议'
  }
  if (workflow.route === 'essay_scoring') {
    base[2] = '分析作文结构、表达和逻辑并给出改写建议'
  }
  if (workflow.route === 'psych_support') {
    base[2] = '进行安全边界内的情绪支持并给出可执行建议'
  }

  return {
    route: workflow.route,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    steps: base,
    nextActions: [
      '如需继续，请补充上下文或上传附件',
      `当前输入摘要：${String(message || '').slice(0, 40)}`
    ]
  }
}

module.exports = {
  buildPlan
}
