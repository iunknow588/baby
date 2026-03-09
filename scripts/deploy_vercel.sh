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

ENVIRONMENT="${1:-preview}"
BABY_VERCEL_SCOPE="${BABY_VERCEL_SCOPE:-iunknow588s-projects}"
BABY_VERCEL_PROJECT="${BABY_VERCEL_PROJECT:-baby}"

if ! command -v vercel >/dev/null 2>&1; then
  log_error "错误: 未检测到 vercel CLI，请先安装: npm i -g vercel"
  exit 1
fi

cd "$PROJECT_ROOT"

log_info "开始部署 Baby 前后端一体到 Vercel ($ENVIRONMENT)"
log_info "Vercel Scope: $BABY_VERCEL_SCOPE"
log_info "Vercel Project: $BABY_VERCEL_PROJECT"

log_info "步骤 1: 链接 Vercel 项目（无交互）"
vercel link --yes --scope "$BABY_VERCEL_SCOPE" --project "$BABY_VERCEL_PROJECT"

log_info "步骤 2: 执行部署"
if [ "$ENVIRONMENT" = "production" ]; then
  vercel deploy --prod --yes --scope "$BABY_VERCEL_SCOPE" --logs
else
  vercel deploy --yes --scope "$BABY_VERCEL_SCOPE" --logs
fi

log_info "步骤 3: 查询最新部署状态"
vercel list --yes --scope "$BABY_VERCEL_SCOPE"

log_info "Vercel 部署完成"
