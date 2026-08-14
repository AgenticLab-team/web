#!/usr/bin/env bash
#
# 交叉编译终端客户端，算校验和，打出一份能直接贴进后台的发布清单。
#
# ═════════════════════════════════════════
# 它**不上传**，也不改任何线上状态
# ═════════════════════════════════════════
#
# 上传要对象存储的凭据，而那份凭据不该出现在一个能被随手跑的脚本里。
# 改线上状态（写 `tui.release` 那个设置项）要走后台，
# 因为那一步是**发布**——它该有一个人在按，而且该留一条设置历史。
#
# 所以这里只做能重复跑、跑坏了也没有后果的那部分：
# 编译、算 sha256、把清单打到屏幕上。
#
#   bash scripts/tui-release.sh 1.2.3 https://cdn.example.com/ash
#
# 第二个参数是**这些文件将来会被放在哪**的前缀。脚本不验证它 ——
# 它没法验证一个还不存在的地址。填错的后果是所有人更新失败，
# 而那正是为什么最后一步要人肉贴进后台：贴的时候会再看一眼。

set -euo pipefail

VERSION="${1:-}"
URL_PREFIX="${2:-}"

if [ -z "$VERSION" ] || [ -z "$URL_PREFIX" ]; then
  echo "用法：bash scripts/tui-release.sh <版本号> <下载地址前缀>" >&2
  echo "例：  bash scripts/tui-release.sh 1.2.3 https://cdn.example.com/ash" >&2
  exit 1
fi

case "$URL_PREFIX" in
  https://*) ;;
  *)
    # 服务端那侧也会拒（validateManifest 只收 https），在这儿先拦一次：
    # 那边拒的时候人已经上传完文件了
    echo "下载地址必须是 https —— http 配合「下完就替换自己」是一条明文的远程执行" >&2
    exit 1
    ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/tui/dist"
cd "$ROOT/tui"

# 先让生成物跟表对上。忘了这一步的话，编出来的二进制会少几个屏幕，
# 而它自己不知道 —— 那种版本装到人手里才发现
(cd "$ROOT" && npm run tui:gen >/dev/null)

rm -rf "$OUT"
mkdir -p "$OUT"

# 平台清单要和 src/lib/tui/release-rules.ts 里那份白名单一致。
# 多编一个服务端不认，少编一个那个平台的人装不上
PLATFORMS="linux/amd64 linux/arm64 darwin/amd64 darwin/arm64"

echo "编译 v$VERSION …" >&2

assets=""
for p in $PLATFORMS; do
  goos="${p%/*}"
  goarch="${p#*/}"
  name="ash_${VERSION}_${goos}_${goarch}"

  # -s -w 去掉符号表和调试信息：二进制小三成，而它是要被
  # 一千多人各下一遍的东西。真要调试的话本地编一个带符号的
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "-s -w -X main.version=$VERSION" \
    -o "$OUT/$name" ./cmd/ash

  if command -v sha256sum >/dev/null 2>&1; then
    sum="$(sha256sum "$OUT/$name" | cut -d' ' -f1)"
  else
    sum="$(shasum -a 256 "$OUT/$name" | cut -d' ' -f1)"
  fi
  size="$(wc -c <"$OUT/$name" | tr -d ' ')"

  echo "  $goos-$goarch  $(( size / 1048576 )) MB  $sum" >&2

  [ -n "$assets" ] && assets="$assets,"
  assets="$assets
    {
      \"platform\": \"$goos-$goarch\",
      \"url\": \"${URL_PREFIX%/}/$name\",
      \"sha256\": \"$sum\",
      \"size\": $size
    }"
done

# 网关只在服务器上跑，不进发布清单 —— 它由部署流程管。
# 编一个出来是为了确认它没坏
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags "-s -w -X main.version=$VERSION" \
  -o "$OUT/ash-sshd_${VERSION}_linux_amd64" ./cmd/ash-sshd
echo "  网关也编了一个（不进清单，它由部署流程管）" >&2

echo >&2
echo "文件在 tui/dist/。上传之后把下面这段贴进后台 → 系统设置 → tui.release：" >&2
echo >&2

cat <<JSON
{
  "version": "$VERSION",
  "releasedAt": $(date +%s000),
  "notes": "在这里写这一版改了什么，一两句",
  "assets": [$assets
  ]
}
JSON

echo >&2
echo "贴之前核对一遍那几个 sha256 —— 服务端读清单时会校验格式，" >&2
echo "但它没法知道你上传的文件是不是这几个。" >&2
