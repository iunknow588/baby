#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env.local"
SYNC_SCRIPT="$PROJECT_ROOT/coze/scripts/sync_workflows_to_coze.py"

if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] python3 未安装，无法执行 Coze 同步检查。"
  exit 1
fi

if [ ! -f "$SYNC_SCRIPT" ]; then
  echo "[ERROR] 缺少脚本: $SYNC_SCRIPT"
  exit 1
fi

echo "[INFO] Coze 绑定同步检查（registry -> CozeLoop）"
python3 "$SYNC_SCRIPT" "$@"
