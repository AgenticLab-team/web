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
#   2. 构建在服务器上先跑完并**确认退出码**，再切流量
#   3. 切完探活，不对就切回去
#
# ─────────────────────────────────────────
# 蓝绿：502 的两个来源，不是一个
# ─────────────────────────────────────────
#
# 站长说「502 时间特别长、还频繁」。拆开看是两段，而**长的那段不是重启**：
#
#   一、构建那一分多钟。老办法是在线上直接 `npm run build`，
#       而它会把**正在跑的那个进程脚下的 `.next` 换掉**。
#       运行中的实例按老的 chunk 名去读文件，那些文件已经不在了 ——
#       页面报错、接口 500。这一段有一分钟以上。
#   二、`systemctl restart` 之后 Next 起来之前那几秒，nginx 拿到
#       connection refused，回 502。
#
# 现在两边各有自己的构建目录（`.next-blue` / `.next-green`）和端口
# （3000 / 3001）。部署时**建的永远是没在服务的那一边**，所以第一段
# 从头到尾对线上零影响；建好、起好、自己探活通过之后，才改 nginx 的
# upstream 并 reload —— reload 是平滑的，老 worker 把手上的请求处理完
# 再退，所以第二段也没了。
#
# 附带的好处比省下的那几十秒更重要：**构建失败或者新版本起不来的时候，
# nginx 根本没被碰过**。以前这种情况是「站点躺了，人工去修」，
# 现在是「线上照旧跑着老版本，脚本报个错就完了」。
#
# 首次启用要先跑一次 bash scripts/install-bluegreen.sh。
# 没跑过的话这个脚本会退回老路径（单实例 + restart），照样能部署。
#
set -euo pipefail

# shellcheck source=scripts/_host.sh
source "$(dirname "${BASH_SOURCE[0]}")/_host.sh"
HOST="$(resolve_deploy_host)"
REMOTE="${DEPLOY_PATH:-/home/ubuntu/agenticlab}"
URL="${DEPLOY_URL:-https://agenticlab.sh}"
UPSTREAM_CONF=/etc/nginx/conf.d/agenticlab-upstream.conf
# 首屏 JS 预算（字节，**压缩后**）。
#
# 量压缩后是因为那才是用户真的要下的东西：按未压缩定预算等于按一个
# 没有人经历过的数字做决定。
#
# ── 8-10 重定：原来那条守卫量的根本不是它说的那个东西 ──
#
# 它抓 chunk 用的是 `[a-z0-9_]*\.js`，**字符类里没有连字符**。
# 而 Turbopack 的 chunk 名是随机串，里面出不出现 `-` 全看这次构建的运气。
# 后果不是少算几个字节，是那个 chunk 在它眼里**根本不存在**：
#
#   · 首页两个带 `-` 的 chunk 之一（14 KB gz）装的正是我们自己的界面代码
#     （「配色方案」「离线期间有 N 条新通知」「关掉这条公告」都在里面）——
#     **它声称要保护的那部分，一直在它的视野之外**
#   · 更糟的是这个漏法**逐次构建随机**：同一份代码，这次哈希带 `-`
#     就少算 20 KB，下次不带就全算上。8-08 记的「当前 109 KB」和
#     8-10 量到的 186 KB 之间那 77 KB，多半就是这么来的 ——
#     一个会自己乱跳的读数，比没有读数更坏：
#     有人会照着它去修一个不存在的膨胀。
#
# 修好正则之后的实测：总共 185 KB，其中 **171 KB 是框架地板**
# （react-dom + Next 客户端运行时；用一个空白 404 页量出来的，
# 那几个 chunk 里一个中文字符都没有，没有一行是我们写的），
# 我们自己的只有 14 KB。原来 160 KB 的预算连地板都装不下 ——
# 也就是说修好正则之后它会**永远红**，而一条永远红的守卫比没有更糟：
# 红过三次就没有人再看它，真正该拦的那次一样不会有人看。
#
# 所以拆成两个数：
#
#   · APP_JS_BUDGET —— 首页比空白 404 页**多拉**的那部分（现在 14 KB）。
#     这才是我们自己的代码，也是唯一一个改代码能改动的数。
#     加一个重的客户端组件会直接顶到这里。
#   · JS_BUDGET —— 总量上限（现在 185 KB），留得松。它拦的是另一类事：
#     框架自己爆了（升级引入一大坨）。那不是我们写的，但用户照样要下，
#     所以仍然要有人知道。
FLOOR_PROBE_PATH="${FLOOR_PROBE_PATH:-/__js-budget-floor-probe__}"
APP_JS_BUDGET="${APP_JS_BUDGET:-40960}"
JS_BUDGET="${JS_BUDGET:-215040}"

step() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }
note() { printf '  %s\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

step "本地检查"
# 先把输出落到文件再判断，**不要在 if 条件里用管道**：
# 开了 pipefail 之后，tsc 发现错误会返回非零，整条管道就跟着非零，
# 于是 `if ... | grep -q` 判定为假，反而跳过了报错分支 —— 检查形同虚设。
#
# 过滤按**路径**而不是按错误文本：早先写成过滤 "not assignable"，
# 把真实的类型错误一起滤掉了，同样是形同虚设。
npx tsc --noEmit > /tmp/al-tsc.log 2>&1 || true
if grep -v '^\.next' /tmp/al-tsc.log | grep -q 'error TS'; then
  grep -v '^\.next' /tmp/al-tsc.log | grep 'error TS' | head -10
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
# 扫全仓而不是只扫 src：测试文件里同样会出现真问题
# （加这一行的当天就查出两处 require() 风格的导入）。
# 只扫 src 的检查，看起来在跑，实际上放过了三分之一的代码。
npx eslint . > /tmp/al-lint.log 2>&1 || true
if grep -qE '[1-9][0-9]* error' /tmp/al-lint.log; then
  tail -30 /tmp/al-lint.log
  fail "lint 未通过"
fi

npm test > /tmp/al-test.log 2>&1 || { tail -20 /tmp/al-test.log; fail "本地测试未通过"; }
grep -E '^. (tests|pass|fail)' /tmp/al-test.log | tail -3

step "同步代码"
# 排除 .next* 而不是 .next：蓝绿两份产物都在服务器上，
# 只写 .next 的话 --delete 会把 .next-blue / .next-green 一起删掉,
# 而其中一份正是此刻在服务的那个版本。
# `.env.local*` 带星号，不是只排 `.env.local` —— **--delete 会连备份一起删**。
#
# 配 VAPID 密钥时踩过一次：改之前先 `cp .env.local .env.local.bak-$(date +%s)`，
# 下一次部署把那份备份静静删掉了。真出事要回滚配置的那一刻，
# 备份已经不在了 —— 而那正是唯一需要它的时刻。
#
# 同理 `.next*` 也带星号：两份构建产物（.next-blue / .next-green）
# 都在服务器上，删掉正在跑的那一份等于把站点删了。
rsync -az --delete \
  --exclude node_modules --exclude '.next*' --exclude data --exclude '.env.local*' --exclude .git \
  ./ "$HOST:$REMOTE/"

step "服务器：依赖与迁移"
# 迁移在切流量**之前**跑，所以有那么一小会儿是老代码在跑新库。
# 这个项目的迁移一直是加列加表这种加法，老代码看不见新列，相安无事。
# 哪天要删列或者改列的语义，得拆成两次部署：先加、切过去、再删。
ssh "$HOST" "cd $REMOTE && npm install --silent && npm run bootstrap 2>&1 | tail -3"

step "服务器：测试"
ssh "$HOST" "cd $REMOTE && npm test > /tmp/test.log 2>&1 || { tail -30 /tmp/test.log; exit 1; }" \
  || fail "服务器测试未通过"

# ── 这次上哪一边 ────────────────────────────────────────────────
ACTIVE_PORT=$(ssh "$HOST" "grep -oE '127\.0\.0\.1:(3000|3001)' $UPSTREAM_CONF 2>/dev/null | grep -oE '300[01]' | head -1" || true)

if [ -z "$ACTIVE_PORT" ]; then
  # 还没启用蓝绿。老路径照走，只是会有那两段 502。
  step "服务器：构建（单实例模式）"
  printf '\033[33m  还没启用蓝绿 —— 先跑一次 bash scripts/install-bluegreen.sh，之后就不再有部署 502 了\033[0m\n'
  ssh "$HOST" "cd $REMOTE && npm run build > /tmp/build.log 2>&1 || { tail -30 /tmp/build.log; exit 1; }" \
    || fail "构建失败，**没有重启服务**，线上仍是旧版本"
  step "重启"
  ssh "$HOST" "sudo systemctl restart agenticlab"
else
  if [ "$ACTIVE_PORT" = "3000" ]; then
    ACTIVE=blue; TARGET=green; TARGET_PORT=3001
  else
    ACTIVE=green; TARGET=blue; TARGET_PORT=3000
  fi
  note "现在在跑：$ACTIVE（:$ACTIVE_PORT）；这次建到：$TARGET（:$TARGET_PORT）"

  step "服务器：构建 $TARGET"
  note "线上跑的是 $ACTIVE，它的 .next-$ACTIVE 这一步一个字节都不会动"
  ssh "$HOST" "cd $REMOTE && NEXT_DIST_DIR=.next-$TARGET npm run build > /tmp/build.log 2>&1 || { tail -30 /tmp/build.log; exit 1; }" \
    || fail "构建失败 —— nginx 没被碰过，线上仍是 $ACTIVE 上的旧版本，照常服务"

  step "起 $TARGET（还没有流量进去）"
  ssh "$HOST" "sudo systemctl restart agenticlab-$TARGET"

  step "$TARGET 自检"
  # 直连它自己的端口探，绕开 nginx —— 此刻 nginx 还指着老的那一边
  ready=""
  for attempt in $(seq 1 20); do
    code=$(ssh "$HOST" "curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:$TARGET_PORT/ || echo 000")
    if [ "$code" = "200" ]; then ready=1; note "第 $attempt 次通过"; break; fi
    note "第 $attempt 次：$code"
    sleep 2
  done
  if [ -z "$ready" ]; then
    ssh "$HOST" "sudo journalctl -u agenticlab-$TARGET -n 30 --no-pager" || true
    # 起不来就把它停了。nginx 从头到尾没动过，线上还是老版本在跑。
    ssh "$HOST" "sudo systemctl stop agenticlab-$TARGET" || true
    fail "$TARGET 起不来 —— 流量始终在 $ACTIVE 上，线上没有受影响"
  fi

  step "切流量到 $TARGET"
  # 只改 upstream 里那一行，然后 reload。reload 期间老 worker
  # 会把手上的请求处理完再退，所以这一步不掉请求。
  ssh "$HOST" "
    set -e
    sudo sed -i 's#server 127\.0\.0\.1:300[01];#server 127.0.0.1:$TARGET_PORT;#' $UPSTREAM_CONF
    sudo sed -i 's#\# active=.*#\# active=$TARGET#' $UPSTREAM_CONF
    sudo nginx -t
    sudo systemctl reload nginx
  " || fail "nginx 拒绝了新配置 —— 没有 reload，流量还在 $ACTIVE 上"

  step "公网探活"
  ok=""
  for attempt in $(seq 1 5); do
    code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$URL/" || echo 000)
    if [ "$code" = "200" ]; then ok=1; note "第 $attempt 次通过"; break; fi
    note "第 $attempt 次：$code"
    sleep 2
  done
  if [ -z "$ok" ]; then
    # 切过去之后才发现不对 —— 立刻切回来，别让站点停在坏的那一边
    step "切回 $ACTIVE"
    ssh "$HOST" "
      sudo sed -i 's#server 127\.0\.0\.1:300[01];#server 127.0.0.1:$ACTIVE_PORT;#' $UPSTREAM_CONF
      sudo sed -i 's#\# active=.*#\# active=$ACTIVE#' $UPSTREAM_CONF
      sudo nginx -t && sudo systemctl reload nginx
    " || true
    fail "新版本公网探活没过，已经切回 $ACTIVE"
  fi

  step "停掉 $ACTIVE"
  # 等一下再停：reload 之后老 worker 手上可能还有没跑完的请求。
  # 它的 .next-$ACTIVE 留着不删 —— 下次部署才会覆盖，
  # 所以这期间随时可以 bash scripts/rollback.sh 切回去，不用重新构建。
  sleep 5
  ssh "$HOST" "sudo systemctl stop agenticlab-$ACTIVE" || true
  note "$ACTIVE 已停，它那份构建产物留着 —— 要回滚跑 bash scripts/rollback.sh"
fi

step "探活"
for attempt in $(seq 1 10); do
  code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$URL/" || echo 000)
  if [ "$code" = "200" ]; then
    printf '  第 %s 次探活通过\n' "$attempt"

    # 首屏 JS 体积预算。
    #
    # 不设上限的话它只会单调变大 —— 每次都只多几 KB，
    # 没有哪一次值得拦下来，而半年后首页要下三百 KB。
    # 量的是**首页真的会拉的那几个 chunk**，不是构建产物总大小：
    # 后者包含所有路由，涨了也不一定影响任何人。
    #
    # 地板（框架自己那一份）用一个**不存在的路径**量：它渲染的是
    # 空白 404，拉到的就是「任何一页都躲不掉」的那几个 chunk。
    # 首页减去它，剩下的才是我们自己加上去的。
    step "首屏体积"

    # 名字里的**连字符**必须收进字符类。
    #
    # 原来写的是 `[a-z0-9_]*`，于是 `290o-o0p8zxxi.js` 这种带 `-` 的
    # 整个匹配不上 —— 不是少算几个字节，是**那个 chunk 根本不存在**。
    # 而首页恰好只有两个带 `-` 的 chunk，其中一个（14 KB gz）
    # 装的正是我们自己的界面代码（「配色方案」「关掉这条公告」都在里面）。
    #
    # 也就是说：这条守卫量到的一直是框架，**它声称要保护的那部分
    # 从来就在它的视野之外**。和 schema 扫描那次是同一个病 ——
    # 正则漏掉一类命名，守卫照常变绿，没有任何地方会喊。
    chunks_of() {
      curl -s -m 10 "$1" | grep -oE '/_next/static/chunks/[A-Za-z0-9_-]+\.js' | sort -u
    }
    sum_of() {
      local total=0 size
      while read -r chunk; do
        [ -n "$chunk" ] || continue
        # 带上 Accept-Encoding：量的是用户真的要下的字节数
        size=$(curl -s -m 10 -H 'Accept-Encoding: br, gzip' -o /dev/null -w '%{size_download}' "$URL$chunk" || echo 0)
        total=$((total + size))
      done
      printf '%s' "$total"
    }

    home_list=$(chunks_of "$URL/")
    floor_list=$(chunks_of "$URL$FLOOR_PROBE_PATH")
    app_list=$(comm -23 <(printf '%s\n' "$home_list") <(printf '%s\n' "$floor_list"))

    bytes=$(printf '%s\n' "$home_list" | sum_of)
    app_bytes=$(printf '%s\n' "$app_list" | sum_of)
    floor_bytes=$((bytes - app_bytes))

    printf '  首页 JS %s KB＝框架地板 %s KB ＋ 我们自己的 %s KB（预算 %s KB）\n' \
      "$((bytes / 1024))" "$((floor_bytes / 1024))" \
      "$((app_bytes / 1024))" "$((APP_JS_BUDGET / 1024))"

    if [ "$app_bytes" -gt "$APP_JS_BUDGET" ]; then
      fail "首页自己的 JS 超预算 —— 是我们加进去的，要么拆包/换成服务端组件，要么调高 APP_JS_BUDGET 并说明换来了什么"
    fi
    if [ "$bytes" -gt "$JS_BUDGET" ]; then
      # 这一条不是我们写的代码涨的，但用户照样要下 —— 所以仍然要拦
      fail "首屏 JS 总量超上限（地板 $((floor_bytes / 1024)) KB）—— 框架这一层变重了，确认是升级带来的再调 JS_BUDGET"
    fi

    step "完成"
    curl -s -m 10 "$URL/api/health" | head -c 200
    echo
    exit 0
  fi
  printf '  第 %s 次：%s\n' "$attempt" "$code"
  sleep 2
done

ssh "$HOST" "sudo journalctl -u agenticlab -u agenticlab-blue -u agenticlab-green -n 20 --no-pager" || true
fail "站点没起来"
