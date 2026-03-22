# Baby Coze 自动化开发骨架

该目录用于实现“后台智能体与工作流自动化开发/调试”的最小可运行版本。

## 1. 当前能力
1. 工作流注册中心：`registry/workflows.json`
2. 自动路由：按关键词路由到 `general_chat/calligraphy_scoring/essay_scoring/psych_support`
3. 规划与执行：输出 `processingFlow + executionType + interactionMode + traceId`
4. 执行网关：支持 `local` 与 `coze` provider（Coze 当前为安全降级模拟）
5. 回归检查：`regression/cases.json`

## 2. 目录结构
- `cli.js`：命令行入口
- `src/`：核心模块（registry/router/planner/gateway/pipeline/regression）
- `registry/workflows.json`：流程配置
- `regression/cases.json`：回归样例

## 3. 使用方法
```bash
# 单条执行
node /home/lc/luckee_dao/baby/coze/cli.js run --message "可以帮我给书法作业打分吗"

# 回归测试
node /home/lc/luckee_dao/baby/coze/cli.js regress

# 健康检查
node /home/lc/luckee_dao/baby/coze/cli.js check

# 配置体检（registry + COZE_*）
node /home/lc/luckee_dao/baby/coze/cli.js doctor

# 会话模式：发送（自动创建 conversation/topic）
node /home/lc/luckee_dao/baby/coze/cli.js session-send --message "请帮我批改作文"

# 会话模式：新建话题并发送
node /home/lc/luckee_dao/baby/coze/cli.js session-send --conversationId conv_xxx --newTopic --topicTitle "数学作业" --message "这道题怎么做"

# 会话模式：继续上次工作流（显式传 previousWorkflowId）
node /home/lc/luckee_dao/baby/coze/cli.js session-send --conversationId conv_xxx --topicId topic_xxx --previousWorkflowId wf_essay_scoring_v1 --workflowAction continue --message "继续上一段作文建议"

# 会话模式：强制切换工作流
node /home/lc/luckee_dao/baby/coze/cli.js session-send --conversationId conv_xxx --topicId topic_xxx --previousWorkflowId wf_essay_scoring_v1 --workflowAction switch --message "改为书法打分"

# 会话模式：查看会话内话题
node /home/lc/luckee_dao/baby/coze/cli.js session-view --conversationId conv_xxx

# 会话模式：切换激活话题
node /home/lc/luckee_dao/baby/coze/cli.js session-switch --conversationId conv_xxx --topicId topic_xxx

# 会话模式：查看全部会话
node /home/lc/luckee_dao/baby/coze/cli.js session-conversations
```

## 4. 环境说明
1. `provider=coze` 支持三种执行模式：`BABY_COZE_EXEC_MODE=auto|real|mock`（默认 `auto`）。
2. 缺少 `COZE_API_BASE_URL/COZE_API_TOKEN/COZE_BOT_ID` 时：
- `auto`：自动降级为 mock；
- `real`：尝试 real 但会降级并给出原因；
- `mock`：始终使用 mock。
3. 部署前可运行：`/home/lc/luckee_dao/baby/scripts/coze_gate.sh`

## 5. conversationId + topicId 约束
1. `conversationId`：会话容器，承载多个话题。
2. `topicId`：会话内单个话题上下文，消息严格按 topic 隔离。
3. 运行时文件：`/home/lc/luckee_dao/baby/coze/runtime/state.json`。

## 5. 文档
1. [可行性分析_v0.0.1](./可行性分析_v0.0.1.md)
2. [控制程序架构设计_v0.0.1](./控制程序架构设计_v0.0.1.md)
3. [实施计划_v0.0.1](./实施计划_v0.0.1.md)
