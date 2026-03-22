#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env.local"
PROBE_SCRIPT="$PROJECT_ROOT/coze/scripts/cozeloop_probe.py"

if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] python3 未安装，无法执行 CozeLoop 探测。"
  exit 1
fi

if [ ! -f "$PROBE_SCRIPT" ]; then
  echo "[ERROR] 缺少探测脚本: $PROBE_SCRIPT"
  exit 1
fi

echo "[INFO] CozeLoop JWT + API 连通探测"
python3 "$PROBE_SCRIPT" "$@"
