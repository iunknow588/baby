# baby scripts

本目录是 Baby 项目的部署脚本入口。

## 核心脚本

- `deploy.sh`：统一入口
- `deploy_all.sh`：一键流程（测试/构建/GitHub + Vercel）
- `upload_to_github.sh`：提交并推送到 GitHub
- `deploy_vercel.sh`：部署到 Vercel
- `smoke_api.sh`：接口冒烟检查（chat/sse/coze/social）
- `check_remote_backend.sh`：检查远程后端可达性与 Baby 接口缺口

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
# 默认探测本地 http://127.0.0.1:9000 ，远端时显式覆盖
BABY_API_BASE_URL=https://api.example.com \
BABY_GATEWAY_TOKEN=your_token \
./scripts/deploy.sh smoke

# 远程后端探测（检查 student 已有接口 + Baby 关键接口缺口）
BABY_REMOTE_BASE_URL=http://115.190.127.72:9000 \
./scripts/deploy.sh probe

# 完整流程（默认: test + build + github + vercel）
./scripts/deploy.sh all production "feat: release"

# 如需仅执行到 GitHub（跳过 Vercel）
BABY_DEPLOY_VERCEL=false ./scripts/deploy.sh all preview "feat: preview release"

# all-vercel 为 all 的兼容别名
./scripts/deploy.sh all-vercel production "feat: release"
```

## 环境变量

- `BABY_RUN_TEST`：`true|false`，默认 `true`
- `BABY_RUN_BUILD`：`true|false`，默认 `true`
- `BABY_DEPLOY_VERCEL`：`true|false`，默认 `true`
- `BABY_VERCEL_SCOPE`：Vercel scope，默认 `iunknow588s-projects`
- `BABY_VERCEL_PROJECT`：Vercel project name，默认 `app`

## 安全建议

- 网关令牌不要放到 `VITE_` 前缀变量（会暴露到浏览器）。
- `BABY_API_BASE_URL/BABY_COZE_API_URI` 属于脚本运行参数，不建议写入前端 `.env.local`。
- 优先使用 `BABY_TOKEN_FILE=~/.baby_gateway_token`，避免命令行明文传参。
- 本仓库不会提交 `app/.env.local`，令牌仅本机可见。
