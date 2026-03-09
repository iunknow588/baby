#!/bin/bash

# v0.0.2 分组提交执行脚本
# 默认行为：仅展示将要执行的命令，不自动提交。
# 使用方法：
#   ./scripts/commit_plan_v0.0.2.sh show
#   ./scripts/commit_plan_v0.0.2.sh exec

set -euo pipefail

MODE="${1:-show}"
ROOT="/home/lc/luckee_dao/baby"
DOCS_ROOT="/home/lc/luckee_dao/works-docs"

if [[ "$MODE" != "show" && "$MODE" != "exec" ]]; then
  echo "Usage: $0 [show|exec]"
  exit 1
fi

run() {
  if [[ "$MODE" == "show" ]]; then
    echo "+ $*"
  else
    eval "$@"
  fi
}

cat <<'BANNER'
========================================
Baby v0.0.2 Commit Plan
========================================
BANNER

echo "Mode: $MODE"

echo "\n[Group A] feat(api): platform routes + realtime + capabilities"
run "cd $ROOT"
run "git add \\
  api/_lib/capabilities.js \\
  api/_lib/platform-chat.js \\
  api/_lib/supabase.js \\
  api/chat/sessions.js \\
  api/chat/stream.js \\
  api/social/contacts.js \\
  api/social/friend-requests.js \\
  api/social/friend-requests/[requestId]/accept.js \\
  api/social/friend-requests/[requestId]/reject.js \\
  api/v1/assets/upload.js \\
  api/v1/capabilities/execute.js \\
  api/v1/conversations.js \\
  api/v1/conversations/[conversationId]/messages.js \\
  api/v1/groups.js \\
  api/v1/groups/[groupId]/members.js \\
  api/v1/groups/[groupId]/members/[memberId].js \\
  api/voice/asr.js \\
  api/voice/tts.js \\
  api/voice/upload.js \\
  supabase/migrations/20260309_platform_refactor_schema.sql"
run "git commit -m 'feat(api): add v1 platform routes realtime stream and capability registry'"

echo "\n[Group B] refactor(app): conversation/session chat flow"
run "cd $ROOT"
run "git add \\
  app/src/services/api/chat.api.ts \\
  app/src/services/realtime/sseClient.ts \\
  app/src/stores/chat.ts \\
  app/src/services/api/__tests__/chat.api.test.ts \\
  app/src/stores/__tests__/chat.store.test.ts"
run "git commit -m 'refactor(app): align chat flow with conversation session model'"

echo "\n[Group C] chore(scripts): smoke gates + local gate + strict probe"
run "cd $ROOT"
run "git add \\
  scripts/deploy.sh \\
  scripts/check_remote_backend.sh \\
  scripts/gate_local.sh \\
  scripts/run_local.sh \\
  scripts/smoke_realtime.sh \\
  scripts/smoke_platform.sh \\
  scripts/README.md"
run "git commit -m 'chore(scripts): add smoke gates local gate and strict probe mode'"

echo "\n[Group D] docs(api/checklist): sync docs and release artifacts"
run "cd $ROOT"
run "git add api/README.md"
run "git commit -m 'docs(api): sync routes migration notes and deprecation policy'"

run "cd $DOCS_ROOT"
run "git add \\
  baby/check_list/readme.md \\
  baby/check_list/系统重构开发计划_v0.0.2.md \\
  baby/check_list/接口对照表_v0.0.2.md \\
  baby/check_list/遗留目录处理策略_v0.0.2.md \\
  baby/check_list/测试与门禁报告_v0.0.2.md \\
  baby/check_list/迁移与回滚说明_v0.0.2.md \\
  baby/check_list/发布说明_v0.0.2.md \\
  baby/check_list/提交分组建议_v0.0.2.md \\
  baby/check_list/提交执行清单_v0.0.2.md"
run "git commit -m 'docs(checklist): finalize v0.0.2 delivery package'"

echo "\n[Manual Review Required]"
echo "These files are intentionally excluded and require manual decision:"
echo "  - $ROOT/app/src/pages/ChatPage.vue"
echo "  - $ROOT/app/vite.config.ts"
echo "  - $ROOT/scripts/deploy_vercel.sh"

echo "\nDone."
