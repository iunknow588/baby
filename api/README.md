# Baby API (Vercel Functions)

## 部署模式

1. Vercel 运行入口：`api/index.js`（单函数网关）
2. 业务处理器目录：`api_handlers/**`
3. `vercel.json` rewrite 将 `/api/*` 显式转发至 `/api/index` 并透传原路径
4. 路由分发实现：`api_handlers/router.js`

## 路由状态

当前启用:
- `GET /api/health`
- `GET /api/diagnostics`
- `POST /api/user`
- `POST /api/chat`
- `GET /api/history`
- `POST /api/coze/chat`
- `POST /api/chat/sessions`
- `GET /api/chat/stream`
- `POST|GET /api/v1/groups`
- `POST|DELETE /api/v1/groups/{groupId}/members`
- `DELETE /api/v1/groups/{groupId}/members/{memberId}`
- `POST|GET /api/v1/conversations`
- `POST|GET /api/v1/conversations/{conversationId}/messages`
- `POST /api/v1/assets/upload`
- `POST /api/v1/capabilities/execute`
- `GET /api/social/contacts`
- `GET|POST /api/social/friend-requests`
- `POST /api/social/friend-requests/{requestId}/accept`
- `POST /api/social/friend-requests/{requestId}/reject`
- `POST /api/voice/upload`
- `POST /api/voice/asr`
- `POST /api/voice/tts`

历史占位（保留文件，仅返回 `410 LEGACY_API_DEPRECATED`）:
- `/api/chat/rooms`
- `/api/chat/rooms/{roomId}/messages`
- `/api/chat/messages`

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
- `supabase/migrations/20260309_platform_refactor_schema.sql`（平台重构增量）

## 说明

1. 响应统一 envelope: `{ success, data, error, traceId }`
2. MVP 当前基线接口：`/api/user`、`/api/chat`、`/api/history`、`/api/coze/chat`
3. 平台重构接口（v1）：`/api/v1/groups`、`/api/v1/conversations`、`/api/v1/assets/upload`、`/api/v1/capabilities/execute`
4. 社交与语音接口（MVP 占位实现）：`/api/social/*`、`/api/voice/*`
5. 旧房间接口 `/api/chat/rooms*`、`/api/chat/messages` 统一返回 `410 LEGACY_API_DEPRECATED`（用于防误接旧协议）
6. 生产建议后续接入 Supabase Auth + RLS
