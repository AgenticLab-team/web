#!/usr/bin/env bash
#
# 部署。
#
# 这个脚本存在的原因：早先是手敲一串命令用 && 串起来，中间还接了 grep 过滤输出——
# 而**管道的退出码是最后一个命令的**，`npm run build | grep error` 在构建失败时
# grep 反而返回成功，于是失败的构建照样触发了重启，站点直接 502。
#
# 所以这里的规矩是：
#   1. set -euo pipefail —— 管道里任何一环失败都算失败
#   2. 构建在服务器上先跑完并**确认退出码**，再重启
#   3. 重启后探活，起不来就报警并保留现场
#
set -euo pipefail

HOST="${DEPLOY_HOST:-ubuntu@agenticlab.sh}"
REMOTE="${DEPLOY_PATH:-/home/ubuntu/agenticlab}"
URL="${DEPLOY_URL:-https://agenticlab.sh}"

step() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

step "本地检查"
# 先把输出落到文件再判断，**不要在 if 条件里用管道**：
# 开了 pipefail 之后，tsc 发现错误会返回非零，整条管道就跟着非零，
# 于是 `if ... | grep -q` 判定为假，反而跳过了报错分支 —— 检查形同虚设。
#
# 过滤按**路径**而不是按错误文本：早先写成过滤 "not assignable"，
# 把真实的类型错误一起滤掉了，同样是形同虚设。
npx tsc --noEmit > /tmp/al-tsc.log 2>&1 || true
if grep -v '^\.next/' /tmp/al-tsc.log | grep -q 'error TS'; then
  grep -v '^\.next/' /tmp/al-tsc.log | grep 'error TS' | head -10
  fail "类型检查未通过"
fi

# lint 以前不在这条流水线里，于是它悄悄烂了很久 ——
# 攒到 6 个 error（渲染期读 ref、effect 里同步 setState）才被发现，
# 而其中有些是真会出问题的写法，不只是风格问题。
#
# 只挡 error，warning 放行：把 warning 也做成硬失败的话，
# 加一个临时的 console.log 都要先去改配置，最后大家会去掉整个检查。
# 注意是 [1-9] 开头：eslint 在只有 warning 时会打印「0 errors」，
# 写成 [0-9]+ 的话每次都会误判失败 —— 又一个「看起来在检查」的坑。
npx eslint src > /tmp/al-lint.log 2>&1 || true
if grep -qE '[1-9][0-9]* error' /tmp/al-lint.log; then
  tail -30 /tmp/al-lint.log
  fail "lint 未通过"
fi

npm test > /tmp/al-test.log 2>&1 || { tail -20 /tmp/al-test.log; fail "本地测试未通过"; }
grep -E '^. (tests|pass|fail)' /tmp/al-test.log | tail -3

step "同步代码"
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude data --exclude .env.local --exclude .git \
  ./ "$HOST:$REMOTE/"

step "服务器：依赖与迁移"
ssh "$HOST" "cd $REMOTE && npm install --silent && npm run bootstrap 2>&1 | tail -3"

step "服务器：测试"
ssh "$HOST" "cd $REMOTE && npm test > /tmp/test.log 2>&1 || { tail -30 /tmp/test.log; exit 1; }" \
  || fail "服务器测试未通过"

step "服务器：构建"
# 不接管道，直接看退出码。失败时把日志尾巴带回来
ssh "$HOST" "cd $REMOTE && npm run build > /tmp/build.log 2>&1 || { tail -30 /tmp/build.log; exit 1; }" \
  || fail "构建失败，**没有重启服务**，线上仍是旧版本"

step "重启"
ssh "$HOST" "sudo systemctl restart agenticlab"

step "探活"
for attempt in $(seq 1 10); do
  code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$URL/" || echo 000)
  if [ "$code" = "200" ]; then
    printf '  第 %s 次探活通过\n' "$attempt"
    step "完成"
    curl -s -m 10 "$URL/api/health" | head -c 200
    echo
    exit 0
  fi
  printf '  第 %s 次：%s\n' "$attempt" "$code"
  sleep 2
done

ssh "$HOST" "sudo journalctl -u agenticlab -n 20 --no-pager" || true
fail "重启后站点没起来"
