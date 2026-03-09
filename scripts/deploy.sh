#!/bin/bash

# Baby 项目统一部署入口

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
  echo -e "${CYAN}Baby 项目部署脚本${NC}"
  echo ""
  echo "使用方法:"
  echo "  ./scripts/deploy.sh [选项]"
  echo ""
  echo "选项:"
  echo "  github [提交信息]                  仅提交到 GitHub"
  echo "  vercel [production|preview]        部署前后端一体到 Vercel"
  echo "  smoke                              执行后端接口冒烟检查"
  echo "  smoke-rt                           执行实时链路冒烟检查（sessions + stream）"
  echo "  smoke-platform                     执行平台能力冒烟（groups/assets/capabilities）"
  echo "  smoke-all                          串行执行 smoke + smoke-rt + smoke-platform"
  echo "  gate                               执行本地门禁（docs + scripts + app）"
  echo "  docs-check                         执行 works-docs 链接巡检"
  echo "  probe                              检查远程后端 MVP 接口可达性"
  echo "  local                              一键启动本地前后端联调环境"
  echo "  test                               仅执行 app 单元测试"
  echo "  build                              仅执行 app 构建"
  echo "  all [环境] [提交信息]               完整流程（测试/构建/GitHub + Vercel）"
  echo "  all-vercel [环境] [提交信息]        同 all（兼容旧命令）"
  echo "  help                               显示帮助"
  echo ""
  echo "示例:"
  echo "  ./scripts/deploy.sh github \"chore: update scripts\""
  echo "  ./scripts/deploy.sh all production \"feat: release\""
  echo "  ./scripts/deploy.sh all-vercel production \"feat: release\""
  echo ""
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$PROJECT_ROOT/app"
DOCS_CHECK_SCRIPT="$PROJECT_ROOT/../works-docs/baby/scripts/check_links.sh"
BABY_SKIP_DOCS_CHECK="${BABY_SKIP_DOCS_CHECK:-false}"

run_docs_check() {
  if [ "$BABY_SKIP_DOCS_CHECK" = "true" ]; then
    log_info "跳过文档巡检（BABY_SKIP_DOCS_CHECK=true）"
    return
  fi
  if [ ! -x "$DOCS_CHECK_SCRIPT" ]; then
    log_error "缺少文档巡检脚本: $DOCS_CHECK_SCRIPT"
    exit 1
  fi
  log_section "执行文档链接巡检"
  "$DOCS_CHECK_SCRIPT"
}

cd "$PROJECT_ROOT"

ACTION=${1:-"help"}

case "$ACTION" in
  github)
    log_section "提交到 GitHub"
    COMMIT_MSG=${2:-""}
    if [ -n "$COMMIT_MSG" ]; then
      "$SCRIPT_DIR/upload_to_github.sh" "$COMMIT_MSG"
    else
      "$SCRIPT_DIR/upload_to_github.sh"
    fi
    ;;

  vercel)
    log_section "部署到 Vercel"
    ENVIRONMENT=${2:-"preview"}
    "$SCRIPT_DIR/deploy_vercel.sh" "$ENVIRONMENT"
    ;;

  smoke)
    log_section "执行接口冒烟检查"
    "$SCRIPT_DIR/smoke_api.sh"
    ;;

  smoke-rt)
    log_section "执行实时链路冒烟检查"
    "$SCRIPT_DIR/smoke_realtime.sh"
    ;;

  smoke-platform)
    log_section "执行平台能力冒烟检查"
    "$SCRIPT_DIR/smoke_platform.sh"
    ;;

  smoke-all)
    log_section "执行全量冒烟检查"
    "$SCRIPT_DIR/smoke_api.sh"
    "$SCRIPT_DIR/smoke_realtime.sh"
    "$SCRIPT_DIR/smoke_platform.sh"
    ;;

  gate)
    log_section "执行本地门禁"
    "$SCRIPT_DIR/gate_local.sh"
    ;;

  docs-check)
    run_docs_check
    ;;

  probe)
    run_docs_check
    log_section "检查远程后端 MVP 接口可达性"
    "$SCRIPT_DIR/check_remote_backend.sh"
    ;;

  local)
    log_section "启动本地联调环境"
    "$SCRIPT_DIR/run_local.sh"
    ;;

  test)
    log_section "执行测试"
    cd "$APP_DIR"
    npm test
    ;;

  build)
    log_section "执行构建"
    cd "$APP_DIR"
    npm run build
    ;;

  all)
    run_docs_check
    log_section "完整部署流程"
    ENVIRONMENT=${2:-"production"}
    COMMIT_MSG=${3:-""}
    if [ -n "$COMMIT_MSG" ]; then
      "$SCRIPT_DIR/deploy_all.sh" "$ENVIRONMENT" "$COMMIT_MSG"
    else
      "$SCRIPT_DIR/deploy_all.sh" "$ENVIRONMENT"
    fi
    ;;

  all-vercel)
    run_docs_check
    log_section "完整部署流程（兼容别名）"
    ENVIRONMENT=${2:-"production"}
    COMMIT_MSG=${3:-""}
    if [ -n "$COMMIT_MSG" ]; then
      "$SCRIPT_DIR/deploy_all.sh" "$ENVIRONMENT" "$COMMIT_MSG"
    else
      "$SCRIPT_DIR/deploy_all.sh" "$ENVIRONMENT"
    fi
    ;;

  help|--help|-h)
    show_help
    ;;

  *)
    log_error "未知选项: $ACTION"
    show_help
    exit 1
    ;;
esac
