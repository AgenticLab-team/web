#!/usr/bin/env bash
#
# 把 80/443 对所有来源打开 —— lockdown-cloudflare.sh 的反面。
#
# ─────────────────────────────────────────
# 为什么这也要写成脚本
# ─────────────────────────────────────────
#
# 「上锁」有脚本而「开锁」靠手敲的话，两边就不对称：开锁那次没人
# review、没人记得当时敲了什么，而半年后想知道「现在到底是哪种状态」
# 只能上服务器看。两个方向各一个脚本，仓库本身就答得上来。
#
# ⚠️ 顺序要紧：**先放行，再删旧规则**。反过来的话，从删完到加上
# 之间 ufw 的默认拒绝会让全站打不开 —— 包括你自己。
#
# ⚠️ 删旧规则时**不要按备注里的关键词去匹配**。第一次做这件事就是
# 这么翻的车：新加的那条放行规则备注里写了「原 cloudflare-only 已撤销」，
# 于是 `grep cloudflare` 把它自己一起删了，站当场下线。
# 下面按「有没有 CIDR 网段」来认，那是这些规则真正的共同点。
#
# 用法：bash scripts/open-http.sh
set -euo pipefail

# shellcheck source=scripts/_host.sh
source "$(dirname "${BASH_SOURCE[0]}")/_host.sh"
HOST="$(resolve_deploy_host)"

step() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }

step "在服务器上开放 80/443"
ssh "$HOST" 'bash -s' <<'REMOTE'
set -uo pipefail

# ① 先放行。备注里**不出现任何网段关键词**，见顶上那段
sudo ufw allow proto tcp from any to any port 80,443 comment 'http/https — 对所有来源开放'

# ② 再删掉所有「只放行某个网段」的 80/443 规则。
#    按 CIDR 认（`/` 后面跟数字），不按备注里的词认
for _ in $(seq 1 60); do
  n=$(sudo ufw status numbered \
      | grep -E '^\[ *[0-9]+\] *80,443/tcp' \
      | grep -E '[0-9a-fA-F:.]+/[0-9]+' \
      | sed -n '1s/^.*\[ *\([0-9]*\)\].*/\1/p')
  [ -z "$n" ] && break
  yes | sudo ufw delete "$n" >/dev/null 2>&1
done

sudo ufw status verbose
REMOTE

step "确认还打得开"
curl -s -o /dev/null -w '  经 CDN: HTTP %{http_code}\n' -m 20 https://agenticlab.sh/
