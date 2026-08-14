#!/usr/bin/env bash
#
# certbot 续期之后重启收信网关。
#
# ═════════════════════════════════════════
# 为什么非要有这个钩子
# ═════════════════════════════════════════
#
# `gateway.mjs` 是**启动时** `readFileSync` 一次证书的
# （见那个文件里的 `const tls = ...`）。也就是说 certbot 在第 60 天
# 换好新证书之后，网关手上仍然是旧的那张 —— 直到有人碰巧重启它。
#
# 而证书过期在 SMTP 上的症状特别难查：**发信方会静默降级成明文**
# （投递照常成功），或者干脆拒绝投递，取决于对方的策略。
# 两种都不会在我们这边留下任何错误日志。
#
# 装：放进 /etc/letsencrypt/renewal-hooks/deploy/，chmod +x。
# 那个目录里的脚本 certbot 每次成功续期后都会跑。
set -euo pipefail

# 只在续的是网关那张时才动它 —— 站点证书续期跟网关没关系，
# 白重启一次会掐断当时正在投递的连接
case "${RENEWED_LINEAGE:-}" in
  */publicmx.agenticlab.sh) ;;
  *) exit 0 ;;
esac

systemctl restart agenticlab-mail
