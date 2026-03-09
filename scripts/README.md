# baby scripts

本目录是 Baby 项目的部署脚本入口。

## 核心脚本

- `deploy.sh`：统一入口
- `deploy_all.sh`：一键流程（测试/构建/GitHub + Vercel）
- `upload_to_github.sh`：提交并推送到 GitHub
- `deploy_vercel.sh`：部署前后端一体到 Vercel（根目录 `vercel.json` + `api/*` Functions）
- `smoke_api.sh`：MVP 接口冒烟检查（`/api/user`、`/api/chat`、`/api/history`、`/api/coze/chat`）
- `smoke_realtime.sh`：实时链路冒烟检查（`/api/chat/sessions`、`/api/chat/stream`、`/api/v1/conversations/*`）
- `smoke_platform.sh`：平台能力冒烟检查（`/api/v1/groups/*`、`/api/v1/assets/upload`、`/api/v1/capabilities/execute`）
- `deploy.sh smoke-all`：串行执行 `smoke + smoke-rt + smoke-platform`
- `gate_local.sh`：本地门禁（文档巡检 + 脚本语法 + 前端测试构建）

说明: `smoke-rt` 与 `smoke-platform` 为 fail-fast 策略，关键步骤失败会立即退出并返回非 0。
- `check_remote_backend.sh`：检查远程后端 MVP + Platform 接口可达性
- `run_local.sh`：一键启动本地联调（后端 `4010` + 前端 `5173`）
- `../works-docs/baby/scripts/check_links.sh`：文档链接巡检

## 远端仓库

脚本会校验 `origin`，默认强制为：

- `git@github.com:iunknow588/baby.git`

## 常用命令

```bash
cd /home/lc/luckee_dao/baby

# 查看帮助
./scripts/deploy.sh help

# 仅推送 GitHub
./scripts/deploy.sh github "chore: update deploy scripts"

# 仅测试/构建
./scripts/deploy.sh test
./scripts/deploy.sh build

# 接口冒烟（建议使用网关令牌）
BABY_API_BASE_URL=https://api.example.com \
BABY_GATEWAY_TOKEN=your_token \
./scripts/deploy.sh smoke

# 实时链路冒烟（sessions + SSE stream）
BABY_API_BASE_URL=https://api.example.com \
BABY_GATEWAY_TOKEN=your_token \
./scripts/deploy.sh smoke-rt

# 平台能力冒烟（C006/C007/C008/X001 最小链路）
BABY_API_BASE_URL=https://api.example.com \
BABY_GATEWAY_TOKEN=your_token \
./scripts/deploy.sh smoke-platform

# 全量冒烟（MVP + realtime + platform）
BABY_API_BASE_URL=https://api.example.com \
BABY_GATEWAY_TOKEN=your_token \
./scripts/deploy.sh smoke-all

# 远程后端探测（检查 Baby MVP + Platform 接口可达性）
BABY_REMOTE_BASE_URL=https://your-backend-domain \
./scripts/deploy.sh probe

# 文档链接巡检
./scripts/deploy.sh docs-check

# 本地门禁（docs + scripts + app）
./scripts/deploy.sh gate

# 本地联调一键启动
./scripts/deploy.sh local

# 完整流程（默认: test + build + github + vercel）
./scripts/deploy.sh all production "feat: release"

# 如需仅执行到 GitHub（跳过 Vercel）
BABY_DEPLOY_VERCEL=false ./scripts/deploy.sh all preview "feat: preview release"

# all-vercel 为 all 的兼容别名
./scripts/deploy.sh all-vercel production "feat: release"
```

## 环境变量

- 脚本默认读取 `baby/.env.local`（后端配置源）。
- `BABY_RUN_TEST`：`true|false`，默认 `true`
- `BABY_RUN_BUILD`：`true|false`，默认 `true`
- `BABY_DEPLOY_VERCEL`：`true|false`，默认 `true`
- `BABY_VERCEL_SCOPE`：Vercel scope，默认 `iunknow588s-projects`
- `BABY_VERCEL_PROJECT`：Vercel project name，默认 `baby`
- `BABY_SMOKE_TIMEOUT`：`smoke_api.sh` 超时秒数，默认 `80`
- `BABY_REMOTE_TIMEOUT`：`check_remote_backend.sh` 超时秒数，默认 `80`
- `BABY_PROBE_STRICT`：`true|false`，默认 `false`；为 `true` 时 probe 发现缺口即返回非 0
- `BABY_SKIP_DOCS_CHECK`：`true|false`，默认 `false`；在 `probe/all/all-vercel` 前跳过文档巡检

## 安全建议

- 网关令牌不要放到 `VITE_` 前缀变量（会暴露到浏览器）。
- `BABY_API_BASE_URL/BABY_COZE_API_URI` 属于脚本运行参数，建议通过命令行环境变量传入。
- 优先使用 `BABY_TOKEN_FILE=~/.baby_gateway_token`，避免命令行明文传参。
- 后端必需配置放在 `baby/.env.local`（如 `SUPABASE_*`、`COZE_*`），不要放前端 `app/.env.local`。
