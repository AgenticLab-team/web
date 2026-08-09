#!/usr/bin/env bash
#
# 切回上一版。
#
# ─────────────────────────────────────────
# 回滚不该需要重新构建
# ─────────────────────────────────────────
#
# 上一版的构建产物还原封不动地躺在另一个 `.next-*` 里 ——
# 部署时只是把它那一边的进程停了，没删过东西。所以回滚就是
# 「把它起回来 + 把 nginx 指回去」，十来秒的事，不用等构建。
#
# 这一点是**在出事的时候才值钱的**：真出事那一刻，
# 一个要先跑三分钟构建的回滚等于没有回滚 ——
# 人会去改代码硬顶，而那通常让事情更糟。
#
# 用法：bash scripts/rollback.sh
set -euo pipefail

# shellcheck source=scripts/_host.sh
source "$(dirname "${BASH_SOURCE[0]}")/_host.sh"
HOST="$(resolve_deploy_host)"
URL="${DEPLOY_URL:-https://agenticlab.sh}"
UPSTREAM_CONF=/etc/nginx/conf.d/agenticlab-upstream.conf

step() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }
note() { printf '  %s\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

ACTIVE_PORT=$(ssh "$HOST" "grep -oE '127\.0\.0\.1:(3000|3001)' $UPSTREAM_CONF 2>/dev/null | grep -oE '300[01]' | head -1" || true)
[ -n "$ACTIVE_PORT" ] || fail "还没启用蓝绿，没有可以切回去的另一边（先跑 scripts/install-bluegreen.sh）"

if [ "$ACTIVE_PORT" = "3000" ]; then
  ACTIVE=blue; TARGET=green; TARGET_PORT=3001
else
  ACTIVE=green; TARGET=blue; TARGET_PORT=3000
fi

step "现在在跑 $ACTIVE，准备切回 $TARGET"

# 另一边到底有没有可以起的东西 —— 没有就别动 nginx。
# 第一次部署之后另一边是空的，这时候「回滚」会把站点切进一个 502。
has=$(ssh "$HOST" "[ -d /home/ubuntu/agenticlab/.next-$TARGET ] && echo yes || echo no")
[ "$has" = "yes" ] || fail "$TARGET 那边没有构建产物 —— 没有上一版可以回"

step "起 $TARGET"
ssh "$HOST" "sudo systemctl restart agenticlab-$TARGET"

step "$TARGET 自检"
ready=""
for attempt in $(seq 1 20); do
  code=$(ssh "$HOST" "curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:$TARGET_PORT/ || echo 000")
  if [ "$code" = "200" ]; then ready=1; note "第 $attempt 次通过"; break; fi
  note "第 $attempt 次：$code"
  sleep 2
done
if [ -z "$ready" ]; then
  ssh "$HOST" "sudo systemctl stop agenticlab-$TARGET" || true
  fail "$TARGET 也起不来 —— nginx 没动，流量还在 $ACTIVE 上"
fi

step "切回去"
ssh "$HOST" "
  set -e
  sudo sed -i 's#server 127\.0\.0\.1:300[01];#server 127.0.0.1:$TARGET_PORT;#' $UPSTREAM_CONF
  sudo sed -i 's#\# active=.*#\# active=$TARGET#' $UPSTREAM_CONF
  sudo nginx -t
  sudo systemctl reload nginx
"

step "公网探活"
code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$URL/" || echo 000)
[ "$code" = "200" ] || fail "切回来之后探活是 $code —— 两边都有问题，去看 journalctl"
note "200"

step "停掉 $ACTIVE"
sleep 5
ssh "$HOST" "sudo systemctl stop agenticlab-$ACTIVE" || true

step "完成"
note "现在跑的是 $TARGET。注意：数据库迁移**不会**跟着回滚 ——"
note "库里还是新版本的结构。加列加表的迁移对老代码无害，"
note "但如果这一版删过列或者改过列的语义，得手工处理。"
