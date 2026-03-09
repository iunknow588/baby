#!/bin/bash

# Baby Realtime API 冒烟脚本
# 用法:
#   BABY_API_BASE_URL=https://xxx ./scripts/smoke_realtime.sh

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_ENV_FILE="$PROJECT_ROOT/.env.local"
if [ -f "$ROOT_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ROOT_ENV_FILE"
fi

API_BASE_RAW="${BABY_API_BASE_URL:-}"
TOKEN="${BABY_GATEWAY_TOKEN:-${BABY_TOKEN:-}}"
TOKEN_FILE="${BABY_TOKEN_FILE:-}"
SMOKE_TIMEOUT="${BABY_SMOKE_TIMEOUT:-80}"

if [ -z "$API_BASE_RAW" ]; then
  log_error "缺少 API 基础地址，请设置 BABY_API_BASE_URL"
  exit 1
fi
if [[ "$API_BASE_RAW" != http* ]]; then
  log_error "BABY_API_BASE_URL 必须是绝对地址（当前: $API_BASE_RAW）"
  exit 1
fi

API_BASE="$(trim_trailing_slash "$API_BASE_RAW")"

if [ -z "$TOKEN" ] && [ -n "$TOKEN_FILE" ] && [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(head -n1 "$TOKEN_FILE" | tr -d '\r\n')"
fi

AUTH_ARGS=()
if [ -n "$TOKEN" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer $TOKEN")
else
  log_warn "未提供网关令牌，将使用匿名请求"
fi

ACTOR_ID="dev_rt_001"
ROOM_ID="r_mvp_main"
PASS=0
FAIL=0

request_json() {
  local name="$1"
  local method="$2"
  local url="$3"
  local payload="${4:-}"
  local body_file
  body_file="$(mktemp)"
  local code

  local args=(-sS -m "$SMOKE_TIMEOUT" -o "$body_file" -w "%{http_code}" -X "$method" -H "Content-Type: application/json" -H "x-user-id: $ACTOR_ID")
  args+=("${AUTH_ARGS[@]}")
  if [ -n "$payload" ]; then
    args+=(--data "$payload")
  fi

  if ! code="$(curl "${args[@]}" "$url")"; then
    code="000"
  fi

  local body
  body="$(cat "$body_file")"
  rm -f "$body_file"

  if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
    PASS=$((PASS + 1))
    log_info "$name => HTTP $code"
    echo "$body"
    return 0
  fi

  FAIL=$((FAIL + 1))
  log_error "$name => HTTP $code"
  echo "$body" | head -c 280
  echo ""
  return 1
}

print_title "Realtime 冒烟开始"
log_info "API Base: $API_BASE"
log_info "Actor: $ACTOR_ID"

print_title "准备用户与会话"
if ! request_json "user-upsert" "POST" "$(join_url "$API_BASE" "/api/user")" "{\"deviceId\":\"$ACTOR_ID\"}" >/dev/null; then
  exit 2
fi
if ! request_json "list-conversations" "GET" "$(join_url "$API_BASE" "/api/v1/conversations")" >/dev/null; then
  exit 2
fi

if ! SESSION_RESPONSE="$(request_json "create-session" "POST" "$(join_url "$API_BASE" "/api/chat/sessions")" "{\"roomId\":\"$ROOM_ID\"}")"; then
  exit 2
fi
SESSION_ID="$(echo "$SESSION_RESPONSE" | sed -n 's/.*"sessionId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
if [ -z "$SESSION_ID" ]; then
  FAIL=$((FAIL + 1))
  log_error "create-session => missing sessionId in response"
  exit 2
fi
log_info "sessionId: $SESSION_ID"

print_title "发送一条消息"
if ! request_json "send-message" "POST" "$(join_url "$API_BASE" "/api/v1/conversations/${ROOM_ID}/messages")" "{\"content\":\"realtime smoke ping\",\"type\":\"text\"}" >/dev/null; then
  exit 2
fi

print_title "检查 SSE 心跳/消息"
STREAM_URL="$(join_url "$API_BASE" "/api/chat/stream?sessionId=${SESSION_ID}&actorId=${ACTOR_ID}")"
STREAM_OUT="$(mktemp)"
STREAM_CODE="$(curl -sS -N -m 12 -o "$STREAM_OUT" -w "%{http_code}" "${AUTH_ARGS[@]}" "$STREAM_URL" || true)"

if [[ "$STREAM_CODE" =~ ^2[0-9][0-9]$ ]]; then
  if grep -q "event: heartbeat" "$STREAM_OUT"; then
    PASS=$((PASS + 1))
    log_info "stream-heartbeat => OK"
  else
    FAIL=$((FAIL + 1))
    log_error "stream-heartbeat => missing"
  fi

  if grep -q "event: message" "$STREAM_OUT"; then
    PASS=$((PASS + 1))
    log_info "stream-message => OK"
  else
    log_warn "stream-message => 未在窗口内捕获（可接受，可能因时序）"
  fi
else
  FAIL=$((FAIL + 1))
  log_error "stream-open => HTTP $STREAM_CODE"
fi

rm -f "$STREAM_OUT"

print_title "结果汇总"
log_info "通过: $PASS"
if [ "$FAIL" -gt 0 ]; then
  log_error "失败: $FAIL"
  exit 2
fi
log_info "失败: $FAIL"
log_info "realtime 冒烟通过"
