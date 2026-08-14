import type { ReleaseManifest } from "./release-rules";

/**
 * 「这次请求想要的是安装脚本，还是网页」。纯规则。
 *
 * ═════════════════════════════════════════
 * 判错的后果是一整页 HTML 被灌进 bash
 * ═════════════════════════════════════════
 *
 * `curl -Ls agenticlab.sh | bash` 要在裸域名上拿到一段 shell，
 * 而浏览器打开同一个地址要拿到网页。同一个 URL，两种东西。
 *
 * 判宽了（把浏览器当成 curl）：有人打开首页看到一屏 shell 源码。
 * 难看，但无害，而且当场就看得见。
 *
 * 判窄了（把 curl 当成浏览器）：**一整页 HTML 进了 bash**。
 * 绝大多数行会报「command not found」然后继续往下跑 ——
 * 而 HTML 里恰好有一行能被 shell 执行的东西的话，它就执行了。
 *
 * 两种错误的代价不对称，所以判据要**同时**满足两条：
 * UA 像命令行工具，**且** Accept 里没有 text/html。
 * 少任何一条都会有正常浏览器落进来。
 *
 * ─────────────────────────────────────────
 * 为什么判据在应用里，而不是 nginx 配置里
 * ─────────────────────────────────────────
 *
 * nginx 配置没有测试。而这一条一旦写错，症状是
 * 「某些人 curl 一下拿到了网页」—— 那些人不会来报，
 * 他们只会觉得这个安装命令是假的。
 */

/**
 * 认得出的命令行下载工具。
 *
 * ─────────────────────────────────────────
 * 白名单，不是「不像浏览器就算」
 * ─────────────────────────────────────────
 *
 * 反过来写（黑名单排除 Mozilla/Chrome/Safari）会把每一个
 * 认不出的 UA 都判成命令行 —— 而认不出的 UA 里有微信内置浏览器
 * 的一部分版本、有各种小众浏览器、有搜索引擎爬虫。
 *
 * 名单漏一个的代价只是「那个工具拿到网页」，人换成 curl 就好了。
 */
const CLI_AGENTS = [
  "curl/",
  "wget/",
  "httpie/",
  "libcurl/",
  "powershell/",
  /*
   * `fetch` 是 BSD 的下载工具，`aria2` 也有人用。
   * 加它们不是为了完整 —— 是因为它们的 UA 里
   * 恰好也没有 `text/html`，误判的概率极低。
   */
  "fetch/",
  "aria2/",
];

export function looksLikeCli(userAgent: string | null | undefined): boolean {
  if (!userAgent) {
    /*
     * 没有 UA 的**不算**命令行。
     *
     * 很多扫描器和探活工具不带 UA，而它们的请求量远大于真人。
     * 判成命令行的话，安装脚本会被当成首页反复抓走 ——
     * 不危险，但它会把这条判定的日志淹掉，
     * 而那些日志是「有多少人在装」的唯一来源。
     */
    return false;
  }
  const ua = userAgent.toLowerCase();
  return CLI_AGENTS.some((a) => ua.includes(a));
}

/**
 * 明确想要 HTML 吗。
 *
 * `curl` 默认发的是 `Accept: * / *`，浏览器一定带 `text/html`。
 * 所以这一条是那个不对称判据里更硬的那一半。
 */
export function wantsHtml(accept: string | null | undefined): boolean {
  if (!accept) return false;
  return accept.toLowerCase().includes("text/html");
}

/** 两条都满足才给脚本 */
export function wantsInstallScript(headers: {
  userAgent?: string | null;
  accept?: string | null;
}): boolean {
  return looksLikeCli(headers.userAgent) && !wantsHtml(headers.accept);
}

/* ── 那段 shell 本身 ────────────────────────────────── */

/**
 * 拼出 `curl -Ls agenticlab.sh | bash` 那段脚本。
 *
 * ─────────────────────────────────────────
 * 收参数而不是自己去读设置，是为了**能被测**
 * ─────────────────────────────────────────
 *
 * 这段脚本是生成出来的，而它会被一千多人管道进 bash ——
 * 一个语法错误就是所有人装不上，而且是**静默**的：
 * bash 会把它能解析的那部分跑完。
 *
 * 自己读设置的话，测它就要起一个数据库；而不测它就等于
 * 把一段没人验证过的 shell 发给所有人。
 * `tests/tui-install.test.ts` 现在拿一份假清单渲染它，
 * 然后用 `bash -n` 真的解析一遍。
 */
export function renderInstallScript(manifest: ReleaseManifest | null, site: string): string {
  /*
   * 没发布过的时候给一段**会好好解释的**脚本，而不是 404。
   *
   * 404 在管道里的表现是「什么也没发生」—— 人会以为命令跑成功了，
   * 然后去敲 `ash`，再拿到一句 command not found。
   */
  if (!manifest) {
    return [
      "#!/usr/bin/env bash",
      "echo '这个站还没有发布终端客户端。' >&2",
      "echo '源码在仓库的 tui/ 目录下，可以自己 go build。' >&2",
      "exit 1",
      "",
    ].join("\n");
  }

  const cases = manifest.assets
    .map((a) => `    ${a.platform}) url="${a.url}"; want="${a.sha256}" ;;`)
    .join("\n");

  return `#!/usr/bin/env bash
# Agentic Lab 终端客户端安装脚本
#   curl -Ls ${site.replace(/^https?:\/\//, "")} | bash
#
# 这段脚本只做六件事，每一件失败都会说清楚是哪一件：
#   探测平台 → 下载 → 校验 sha256 → 装进 PATH → 注册两个名字 → 装补全
#
# 整段包在一个函数里，最后一行才调用 —— 见 lib/tui/install-script.ts 顶上：
# curl | bash 是边下边执行的，下到一半断线时不能跑半截。

set -euo pipefail

main() {
  local version="${manifest.version}"
  local bindir="\${ASH_BIN_DIR:-$HOME/.local/bin}"
  local os arch platform url want tmp got

  # ── 一、探测平台 ────────────────────────────────────
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) die "没有为 $arch 预编译的二进制。源码在仓库 tui/ 目录，可以自己 go build" ;;
  esac
  platform="\${os}-\${arch}"

  case "$platform" in
${cases}
    *) die "没有为 $platform 预编译的二进制。源码在仓库 tui/ 目录，可以自己 go build" ;;
  esac

  need curl
  need shasum_or_sha256sum

  say "正在安装 Agentic Lab 终端客户端 \${version}（\${platform}）"

  # ── 二、下载 ────────────────────────────────────────
  #
  # 下到临时目录再原子移动。直接往 $bindir 里写的话，
  # 下载中断会留下一个半截的可执行文件 —— 而它是有执行位的，
  # 人敲下去看到的是一句莫名其妙的报错，而不是「没装成」。
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$tmp/ash" "$url" \\
    || die "下载失败：$url"

  # ── 三、校验 ────────────────────────────────────────
  #
  # 这一步不能省。自更新和安装做的都是「拿一个文件当可执行程序跑」，
  # 没有校验和的话，一次半截下载或者一次被改掉的对象存储
  # 就等于一条远程执行。
  got="$(hashof "$tmp/ash")"
  if [ "$got" != "$want" ]; then
    die "校验和对不上，装不了。期望 \${want}，实际 \${got} —— 别跑这个文件，把这行贴给站长"
  fi

  # ── 四、装进 PATH ───────────────────────────────────
  mkdir -p "$bindir"
  chmod +x "$tmp/ash"
  mv -f "$tmp/ash" "$bindir/ash.new"
  mv -f "$bindir/ash.new" "$bindir/ash"

  # ── 五、两个名字 ────────────────────────────────────
  #
  # \`ash\` 是每天敲的那个（三个字母），
  # \`agenticlab.sh\` 是**别人在群里贴出来的那个** ——
  # 一个人看到安装命令之后，最可能敲的下一个命令就是它。
  # 它不在的话，他会以为装失败了。
  ln -sf "$bindir/ash" "$bindir/agenticlab.sh"

  # 系统上已经有 ash（Alpine 的 /bin/ash 是个 shell）就不抢这个名字。
  # 静默覆盖别人的 shell 是这段脚本能造成的最大伤害。
  if command -v ash >/dev/null 2>&1 && [ "$(command -v ash)" != "$bindir/ash" ]; then
    say "注意：$(command -v ash) 已经存在（多半是 Almquist shell），没有覆盖它。"
    say "     用 agenticlab.sh 这个名字启动，或者把 $bindir 放到 PATH 更前面。"
  fi

  # ── 六、shell 补全 ──────────────────────────────────
  install_completion "$bindir"

  case ":$PATH:" in
    *":$bindir:"*) ;;
    *)
      say ""
      say "$bindir 不在 PATH 里。加上这一行（然后重开终端）："
      say "  export PATH=\\"$bindir:\\$PATH\\""
      ;;
  esac

  say ""
  say "装好了。敲 ash 进去，或者 agenticlab.sh —— 两个是同一个东西。"
  say "没有账号也能进：里面会给你一串码，在浏览器里确认一下就行。"
}

# ── 小工具 ────────────────────────────────────────────

say() { printf '%s\\n' "$*"; }
die() { printf '%s\\n' "$*" >&2; exit 1; }

need() {
  case "$1" in
    shasum_or_sha256sum)
      command -v sha256sum >/dev/null 2>&1 && return 0
      command -v shasum >/dev/null 2>&1 && return 0
      die "找不到 sha256sum 或 shasum，没法校验下载的文件 —— 不校验就不装"
      ;;
    *)
      command -v "$1" >/dev/null 2>&1 || die "找不到 $1"
      ;;
  esac
}

# macOS 上没有 sha256sum，只有 shasum -a 256。两者输出格式一样
hashof() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

install_completion() {
  local bindir="$1" dir
  # 补全装不上不算失败 —— 它是锦上添花，而这段脚本开着 set -e
  if [ -n "\${ZSH_VERSION:-}" ] || [ -d "$HOME/.zsh/completions" ]; then
    dir="$HOME/.zsh/completions"
    mkdir -p "$dir" && "$bindir/ash" completion zsh >"$dir/_ash" 2>/dev/null || true
  fi
  if [ -d "$HOME/.bash_completion.d" ] || [ -n "\${BASH_VERSION:-}" ]; then
    dir="$HOME/.bash_completion.d"
    mkdir -p "$dir" && "$bindir/ash" completion bash >"$dir/ash" 2>/dev/null || true
  fi
}

# 最后一行才调用 —— 上面那一大段没下完的话，这一行不会出现，于是一行都不会跑
main "$@"
`;
}
