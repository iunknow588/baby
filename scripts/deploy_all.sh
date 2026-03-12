#!/bin/bash

# Baby 项目完整部署脚本（唯一模式：部署所有代码）

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
Baby 项目完整部署脚本（deploy_all）

用法:
  ./scripts/deploy_all.sh

说明:
  - 该脚本不接收业务参数，执行即完整部署所有代码
  - 完整流程: docs-check -> test -> build -> github -> vercel
  - 可通过环境变量控制细节（见下）

可选环境变量:
  BABY_DEPLOY_ENVIRONMENT   默认 production（可设为 preview）
  BABY_COMMIT_MSG           Git 提交信息（默认自动生成）
  BABY_RUN_TEST             true|false，默认 true
  BABY_RUN_BUILD            true|false，默认 true
  BABY_DEPLOY_VERCEL        true|false，默认 true
  BABY_SKIP_DOCS_CHECK      true|false，默认 false
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$PROJECT_ROOT/app"
DOCS_CHECK_SCRIPT="$PROJECT_ROOT/../works-docs/baby/scripts/check_links.sh"
AUDIT_LOG="$PROJECT_ROOT/.deploy_audit.log"
ROOT_VERCEL_FILE="$PROJECT_ROOT/.vercel/project.json"
APP_VERCEL_FILE="$PROJECT_ROOT/app/.vercel/project.json"
LOCKED_VERCEL_PROJECT_ID="prj_zIhaklJ2j8v0tblKxzYanBzPJl3X"

BABY_DEPLOY_ENVIRONMENT="${BABY_DEPLOY_ENVIRONMENT:-production}"
BABY_COMMIT_MSG="${BABY_COMMIT_MSG:-}"
BABY_RUN_TEST="${BABY_RUN_TEST:-true}"
BABY_RUN_BUILD="${BABY_RUN_BUILD:-true}"
BABY_DEPLOY_VERCEL="${BABY_DEPLOY_VERCEL:-true}"
BABY_SKIP_DOCS_CHECK="${BABY_SKIP_DOCS_CHECK:-false}"
BABY_DEPLOY_BRANCH="${BABY_DEPLOY_BRANCH:-main}"
BABY_ALLOW_NON_MAIN="${BABY_ALLOW_NON_MAIN:-false}"

log_audit() {
  local message="$1"
  printf '%s script=%s env=%s user=%s cwd=%s msg=%s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" \
    "deploy_all.sh" \
    "$BABY_DEPLOY_ENVIRONMENT" \
    "${USER:-unknown}" \
    "$PROJECT_ROOT" \
    "$message" >> "$AUDIT_LOG" 2>/dev/null || true
}

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

extract_project_field() {
  local file="$1"
  local field="$2"
  if [ ! -f "$file" ]; then
    echo ""
    return
  fi
  sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -n1
}

run_preflight_checks() {
  local branch
  branch="$(git -C "$PROJECT_ROOT" branch --show-current || true)"
  if [ -z "$branch" ]; then
    log_error "无法识别当前 Git 分支。"
    exit 1
  fi

  if [ "$BABY_ALLOW_NON_MAIN" != "true" ] && [ "$branch" != "$BABY_DEPLOY_BRANCH" ]; then
    log_error "当前分支为 '$branch'，默认只允许在 '$BABY_DEPLOY_BRANCH' 分支部署。"
    log_error "如确需跨分支部署，请显式设置 BABY_ALLOW_NON_MAIN=true。"
    exit 1
  fi

  local root_project_id app_project_id
  root_project_id="$(extract_project_field "$ROOT_VERCEL_FILE" "projectId")"
  app_project_id="$(extract_project_field "$APP_VERCEL_FILE" "projectId")"

  if [ -n "$root_project_id" ] && [ "$root_project_id" != "$LOCKED_VERCEL_PROJECT_ID" ]; then
    log_warn "检测到根目录历史绑定 projectId=$root_project_id，期望=$LOCKED_VERCEL_PROJECT_ID。"
    log_warn "后续 deploy_vercel.sh 会自动修正到唯一项目。"
  fi

  if [ -n "$app_project_id" ] && [ "$app_project_id" != "$LOCKED_VERCEL_PROJECT_ID" ]; then
    log_warn "检测到 app/.vercel 历史绑定 projectId=$app_project_id，期望=$LOCKED_VERCEL_PROJECT_ID。"
    log_warn "建议清理 app/.vercel，避免后续排障歧义。"
  fi
}

run_full_pipeline() {
  log_section "完整部署流程"
  log_info "项目路径: $PROJECT_ROOT"
  log_info "前端目录: $APP_DIR"
  log_info "环境: $BABY_DEPLOY_ENVIRONMENT"
  log_info "执行测试: $BABY_RUN_TEST"
  log_info "执行构建: $BABY_RUN_BUILD"
  log_info "部署 Vercel: $BABY_DEPLOY_VERCEL"
  if [ "$BABY_DEPLOY_VERCEL" != "true" ]; then
    log_info "提示: 当前已关闭 Vercel 部署（BABY_DEPLOY_VERCEL=false）"
  fi

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
  if [ -n "$BABY_COMMIT_MSG" ]; then
    "$SCRIPT_DIR/upload_to_github.sh" "$BABY_COMMIT_MSG"
  else
    "$SCRIPT_DIR/upload_to_github.sh"
  fi

  if [ "$BABY_DEPLOY_VERCEL" = "true" ]; then
    log_section "步骤 4: 部署到 Vercel"
    "$SCRIPT_DIR/deploy_vercel.sh" "$BABY_DEPLOY_ENVIRONMENT"
  fi

  log_section "部署完成"
  log_info "所有步骤已完成"
}

cd "$PROJECT_ROOT"
log_audit "entry"

if [ "$#" -gt 0 ]; then
  case "$1" in
    help|--help|-h)
      show_help
      exit 0
      ;;
    *)
      log_error "deploy_all.sh 不接受业务参数。请直接执行: ./scripts/deploy_all.sh"
      log_error "如需说明，请执行: ./scripts/deploy_all.sh help"
      exit 1
      ;;
  esac
fi

run_preflight_checks
run_docs_check
run_full_pipeline
