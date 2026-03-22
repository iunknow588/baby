#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env.local"
COZE_CLI="$PROJECT_ROOT/coze/cli.js"

if [ ! -f "$COZE_CLI" ]; then
  echo "[ERROR] 缺少 coze CLI: $COZE_CLI"
  exit 1
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

echo "[INFO] Coze Gate: 配置体检"
node "$COZE_CLI" doctor

echo "[INFO] Coze Gate: 协议检查"
node "$COZE_CLI" check

echo "[INFO] Coze Gate: 回归检查"
node "$COZE_CLI" regress

echo "[INFO] Coze Gate: 会话隔离冒烟（conversationId + topicId）"
node "$COZE_CLI" session-smoke

echo "[INFO] Coze Gate: 全部通过"
