#!/bin/bash

# Baby 本地门禁：
# 1) works-docs 链接巡检
# 2) scripts 语法检查
# 3) app 测试 + 构建

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_section() {
  echo ""
  echo -e "${CYAN}════════════════════════════════════${NC}"
  echo -e "${CYAN}$1${NC}"
  echo -e "${CYAN}════════════════════════════════════${NC}"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$PROJECT_ROOT/app"
DOCS_CHECK_SCRIPT="$PROJECT_ROOT/../works-docs/baby/scripts/check_links.sh"

if [ ! -x "$DOCS_CHECK_SCRIPT" ]; then
  log_error "缺少文档巡检脚本: $DOCS_CHECK_SCRIPT"
  exit 1
fi

log_section "文档链接巡检"
"$DOCS_CHECK_SCRIPT"

log_section "脚本语法检查"
bash -n "$SCRIPT_DIR/deploy.sh"
bash -n "$SCRIPT_DIR/check_remote_backend.sh"
bash -n "$SCRIPT_DIR/smoke_api.sh"
bash -n "$SCRIPT_DIR/smoke_realtime.sh"
bash -n "$SCRIPT_DIR/smoke_platform.sh"
bash -n "$SCRIPT_DIR/run_local.sh"
log_info "脚本语法检查通过"

log_section "前端测试"
(
  cd "$APP_DIR"
  npm test
)

log_section "前端构建"
(
  cd "$APP_DIR"
  npm run build
)

log_section "门禁通过"
log_info "docs + scripts + app 已全部通过"
