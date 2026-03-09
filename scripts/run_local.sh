#!/bin/bash

# Baby 本地联调一键启动：
# - Vercel Functions: http://127.0.0.1:4010
# - Vite Client:      http://127.0.0.1:5173

set -euo pipefail

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$PROJECT_ROOT/app"

API_HOST="${BABY_LOCAL_API_HOST:-127.0.0.1}"
API_PORT="${BABY_LOCAL_API_PORT:-4010}"
WEB_HOST="${BABY_LOCAL_WEB_HOST:-127.0.0.1}"
WEB_PORT="${BABY_LOCAL_WEB_PORT:-5173}"

if ! command -v vercel >/dev/null 2>&1; then
  log_error "未检测到 vercel CLI，请先安装: npm i -g vercel"
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/.env.local" ]; then
  log_error "缺少后端配置文件: $PROJECT_ROOT/.env.local"
  exit 1
fi

if [ ! -f "$APP_DIR/package.json" ]; then
  log_error "缺少前端工程: $APP_DIR/package.json"
  exit 1
fi

API_PID=""
WEB_PID=""

cleanup() {
  if [ -n "$WEB_PID" ] && kill -0 "$WEB_PID" >/dev/null 2>&1; then
    kill "$WEB_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$API_PID" ] && kill -0 "$API_PID" >/dev/null 2>&1; then
    kill "$API_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

wait_for_http() {
  local url="$1"
  local retries="${2:-60}"
  local interval="${3:-0.5}"
  local i
  for i in $(seq 1 "$retries"); do
    if curl -sS -m 1 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$interval"
  done
  return 1
}

port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN -P -n >/dev/null 2>&1
    return $?
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :$port )" | tail -n +2 | grep -q .
    return $?
  fi
  return 1
}

if port_in_use "$API_PORT"; then
  log_error "端口已占用: $API_PORT，请先释放或设置 BABY_LOCAL_API_PORT"
  exit 1
fi

if port_in_use "$WEB_PORT"; then
  log_error "端口已占用: $WEB_PORT，请先释放或设置 BABY_LOCAL_WEB_PORT"
  exit 1
fi

log_info "启动本地后端: http://${API_HOST}:${API_PORT}"
(
  cd "$PROJECT_ROOT"
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/.env.local"
  set +a
  exec vercel dev --listen "${API_HOST}:${API_PORT}"
) &
API_PID=$!

if ! wait_for_http "http://${API_HOST}:${API_PORT}/api/health" 120 0.5; then
  log_error "本地后端启动超时: http://${API_HOST}:${API_PORT}/api/health"
  exit 1
fi
log_info "后端就绪"

log_info "启动本地前端: http://${WEB_HOST}:${WEB_PORT}"
(
  cd "$APP_DIR"
  exec npm run dev -- --host "$WEB_HOST" --port "$WEB_PORT"
) &
WEB_PID=$!

if ! wait_for_http "http://${WEB_HOST}:${WEB_PORT}/" 60 0.5; then
  log_error "本地前端启动超时: http://${WEB_HOST}:${WEB_PORT}/"
  exit 1
fi
log_info "前端就绪"

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}Local Ready${NC}"
echo -e "${CYAN}Frontend:${NC} http://${WEB_HOST}:${WEB_PORT}"
echo -e "${CYAN}Backend :${NC} http://${API_HOST}:${API_PORT}"
echo -e "${CYAN}Press Ctrl+C to stop both processes${NC}"
echo -e "${CYAN}========================================${NC}"

wait "$WEB_PID"
