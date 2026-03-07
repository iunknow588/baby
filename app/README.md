# Baby H5 App

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

- `VITE_API_BASE_URL`: API 网关地址，默认 `/api`
- `VITE_COZE_API_URI`: Coze BFF URI，默认 `/api/coze`
- `VITE_SSE_RECONNECT_MS`: SSE 自动重连间隔（毫秒），默认 `5000`
- `VITE_SSE_STALE_MS`: SSE 连接陈旧阈值（毫秒），默认 `15000`
- `VITE_SSE_WATCHDOG_MS`: SSE 健康检查周期（毫秒），默认 `3000`
- `VITE_SSE_AUTO_RECOVER_COOLDOWN_MS`: SSE 自动恢复最小间隔（毫秒），默认 `8000`

示例：

```bash
cp .env.local.example .env.local
```

`.env.local` 已被 Git 忽略，仅用于本机账号联调。

## Coze API

当前前端通过 BFF 对接 Coze（避免在浏览器暴露私钥），默认请求：

- `POST {VITE_COZE_API_URI}/chat`

请求体：

```json
{
  "message": "用户输入文本",
  "conversationId": "可选",
  "extra": {}
}
```

响应体沿用统一 envelope：`{ success, data, error, traceId }`。

联调入口：
- 页面 `我的`（`/profile`）提供 Coze 配置展示与“发送给 Coze”测试按钮。

## Notes

- 当前已接入 `vue-advanced-chat` 基础聊天壳。
- 聊天/联系人页面已具备 mock 回退能力，便于先跑通界面。
- 联调阶段按 `works-docs/baby/03-接口联调清单_v1.md` 对接后端。
