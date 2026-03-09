# Baby API (Vercel Functions)

## 路由状态

当前启用（MVP）:
- `api/health.js`
- `api/diagnostics.js`
- `api/user.js`
- `api/chat.js`
- `api/history.js`
- `api/coze/chat.js`

历史占位（保留文件，仅返回 `410 LEGACY_API_DEPRECATED`）:
- `api/chat/rooms.js`
- `api/chat/rooms/[roomId]/messages.js`
- `api/chat/sessions.js`
- `api/chat/messages.js`

## 环境变量

必需:
1. `SUPABASE_URL`
2. `SUPABASE_SERVICE_ROLE_KEY`
3. `COZE_API_BASE_URL`
4. `COZE_API_TOKEN`
5. `COZE_BOT_ID`

可选:
1. `COZE_MAX_WAIT_MS`（v3 轮询等待上限，默认 `60000`）

## 数据库初始化

在 Supabase SQL Editor 执行:

- `supabase/migrations/20260309_init_mvp_schema.sql`（MVP 当前基线）
- `supabase/migrations/20260308_init_chat_schema.sql`

## 说明

1. 响应统一 envelope: `{ success, data, error, traceId }`
2. MVP 当前基线接口：`/api/user`、`/api/chat`、`/api/history`、`/api/coze/chat`
3. 旧 `/api/chat/*` 为历史房间接口，当前统一返回 `410 LEGACY_API_DEPRECATED`（用于防误接旧协议）
4. 生产建议后续接入 Supabase Auth + RLS
