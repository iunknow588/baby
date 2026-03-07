#!/bin/bash

# Baby API 冒烟脚本（Day1/Day2/Day4/Day5）
# 用法:
#   BABY_API_BASE_URL=https://xxx ./scripts/smoke_api.sh
#   BABY_API_BASE_URL=https://xxx BABY_GATEWAY_TOKEN=... ./scripts/smoke_api.sh
#   BABY_API_BASE_URL=https://xxx BABY_TOKEN_FILE=~/.baby_gateway_token ./scripts/smoke_api.sh

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_ENV_FILE="$PROJECT_ROOT/app/.env.local"

if [ -f "$APP_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$APP_ENV_FILE"
fi

API_BASE_RAW="${BABY_API_BASE_URL:-${VITE_API_BASE_URL:-}}"
COZE_BASE_RAW="${BABY_COZE_API_URI:-${VITE_COZE_API_URI:-}}"
USER_ID="${BABY_COZE_USER_ID:-${VITE_COZE_USER_ID:-}}"
TOKEN="${BABY_GATEWAY_TOKEN:-${BABY_TOKEN:-}}"
TOKEN_FILE="${BABY_TOKEN_FILE:-}"
SMOKE_TIMEOUT="${BABY_SMOKE_TIMEOUT:-10}"

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

if [ -z "$API_BASE_RAW" ]; then
  log_error "缺少 API 基础地址，请设置 BABY_API_BASE_URL"
  exit 1
fi

if [[ "$API_BASE_RAW" != http* ]]; then
  log_error "BABY_API_BASE_URL 必须是绝对地址（当前: $API_BASE_RAW）"
  log_warn "示例: BABY_API_BASE_URL=https://baby-api.example.com"
  exit 1
fi

API_BASE="$(trim_trailing_slash "$API_BASE_RAW")"
if [ -n "$COZE_BASE_RAW" ]; then
  if [[ "$COZE_BASE_RAW" == http* ]]; then
    COZE_BASE="$(trim_trailing_slash "$COZE_BASE_RAW")"
  else
    COZE_BASE="$(join_url "$API_BASE" "$COZE_BASE_RAW")"
    COZE_BASE="$(trim_trailing_slash "$COZE_BASE")"
  fi
else
  COZE_BASE="$(join_url "$API_BASE" "/api/coze")"
fi

if [ -z "$TOKEN" ] && [ -n "$TOKEN_FILE" ] && [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(head -n1 "$TOKEN_FILE" | tr -d '\r\n')"
fi

PASS_COUNT=0
FAIL_COUNT=0

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
else
  log_warn "未提供网关令牌（BABY_GATEWAY_TOKEN 或 BABY_TOKEN_FILE），将使用匿名请求"
fi

print_title() {
  echo ""
  echo -e "${CYAN}════════════════════════════════════${NC}"
  echo -e "${CYAN}$1${NC}"
  echo -e "${CYAN}════════════════════════════════════${NC}"
}

request() {
  local name="$1"
  local method="$2"
  local url="$3"
  local payload="${4:-}"

  local body_file
  body_file="$(mktemp)"
  local code

  local curl_args
  curl_args=(-sS -m "$SMOKE_TIMEOUT" -o "$body_file" -w "%{http_code}" -X "$method" -H "Content-Type: application/json")
  if [ -n "$auth_config_file" ]; then
    curl_args+=(--config "$auth_config_file")
  fi
  if [ -n "$payload" ]; then
    curl_args+=(--data "$payload")
  fi

  if ! code="$(curl "${curl_args[@]}" "$url")"; then
    code="000"
  fi

  local body
  body="$(cat "$body_file")"
  rm -f "$body_file"

  if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    local trace_id
    trace_id="$(echo "$body" | sed -n 's/.*"traceId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
    log_info "$name => HTTP $code ${trace_id:+(traceId: $trace_id)}"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    log_error "$name => HTTP $code"
    echo "$body" | head -c 280
    echo ""
  fi
}

print_title "Baby API 冒烟开始"
log_info "API Base: $API_BASE"
log_info "Coze Base: $COZE_BASE"
log_info "Timeout: ${SMOKE_TIMEOUT}s"

print_title "Day1 Chat"
request "create-session" "POST" "$(join_url "$API_BASE" "/api/chat/sessions")" '{"roomType":"dm","targetId":"u_smoke"}'
request "list-rooms" "GET" "$(join_url "$API_BASE" "/api/chat/rooms?limit=1")"

print_title "Day2 SSE"
if [ -n "$TOKEN" ]; then
  local_stream_url="$(join_url "$API_BASE" "/api/chat/stream?sessionId=s_smoke")"
  stream_args=(-sS -m 8 -o /tmp/baby_sse_head.out -w "%{http_code}" -N)
  if [ -n "$auth_config_file" ]; then
    stream_args+=(--config "$auth_config_file")
  fi
  if ! stream_head_code="$(curl "${stream_args[@]}" "$local_stream_url")"; then
    stream_head_code="000"
  fi
  if [[ "$stream_head_code" == "200" || "$stream_head_code" == "204" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    log_info "sse-stream => HTTP $stream_head_code"
  elif [ "$stream_head_code" = "000" ] && [ -f /tmp/baby_sse_head.out ] && rg -q "event:[[:space:]]*heartbeat" /tmp/baby_sse_head.out; then
    PASS_COUNT=$((PASS_COUNT + 1))
    log_info "sse-stream => 收到 heartbeat（按通过处理）"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    log_error "sse-stream => HTTP $stream_head_code"
    head -c 200 /tmp/baby_sse_head.out || true
    echo ""
  fi
  rm -f /tmp/baby_sse_head.out
else
  log_warn "跳过 sse-stream（缺少网关令牌）"
fi

print_title "Day4 Coze"
request "coze-chat" "POST" "$(join_url "$COZE_BASE" "/chat")" "{\"message\":\"你好，请做一次联调自检\",\"userId\":\"${USER_ID:-user_smoke}\"}"

print_title "Day5 Social"
request "contacts" "GET" "$(join_url "$API_BASE" "/api/social/contacts?limit=1")"
request "friend-requests" "GET" "$(join_url "$API_BASE" "/api/social/friend-requests?limit=1")"

print_title "结果汇总"
log_info "通过: $PASS_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  log_error "失败: $FAIL_COUNT"
  exit 2
fi

log_info "失败: $FAIL_COUNT"
log_info "冒烟通过"
