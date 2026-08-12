import "server-only";

import { desc, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { githubFacts, posts, replies } from "@/lib/db/schema";

import { githubJson } from "./api";
import { highlightSnippet } from "./code-render";
import {
  apiPathFor,
  codeSnippet,
  pathLabel,
  shouldFetch,
  summaryFactsOf,
  type CodeSnippet,
} from "./link-facts";
import { canonicalUrl, refKey, refsInHtml, type GithubRef } from "./link-refs";

/**
 * 帖子底下那一排「提到的项目」。
 *
 * ═════════════════════════════════════════
 * 读的时候拼，不在发帖时烤进正文
 * ═════════════════════════════════════════
 *
 * 帖子的 HTML 是发表那一刻渲染好存下来的。把「★ 1.2k」写进去的话，
 * 那个数字就永远停在发帖那天 —— 而且**看不出它是旧的**。
 * 一个停住的数字比没有数字更坏：读者会拿它当现在的情况。
 *
 * 所以正文里始终只是一条普通链接，卡片在读的时候从缓存拼出来。
 *
 * ═════════════════════════════════════════
 * 渲染这条路上**绝不联网**
 * ═════════════════════════════════════════
 *
 * 这里只读缓存。缓存里没有就不显示卡片 —— 正文里那条链接原样还在，
 * 读者什么都没少。
 *
 * 反过来（渲染时顺手去问一下 GitHub）会把一个第三方接口
 * **接进每一次打开帖子的路径上**：GitHub 慢一秒，我们的帖子就慢一秒；
 * GitHub 挂了，帖子页跟着挂。而它换来的只是一张卡片早几分钟出现。
 *
 * 补缓存由定时任务干（`agenticlab-github.timer`），见 `fillMentionFacts`。
 */

export interface MentionCard {
  key: string;
  kind: "repo" | "issue" | "pr" | "commit" | "code";
  url: string;
  title: string;
  summary: string | null;
  /** 代码片段那一块的 HTML（已高亮、已消毒）。别的种类为 null */
  body: string | null;
}

/**
 * 一篇帖子底下最多展开几段代码。
 *
 * 和 `MAX_MENTIONS` 是两件事：那个管的是「一共几张卡片」，
 * 而代码块的**高度**是别的卡片的十倍。四段代码摞在帖子底下，
 * 帖子本身会被挤到看不见 —— 这一块是正文的注脚，不是第二篇正文。
 *
 * 超出的那几条不显示卡片，正文里那条链接原样还在。
 */
export const MAX_CODE_CARDS = 2;

/**
 * 这篇帖子该显示哪几张卡片。**只读缓存，不联网。**
 *
 * 顺序跟着正文里出现的顺序 —— 作者先说的排前面。
 * 按缓存表的顺序返回的话，同一篇帖子在不同时候会给出不同的排列，
 * 而那种「每次刷新都换个样」是最容易让人觉得页面坏了的表现。
 */
export function mentionsFor(html: string): MentionCard[] {
  const refs = refsInHtml(html).filter(shouldFetch);
  if (refs.length === 0) return [];

  const keys = refs.map(refKey);
  const rows = db.select().from(githubFacts).where(inArray(githubFacts.key, keys)).all();
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const cards: MentionCard[] = [];
  let codeCards = 0;
  for (const ref of refs) {
    const row = byKey.get(refKey(ref));
    // 没问过、或者问了发现东西没了 —— 都不显示卡片，正文里那条链接还在
    if (!row || row.gone || !row.title) continue;
    if (row.kind === "code") {
      // 取回来了但没有代码 = 半张卡片，比没有更让人以为页面坏了
      if (!row.body) continue;
      if (codeCards >= MAX_CODE_CARDS) continue;
      codeCards++;
    }
    cards.push({
      key: row.key,
      kind: row.kind,
      // 地址用**我们解析出来的**：仓库改名后接口回的是新名，而链接写的是老名
      url: row.url,
      title: row.title,
      summary: row.summary,
      body: row.kind === "code" ? row.body : null,
    });
  }
  return cards;
}

/** 这一批 ref 里，哪些还没问过 —— 定时任务拿它决定要补什么 */
export function unknownRefs(refs: readonly GithubRef[]): GithubRef[] {
  const wanted = refs.filter(shouldFetch);
  if (wanted.length === 0) return [];
  const known = new Set(
    db
      .select({ key: githubFacts.key })
      .from(githubFacts)
      .where(
        inArray(
          githubFacts.key,
          wanted.map(refKey),
        ),
      )
      .all()
      .map((r) => r.key),
  );
  const seen = new Set<string>();
  return wanted.filter((ref) => {
    const key = refKey(ref);
    if (known.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface FillReport {
  asked: number;
  written: number;
  gone: number;
  failed: number;
  notes: string[];
}

/** GitHub 说「没有」的那几个 —— 和资源库那边同一套口径，理由见 link-lookup.ts */
const GONE = new Set([404, 451]);

export type Fetcher = (path: string) => Promise<Record<string, unknown>>;

/**
 * 把还没问过的补上。**只有定时任务会调它**，渲染路径永远不碰。
 *
 * 失败分两类，和资源库那边一模一样：404/451 是结论（记下来，
 * 并且 `gone` 置真，下次不再问）；网络错误、限流、超时是故障，
 * **一行都不写** —— 写了的话一次抖动会让这些 ref 永远不再被问。
 */
export async function fillMentionFacts(
  refs: readonly GithubRef[],
  options: { fetcher?: Fetcher } = {},
): Promise<FillReport> {
  const fetcher: Fetcher = options.fetcher ?? ((path) => githubJson(path));
  const report: FillReport = { asked: 0, written: 0, gone: 0, failed: 0, notes: [] };

  for (const ref of refs) {
    const path = apiPathFor(ref);
    if (!path) continue;
    report.asked++;

    let payload: Record<string, unknown>;
    try {
      payload = await fetcher(path);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (typeof status === "number" && GONE.has(status)) {
        db.insert(githubFacts)
          .values({
            key: refKey(ref),
            kind: ref.kind,
            url: canonicalUrl(ref),
            title: "",
            summary: null,
            checkedAt: Date.now(),
            gone: true,
          })
          .onConflictDoUpdate({
            target: githubFacts.key,
            set: { gone: true, checkedAt: Date.now() },
          })
          .run();
        report.gone++;
        continue;
      }
      report.failed++;
      report.notes.push(`${canonicalUrl(ref)}：${(error as Error).message}`);
      // 限流之后当轮就停 —— 继续跑只是把剩下的每条都换成一次超时
      if (status === 403 || status === 429) {
        report.notes.push("GitHub 限流了，这一轮停在这里 —— 剩下的下次再问");
        break;
      }
      continue;
    }

    const facts = factsOf(ref, payload);
    if (!facts) {
      // 回来了但字段读不出来 —— 是故障不是结论，什么都不写，下次再试
      report.failed++;
      report.notes.push(`${canonicalUrl(ref)}：回复里没有能用的字段`);
      continue;
    }

    /*
     * 代码那一段在**写库之前**高亮好。
     *
     * 放在读的时候做的话，每一个打开这篇帖子的人都要重跑一遍 shiki，
     * 而 sha 固定的内容每次跑出来一模一样（理由写在 code-render.ts）。
     */
    const body = facts.snippet
      ? await highlightSnippet(facts.snippet.code, facts.snippet.lang)
      : null;

    db.insert(githubFacts)
      .values({
        key: refKey(ref),
        kind: ref.kind,
        url: canonicalUrl(ref),
        title: facts.title,
        summary: facts.summary,
        body,
        checkedAt: Date.now(),
        gone: false,
      })
      .onConflictDoUpdate({
        target: githubFacts.key,
        set: {
          title: facts.title,
          summary: facts.summary,
          body,
          checkedAt: Date.now(),
          gone: false,
        },
      })
      .run();
    report.written++;
  }

  return report;
}

/**
 * 一条 ref + 一份回答 → 卡片上要显示的东西。
 *
 * 分派收在这一个函数里，而不是在上面那段循环里摊开写 —— 循环里
 * 那一段管的是「失败怎么记」，那件事对五种 ref 完全一样，
 * 混在一起的话下一个人加第六种时会漏掉其中一条错误处理。
 */
function factsOf(
  ref: GithubRef,
  payload: Record<string, unknown>,
): { title: string; summary: string | null; snippet?: CodeSnippet } | null {
  if (ref.kind !== "code") return summaryFactsOf(ref, payload);

  const snippet = codeSnippet(ref, payload);
  if (!snippet) return null;

  /*
   * 标题是**路径**，不是仓库名。
   *
   * 贴一条代码永久链接的人想说的是「看这个文件的这几行」——
   * 把 owner/repo 摆在最显眼的位置，等于把他说的话换成了另一句。
   * 仓库名退到下面那行小字里，它是背景不是主语。
   */
  const range = snippet.from === snippet.to ? `第 ${snippet.from} 行` : `第 ${snippet.from}–${snippet.to} 行`;
  /*
   * 少给了就要说出来。
   *
   * 作者写的是 `#L10-L200`，我们只显示 20 行 —— 不说的话，
   * 读者会以为他指的就是这 20 行，然后照着一段被截断的代码讨论。
   */
  const omitted = snippet.omitted > 0 ? `，还有 ${snippet.omitted} 行没展开` : "";
  return {
    title: pathLabel(ref.path),
    summary: `${ref.owner}/${ref.repo} · ${range}${omitted}`,
    snippet,
  };
}

/**
 * 扫最近的帖子和回复，把它们提到的 GitHub 东西补进缓存。
 *
 * ─────────────────────────────────────────
 * 为什么只扫「最近的」
 * ─────────────────────────────────────────
 *
 * 一次全表扫描会翻出几百个 ref，而配额是按小时算的 ——
 * 一轮就能把它烧干，之后**新发的帖子反而排在最后面**。
 * 而新帖子恰恰是有人正在读的那些。
 *
 * 老帖子不会永远等着：每一轮都从最新往回扫，缓存里已有的直接跳过，
 * 所以每一轮都会往前多啃一段，最终会追平。
 */
export async function fillRecentMentions(
  options: { posts?: number; refs?: number; fetcher?: Fetcher } = {},
): Promise<FillReport> {
  const scan = options.posts ?? 200;

  const bodies = [
    ...db
      .select({ html: posts.contentHtml })
      .from(posts)
      .orderBy(desc(posts.createdAt))
      .limit(scan)
      .all(),
    ...db
      .select({ html: replies.contentHtml })
      .from(replies)
      .orderBy(desc(replies.createdAt))
      .limit(scan)
      .all(),
  ];

  const all: GithubRef[] = [];
  const seen = new Set<string>();
  for (const { html } of bodies) {
    for (const ref of refsInHtml(html)) {
      const key = refKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(ref);
    }
  }

  /*
   * 一轮最多问这么多。默认卡在 GitHub 匿名配额（60/小时）的一半以内，
   * 给手动重跑和资源库那一步留出余量 —— 它们共用同一个出口 IP，
   * 也就是共用同一份配额。
   */
  const todo = unknownRefs(all).slice(0, options.refs ?? 20);
  return fillMentionFacts(todo, { fetcher: options.fetcher });
}
