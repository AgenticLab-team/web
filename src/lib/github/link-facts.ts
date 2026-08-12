import { MAX_SUMMARY_CHARS, MAX_TITLE_CHARS } from "@/lib/links/enrich-rules";

import type { GithubRef } from "./link-refs";

/**
 * 把 GitHub API 的回答整理成资源库那两栏要的「标题 + 一句话」。纯函数。
 *
 * ═════════════════════════════════════════
 * 为什么 GitHub 链接不该去问模型
 * ═════════════════════════════════════════
 *
 * 资源库现在的做法是：把链接和它出现的上下文丢给模型，让它猜
 * 「这是什么」。对一条 GitHub 链接来说这是绕远路 ——
 * **GitHub 自己就会回答这个问题**，而且答案是权威的：
 * 仓库叫什么、一句话简介、什么语言、多少 star、归没归档。
 *
 * 问模型的三个代价：一次调用的钱、一次网络往返的时间，
 * 以及最要紧的 —— **模型会编**。一个语气笃定却说错了的简介，
 * 比空着更坏，因为没有人会去核对。
 *
 * ═════════════════════════════════════════
 * 长度：宁可截断，也不能溢出到别的地方
 * ═════════════════════════════════════════
 *
 * 这两栏和模型写的那两栏共用同一套展示，长度上限也就得一样
 * （`MAX_TITLE_CHARS` / `MAX_SUMMARY_CHARS`）。
 * 从那边 import 而不是抄一份数字：抄的那份迟早和它分叉，
 * 而分叉的表现是「某些卡片会把布局撑破」——
 * 没有人会把它联想到这里。
 */

/** GitHub 仓库接口里我们真的会用的那几个字段 */
export interface RepoPayload {
  full_name?: unknown;
  description?: unknown;
  language?: unknown;
  stargazers_count?: unknown;
  archived?: unknown;
}

/** issue / PR 接口 */
export interface IssuePayload {
  title?: unknown;
  state?: unknown;
  /** 只有 PR 才有这个字段 —— 靠它区分 issue 和 PR */
  pull_request?: unknown;
  merged_at?: unknown;
}

export interface LinkFacts {
  title: string;
  summary: string | null;
}

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;

/**
 * 截断。
 *
 * 用 `[...s]` 按**码点**切而不是 `slice` 按 UTF-16 码元切 ——
 * 后者会把一个 emoji 劈成两半，留下半个代理对，
 * 而半个代理对在页面上是一个「�」。仓库简介里 emoji 很常见。
 */
export function clamp(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  // 留一个字给省略号，让人看得出是截断而不是原文就这么短
  return `${chars.slice(0, max - 1).join("")}…`;
}

/** star 数：四位以上折成 k，省得把标题挤没 */
export function stars(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/**
 * 仓库显示成什么。装不下时**先丢 owner，不丢仓库名**。
 *
 * `facebookresearch/videoseal` 是 26 个字，直接截到 24 会变成
 * `facebookresearch/videos…` —— 被切掉的正好是仓库名，
 * 而那才是识别它的那半个。留下的 `facebookresearch` 谁都知道，
 * 等于用整整 16 个字说了一句废话。
 *
 * 丢掉的 owner 不会消失：下面那行小字会把原始标题带出来。
 */
export function repoLabel(owner: string, repo: string, max = MAX_TITLE_CHARS): string {
  const full = `${owner}/${repo}`;
  if ([...full].length <= max) return full;
  return clamp(repo, max);
}

/**
 * issue / PR 显示成什么。**编号一个字都不能少。**
 *
 * 线上真出过：`open-city-ai/haidian#1061` 有 25 个字，直接截成
 * `open-city-ai/haidian#10…` —— 读起来是 **#10**，而它其实是 #1061。
 *
 * 那不是「显示得不全」，是**显示了一个错的编号**。而且同一份列表里
 * 就摆着 `open-city-ai/haidian#840`，于是 `#10…` 看上去完全正常 ——
 * 那个仓库里真有 10 号。和把 `/issues/1e3` 认成 1000 号是同一类错：
 * 一张说得斩钉截铁、指的却是另一件东西的卡片。
 *
 * 所以先丢 owner，还装不下就截仓库名，编号始终留在最后。
 */
export function issueLabel(
  owner: string,
  repo: string,
  number: number,
  max = MAX_TITLE_CHARS,
): string {
  const tail = `#${number}`;
  const full = `${owner}/${repo}${tail}`;
  if ([...full].length <= max) return full;

  /*
   * 丢掉 owner 之后**先把编号的位置留出来**，剩下多少给仓库名。
   *
   * 这一句同时管两种情况：`repo#n` 装得下时 clamp 一个字都不动，
   * 装不下时截的也只是仓库名。所以不必再单写一个「先试试 repo#n」
   * 的分支 —— 那个分支算出来的结果和这句一模一样
   * （突变测试里删掉它，行为没有任何变化）。
   */
  return `${clamp(repo, Math.max(1, max - [...tail].length))}${tail}`;
}

/**
 * 提交显示成什么。**sha 那一截一个字都不能少。**
 *
 * 和 issueLabel 是同一条理由：`owner/repo@a1b2c3d` 被从右边截掉的话，
 * 剩下的那一串仍然像一个合法的短 sha —— 而它指向的是另一次提交，
 * 或者根本不存在。所以先丢 owner，再截仓库名，sha 始终留在最后。
 *
 * 用 7 位短 sha：GitHub 自己就是这么显示的，而 40 位一行放不下。
 */
export function commitLabel(
  owner: string,
  repo: string,
  sha: string,
  max = MAX_TITLE_CHARS,
): string {
  const tail = `@${sha.slice(0, 7)}`;
  const full = `${owner}/${repo}${tail}`;
  if ([...full].length <= max) return full;
  return `${clamp(repo, Math.max(1, max - [...tail].length))}${tail}`;
}

/**
 * 路径显示成什么 —— **从左边截，留住文件名**。
 *
 * `src/lib/github/link-refs.ts` 装不下时截成
 * `src/lib/github/link-re…` 的话，被切掉的正好是文件名，
 * 而那才是识别它的那半个。和 repoLabel 先丢 owner 是同一条道理，
 * 只是方向相反：仓库名在后面，路径的信息量也在后面。
 */
export function pathLabel(path: string, max = MAX_TITLE_CHARS): string {
  const chars = [...path];
  if (chars.length <= max) return path;
  return `…${chars.slice(chars.length - (max - 1)).join("")}`;
}

/** commit 接口里我们真的会用的那几个字段 */
export interface CommitPayload {
  commit?: unknown;
}

export function commitFacts(ref: GithubRef, payload: CommitPayload): LinkFacts | null {
  if (ref.kind !== "commit") return null;
  const commit = payload.commit;
  const message =
    commit && typeof commit === "object" ? str((commit as { message?: unknown }).message) : null;
  /*
   * 拿不到 message 就整条不算数（返回 null → 调用方按「故障」处理，
   * 下次还会再问）。只剩一个 `owner/repo@sha` 的卡片没有任何价值 ——
   * 那几个字正文里那条链接上就写着，我们等于抄了一遍还占了一块地方。
   */
  if (!message) return null;

  /*
   * 只取第一行。
   *
   * commit message 的正文部分动辄十几行（还常常带着 Co-authored-by、
   * Signed-off-by、issue 链接）。整段贴进帖子底下，一张本来是
   * 「一句话说清这是什么」的卡片会变成比正文还长的一块。
   */
  const subject = message.split("\n")[0].trim();
  if (!subject) return null;

  return {
    title: commitLabel(ref.owner, ref.repo, ref.sha),
    summary: clamp(subject, MAX_SUMMARY_CHARS),
  };
}

/**
 * ═════════════════════════════════════════
 * 代码永久链接展开成代码块
 * ═════════════════════════════════════════
 *
 * 三道上限，各挡一件事。它们不是「性能考虑」，每一条都对应
 * 一种能把帖子页面毁掉的真实内容：
 */

/** 一段最多显示多少行。再多就不是「看一眼他在说哪几行」，是把文件搬过来了 */
export const MAX_SNIPPET_LINES = 20;

/**
 * 单行最多多少字符。
 *
 * 一个 minify 过的文件可以只有一行、几十万字符 —— 不截的话
 * 这一行会把整块横向撑到天边，或者（更糟）被存进库里再读出来。
 */
export const MAX_SNIPPET_LINE_CHARS = 200;

/**
 * 整个文件超过这么大就不展开。
 *
 * contents 接口对 1MB 以上的文件本来就不返回内容，但**不能靠它**：
 * 一个 900KB 的文件它会老老实实返回，而我们只要中间那 20 行，
 * 却得先把 900KB 解码进内存、再切一遍。
 */
export const MAX_FILE_BYTES = 512 * 1024;

/** contents 接口 */
export interface ContentsPayload {
  type?: unknown;
  encoding?: unknown;
  content?: unknown;
  size?: unknown;
}

export interface CodeSnippet {
  /** 纯文本，还没高亮 */
  code: string;
  /** 猜出来的语言，喂给高亮器。认不出是 "text" */
  lang: string;
  /** 真正取到的区间 —— 可能比作者写的短（见 MAX_SNIPPET_LINES） */
  from: number;
  to: number;
  /** 作者写的区间还剩多少行没显示。大于 0 时界面要说出来，不能悄悄少给 */
  omitted: number;
}

/**
 * 扩展名 → 高亮器认的语言名。
 *
 * 认不出来不是错误，退回 `text` ——「没有颜色」和「整块不出现」
 * 差着一个量级，而这个社区贴的文件类型没有边界。
 */
const LANGS: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", swift: "swift", lua: "lua", sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql", json: "json", yml: "yaml", yaml: "yaml", toml: "toml",
  md: "markdown", css: "css", scss: "scss", html: "html", vue: "vue", svelte: "svelte",
  dockerfile: "docker", tf: "terraform", proto: "proto",
};

export function langOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  if (base.toLowerCase() === "dockerfile") return "docker";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return LANGS[ext] ?? "text";
}

/**
 * 把 contents 接口的回答切成要显示的那几行。
 *
 * 认不出来一律返回 null —— 和整条解析层同一个缺省：
 * **不展开永远是安全的**，正文里那条链接原样还在，读者点得动。
 */
export function codeSnippet(ref: GithubRef, payload: ContentsPayload): CodeSnippet | null {
  if (ref.kind !== "code" || !ref.lines) return null;

  /*
   * 目录也会走同一个接口，返回的是一个数组。
   * 不判 type 的话下面 `content` 取到 undefined，表现成一次「故障」，
   * 于是每一轮都会去重问同一个目录。
   */
  if (payload.type !== "file") return null;
  if (payload.encoding !== "base64") return null;
  const size = int(payload.size);
  if (size === null || size > MAX_FILE_BYTES) return null;

  const raw = str(payload.content);
  if (!raw) return null;

  let text: string;
  try {
    text = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return null;
  }

  /*
   * 二进制文件不展开。
   *
   * 一张 png 解成 utf8 是一大团替换字符和控制字符 —— 贴进帖子底下
   * 既没意义又可能把版面弄乱。NUL 字节是最可靠的那条判据。
   */
  if (text.includes("\u0000")) return null;

  const all = text.split("\n");
  const from = ref.lines.from;
  // 作者写的行号超出文件了 —— 多半是文件后来变了，而 sha 固定的链接不该这样。不展开
  if (from > all.length) return null;

  const wanted = Math.min(ref.lines.to, all.length);
  const to = Math.min(wanted, from + MAX_SNIPPET_LINES - 1);
  const code = all
    .slice(from - 1, to)
    // 行尾的 \r 会在 <pre> 里留下一个看不见的字符
    .map((line) => clamp(line.replace(/\r$/, ""), MAX_SNIPPET_LINE_CHARS))
    .join("\n");

  return { code, lang: langOf(ref.path), from, to, omitted: wanted - to };
}

export function repoFacts(ref: GithubRef, payload: RepoPayload): LinkFacts | null {
  if (ref.kind !== "repo") return null;
  /*
   * 标题用**我们自己解析出来的** owner/repo，不用接口回的 full_name。
   *
   * 仓库改名之后 GitHub 会把老地址重定向到新名字，于是接口回的是新名，
   * 而帖子里那条链接写的是老名 —— 卡片和链接对不上，
   * 读者会以为点过去是另一个东西。以链接为准。
   */
  const fullName = repoLabel(ref.owner, ref.repo);
  const desc = str(payload.description);
  const lang = str(payload.language);
  const count = int(payload.stargazers_count);
  const archived = payload.archived === true;

  const bits: string[] = [];
  if (lang) bits.push(lang);
  if (count !== null) bits.push(`★ ${stars(count)}`);
  // 归档了是这条链接最要紧的一件事：它不再更新了
  if (archived) bits.push("已归档");

  const head = bits.length > 0 ? `${bits.join(" · ")}` : null;
  const summary = desc && head ? `${head} — ${desc}` : (desc ?? head);

  return {
    title: fullName,
    summary: summary ? clamp(summary, MAX_SUMMARY_CHARS) : null,
  };
}

export function issueFacts(ref: GithubRef, payload: IssuePayload): LinkFacts | null {
  if (ref.kind !== "issue" && ref.kind !== "pr") return null;
  const title = str(payload.title);
  if (!title) return null;

  /*
   * 是 issue 还是 PR，**以接口为准，不以链接的写法为准**。
   *
   * `/issues/12` 和 `/pull/12` 指的是同一个号，两种写法都能打开 ——
   * 有人会把一个 PR 的地址写成 /issues/ 的形式。按写法认会把
   * 「PR」显示成「issue」，而这两件事在讨论里不是一回事。
   */
  const isPr = payload.pull_request !== undefined && payload.pull_request !== null;
  const merged = str(payload.merged_at) !== null;
  const open = str(payload.state) === "open";

  const kind = isPr ? "PR" : "issue";
  // 合并了的 PR 说「已合并」而不是「已关闭」—— 关掉和合进去是两回事
  const state = merged ? "已合并" : open ? "开着" : "已关闭";

  return {
    title: issueLabel(ref.owner, ref.repo, ref.number),
    summary: clamp(`${kind}·${state} — ${title}`, MAX_SUMMARY_CHARS),
  };
}

/**
 * 一条 ref + 一份回答 → 「标题 + 一句话」。
 *
 * 代码片段**不在这里** —— 它的产物是一个代码块，塞不进
 * `fact_title` / `fact_summary` 那两栏（资源库那一页是一行一条，
 * 不是一块一块）。所以那边用 `wantsSummary` 把 code 挡在外面，
 * 而不是让这个函数返回一个空壳。
 */
export function summaryFactsOf(
  ref: GithubRef,
  payload: Record<string, unknown>,
): LinkFacts | null {
  switch (ref.kind) {
    case "repo":
      return repoFacts(ref, payload);
    case "issue":
    case "pr":
      return issueFacts(ref, payload);
    case "commit":
      return commitFacts(ref, payload);
    case "code":
      return null;
  }
}

/**
 * 资源库那条路只要能变成「标题 + 一句话」的。
 *
 * 和 `shouldFetch` 分开写，是因为两条路要的东西不一样：
 * 帖子底下的卡片能摆一个代码块，资源库的一行摆不下。
 * 共用一个判定的话，资源库会去取代码、然后发现没地方放 ——
 * 表现是每一轮都重问同一条链接，而报告里看起来一切正常
 * （见 link-lookup.ts 里那段「问没问过只看 factCheckedAt」）。
 */
export function wantsSummary(ref: GithubRef): boolean {
  return ref.kind !== "code";
}

/**
 * 这条 ref 值不值得去问 GitHub。
 *
 * ─────────────────────────────────────────
 * 不带行号的代码链接**不问**
 * ─────────────────────────────────────────
 *
 * `/blob/<sha>/some/file.ts` 没写行号时，作者指的是「这个文件」，
 * 而一个文件可能有一万行。取回来也没有一个说得过去的显示方式：
 * 截前 20 行是**替作者选了一段他没选的代码**，而读者会以为
 * 那就是他要说的地方。这一条和整个解析层同一个缺省 ——
 * 拿不准就什么都不做，正文里那条链接原样还在。
 *
 * commit 从「不问」改成「问」了：它的 message 是链接上没有的东西，
 * 而那正是别人贴一次提交时想说的那句话。
 */
export function shouldFetch(ref: GithubRef): boolean {
  if (ref.kind === "code") return ref.lines !== null;
  return true;
}

/** 该请求哪个接口 */
export function apiPathFor(ref: GithubRef): string | null {
  switch (ref.kind) {
    case "repo":
      return `/repos/${ref.owner}/${ref.repo}`;
    case "issue":
    case "pr":
      /*
       * 一律走 `/issues/{n}`，PR 也走它。
       *
       * GitHub 的 issue 接口对 PR 同样返回，并且带上 `pull_request`
       * 字段告诉我们它其实是个 PR —— 而 `/pulls/{n}` 对普通 issue
       * 返回 404。用前者，`/issues/12` 写法的 PR 链接才不会整条失败。
       */
      return `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
    case "commit":
      return `/repos/${ref.owner}/${ref.repo}/commits/${ref.sha}`;
    case "code": {
      if (!ref.lines) return null;
      /*
       * `?ref=<sha>` 而不是分支名 —— 解析层只认带 sha 的链接，
       * 这里跟着它走：同一条链接过一年再取回来必须是同一段代码，
       * 否则帖子底下那段会悄悄变，而讨论还停在旧代码上。
       *
       * 路径逐段编码。整条 encodeURIComponent 会把 `/` 也编掉，
       * 于是请求的是一个名字里带斜杠的文件 —— 404，而且看不出为什么。
       */
      const path = ref.path.split("/").map(encodeURIComponent).join("/");
      return `/repos/${ref.owner}/${ref.repo}/contents/${path}?ref=${ref.sha}`;
    }
  }
}
