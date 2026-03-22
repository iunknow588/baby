# baby scripts

本目录是 Baby 项目的部署脚本入口。

## 核心脚本

- `deploy_all.sh`：统一顶层入口（无参数执行完整部署）
- `deploy.sh`：兼容别名入口（等价转发到 `deploy_all.sh`）
- `upload_to_github.sh`：提交并推送到 GitHub
- `deploy_vercel.sh`：部署前后端一体到 Vercel（根目录 `vercel.json` + `api/*` Functions）
- `coze_gate.sh`：Coze 自动化门禁（配置体检 + 协议检查 + 路由回归）
- `coze_create_preflight.sh`：Coze 自动创建前置检查（聊天连通 + CozeLoop 创建凭证检查）
- `cozeloop_probe.sh`：CozeLoop JWT + API 实连探测（验证私钥可解析并调用 `/v1/loop/prompts/mget`）
- `coze_sync_check.sh`：校验本地工作流绑定清单与 CozeLoop 资源一致性（当前仅检查 Prompt 资源）
- `smoke_api.sh`：MVP 接口冒烟检查（`/api/user`、`/api/chat`、`/api/history`、`/api/coze/chat`）
- `smoke_realtime.sh`：实时链路冒烟检查（`/api/chat/sessions`、`/api/chat/stream`、`/api/v1/conversations/*`）
- `smoke_platform.sh`：平台能力冒烟检查（`/api/v1/groups/*`、`/api/v1/assets/upload`、`/api/v1/capabilities/execute`）
- `smoke_all`：通过顺序执行 `smoke_api.sh + smoke_realtime.sh + smoke_platform.sh` 实现
- `gate_local.sh`：本地门禁（文档巡检 + 脚本语法 + 前端测试构建）

说明: `smoke-rt` 与 `smoke-platform` 为 fail-fast 策略，关键步骤失败会立即退出并返回非 0。
- `check_remote_backend.sh`：检查远程后端 MVP + Platform 接口可达性
- `run_local.sh`：一键启动本地联调（后端 `4010` + 前端 `5173`）
- `../works-docs/baby/scripts/check_links.sh`：文档链接巡检

## 调用关系

- 顶层入口：`deploy_all.sh`
- 兼容别名：`deploy.sh`（仅转发到 `deploy_all.sh`，不承载独立业务逻辑）
- 完整发布会在 `deploy_all.sh` 内依次调用：
  - `docs-check`
  - `coze-gate`
  - `test + build`
  - `upload_to_github.sh`
  - `deploy_vercel.sh`（可通过 `BABY_DEPLOY_VERCEL=false` 跳过）
- `deploy_all.sh` 不接收业务参数；执行即开始完整流程。
- `smoke/gate/probe/local` 等能力如需单独执行，请直接运行对应脚本文件。

## 远端仓库

脚本会校验 `origin`，默认强制为：

- `git@github.com:iunknow588/baby.git`

## 常用命令

```bash
cd /home/lc/luckee_dao/baby

# 直接执行完整部署（docs-check -> coze-gate -> test -> build -> github -> vercel）
./scripts/deploy_all.sh

# 兼容别名（等价）
./scripts/deploy.sh

# 查看帮助
./scripts/deploy_all.sh help

# 使用环境变量控制部署细节
BABY_DEPLOY_ENVIRONMENT=preview \
BABY_COMMIT_MSG="feat: preview release" \
BABY_DEPLOY_VERCEL=true \
./scripts/deploy_all.sh

# 单独冒烟（不走 deploy_all）
./scripts/smoke_api.sh
./scripts/smoke_realtime.sh
./scripts/smoke_platform.sh

# Coze 自动创建前置检查
./scripts/coze_create_preflight.sh

# CozeLoop 实连探测（JWT + API）
./scripts/cozeloop_probe.sh

# Coze 绑定同步检查（registry -> CozeLoop）
./scripts/coze_sync_check.sh
```

## 环境变量

- 脚本默认读取 `baby/.env.local`（后端配置源）。
- `BABY_RUN_TEST`：`true|false`，默认 `true`
- `BABY_RUN_BUILD`：`true|false`，默认 `true`
- `BABY_RUN_COZE_GATE`：`true|false`，默认 `true`
- `BABY_DEPLOY_VERCEL`：`true|false`，默认 `true`
- `BABY_DEPLOY_ENVIRONMENT`：`production|preview`，默认 `production`
- `BABY_COMMIT_MSG`：提交信息（默认由脚本自动生成）
- `BABY_DEPLOY_BRANCH`：允许部署的目标分支，默认 `main`
- `BABY_ALLOW_NON_MAIN`：`true|false`，默认 `false`；为 `true` 时允许非主分支部署
- `BABY_VERCEL_SCOPE`：Vercel scope，固定 `iunknow588s-projects`（脚本会校验）
- `BABY_VERCEL_PROJECT`：Vercel project name，固定 `app`（脚本会校验）
- `BABY_VERCEL_PROJECT_ID`：Vercel project id，固定 `prj_zIhaklJ2j8v0tblKxzYanBzPJl3X`（脚本会校验）
- `BABY_VERCEL_STRICT_LINK`：`true|false`，默认 `true`；开启后若本地 link 状态与预期不一致会直接失败
- `BABY_SMOKE_TIMEOUT`：`smoke_api.sh` 超时秒数，默认 `80`
- `BABY_REMOTE_TIMEOUT`：`check_remote_backend.sh` 超时秒数，默认 `80`
- `BABY_PROBE_STRICT`：`true|false`，默认 `false`；为 `true` 时 probe 发现缺口即返回非 0
- `BABY_SKIP_DOCS_CHECK`：`true|false`，默认 `false`；在 `probe/all/all-vercel` 前跳过文档巡检

## 防冲突策略（已内置）

- 部署前会检查根目录 `.vercel/project.json` 与 `app/.vercel/project.json`，若同时存在且 projectId 不一致会告警，并仅按根目录绑定继续部署。
- 部署前会先确认目标项目在 Vercel 控制台已存在，避免脚本误创建新项目。
- `vercel link` 后会二次校验 `projectName/projectId`，不匹配即终止。
- 部署目标已锁定为 `iunknow588s-projects/app (prj_zIhaklJ2j8v0tblKxzYanBzPJl3X)`，覆盖变量将被拒绝。
- 团队约定：仅允许从仓库根目录执行部署，不在 `app/` 目录单独执行 `vercel link/deploy`。
- 脚本会记录调用审计到 `baby/.deploy_audit.log`，用于追溯到底是哪个入口触发了部署。

## 安全建议

- 网关令牌不要放到 `VITE_` 前缀变量（会暴露到浏览器）。
- `BABY_API_BASE_URL/BABY_COZE_API_URI` 属于脚本运行参数，建议通过命令行环境变量传入。
- 优先使用 `BABY_TOKEN_FILE=~/.baby_gateway_token`，避免命令行明文传参。
- 后端必需配置放在 `baby/.env.local`（如 `SUPABASE_*`、`COZE_*`），不要放前端 `app/.env.local`。
