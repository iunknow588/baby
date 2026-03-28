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

show_help() {
  cat <<'EOF'
验证/测试脚本（run_pipeline_verify）

用法:
  ./run_pipeline_verify.sh --with-real-pipeline
  ./run_pipeline_verify.sh --with-preprocess-test
  ./run_pipeline_verify.sh --with-segment-test
  ./run_pipeline_verify.sh --with-score-test
  ./run_pipeline_verify.sh --all
  ./run_pipeline_verify.sh --cases 1,4 --max-step 3
  ./run_pipeline_verify.sh --real-only --cases 1,4
  ./run_pipeline_verify.sh --preprocess-only
  ./run_pipeline_verify.sh --segment-only
  ./run_pipeline_verify.sh --score-only

说明:
  - 所有测试、回归测试、高级参数都在本脚本中显式控制
  - 不带任务参数时不会自动执行任何测试
  - 如果只传入 --cases / --max-step，则默认执行真实流水线

显式任务参数:
  --with-real-pipeline      执行真实图片流水线
  --with-preprocess-test    执行 00_预处理插件 外框/顶边回归测试
  --with-segment-test       执行 05_切分插件 单元测试
  --with-score-test         执行 07_评分插件 单元测试
  --all                     执行预处理回归 + 切分单测 + 评分单测 + 真实流水线

兼容任务参数:
  --real-only               只执行真实图片流水线
  --preprocess-only         只执行 00_预处理插件 外框/顶边回归测试
  --segment-only            只执行 05_切分插件 单元测试
  --score-only              只执行 07_评分插件 单元测试

高级流水线参数:
  --cases 1,4               仅执行指定真实样本
  --max-step N              仅对真实流水线生效，N 必须为 1-7

环境要求:
  - npm
  - node
  - python3
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREPROCESS_PLUGIN_DIR="$SCRIPT_DIR/00_预处理插件"
SEGMENT_PLUGIN_DIR="$SCRIPT_DIR/05_切分插件"
REAL_PLUGIN_DIR="$SCRIPT_DIR/07_评分插件"

RUN_PREPROCESS_TEST="false"
RUN_SEGMENT_TEST="false"
RUN_SCORE_TEST="false"
RUN_REAL_PIPELINE="false"
PIPELINE_MAX_STEP=""
PIPELINE_CASES=""
TASK_FLAG_SEEN="false"

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

run_preprocess_test() {
  if [ ! -d "$PREPROCESS_PLUGIN_DIR" ]; then
    log_error "找不到目录: $PREPROCESS_PLUGIN_DIR"
    exit 1
  fi

  log_section "步骤 1: 执行 00_预处理插件 外框/顶边回归测试"
  (
    cd "$PREPROCESS_PLUGIN_DIR"
    node test_outer_frame_regression.js
  )
}

run_segment_test() {
  if [ ! -d "$SEGMENT_PLUGIN_DIR" ]; then
    log_error "找不到目录: $SEGMENT_PLUGIN_DIR"
    exit 1
  fi

  log_section "步骤 2: 执行 05_切分插件 单元测试"
  (
    cd "$SEGMENT_PLUGIN_DIR"
    npm test
  )
}

run_score_test() {
  if [ ! -d "$REAL_PLUGIN_DIR" ]; then
    log_error "找不到目录: $REAL_PLUGIN_DIR"
    exit 1
  fi

  log_section "步骤 3: 执行 07_评分插件 单元测试"
  (
    cd "$REAL_PLUGIN_DIR"
    npm test
  )
}

run_real_pipeline() {
  if [ ! -d "$REAL_PLUGIN_DIR" ]; then
    log_error "找不到目录: $REAL_PLUGIN_DIR"
    exit 1
  fi

  log_section "步骤 4: 执行 07_评分插件 真实图片流水线"
  if [ -n "$PIPELINE_MAX_STEP" ]; then
    log_info "最大执行阶段: $PIPELINE_MAX_STEP"
  fi
  if [ -n "$PIPELINE_CASES" ]; then
    log_info "执行样本: $PIPELINE_CASES"
  fi

  (
    cd "$REAL_PLUGIN_DIR"
    if [ -n "$PIPELINE_MAX_STEP" ] && [ -n "$PIPELINE_CASES" ]; then
      PIPELINE_MAX_STEP="$PIPELINE_MAX_STEP" PIPELINE_CASES="$PIPELINE_CASES" npm run test:real
    elif [ -n "$PIPELINE_MAX_STEP" ]; then
      PIPELINE_MAX_STEP="$PIPELINE_MAX_STEP" npm run test:real
    elif [ -n "$PIPELINE_CASES" ]; then
      PIPELINE_CASES="$PIPELINE_CASES" npm run test:real
    else
      npm run test:real
    fi
  )
}

if [ "$#" -eq 0 ]; then
  show_help
  exit 0
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-real-pipeline)
      TASK_FLAG_SEEN="true"
      RUN_REAL_PIPELINE="true"
      ;;
    --with-preprocess-test)
      TASK_FLAG_SEEN="true"
      RUN_PREPROCESS_TEST="true"
      ;;
    --with-segment-test)
      TASK_FLAG_SEEN="true"
      RUN_SEGMENT_TEST="true"
      ;;
    --with-score-test)
      TASK_FLAG_SEEN="true"
      RUN_SCORE_TEST="true"
      ;;
    --all)
      TASK_FLAG_SEEN="true"
      RUN_PREPROCESS_TEST="true"
      RUN_SEGMENT_TEST="true"
      RUN_SCORE_TEST="true"
      RUN_REAL_PIPELINE="true"
      ;;
    --real-only)
      TASK_FLAG_SEEN="true"
      RUN_PREPROCESS_TEST="false"
      RUN_SEGMENT_TEST="false"
      RUN_SCORE_TEST="false"
      RUN_REAL_PIPELINE="true"
      ;;
    --preprocess-only)
      TASK_FLAG_SEEN="true"
      RUN_PREPROCESS_TEST="true"
      RUN_SEGMENT_TEST="false"
      RUN_SCORE_TEST="false"
      RUN_REAL_PIPELINE="false"
      ;;
    --segment-only)
      TASK_FLAG_SEEN="true"
      RUN_PREPROCESS_TEST="false"
      RUN_SEGMENT_TEST="true"
      RUN_SCORE_TEST="false"
      RUN_REAL_PIPELINE="false"
      ;;
    --score-only)
      TASK_FLAG_SEEN="true"
      RUN_PREPROCESS_TEST="false"
      RUN_SEGMENT_TEST="false"
      RUN_SCORE_TEST="true"
      RUN_REAL_PIPELINE="false"
      ;;
    --cases)
      shift
      if [ -z "${1:-}" ]; then
        log_error "--cases 需要一个参数，例如 1,4"
        exit 1
      fi
      PIPELINE_CASES="$1"
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

if [ "$TASK_FLAG_SEEN" != "true" ] && { [ -n "$PIPELINE_MAX_STEP" ] || [ -n "$PIPELINE_CASES" ]; }; then
  RUN_REAL_PIPELINE="true"
fi

if [ "$RUN_PREPROCESS_TEST" != "true" ] && [ "$RUN_SEGMENT_TEST" != "true" ] && [ "$RUN_SCORE_TEST" != "true" ] && [ "$RUN_REAL_PIPELINE" != "true" ]; then
  log_error "没有可执行的任务，请显式指定测试或流水线参数。"
  show_help
  exit 1
fi

ensure_command "npm"
ensure_command "node"
ensure_command "python3"

log_section "验证/测试入口"
log_info "脚本目录: $SCRIPT_DIR"
log_info "执行预处理回归: $RUN_PREPROCESS_TEST"
log_info "执行切分单测: $RUN_SEGMENT_TEST"
log_info "执行评分单测: $RUN_SCORE_TEST"
log_info "执行真实流水线: $RUN_REAL_PIPELINE"
if [ -n "$PIPELINE_MAX_STEP" ]; then
  log_info "真实流水线上限阶段: $PIPELINE_MAX_STEP"
fi
if [ -n "$PIPELINE_CASES" ]; then
  log_info "真实流水线样本: $PIPELINE_CASES"
fi

if [ "$RUN_PREPROCESS_TEST" = "true" ]; then
  run_preprocess_test
fi

if [ "$RUN_SEGMENT_TEST" = "true" ]; then
  run_segment_test
fi

if [ "$RUN_SCORE_TEST" = "true" ]; then
  run_score_test
fi

if [ "$RUN_REAL_PIPELINE" = "true" ]; then
  run_real_pipeline
fi

log_section "执行完成"
log_info "所有已选步骤执行完成"
