#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_SCRIPT="$SCRIPT_DIR/run_pipeline_real.sh"
VERIFY_SCRIPT="$SCRIPT_DIR/run_pipeline_verify.sh"

show_help() {
  cat <<'EOF'
Coze 插件统一流水线路由脚本（run_pipeline）

用法:
  ./run_pipeline.sh
  ./run_pipeline.sh [验证参数...]
  ./run_pipeline.sh --help

路由规则:
  - 不带参数:
      执行最简、最常用模式，只跑真实图片流水线
  - 带参数:
      自动转到验证/测试脚本，由显式参数决定执行哪些测试或高级流水线选项

对应脚本:
  - 默认真实流水线脚本:
      ./run_pipeline_real.sh
  - 验证/测试脚本:
      ./run_pipeline_verify.sh

常见示例:
  ./run_pipeline.sh
  ./run_pipeline.sh --with-preprocess-test
  ./run_pipeline.sh --with-segment-test
  ./run_pipeline.sh --with-score-test
  ./run_pipeline.sh --all
  ./run_pipeline.sh --cases 1,4 --max-step 3

更多验证参数:
  ./run_pipeline_verify.sh --help
EOF
}

if [ ! -f "$REAL_SCRIPT" ]; then
  echo "[ERROR] 找不到默认真实流水线脚本: $REAL_SCRIPT" >&2
  exit 1
fi

if [ ! -f "$VERIFY_SCRIPT" ]; then
  echo "[ERROR] 找不到验证/测试脚本: $VERIFY_SCRIPT" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  exec "$REAL_SCRIPT"
fi

case "$1" in
  -h|--help|help)
    show_help
    exit 0
    ;;
  *)
    exec "$VERIFY_SCRIPT" "$@"
    ;;
esac
