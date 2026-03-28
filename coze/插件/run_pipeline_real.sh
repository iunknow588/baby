#!/bin/bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

log_section() {
  echo ""
  echo -e "${CYAN}════════════════════════════════════${NC}"
  echo -e "${CYAN}$1${NC}"
  echo -e "${CYAN}════════════════════════════════════${NC}"
  echo ""
}

ensure_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log_error "缺少命令: $cmd"
    exit 1
  fi
}

show_help() {
  cat <<'EOF'
默认真实流水线脚本（run_pipeline_real）

用法:
  ./run_pipeline_real.sh

说明:
  - 这是默认、最简、最常用模式
  - 不执行任何回归测试或单元测试
  - 只执行 07_评分插件 真实图片流水线

如果需要:
  - 回归测试
  - 单元测试
  - 指定样本
  - 指定最大阶段

请改用:
  ./run_pipeline_verify.sh --help
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_PLUGIN_DIR="$SCRIPT_DIR/07_评分插件"

if [ "$#" -gt 0 ]; then
  case "$1" in
    -h|--help|help)
      show_help
      exit 0
      ;;
    *)
      log_error "默认真实流水线脚本不接受参数: $1"
      log_info "如需测试或高级参数，请使用: $SCRIPT_DIR/run_pipeline_verify.sh --help"
      exit 1
      ;;
  esac
fi

ensure_command "npm"
ensure_command "node"
ensure_command "python3"

if [ ! -d "$REAL_PLUGIN_DIR" ]; then
  log_error "找不到目录: $REAL_PLUGIN_DIR"
  exit 1
fi

log_section "默认真实流水线"
log_info "脚本目录: $SCRIPT_DIR"
log_info "模式: 默认最简模式"
log_info "执行真实流水线: true"
log_info "执行预处理回归: false"
log_info "执行切分单测: false"
log_info "执行评分单测: false"

log_section "执行真实图片流水线"
(
  cd "$REAL_PLUGIN_DIR"
  npm run test:real
)

log_section "执行完成"
log_info "默认真实流水线执行完成"
