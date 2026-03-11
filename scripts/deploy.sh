#!/bin/bash

# 兼容入口：保留 deploy.sh 但将顶层调度统一交给 deploy_all.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/deploy_all.sh" "$@"
