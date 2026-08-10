/**
 * 把正文里出现的 GitHub 链接**认出来**：这是一个仓库、一个 issue、
 * 一个 PR、一次提交，还是一段代码。纯解析，不联网。
 *
 * ═════════════════════════════════════════
 * 为什么值得做
 * ═════════════════════════════════════════
 *
 * 这个社区互相甩的就是 repo 和 PR 链接。而一条裸链接要点进去才知道
 * 是什么，**大多数人不会点** —— 于是「我看到了这条链接」和
 * 「我知道它是什么」之间隔着一次跳转，绝大部分人停在前面那边。
 * 认出来之后才谈得上在帖子里展开成一张说得清「这是什么」的卡片。
 *
 * ═════════════════════════════════════════
 * 域名必须**整个**比对，不能用「包含」
 * ═════════════════════════════════════════
 *
 * 这是这个文件里唯一一处出错就会变成钓鱼的地方：
 *
 *   · `https://github.com.evil.com/a/b` —— 「以 github.com 开头」放行
 *   · `https://evil.com/github.com/a/b` —— 「含有 github.com」放行
 *   · `https://github.com@evil.com/`   —— userinfo 段，肉眼看着像官方
 *
 * 三种写法在人眼里都像 github.com。一旦放行，我们会**亲手给它加上
 * 一张带 GitHub 图标、写着仓库名和 star 数的卡片** —— 那比裸链接
 * 危险得多：卡片是我们做的，读者信的是我们，不是那条链接。
 *
 * 所以只认 `URL.hostname` 的**全等**（大小写归一后），
 * 一个字符都不许多。
 *
 * ═════════════════════════════════════════
 * 代码永久链接只认带 sha 的
 * ═════════════════════════════════════════
 *
 * `/blob/main/x.ts#L10-L20` 指向的内容会随分支移动 —— 帖子底下那段
 * 代码会在某天悄悄变成别的东西，而讨论还停在旧代码上，
 * 读的人完全看不出发生过什么。带 40 位 sha 的才认。
 */

/** 只认这一个域名。全等比对，见文件头 */
const HOST = "github.com";

/**
 * GitHub 自己占用的一级路径 —— 它们不是用户名。
 *
 * 不排掉的话 `github.com/features/actions` 会被认成
 * 「用户 features 的仓库 actions」，然后我们去请求一个不存在的仓库，
 * 拿回 404，再把这条链接**降级显示成一张失败的卡片** ——
 * 比不展开还糟。
 */
const RESERVED = new Set([
  "about", "apps", "collections", "codespaces", "contact", "customer-stories",
  "dashboard", "enterprise", "events", "explore", "features", "gist", "github",
  "issues", "join", "login", "logout", "marketplace", "new", "notifications",
  "orgs", "organizations", "pricing", "pulls", "readme", "search", "security",
  "sessions", "settings", "signup", "site", "solutions", "sponsors", "stars",
  "topics", "trending", "users", "watching",
]);

/** owner / repo 的合法字符。GitHub 自己的规则比这松一点，宁可少认 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA = /^[0-9a-f]{40}$/;

/**
 * 编号必须是**纯数字串**，不能只靠 `Number()` 判。
 *
 * `Number("1e3")` 是 1000，而且 `isSafeInteger(1000)` 为真 ——
 * 于是 `/issues/1e3` 会被认成 **1000 号**：我们展开出来的卡片讲的是
 * 另一个 issue，而链接指向的是别处。一张说得斩钉截铁、内容却和
 * 那条链接对不上的卡片，比不展开危险得多。
 * `+1` / `0x10` / ` 1 ` / `1.0` 同理。
 */
const DIGITS = /^\d+$/;

function issueNumber(raw: string): number | null {
  if (!DIGITS.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

export type GithubRef =
  | { kind: "repo"; owner: string; repo: string }
  | { kind: "issue"; owner: string; repo: string; number: number }
  | { kind: "pr"; owner: string; repo: string; number: number }
  | { kind: "commit"; owner: string; repo: string; sha: string }
  | {
      kind: "code";
      owner: string;
      repo: string;
      sha: string;
      path: string;
      /** 行号区间（1 起，闭区间）。没写行号时为 null */
      lines: { from: number; to: number } | null;
    };

/** `#L10-L20` / `#L10` → 区间。看不懂就当没写 */
function parseLines(hash: string): { from: number; to: number } | null {
  const m = /^#L(\d+)(?:-L(\d+))?$/.exec(hash);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (!Number.isSafeInteger(from) || from < 1) return null;
  if (!Number.isSafeInteger(to) || to < from) return null;
  return { from, to };
}

/**
 * 一条 URL → 它指的是什么。认不出来返回 `null`（调用方就当普通链接）。
 *
 * **认不出来永远是安全的默认**：最坏的结果是少展开一张卡片。
 * 反过来猜错则是给一条我们没看懂的链接盖上我们的章。
 */
export function parseGithubUrl(raw: string): GithubRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  // 只走 https。http 会被中间人改掉，而我们要拿它去请求
  if (url.protocol !== "https:") return null;
  // 域名全等，一个字符都不许多（见文件头）
  if (url.hostname.toLowerCase() !== HOST) return null;
  /*
   * userinfo 段（`https://github.com@evil.com/`）里 hostname 已经是
   * evil.com，上面那条就挡住了。但反过来
   * `https://user@github.com/a/b` 域名确实是 github.com ——
   * 它能正常访问，只是没有任何正当理由这么写。不认。
   */
  if (url.username || url.password) return null;
  if (url.port) return null;

  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) return null;

  const [owner, repoRaw, ...rest] = parts;
  if (RESERVED.has(owner.toLowerCase())) return null;
  if (!NAME.test(owner)) return null;

  // 仓库名末尾的 .git 是 clone 地址粘过来的，指的是同一个仓库
  const repo = repoRaw.replace(/\.git$/, "");
  if (!NAME.test(repo)) return null;

  if (rest.length === 0) return { kind: "repo", owner, repo };

  const [section, ...tail] = rest;

  if ((section === "issues" || section === "pull") && tail.length === 1) {
    const number = issueNumber(tail[0]);
    if (number === null) return null;
    return { kind: section === "issues" ? "issue" : "pr", owner, repo, number };
  }

  if (section === "commit" && tail.length === 1 && SHA.test(tail[0])) {
    return { kind: "commit", owner, repo, sha: tail[0] };
  }

  if (section === "blob" && tail.length >= 2) {
    const [sha, ...pathParts] = tail;
    // 只认 40 位 sha —— 分支名指向的内容会在帖子底下悄悄变（见文件头）
    if (!SHA.test(sha)) return null;
    const path = pathParts.join("/");
    if (!path) return null;
    return { kind: "code", owner, repo, sha, path, lines: parseLines(url.hash) };
  }

  /*
   * 别的（/tree/、/releases/、/actions/…）暂时不认。
   * 不认 = 保持成一条普通链接，读者照样点得动 —— 这一层的缺省
   * 必须是「什么都不做」，而不是「尽量猜」。
   */
  return null;
}

/*
 * `owner/repo#123` 那种简写**故意还没写**。
 *
 * 它在 ROADMAP 上是单独一条，而这一版没有任何地方会调用它 ——
 * 先写好放着的辅助函数，读起来像有人在守着，实际什么都没守
 * （见 LESSONS「一边清死开关，一边造死开关」）。真要用的时候
 * 它也就十几行，而且那时候才知道它该返回什么形状。
 */
