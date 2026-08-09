#!/usr/bin/env bash
#
# 把 502 页装到 nginx 上。
#
# 单独一个脚本而不是塞进 deploy.sh：它要 sudo 改 nginx 配置，
# 而每次部署都请求一次 sudo 是没必要的 —— 这一步只在第一次、
# 或者改了那一页之后才需要跑。
#
# 用法：bash scripts/install-error-page.sh
set -euo pipefail

# shellcheck source=scripts/_host.sh
source "$(dirname "${BASH_SOURCE[0]}")/_host.sh"
HOST="$(resolve_deploy_host)"

echo "→ 传页面"
ssh "$HOST" 'sudo mkdir -p /var/www/agenticlab'
scp -q ops/502.html "$HOST:/tmp/502.html"
ssh "$HOST" 'sudo mv /tmp/502.html /var/www/agenticlab/__offline.html && sudo chmod 644 /var/www/agenticlab/__offline.html'

echo "→ 传 nginx 片段"
scp -q ops/nginx-error-pages.conf "$HOST:/tmp/nginx-error-pages.conf"
ssh "$HOST" 'sudo mv /tmp/nginx-error-pages.conf /etc/nginx/snippets/agenticlab-error-pages.conf'

echo "→ 接进 server 块（幂等）"
ssh "$HOST" '
  set -e
  CONF=/etc/nginx/sites-enabled/agenticlab
  if ! sudo grep -q "agenticlab-error-pages.conf" "$CONF"; then
    # 插在第一个 server { 之后
    sudo sed -i "0,/^server {/s//server {\n    include snippets\/agenticlab-error-pages.conf;/" "$CONF"
    echo "  已插入"
  else
    echo "  已经有了，跳过"
  fi
  sudo nginx -t
  sudo systemctl reload nginx
'
echo "→ 完成"
