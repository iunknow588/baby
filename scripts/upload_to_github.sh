#!/bin/bash

# Baby 项目自动上传到 GitHub 脚本
# 使用方法: ./scripts/upload_to_github.sh [提交信息]

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

DEFAULT_REMOTE_URL="git@github.com:iunknow588/baby.git"

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

log_debug() {
  echo -e "${BLUE}[DEBUG]${NC} $1"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

log_info "开始上传 Baby 项目到 GitHub"
log_info "项目路径: $PROJECT_ROOT"

if [ ! -d "app" ] || [ ! -f "README.md" ]; then
  log_error "错误: 当前目录不是 baby 项目根目录"
  exit 1
fi

if [ ! -d ".git" ]; then
  log_error "错误: Git 仓库未初始化"
  exit 1
fi

if ! git remote | grep -q '^origin$'; then
  log_warn "未检测到 origin，自动设置为默认远端"
  git remote add origin "$DEFAULT_REMOTE_URL"
else
  CURRENT_ORIGIN_URL="$(git remote get-url origin)"
  if [ "$CURRENT_ORIGIN_URL" != "$DEFAULT_REMOTE_URL" ]; then
    log_warn "origin 与期望不一致，自动更新"
    log_info "原 origin: $CURRENT_ORIGIN_URL"
    log_info "新 origin: $DEFAULT_REMOTE_URL"
    git remote set-url origin "$DEFAULT_REMOTE_URL"
  fi
fi

log_info "Git 状态:"
git status --short

git add -A

if [ -n "$(git diff --cached --name-only)" ]; then
  if [ -n "$1" ]; then
    COMMIT_MSG="$1"
  else
    CHANGED_COUNT="$(git diff --cached --name-only | wc -l | tr -d ' ')"
    COMMIT_MSG="chore(deploy): update baby project\n\n- auto commit from deploy script\n- changed files: ${CHANGED_COUNT}\n- timestamp: $(date '+%Y-%m-%d %H:%M:%S')"
  fi

  log_debug "提交信息: $COMMIT_MSG"
  git commit -m "$COMMIT_MSG"
else
  log_warn "没有可提交的变更，跳过 commit"
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [ -z "$CURRENT_BRANCH" ]; then
  CURRENT_BRANCH="main"
fi

log_info "推送分支: $CURRENT_BRANCH"
git push -u origin "$CURRENT_BRANCH"

log_info "GitHub 推送完成"
log_info "origin: $(git remote get-url origin)"
