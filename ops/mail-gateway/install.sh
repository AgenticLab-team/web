#!/usr/bin/env bash
#
# 装 SMTP 收信网关。**同机和分机都用这一个脚本** —— 差别只在 SITE_URL。
#
#   同机（现在）：SITE_URL=http://127.0.0.1:3000 bash install.sh
#   分机（以后）：SITE_URL=https://agenticlab.sh bash install.sh
#
# 幂等，可以反复跑。
set -euo pipefail

HOME_DIR=/home/mailgw/mail-gateway
SITE_URL="${SITE_URL:-http://127.0.0.1:3000}"
SECRET="${MAIL_INGRESS_SECRET:-}"

if [[ -z "$SECRET" ]]; then
  echo "缺 MAIL_INGRESS_SECRET。生成一个："
  echo "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  echo "⚠ 它必须和站点 .env.local 里那个一模一样 —— 站点那边不配的话，收信入口直接 503 关门。"
  exit 1
fi

# ── 专用账号 ─────────────────────────────────────────────────
#
# 不用站点那个账号跑：网关是**唯一一个直接暴露在公网上的进程**
# （25 端口对全世界开着）。它被打穿的时候，不该顺手拿到数据库。
id -u mailgw >/dev/null 2>&1 || sudo useradd -m -s /usr/sbin/nologin mailgw
sudo -u mailgw mkdir -p "$HOME_DIR"

sudo cp gateway.mjs package.json "$HOME_DIR/"
sudo chown -R mailgw:mailgw "$HOME_DIR"
sudo -u mailgw bash -c "cd '$HOME_DIR' && npm install --omit=dev --no-audit --no-fund"

# ── 配置 ─────────────────────────────────────────────────────
sudo -u mailgw tee "$HOME_DIR/.env" >/dev/null <<EOF
MAIL_INGRESS_SECRET=$SECRET
SITE_URL=$SITE_URL
EOF
sudo chmod 600 "$HOME_DIR/.env"

sudo cp agenticlab-mail.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agenticlab-mail

# ── 放行 25 ──────────────────────────────────────────────────
#
# ⚠ 同机部署时这一条会**把源站 IP 暴露出去** —— MX 记录是公开的。
# 这是有意接受的代价（见 README「两种拓扑」），不是疏忽。
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 25/tcp comment 'smtp — 收信网关'
fi

echo
echo "装好了。SITE_URL=$SITE_URL"
echo "  sudo journalctl -u agenticlab-mail -f"
echo
echo "下一步：把域名的 MX 指过来，并配 SPF / DMARC —— 见 README。"
