#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/www/melon}"
PM2_APP="${PM2_APP:-melon-backend}"
NODE_DIR="${NODE_DIR:-/root/.nvm/versions/node/v24.16.0/bin}"
BACKUP_DIR="${BACKUP_DIR:-/www/melon-backups}"
BRANCH="${BRANCH:-main}"

export PATH="$NODE_DIR:$PATH"

log() {
  printf '\n[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令: $1" >&2
    exit 1
  fi
}

log "检查运行环境"
require_cmd git
require_cmd node
require_cmd npm
require_cmd pm2
require_cmd nginx

cd "$APP_DIR"

log "备份配置和数据库"
mkdir -p "$BACKUP_DIR"
STAMP="$(date '+%Y%m%d-%H%M%S')"
if [ -f backend/.env ]; then
  cp backend/.env "$BACKUP_DIR/.env.$STAMP"
fi
if [ -f backend/data/melon.db ]; then
  cp backend/data/melon.db "$BACKUP_DIR/melon.db.$STAMP"
fi

log "拉取最新代码"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

log "安装依赖"
npm install

log "同步数据库结构"
npm --workspace backend run db:generate
npm --workspace backend run db:push
npm --workspace backend run db:init

log "构建项目"
npm run build

log "重启后端服务"
pm2 restart "$PM2_APP" --update-env
pm2 save

log "检查 Nginx"
nginx -t
systemctl reload nginx

log "健康检查"
curl --fail --silent --show-error http://127.0.0.1:4000/api/auth/status >/dev/null

log "更新完成"
pm2 status "$PM2_APP"
