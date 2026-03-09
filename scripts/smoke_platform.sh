#!/bin/bash

# Baby 平台能力冒烟脚本（C006/C007/C008/X001 最小链路）
# 用法:
#   BABY_API_BASE_URL=https://xxx ./scripts/smoke_platform.sh

set -u

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

title() {
  echo ""
  echo -e "${CYAN}════════════════════════════════════${NC}"
  echo -e "${CYAN}$1${NC}"
  echo -e "${CYAN}════════════════════════════════════${NC}"
}

trim_trailing_slash() { echo "$1" | sed 's:/*$::'; }

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
TIMEOUT="${BABY_SMOKE_TIMEOUT:-80}"
ACTOR_ID="dev_platform_001"

if [ -z "$API_BASE_RAW" ]; then
  log_error "缺少 BABY_API_BASE_URL"
  exit 1
fi
if [[ "$API_BASE_RAW" != http* ]]; then
  log_error "BABY_API_BASE_URL 必须是绝对地址"
  exit 1
fi

API_BASE="$(trim_trailing_slash "$API_BASE_RAW")"
if [ -z "$TOKEN" ] && [ -n "$TOKEN_FILE" ] && [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(head -n1 "$TOKEN_FILE" | tr -d '\r\n')"
fi

AUTH_ARGS=(-H "Content-Type: application/json" -H "x-user-id: $ACTOR_ID")
if [ -n "$TOKEN" ]; then
  AUTH_ARGS+=(-H "Authorization: Bearer $TOKEN")
else
  log_warn "未提供网关令牌，将使用匿名请求"
fi

PASS=0
FAIL=0

request() {
  local name="$1"
  local method="$2"
  local path="$3"
  local payload="${4:-}"

  local body_file
  body_file="$(mktemp)"
  local code
  local args=(-sS -m "$TIMEOUT" -o "$body_file" -w "%{http_code}" -X "$method")
  args+=("${AUTH_ARGS[@]}")
  if [ -n "$payload" ]; then
    args+=(--data "$payload")
  fi

  if ! code="$(curl "${args[@]}" "${API_BASE}${path}")"; then
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
  echo "$body" | head -c 300
  echo ""
  return 1
}

extract_field() {
  local json="$1"
  local key="$2"
  echo "$json" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n1
}

title "平台能力冒烟开始"
log_info "API Base: $API_BASE"

if ! request "user-upsert" "POST" "/api/user" "{\"deviceId\":\"$ACTOR_ID\"}" >/dev/null; then
  exit 2
fi

title "C006 群组创建与成员维护"
if ! GROUP_JSON="$(request "group-create" "POST" "/api/v1/groups" "{\"name\":\"Smoke Group\",\"type\":\"group\"}")"; then
  exit 2
fi
GROUP_ID="$(extract_field "$GROUP_JSON" "groupId")"
if [ -z "$GROUP_ID" ]; then
  FAIL=$((FAIL + 1))
  log_error "group-create => missing groupId in response"
  exit 2
fi
if ! request "group-member-add" "POST" "/api/v1/groups/${GROUP_ID}/members" "{\"userId\":\"u_friend_smoke\"}" >/dev/null; then
  exit 2
fi
if ! request "group-member-remove" "DELETE" "/api/v1/groups/${GROUP_ID}/members/u_friend_smoke" >/dev/null; then
  exit 2
fi

title "会话与附件（C007/C008）"
if ! request "conversation-open" "POST" "/api/v1/conversations" "{\"groupId\":\"$GROUP_ID\"}" >/dev/null; then
  exit 2
fi
if ! request "asset-upload" "POST" "/api/v1/assets/upload" "{\"conversationId\":\"$GROUP_ID\",\"fileName\":\"smoke.txt\",\"mediaType\":\"text/plain\",\"size\":12,\"url\":\"https://example.com/smoke.txt\"}" >/dev/null; then
  exit 2
fi
if ! request "message-send" "POST" "/api/v1/conversations/${GROUP_ID}/messages" "{\"type\":\"text\",\"content\":\"platform smoke message\"}" >/dev/null; then
  exit 2
fi

title "X001 能力包执行"
if ! request "capability-edu-lite" "POST" "/api/v1/capabilities/execute" "{\"capabilityKey\":\"edu-lite\",\"conversationId\":\"$GROUP_ID\",\"inputEnvelope\":{\"text\":\"请解释一次函数\"}}" >/dev/null; then
  exit 2
fi

title "结果汇总"
log_info "通过: $PASS"
if [ "$FAIL" -gt 0 ]; then
  log_error "失败: $FAIL"
  exit 2
fi
log_info "失败: $FAIL"
log_info "平台冒烟通过"
