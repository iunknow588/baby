#!/bin/bash

# Baby 项目一键部署脚本
# 默认流程：测试 -> 构建 -> GitHub
# 可选流程：Vercel 部署

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

log_section() {
  echo ""
  echo -e "${BLUE}========================================${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}========================================${NC}"
  echo ""
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$PROJECT_ROOT/app"

cd "$PROJECT_ROOT"

ENVIRONMENT="${1:-production}"
COMMIT_MSG="${2:-}"

BABY_RUN_TEST="${BABY_RUN_TEST:-true}"
BABY_RUN_BUILD="${BABY_RUN_BUILD:-true}"
BABY_DEPLOY_VERCEL="${BABY_DEPLOY_VERCEL:-false}"

log_section "Baby 项目一键部署"
log_info "项目路径: $PROJECT_ROOT"
log_info "前端目录: $APP_DIR"
log_info "环境: $ENVIRONMENT"
log_info "执行测试: $BABY_RUN_TEST"
log_info "执行构建: $BABY_RUN_BUILD"
log_info "部署 Vercel: $BABY_DEPLOY_VERCEL"

if [ "$BABY_RUN_TEST" = "true" ]; then
  log_section "步骤 1: 执行测试"
  cd "$APP_DIR"
  npm test
  cd "$PROJECT_ROOT"
fi

if [ "$BABY_RUN_BUILD" = "true" ]; then
  log_section "步骤 2: 执行构建"
  cd "$APP_DIR"
  npm run build
  cd "$PROJECT_ROOT"
fi

log_section "步骤 3: 上传到 GitHub"
if [ -n "$COMMIT_MSG" ]; then
  "$SCRIPT_DIR/upload_to_github.sh" "$COMMIT_MSG"
else
  "$SCRIPT_DIR/upload_to_github.sh"
fi

if [ "$BABY_DEPLOY_VERCEL" = "true" ]; then
  log_section "步骤 4: 部署到 Vercel"
  "$SCRIPT_DIR/deploy_vercel.sh" "$ENVIRONMENT"
fi

log_section "部署完成"
log_info "所有步骤已完成"
