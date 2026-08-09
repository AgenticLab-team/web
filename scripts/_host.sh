#!/usr/bin/env bash
#
# 部署脚本共用：算出该 ssh 到哪台机器。
#
# ─────────────────────────────────────────
# 为什么源站地址不能写在仓库里
# ─────────────────────────────────────────
#
# 站点被 DDoS 过一次，换过一次公网 IP，现在整个站躲在 Cloudflare 后面，
# 源站只接受来自 CF 网段的 80/443（见 lockdown-cloudflare.sh）。
#
# 这套防护**唯一的前提是攻击者不知道源站 IP**。而一个写在
# 公开仓库里的地址，就是把这个前提直接送出去 —— 何况这个项目
# 正在准备开源，git 历史里的东西删了也还在。
#
# 所以地址放在 `.deploy-host`（已 gitignore），或者临时用环境变量传。
#
# ─────────────────────────────────────────
# 也不能再写 agenticlab.sh
# ─────────────────────────────────────────
#
# 那个域名现在解析到 Cloudflare，而 **CF 不代理 SSH** ——
# 写它的话每一次部署都会卡在一个莫名其妙的连接超时上。
set -euo pipefail

resolve_deploy_host() {
  if [ -n "${DEPLOY_HOST:-}" ]; then
    printf '%s' "$DEPLOY_HOST"
    return
  fi

  local here file
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  file="$here/.deploy-host"

  if [ -f "$file" ]; then
    # 允许文件里有注释和空行
    grep -vE '^\s*(#|$)' "$file" | head -1 | tr -d '[:space:]'
    return
  fi

  cat >&2 <<'MSG'
✗ 不知道该连哪台机器。

  源站地址不进仓库 —— 站点躲在 Cloudflare 后面，源站只对 CF 网段开 80/443，
  而这套防护的前提就是没人知道源站 IP。

  两种给法，选一种：
    echo 'ubuntu@<源站IP>' > .deploy-host     # 已 gitignore，一次配好
    DEPLOY_HOST=ubuntu@<源站IP> npm run deploy  # 临时

  别写 agenticlab.sh：它现在解析到 Cloudflare，而 CF 不代理 SSH。
MSG
  exit 1
}
