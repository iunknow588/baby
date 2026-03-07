#!/bin/bash

# Baby 项目 Vercel 部署脚本
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
APP_DIR="$PROJECT_ROOT/app"

ENVIRONMENT="${1:-preview}"

if [ ! -d "$APP_DIR" ]; then
  log_error "错误: 未找到 app 目录: $APP_DIR"
  exit 1
fi

if ! command -v vercel >/dev/null 2>&1; then
  log_error "错误: 未检测到 vercel CLI，请先安装: npm i -g vercel"
  exit 1
fi

cd "$APP_DIR"

log_info "开始部署 Baby 前端到 Vercel ($ENVIRONMENT)"

if [ "$ENVIRONMENT" = "production" ]; then
  vercel --prod
else
  vercel
fi

log_info "Vercel 部署完成"
