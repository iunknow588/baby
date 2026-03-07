# baby scripts

本目录是 Baby 项目的部署脚本入口。

## 核心脚本

- `deploy.sh`：统一入口
- `deploy_all.sh`：一键流程（测试/构建/GitHub，可选 Vercel）
- `upload_to_github.sh`：提交并推送到 GitHub
- `deploy_vercel.sh`：部署到 Vercel

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

# 完整流程（默认: test + build + github）
./scripts/deploy.sh all production "feat: release"

# 完整流程并部署 Vercel
BABY_DEPLOY_VERCEL=true ./scripts/deploy.sh all preview "feat: preview release"
```

## 环境变量

- `BABY_RUN_TEST`：`true|false`，默认 `true`
- `BABY_RUN_BUILD`：`true|false`，默认 `true`
- `BABY_DEPLOY_VERCEL`：`true|false`，默认 `false`

