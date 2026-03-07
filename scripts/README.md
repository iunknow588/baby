# baby scripts

本目录是 Baby 项目的部署脚本入口。

## 核心脚本

- `deploy.sh`：统一入口
- `deploy_all.sh`：一键流程（测试/构建/GitHub，可选 Vercel）
- `upload_to_github.sh`：提交并推送到 GitHub
- `deploy_vercel.sh`：部署到 Vercel
- `smoke_api.sh`：接口冒烟检查（chat/sse/coze/social）

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

# 接口冒烟（需配置 BABY_API_BASE_URL，可选 BABY_TOKEN）
BABY_API_BASE_URL=https://api.example.com \
BABY_TOKEN=your_token \
./scripts/deploy.sh smoke

# 完整流程（默认: test + build + github）
./scripts/deploy.sh all production "feat: release"

# 完整流程并部署 Vercel
BABY_DEPLOY_VERCEL=true ./scripts/deploy.sh all preview "feat: preview release"

# 推荐: 使用 all-vercel 一步到位
./scripts/deploy.sh all-vercel production "feat: release"
```

## 环境变量

- `BABY_RUN_TEST`：`true|false`，默认 `true`
- `BABY_RUN_BUILD`：`true|false`，默认 `true`
- `BABY_DEPLOY_VERCEL`：`true|false`，默认 `false`
- `BABY_VERCEL_SCOPE`：Vercel scope，默认 `iunknow588s-projects`
- `BABY_VERCEL_PROJECT`：Vercel project name，默认 `app`
