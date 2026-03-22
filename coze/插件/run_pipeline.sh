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

log_warn() {
  echo -e "${CYAN}[WARN]${NC} $1"
}

log_section() {
  echo ""
  echo -e "${CYAN}════════════════════════════════════${NC}"
  echo -e "${CYAN}$1${NC}"
  echo -e "${CYAN}════════════════════════════════════${NC}"
  echo ""
}

show_help() {
  cat <<'EOF'
Coze 插件统一流水线脚本（run_pipeline）

用法:
  ./run_pipeline.sh
  ./run_pipeline.sh --real-only
  ./run_pipeline.sh --segment-only
  ./run_pipeline.sh --max-step N
  ./run_pipeline.sh --real-only --max-step N

说明:
  - 默认依次执行:
    1. 05_切分插件 单元测试
    2. 07_评分插件 真实图片流水线测试
  - --real-only 只执行真实图片流水线
  - --segment-only 只执行切分插件单元测试
  - --max-step N 仅对真实图片流水线生效，N 必须为 1-7

环境要求:
  - npm
  - node
  - python3
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEGMENT_PLUGIN_DIR="$SCRIPT_DIR/05_切分插件"
REAL_PLUGIN_DIR="$SCRIPT_DIR/07_评分插件"

RUN_SEGMENT_TEST="true"
RUN_REAL_PIPELINE="true"
PIPELINE_MAX_STEP=""

ensure_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log_error "缺少命令: $cmd"
    exit 1
  fi
}

validate_max_step() {
  local value="$1"
  if ! [[ "$value" =~ ^[1-7]$ ]]; then
    log_error "--max-step 必须是 1-7 的整数，当前为: $value"
    exit 1
  fi
}

run_segment_test() {
  if [ ! -d "$SEGMENT_PLUGIN_DIR" ]; then
    log_error "找不到目录: $SEGMENT_PLUGIN_DIR"
    exit 1
  fi

  log_section "步骤 1: 执行 05_切分插件 单元测试"
  (
    cd "$SEGMENT_PLUGIN_DIR"
    npm test
  )
}

run_real_pipeline() {
  if [ ! -d "$REAL_PLUGIN_DIR" ]; then
    log_error "找不到目录: $REAL_PLUGIN_DIR"
    exit 1
  fi

  log_section "步骤 2: 执行 07_评分插件 真实图片流水线"
  if [ -n "$PIPELINE_MAX_STEP" ]; then
    log_info "最大执行阶段: $PIPELINE_MAX_STEP"
  fi

  (
    cd "$REAL_PLUGIN_DIR"
    if [ -n "$PIPELINE_MAX_STEP" ]; then
      PIPELINE_MAX_STEP="$PIPELINE_MAX_STEP" npm run test:real
    else
      npm run test:real
    fi
  )
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --real-only)
      RUN_SEGMENT_TEST="false"
      RUN_REAL_PIPELINE="true"
      ;;
    --segment-only)
      RUN_SEGMENT_TEST="true"
      RUN_REAL_PIPELINE="false"
      ;;
    --max-step)
      shift
      if [ -z "${1:-}" ]; then
        log_error "--max-step 需要一个参数"
        exit 1
      fi
      validate_max_step "$1"
      PIPELINE_MAX_STEP="$1"
      ;;
    -h|--help|help)
      show_help
      exit 0
      ;;
    *)
      log_error "不支持的参数: $1"
      show_help
      exit 1
      ;;
  esac
  shift
done

ensure_command "npm"
ensure_command "node"
ensure_command "python3"

if [ "$RUN_SEGMENT_TEST" != "true" ] && [ "$RUN_REAL_PIPELINE" != "true" ]; then
  log_error "没有可执行的任务，请检查参数。"
  exit 1
fi

log_section "流水线入口"
log_info "脚本目录: $SCRIPT_DIR"
log_info "执行切分单测: $RUN_SEGMENT_TEST"
log_info "执行真实流水线: $RUN_REAL_PIPELINE"
if [ -n "$PIPELINE_MAX_STEP" ]; then
  log_info "真实流水线上限阶段: $PIPELINE_MAX_STEP"
fi

if [ "$RUN_SEGMENT_TEST" = "true" ]; then
  run_segment_test
fi

if [ "$RUN_REAL_PIPELINE" = "true" ]; then
  run_real_pipeline
fi

log_section "执行完成"
log_info "所有已选步骤执行完成"
