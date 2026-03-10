# Lumen Social App

## Start

```bash
cd /home/lc/luckee_dao/baby/app
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Test

```bash
npm test
```

## Env

默认不需要 `app/.env.local`，前端直接使用代码内默认值。

- `VITE_API_BASE_URL`: API 网关地址，默认 `/api`
- `VITE_COZE_API_URI`: Coze BFF URI，默认 `/api/coze`
- `VITE_SSE_RECONNECT_MS`: SSE 自动重连间隔（毫秒），默认 `5000`
- `VITE_SSE_STALE_MS`: SSE 连接陈旧阈值（毫秒），默认 `15000`
- `VITE_SSE_WATCHDOG_MS`: SSE 健康检查周期（毫秒），默认 `3000`
- `VITE_SSE_AUTO_RECOVER_COOLDOWN_MS`: SSE 自动恢复最小间隔（毫秒），默认 `8000`

仅当需要本地覆盖时：

```bash
cp .env.local.example .env.local
```

`.env.local` 已被 Git 忽略。

## Coze API

当前前端通过 BFF 对接 Coze，统一请求：

- `POST {VITE_COZE_API_URI}/chat`

`/chat` 响应体沿用 envelope：`{ success, data, error, traceId }`。

联调入口：
- 页面 `我的`（`/profile`）提供 AI 老师提问入口与 Coze 联调发送按钮。

## Notes

- 聊天页已改为原生 Vue 组件（不再依赖 `vue-advanced-chat`）。
- 聊天页采用单输入区交互：语音仅在本地转文字，发送到后端始终是文本。
- AI 回复可在同一输入区触发 TTS 播报，不再使用独立语音草稿窗口。
- 聊天/联系人页面已具备 mock 回退能力，便于先跑通界面。
- 联调阶段按 `works-docs/baby/03-接口联调清单_v1.md` 对接后端。
