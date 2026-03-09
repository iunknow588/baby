#!/bin/bash

# 检查远程后端可达性与 Baby MVP/Platform 接口状态
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
ROOT_ENV_FILE="$PROJECT_ROOT/.env.local"

if [ -f "$ROOT_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ROOT_ENV_FILE"
fi

BASE_URL="${BABY_REMOTE_BASE_URL:-${BABY_API_BASE_URL:-}}"
TIMEOUT="${BABY_REMOTE_TIMEOUT:-80}"
TOKEN="${BABY_GATEWAY_TOKEN:-${BABY_TOKEN:-}}"
TOKEN_FILE="${BABY_TOKEN_FILE:-}"
STRICT_MODE="${BABY_PROBE_STRICT:-false}"

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
log_info "Strict Mode: ${STRICT_MODE}"

print_title "Baby MVP 接口检查"
MISSING_MVP=0
check_endpoint "user-upsert" "POST" "/api/user" '{"deviceId":"dev_probe_001"}' || MISSING_MVP=$((MISSING_MVP + 1))
check_endpoint "chat-send" "POST" "/api/chat" '{"deviceId":"dev_probe_001","message":"hello"}' || MISSING_MVP=$((MISSING_MVP + 1))
check_endpoint "history-list" "GET" "/api/history?deviceId=dev_probe_001&limit=1" || MISSING_MVP=$((MISSING_MVP + 1))
check_endpoint "coze-chat" "POST" "/api/coze/chat" '{"message":"hello"}' || MISSING_MVP=$((MISSING_MVP + 1))

print_title "Baby Platform 接口检查"
MISSING_PLATFORM=0
check_endpoint "v1-groups-list" "GET" "/api/v1/groups" || MISSING_PLATFORM=$((MISSING_PLATFORM + 1))
check_endpoint "v1-conversations-list" "GET" "/api/v1/conversations" || MISSING_PLATFORM=$((MISSING_PLATFORM + 1))
check_endpoint "chat-session-create" "POST" "/api/chat/sessions" '{"roomId":"r_mvp_main"}' || MISSING_PLATFORM=$((MISSING_PLATFORM + 1))
check_endpoint "voice-tts" "POST" "/api/voice/tts" '{"text":"probe"}' || MISSING_PLATFORM=$((MISSING_PLATFORM + 1))
check_endpoint "social-contacts" "GET" "/api/social/contacts?limit=1" || MISSING_PLATFORM=$((MISSING_PLATFORM + 1))

print_title "结论"
if [ "$MISSING_MVP" -eq 0 ] && [ "$MISSING_PLATFORM" -eq 0 ]; then
  log_info "Baby MVP + Platform 接口已可联调（或仅缺鉴权）"
else
  log_warn "Baby MVP 接口缺口数量: $MISSING_MVP"
  log_warn "Baby Platform 接口缺口数量: $MISSING_PLATFORM"
  log_warn "说明: 通常表示远程路由未完整部署或环境变量缺失"
  if [ "$STRICT_MODE" = "true" ]; then
    log_error "严格模式开启，探测失败"
    exit 2
  fi
fi
