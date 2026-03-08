#!/bin/bash

# 检查远程后端可达性与 Baby 必需接口缺口
# 用法:
#   ./scripts/check_remote_backend.sh
#   BABY_REMOTE_BASE_URL=https://your-backend-domain ./scripts/check_remote_backend.sh

set -u

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
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

print_title() {
  echo ""
  echo -e "${CYAN}════════════════════════════════════${NC}"
  echo -e "${CYAN}$1${NC}"
  echo -e "${CYAN}════════════════════════════════════${NC}"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_ENV_FILE="$PROJECT_ROOT/app/.env.local"

if [ -f "$APP_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$APP_ENV_FILE"
fi

BASE_URL="${BABY_REMOTE_BASE_URL:-${BABY_API_BASE_URL:-}}"
TIMEOUT="${BABY_REMOTE_TIMEOUT:-8}"
TOKEN="${BABY_GATEWAY_TOKEN:-${BABY_TOKEN:-}}"
TOKEN_FILE="${BABY_TOKEN_FILE:-}"

if [ -z "$BASE_URL" ]; then
  log_error "缺少后端地址，请设置 BABY_REMOTE_BASE_URL 或 BABY_API_BASE_URL"
  exit 1
fi

trim_trailing_slash() {
  echo "$1" | sed 's:/*$::'
}

join_url() {
  local base="$1"
  local path="$2"
  if [[ "$path" == /* ]]; then
    echo "${base}${path}"
  else
    echo "${base}/${path}"
  fi
}

BASE_URL="$(trim_trailing_slash "$BASE_URL")"

if [ -z "$TOKEN" ] && [ -n "$TOKEN_FILE" ] && [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(head -n1 "$TOKEN_FILE" | tr -d '\r\n')"
fi

auth_config_file=""
cleanup() {
  if [ -n "$auth_config_file" ] && [ -f "$auth_config_file" ]; then
    rm -f "$auth_config_file"
  fi
}
trap cleanup EXIT

if [ -n "$TOKEN" ]; then
  auth_config_file="$(mktemp)"
  chmod 600 "$auth_config_file"
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$auth_config_file"
fi

check_endpoint() {
  local name="$1"
  local method="$2"
  local path="$3"
  local payload="${4:-}"

  local url
  url="$(join_url "$BASE_URL" "$path")"

  local body_file
  body_file="$(mktemp)"
  local code
  local curl_args
  curl_args=(-sS -m "$TIMEOUT" -o "$body_file" -w "%{http_code}" -X "$method")
  if [ -n "$auth_config_file" ]; then
    curl_args+=(--config "$auth_config_file")
  fi
  if [ -n "$payload" ]; then
    curl_args+=(-H "Content-Type: application/json" --data "$payload")
  fi
  if ! code="$(curl "${curl_args[@]}" "$url")"; then
    code="000"
  fi

  if [ "$code" = "000" ]; then
    log_error "$name -> 网络不可达/超时 ($url)"
    rm -f "$body_file"
    return 2
  fi

  if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
    log_info "$name -> HTTP $code ($url)"
    rm -f "$body_file"
    return 0
  fi

  if [ "$code" = "401" ] || [ "$code" = "403" ]; then
    log_warn "$name -> HTTP $code (需要鉴权, 接口存在)"
    rm -f "$body_file"
    return 0
  fi

  log_warn "$name -> HTTP $code ($url)"
  rm -f "$body_file"
  return 1
}

print_title "远程后端检查"
log_info "Base URL: $BASE_URL"
log_info "Timeout: ${TIMEOUT}s"

print_title "Baby 前端必需接口（差异识别）"
MISSING=0
check_endpoint "chat-sessions" "POST" "/api/chat/sessions" '{"roomType":"dm","targetId":"u_smoke"}' || MISSING=$((MISSING + 1))
check_endpoint "chat-rooms" "GET" "/api/chat/rooms?limit=1" || MISSING=$((MISSING + 1))
check_endpoint "voice-upload" "POST" "/api/voice/upload" '{}' || MISSING=$((MISSING + 1))
check_endpoint "social-contacts" "GET" "/api/social/contacts?limit=1" || MISSING=$((MISSING + 1))
check_endpoint "coze-chat" "POST" "/api/coze/chat" '{"message":"hello"}' || MISSING=$((MISSING + 1))

print_title "结论"
if [ "$MISSING" -eq 0 ]; then
  log_info "Baby 关键接口已可联调（或仅缺鉴权）"
else
  log_warn "Baby 关键接口存在缺口数量: $MISSING"
  log_warn "说明: 这通常表示后端尚未补齐 chat/voice/social/coze 路由或前缀不一致"
fi
