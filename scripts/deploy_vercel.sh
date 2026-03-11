#!/bin/bash

# Baby 项目 Vercel 部署脚本（前后端一体）
# 使用方法: ./scripts/deploy_vercel.sh [production|preview]

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_VERCEL_FILE="$PROJECT_ROOT/.vercel/project.json"
APP_VERCEL_FILE="$PROJECT_ROOT/app/.vercel/project.json"
AUDIT_LOG="$PROJECT_ROOT/.deploy_audit.log"

ENVIRONMENT="${1:-preview}"
LOCKED_VERCEL_SCOPE="iunknow588s-projects"
LOCKED_VERCEL_PROJECT="app"
LOCKED_VERCEL_PROJECT_ID="prj_zIhaklJ2j8v0tblKxzYanBzPJl3X"
BABY_VERCEL_SCOPE="${BABY_VERCEL_SCOPE:-$LOCKED_VERCEL_SCOPE}"
BABY_VERCEL_PROJECT="${BABY_VERCEL_PROJECT:-$LOCKED_VERCEL_PROJECT}"
BABY_VERCEL_ARCHIVE="${BABY_VERCEL_ARCHIVE:-tgz}"
BABY_VERCEL_PROJECT_ID="${BABY_VERCEL_PROJECT_ID:-$LOCKED_VERCEL_PROJECT_ID}"
BABY_VERCEL_STRICT_LINK="${BABY_VERCEL_STRICT_LINK:-true}"

log_audit() {
  local message="$1"
  printf '%s script=%s env=%s scope=%s project=%s user=%s cwd=%s msg=%s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" \
    "deploy_vercel.sh" \
    "$ENVIRONMENT" \
    "$BABY_VERCEL_SCOPE" \
    "$BABY_VERCEL_PROJECT" \
    "${USER:-unknown}" \
    "$PROJECT_ROOT" \
    "$message" >> "$AUDIT_LOG" 2>/dev/null || true
}

if ! command -v vercel >/dev/null 2>&1; then
  log_error "错误: 未检测到 vercel CLI，请先安装: npm i -g vercel"
  exit 1
fi

if [ "$BABY_VERCEL_SCOPE" != "$LOCKED_VERCEL_SCOPE" ] || [ "$BABY_VERCEL_PROJECT" != "$LOCKED_VERCEL_PROJECT" ] || [ "$BABY_VERCEL_PROJECT_ID" != "$LOCKED_VERCEL_PROJECT_ID" ]; then
  log_error "当前脚本已锁定唯一部署目标，禁止切换："
  log_error "  scope=$LOCKED_VERCEL_SCOPE"
  log_error "  project=$LOCKED_VERCEL_PROJECT"
  log_error "  projectId=$LOCKED_VERCEL_PROJECT_ID"
  log_error "请移除覆盖环境变量 BABY_VERCEL_SCOPE/BABY_VERCEL_PROJECT/BABY_VERCEL_PROJECT_ID。"
  exit 1
fi

extract_project_field() {
  local file="$1"
  local field="$2"
  if [ ! -f "$file" ]; then
    echo ""
    return
  fi
  sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -n1
}

validate_local_link_state() {
  local root_project_id app_project_id root_project_name app_project_name
  root_project_id="$(extract_project_field "$ROOT_VERCEL_FILE" "projectId")"
  root_project_name="$(extract_project_field "$ROOT_VERCEL_FILE" "projectName")"
  app_project_id="$(extract_project_field "$APP_VERCEL_FILE" "projectId")"
  app_project_name="$(extract_project_field "$APP_VERCEL_FILE" "projectName")"

  if [ -n "$root_project_id" ] && [ -n "$app_project_id" ] && [ "$root_project_id" != "$app_project_id" ]; then
    log_warn "检测到历史双重 Vercel 绑定："
    log_warn "  根目录 -> ${root_project_name:-unknown} (${root_project_id})"
    log_warn "  app目录 -> ${app_project_name:-unknown} (${app_project_id})"
    log_warn "部署脚本将忽略 app/.vercel，仅按根目录绑定执行。建议后续清理 app/.vercel。"
  fi

  if [ "$BABY_VERCEL_STRICT_LINK" = "true" ] && [ -n "$root_project_id" ] && [ -n "$BABY_VERCEL_PROJECT_ID" ] && [ "$root_project_id" != "$BABY_VERCEL_PROJECT_ID" ]; then
    log_warn "当前仓库历史绑定与预期不一致，将在 link 阶段自动修正："
    log_warn "  当前: $root_project_id (${root_project_name:-unknown})"
    log_warn "  预期: $BABY_VERCEL_PROJECT_ID ($BABY_VERCEL_PROJECT)"
  fi
}

validate_remote_project_exists() {
  if ! vercel project inspect "$BABY_VERCEL_PROJECT" --scope "$BABY_VERCEL_SCOPE" >/dev/null 2>&1; then
    log_error "目标 Vercel 项目不存在: $BABY_VERCEL_SCOPE/$BABY_VERCEL_PROJECT"
    log_error "为避免误创建重复项目，脚本已终止。请先在控制台确认目标项目。"
    exit 1
  fi
}

verify_link_result() {
  local linked_project_id linked_project_name
  linked_project_id="$(extract_project_field "$ROOT_VERCEL_FILE" "projectId")"
  linked_project_name="$(extract_project_field "$ROOT_VERCEL_FILE" "projectName")"

  if [ -z "$linked_project_id" ] || [ -z "$linked_project_name" ]; then
    log_error "无法读取 $ROOT_VERCEL_FILE，无法确认 link 结果。"
    exit 1
  fi
  if [ "$linked_project_name" != "$BABY_VERCEL_PROJECT" ]; then
    log_error "link 后项目名不匹配：实际=$linked_project_name，预期=$BABY_VERCEL_PROJECT"
    exit 1
  fi
  if [ -n "$BABY_VERCEL_PROJECT_ID" ] && [ "$linked_project_id" != "$BABY_VERCEL_PROJECT_ID" ]; then
    log_error "link 后 projectId 不匹配：实际=$linked_project_id，预期=$BABY_VERCEL_PROJECT_ID"
    exit 1
  fi
}

cd "$PROJECT_ROOT"
log_audit "entry"

log_info "开始部署 Baby 前后端一体到 Vercel ($ENVIRONMENT)"
log_info "Vercel Scope: $BABY_VERCEL_SCOPE"
log_info "Vercel Project: $BABY_VERCEL_PROJECT"
log_info "Vercel Project ID: ${BABY_VERCEL_PROJECT_ID:-<未限制>}"
log_info "Vercel Archive: $BABY_VERCEL_ARCHIVE"

validate_local_link_state
validate_remote_project_exists

log_info "步骤 1: 链接 Vercel 项目（无交互）"
vercel link --yes --scope "$BABY_VERCEL_SCOPE" --project "$BABY_VERCEL_PROJECT"
verify_link_result
log_audit "linked"

log_info "步骤 2: 执行部署"
if [ "$ENVIRONMENT" = "production" ]; then
  vercel deploy --prod --yes --scope "$BABY_VERCEL_SCOPE" --logs --archive="$BABY_VERCEL_ARCHIVE"
else
  vercel deploy --yes --scope "$BABY_VERCEL_SCOPE" --logs --archive="$BABY_VERCEL_ARCHIVE"
fi
log_audit "deployed"

log_info "步骤 3: 查询最新部署状态"
vercel list --yes --scope "$BABY_VERCEL_SCOPE"

log_info "Vercel 部署完成"
