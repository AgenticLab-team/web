#!/usr/bin/env bash
#
# 一次性：把线上从「单实例 + restart」改成蓝绿两实例 + nginx 平滑切换。
#
# 单独一个脚本而不是塞进 deploy.sh：它要 sudo 改 systemd 和 nginx，
# 而每次部署都请求一次 sudo 是没必要的 —— 这一步只在第一次跑。
# 跑完之后 deploy.sh 自己就能切，不再需要 sudo 以外的任何人工步骤。
#
# **幂等**：重复跑不会把东西装两遍，也不会打断正在服务的那一边。
#
# 用法：bash scripts/install-bluegreen.sh
set -euo pipefail

HOST="${DEPLOY_HOST:-ubuntu@agenticlab.sh}"
REMOTE="${DEPLOY_PATH:-/home/ubuntu/agenticlab}"

step() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

step "传 systemd 单元和 nginx 片段"
scp -q ops/agenticlab-blue.service ops/agenticlab-green.service ops/nginx-upstream.conf "$HOST:/tmp/"

step "装 systemd 单元"
ssh "$HOST" '
  set -e
  sudo mv /tmp/agenticlab-blue.service /tmp/agenticlab-green.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable agenticlab-blue.service agenticlab-green.service >/dev/null
  echo "  蓝绿两个单元已就位"
'

step "两个构建目录先建出来"
# 单元文件里那三个路径都带了「不存在就跳过」的减号，所以少一个也起得来；
# 但先建出来更省事 —— 否则 green 第一次被构建之前，
# 它对 blue 那个进程来说是「跳过」的，而部署脚本正要往里写。
ssh "$HOST" "mkdir -p $REMOTE/.next-blue $REMOTE/.next-green"

step "先把蓝那一边建出来"
# 现在跑着的是老单元（agenticlab.service，用 .next）。
# 蓝要用 .next-blue，所以得先有这份产物 —— 在老实例照常服务的同时建，
# 建的是一个它根本不认识的目录，**对线上零影响**。这正是蓝绿要换来的东西，
# 而这一步本身就是第一次享受到它。
ssh "$HOST" "cd $REMOTE && NEXT_DIST_DIR=.next-blue npm run build > /tmp/build-blue.log 2>&1 || { tail -30 /tmp/build-blue.log; exit 1; }" \
  || fail "蓝的构建失败 —— 什么都还没动，线上照旧"

step "起蓝（此时老实例还在服务，蓝只是在 3000 之外自己听着）"
# 注意：老的 agenticlab.service 也听 3000。所以要先停老的再起蓝，
# 这中间有几秒空窗 —— **这是最后一次**，之后所有部署都不再有这一段。
ssh "$HOST" '
  set -e
  sudo systemctl disable --now agenticlab.service 2>/dev/null || true
  sudo systemctl start agenticlab-blue.service
'

step "等蓝起来"
for attempt in $(seq 1 20); do
  code=$(ssh "$HOST" "curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || echo 000")
  if [ "$code" = "200" ]; then
    printf '  第 %s 次通过\n' "$attempt"
    break
  fi
  printf '  第 %s 次：%s\n' "$attempt" "$code"
  if [ "$attempt" = "20" ]; then
    ssh "$HOST" "sudo journalctl -u agenticlab-blue -n 30 --no-pager" || true
    # 起不来就把老的放回去，别让站点一直躺着
    ssh "$HOST" "sudo systemctl enable --now agenticlab.service" || true
    fail "蓝起不来，已经把老单元放回去了"
  fi
  sleep 2
done

step "接 nginx（幂等）"
ssh "$HOST" '
  set -e
  sudo mv /tmp/nginx-upstream.conf /etc/nginx/conf.d/agenticlab-upstream.conf
  CONF=/etc/nginx/sites-enabled/agenticlab
  # proxy_pass 从写死的 127.0.0.1:3000 换成 upstream 名字。
  # 换成名字之后，「指向哪一边」这件事就只存在于 upstream 那一个文件里，
  # 部署时改一行、reload 一下就切完了 —— 不用再动站点配置。
  sudo sed -i "s#proxy_pass http://127\.0\.0\.1:300[01];#proxy_pass http://agenticlab_app;#g" "$CONF"
  sudo nginx -t
  sudo systemctl reload nginx
  echo "  nginx 已指向 upstream"
'

step "探活"
code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "https://agenticlab.sh/" || echo 000)
[ "$code" = "200" ] || fail "公网探活失败：$code"
printf '  公网 200\n'

step "完成"
echo "  之后 npm run deploy 就是蓝绿轮换了，正常情况下不再有 502。"
echo "  回滚：bash scripts/rollback.sh"
