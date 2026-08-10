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
 * 这条 ref 值不值得去问 GitHub。
 *
 * commit 和 code 现在不问：它们的「标题」就是那条链接本身写着的东西
 * （哪个仓库、哪个文件、哪几行），去问一趟拿不回更多，
 * 白花一次配额。等真做代码块展开时再说。
 */
export function shouldFetch(ref: GithubRef): boolean {
  return ref.kind === "repo" || ref.kind === "issue" || ref.kind === "pr";
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
    default:
      return null;
  }
}
