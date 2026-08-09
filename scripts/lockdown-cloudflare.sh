#!/usr/bin/env bash
#
# 只让 Cloudflare 打得到 80/443。
#
# 起因：站点被 DDoS，公网 IP 换过一次。换 IP 只能买到几个小时 ——
# 源站 IP 一旦再次泄露（历史 DNS 记录、证书透明日志、一封从这台机器发出的邮件），
# 攻击立刻跟过来。真正管用的是**让源站只接受来自 CDN 的连接**。
#
# ─────────────────────────────────────────
# 这个脚本要重复跑
# ─────────────────────────────────────────
#
# Cloudflare 的网段会变。写死一份进仓库，半年后某个新段被挡在外面，
# 症状是「一部分人打不开」——而这种问题几乎没人会往防火墙上想。
# 所以每次都去 Cloudflare 现取，并且**取不到就什么都不做**。
#
# 用法：bash scripts/lockdown-cloudflare.sh
set -euo pipefail

# shellcheck source=scripts/_host.sh
source "$(dirname "${BASH_SOURCE[0]}")/_host.sh"
HOST="$(resolve_deploy_host)"

step() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

step "在服务器上配防火墙"
ssh "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail

V4=$(curl -fsS -m 20 https://www.cloudflare.com/ips-v4)
V6=$(curl -fsS -m 20 https://www.cloudflare.com/ips-v6)

# **取不到就退出，一条规则都不改。**
#
# 这是整个脚本最要紧的一行。curl 失败时 $V4 是空字符串，
# 而「允许空列表访问 80/443」+ 默认拒绝 = 全世界都打不开，
# 包括站长自己。宁可这次没配上，也不能配出一个静默的全站下线。
count4=$(printf '%s\n' "$V4" | grep -cE '^[0-9]+\.' || true)
count6=$(printf '%s\n' "$V6" | grep -cE '^[0-9a-fA-F]*:' || true)
if [ "$count4" -lt 10 ] || [ "$count6" -lt 4 ]; then
  echo "✗ 从 Cloudflare 取到的网段不像话（v4=$count4 v6=$count6），没有改动任何规则" >&2
  exit 1
fi
echo "  取到 $count4 个 v4 段、$count6 个 v6 段"

# 先放行 SSH，再谈别的。
#
# ufw 一旦 enable 就是默认拒绝进站 —— 顺序反了的话，
# 这条命令本身就是最后一条能在这台机器上跑的命令。
sudo ufw allow 22/tcp comment 'ssh — 必须在 enable 之前放行' >/dev/null

# frp 的控制端口。NekoBot 从站长那边连进来，切了它群消息同步就停了，
# 而症状是「网站好好的，只是消息不更新了」—— 要查很久才会想到防火墙。
sudo ufw allow 7000/tcp comment 'frp — NekoBot 从外面连进来' >/dev/null

# 把上一次留下的 CF 规则清掉再重建，否则网段变更之后旧段一直留着。
# 倒着删：ufw 的编号会随着删除往前移。
#
# 末尾那个 `|| true` 不是保险，是**必需的**：第一次跑的时候
# 一条 cloudflare 规则都还没有，grep 返回非零，而开了 pipefail
# 整个脚本就在这里静默退出了 —— 前面的 allow 都加上了、ufw 却没启用，
# 看起来像是「跑完了」。这个坑我已经踩过一次。
{
  sudo ufw status numbered 2>/dev/null \
    | grep 'cloudflare' \
    | grep -oE '^\[[ ]*[0-9]+' | grep -oE '[0-9]+' \
    | sort -rn \
    | while read -r n; do yes | sudo ufw delete "$n" >/dev/null 2>&1 || true; done
} || true

for cidr in $V4 $V6; do
  sudo ufw allow proto tcp from "$cidr" to any port 80,443 comment cloudflare >/dev/null
done

sudo ufw default deny incoming >/dev/null
sudo ufw default allow outgoing >/dev/null
sudo ufw --force enable >/dev/null

echo "  规则条数：$(sudo ufw status | grep -c ALLOW || true)"

# ─────────────────────────────────────────
# 真实客户端 IP
# ─────────────────────────────────────────
#
# 挡住源站只是第一步。CF 一进来，**每个访客在 nginx 眼里都是 CF 的边缘节点**，
# 而这个站有几处东西是认 IP 的：
#
#   · `/join`（申请加入社群）是全站唯一未登录可写的入口，按 IP 限流
#   · 审计日志记 actorIp
#   · 获取二维码 24 小时 10 次的限制
#
# 不配的话这些要么全站共用一个 IP（一个人触发限流，所有人一起被挡），
# 要么更糟 —— 现在 nginx 传的是 `$proxy_add_x_forwarded_for`，
# 它会把**客户端自己发来的 X-Forwarded-For 原样保留**再追加一个。
# 而应用取的是这串里的第一个。也就是说：随便发一个
# `X-Forwarded-For: 1.2.3.4`，限流和审计里记的就是 1.2.3.4 ——
# **按 IP 限流当场失效，审计日志可以随便伪造**。
#
# 所以：只认 CF 段传来的连接，从 `CF-Connecting-IP` 取真身，
# 然后把 X-Forwarded-For 换成 `$remote_addr`（此时它已经是真客户端 IP），
# 让应用拿到的那一串**只有一个、且不可伪造**。
echo "  写 real_ip 配置"
{
  echo "# 由 scripts/lockdown-cloudflare.sh 生成，不要手改 —— 网段会变，重跑脚本即可"
  for cidr in $V4 $V6; do echo "set_real_ip_from $cidr;"; done
  echo "real_ip_header CF-Connecting-IP;"
  # 只信任上面列出的那些来源；别的来源发来的这个头一律不认
  echo "real_ip_recursive off;"
} | sudo tee /etc/nginx/snippets/agenticlab-cloudflare-realip.conf >/dev/null

CONF=/etc/nginx/sites-enabled/agenticlab
if ! sudo grep -q "agenticlab-cloudflare-realip.conf" "$CONF"; then
  sudo sed -i "0,/^server {/s//server {\n    include snippets\/agenticlab-cloudflare-realip.conf;/" "$CONF"
  echo "  已接进 server 块"
else
  echo "  已经接过了"
fi

# 把伪造的那一串换掉。$remote_addr 经过 real_ip 模块改写之后就是真客户端 IP。
sudo sed -i 's#proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;#proxy_set_header X-Forwarded-For $remote_addr;#g' "$CONF"

sudo nginx -t
sudo systemctl reload nginx
echo "  nginx 已重载"
REMOTE

step "核对"
ssh "$HOST" '
  echo "  ufw：$(sudo ufw status | head -1)"
  echo "  22：  $(sudo ufw status | grep -c "^22/tcp" || true) 条"
  echo "  7000：$(sudo ufw status | grep -c "^7000/tcp" || true) 条"
  echo "  CF：  $(sudo ufw status | grep -c "cloudflare" || true) 条"
  echo
  echo "  现在还对公网开着的端口（应该只剩 22 和 7000，以及 CF 能进的 80/443）："
  sudo ufw status | grep ALLOW | head -30
'

step "完成"
echo "  注意：3000 端口原本是 *:3000（Next 直接对公网可达，绕过 nginx 和 CF）——"
echo "  现在被默认拒绝挡住了。这一条本身就值得单独说一句：源站 IP 泄露时，"
echo "  攻击者可以直接打 3000，CF 前面挡得再好也没用。"
