#!/usr/bin/env bash
#
# 装 SMTP 收信网关。**同机和分机都用这一个脚本** —— 差别只在 SITE_URL。
#
#   SITE_URL=https://agenticlab.sh bash install.sh
#
# ⚠ **同机也用公网地址，别写 `http://127.0.0.1:3000`。**
#
# 站点是蓝绿部署的：两份构建轮流在 3000 和 3001 上跑，
# 每次 `npm run deploy` 换一边。写死端口的话，网关在下一次部署之后
# 就开始往一个已经停掉的端口投递 —— 而症状是「隔一次部署收不到信」，
# 没有人会往部署上想。
#
# 走公网多一跳（nginx → CDN → 回源），换来的是它永远指向活着的那一边。
#
# 幂等，可以反复跑。
set -euo pipefail

# 装在 /opt 而不是 mailgw 的家目录：服务单元里开着 ProtectHome=true，
# 它会让 /home 整个不可见 —— 装在家里的话 systemd 连 chdir 都做不到，
# 而报错是「Permission denied」，指向一个根本没问题的目录权限。
HOME_DIR=/opt/agenticlab-mail
SITE_URL="${SITE_URL:-https://agenticlab.sh}"
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
sudo mkdir -p "$HOME_DIR" && sudo chown mailgw:mailgw "$HOME_DIR"

sudo cp gateway.mjs package.json "$HOME_DIR/"
sudo chown -R mailgw:mailgw "$HOME_DIR"
sudo -u mailgw bash -c "cd '$HOME_DIR' && npm install --omit=dev --no-audit --no-fund"

# ── 配置 ─────────────────────────────────────────────────────
#
# ⚠️ **只改这两行，别的原样留着。**
#
# 原来这里是整份覆盖（`tee` 一个 heredoc）。而 `.env` 里还有别的东西 ——
# 最要紧的是 TLS 证书那两行（`TLS_KEY_PATH` / `TLS_CERT_PATH`）。
#
# 于是「升级一次网关」= **悄悄关掉 STARTTLS**，
# 而唯一的症状是启动日志里一句 warning：
# 「smtp-server is using the built-in default TLS certificate」——
# 服务照常 active、25 端口照常在听、信照常收得到，
# 只是从那一刻起每一封信在路上都是明文的。
#
# 这件事真的发生过一次（2026-08-15 升级带附件的那版时）。
KEEP="$(sudo cat "$HOME_DIR/.env" 2>/dev/null | grep -vE '^(MAIL_INGRESS_SECRET|SITE_URL)=' || true)"
sudo -u mailgw tee "$HOME_DIR/.env" >/dev/null <<EOF
MAIL_INGRESS_SECRET=$SECRET
SITE_URL=$SITE_URL
$KEEP
EOF
sudo chmod 600 "$HOME_DIR/.env"

# 装完要**重启**，不是 enable --now —— 后者对已经在跑的服务什么都不做，
# 于是文件换了、进程里还是旧代码。这个也踩过一次。

# node 的绝对路径按这台机器实际的来填。
#
# systemd 不读 PATH，ExecStart 必须是绝对路径；而 node 的位置
# 因装法而异（apt 装在 /usr/bin，官方 tarball 装在 /usr/local/bin）。
# 写死一个的后果是 `status=203/EXEC` —— 那个错误码不会提到 node。
NODE_BIN="$(command -v node)"
[[ -n "$NODE_BIN" ]] || { echo "找不到 node"; exit 1; }
sed "s|__NODE__|$NODE_BIN|" agenticlab-mail.service | sudo tee /etc/systemd/system/agenticlab-mail.service >/dev/null
# ── 续期钩子 ─────────────────────────────────────────────────
#
# 网关是**启动时读一次**证书的，所以 certbot 换了新证书之后
# 必须有人重启它。没有这一步的话，第 90 天开始发信方会静默降级成
# 明文、或者干脆拒投 —— 两种都不在我们这边留错误日志。
if [[ -d /etc/letsencrypt ]]; then
  sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  sudo cp renew-hook.sh /etc/letsencrypt/renewal-hooks/deploy/agenticlab-mail.sh
  sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/agenticlab-mail.sh
fi

sudo systemctl daemon-reload
sudo systemctl enable agenticlab-mail
sudo systemctl restart agenticlab-mail

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
