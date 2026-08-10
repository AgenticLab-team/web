import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db, sqlite } from "@/lib/db";
import { groupMembers, linkSaves, linkVotes, links } from "@/lib/db/schema";
import { domainLabel } from "@/lib/links/extract";

/**
 * 资源库的读取。
 *
 * ─────────────────────────────────────────
 * 可见性和成员目录同一条规矩
 * ─────────────────────────────────────────
 *
 * 一条链接你看得到，当且仅当**它至少在你所在的某个群里被分享过**。
 * 链接本身是公开的互联网资源，但「哪个群在讨论什么」是隐私 ——
 * 把别的群分享的东西列给你，等于把那个群的关注点告诉了你。
 *
 * 分享者的名字会显示（你本来就在那个群里看得到他），
 * **但群名不显示** —— 一条链接可能来自你的两个群里的一个，
 * 说出来就等于泄露了另一个群的存在。
 */

export interface LinkItem {
  id: string;
  url: string;
  domain: string;
  domainLabel: string;
  title: string;
  note: string | null;
  /**
   * 模型根据上下文整理出来的标题与简介。
   *
   * **和 title/note 分开传到界面上**，因为界面要说清楚哪一条是机器写的 ——
   * 一个语气笃定的简介，人默认它是可靠的。
   */
  aiTitle: string | null;
  aiSummary: string | null;
  shareCount: number;
  firstSharedAt: number;
  lastSharedAt: number;
  /** 在**你看得到的群里**被分享过几次 —— 不是全站次数 */
  visibleShares: number;
  sharers: string[];
  saved: boolean;
  /** 点赞数（公开）与我点没点过（私人视角） */
  voteCount: number;
  voted: boolean;
}

export interface DomainFacet {
  domain: string;
  label: string;
  count: number;
}

/**
 * 排序方式。
 *
 * ─────────────────────────────────────────
 * 「最有用」不能只靠点赞
 * ─────────────────────────────────────────
 *
 * 线上 213 条链接，**被赞过的只有 2 条**。也就是说
 * 「最有用」这一档实际上是按时间排的 —— 而这一页的价值
 * 恰恰是「两百条里值得看的就那么十几条」。
 *
 * 而「有几个人在群里分享过它」这个信号**一直就在数据里**，
 * 不需要任何人动手：一条被三个人在两个群里贴过的链接，
 * 比一条只被贴过一次的更可能值得看。
 */
export type LinkSort = "recent" | "votes" | "shares";

export interface LinkQuery {
  /** 排序：默认按最近被分享；「最有用」按点赞数 */
  sort?: LinkSort;
  domain?: string;
  q?: string;
  savedOnly?: boolean;
  limit?: number;
}

export interface LinkResult {
  items: LinkItem[];
  facets: DomainFacet[];
  total: number;
  savedCount: number;
}

const EMPTY: LinkResult = { items: [], facets: [], total: 0, savedCount: 0 };

function myGroupIds(user: CurrentUser): string[] {
  if (!user.wxId) return [];
  return db
    .select({ convId: groupMembers.convId })
    .from(groupMembers)
    .where(and(eq(groupMembers.wxId, user.wxId), isNull(groupMembers.leftAt)))
    .all()
    .map((g) => g.convId);
}

export function listLinks(user: CurrentUser | null, query: LinkQuery = {}): LinkResult {
  if (!user) return EMPTY;

  const convIds = myGroupIds(user);
  if (convIds.length === 0) return EMPTY;

  const placeholders = convIds.map(() => "?").join(",");

  /*
   * 可见次数**只数你看得到的群里的分享**。
   *
   * 直接用 links.share_count 的话，一条只在别的群火过的链接会显示
   * 「被分享 12 次」，而你在自己的群里从没见过它 ——
   * 那个数字本身就泄露了别处的热度。
   */
  const rows = sqlite
    .prepare(
      `SELECT l.id, l.url, l.domain, l.title, l.note,
              l.ai_title AS aiTitle, l.ai_summary AS aiSummary, l.share_count AS shareCount,
              l.vote_count AS voteCount,
              l.first_shared_at AS firstSharedAt, l.last_shared_at AS lastSharedAt,
              COUNT(m.id) AS visibleShares,
              MAX(m.shared_at) AS visibleLastAt,
              GROUP_CONCAT(DISTINCT m.sharer_name) AS sharers
       FROM links l
       JOIN link_mentions m ON m.link_id = l.id AND m.conv_id IN (${placeholders})
       WHERE l.hidden = 0
       GROUP BY l.id
       ORDER BY visibleLastAt DESC
       LIMIT 500`,
    )
    .all(...convIds) as {
    id: string;
    url: string;
    domain: string;
    title: string;
    note: string | null;
    aiTitle: string | null;
    aiSummary: string | null;
    voteCount: number;
    shareCount: number;
    firstSharedAt: number;
    lastSharedAt: number;
    visibleShares: number;
    visibleLastAt: number;
    sharers: string | null;
  }[];

  const savedIds = new Set(
    db
      .select({ linkId: linkSaves.linkId })
      .from(linkSaves)
      .where(eq(linkSaves.userId, user.id))
      .all()
      .map((s) => s.linkId),
  );

  // 一次查完自己点过的，避免每条一次查询
  const votedIds = new Set(
    db
      .select({ linkId: linkVotes.linkId })
      .from(linkVotes)
      .where(eq(linkVotes.userId, user.id))
      .all()
      .map((v) => v.linkId),
  );

  let items: LinkItem[] = rows.map((row) => ({
    id: row.id,
    url: row.url,
    domain: row.domain,
    domainLabel: domainLabel(row.domain),
    title: row.title,
    note: row.note,
    aiTitle: row.aiTitle,
    aiSummary: row.aiSummary,
    voteCount: row.voteCount ?? 0,
    voted: votedIds.has(row.id),
    shareCount: row.shareCount,
    firstSharedAt: row.firstSharedAt,
    // 时间也用可见范围里的 —— 和次数一个道理
    lastSharedAt: row.visibleLastAt,
    visibleShares: row.visibleShares,
    sharers: (row.sharers ?? "").split(",").filter(Boolean).slice(0, 3),
    saved: savedIds.has(row.id),
  }));

  const facets = buildDomainFacets(items);
  const total = items.length;
  const savedCount = items.filter((i) => i.saved).length;

  if (query.domain) items = items.filter((i) => i.domain === query.domain);
  if (query.savedOnly) items = items.filter((i) => i.saved);
  /*
   * ─────────────────────────────────────────
   * 这里**不过**「别人能搜到我的发言」那个开关，是想清楚了的
   * ─────────────────────────────────────────
   *
   * 一次对抗性审计把这里报成了漏网之鱼，理由是它显示分享者的名字。
   * 结论是不该过，理由写在这儿，省得下一个人（或者下一轮审计）
   * 再从头纠结一遍：
   *
   * · **这里搜的是链接本身**（标题、网址、备注、AI 整理出来的摘要），
   *   不是消息正文。开关管的是「搜到你说过的话」，
   *   而一条链接的标题不是任何人说的话
   * · 分享者的名字显示出来，和「按天回看」是同一个道理 ——
   *   你本来就在那个群里，那条链接你当时就看见了，是谁发的也看见了。
   *   这里没有多出新的暴露
   * · 真要过滤的话，代价是一条被藏起来的人分享过的链接会**从库里消失**，
   *   而那条链接是所有人的资产，不是他一个人的
   *
   * 边界在于：哪天这里能按**发言人**筛，或者能搜到消息正文，
   * 那它就变成搜索了，必须接上过滤。
   * 这一条有测试盯着（见 tests/privacy-switches.test.ts）。
   */
  if (query.q) {
    const needle = query.q.trim().toLowerCase();
    if (needle) {
      items = items.filter(
        (i) =>
          i.title.toLowerCase().includes(needle) ||
          i.url.toLowerCase().includes(needle) ||
          (i.note ?? "").toLowerCase().includes(needle) ||
          // 整理出来的标题和简介也要能搜到 —— 不然「台风」搜不出中央气象台那条
          (i.aiTitle ?? "").toLowerCase().includes(needle) ||
          (i.aiSummary ?? "").toLowerCase().includes(needle),
      );
    }
  }

  /*
   * 按点赞排时用**点赞数在前、时间在后**的稳定序。
   *
   * 只按点赞数排的话，大量 0 票的条目顺序由数组原顺序决定 ——
   * 那个顺序会随着新消息进来而变，人翻到第二屏就发现刚看过的又出现了。
   */
  if (query.sort === "votes") {
    items = [...items].sort(
      (a, b) => b.voteCount - a.voteCount || b.lastSharedAt - a.lastSharedAt,
    );
  }

  /*
   * 按分享次数排 —— **用 visibleShares，不是 shareCount**。
   *
   * 后者是全站次数。拿它排序的话，顺序本身就泄露了别的群的热度：
   * 一条你在自己群里从没见过的链接排在最前面，
   * 这件事等于告诉你「别处有人在热议它」。
   *
   * 这一页的其它地方（那个次数标）早就只显示 visibleShares 了，
   * 排序漏掉的话，前面所有的小心都白做。
   */
  if (query.sort === "shares") {
    items = [...items].sort(
      (a, b) => b.visibleShares - a.visibleShares || b.lastSharedAt - a.lastSharedAt,
    );
  }

  return { items: items.slice(0, query.limit ?? 200), facets, total, savedCount };
}

/**
 * 域名筛选栏。
 *
 * 只出现一次的域名不进筛选栏 —— 点进去看到一条，
 * 而那一条在总列表里本来就看得到。
 */
function buildDomainFacets(items: LinkItem[]): DomainFacet[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.domain, (counts.get(item.domain) ?? 0) + 1);

  return [...counts]
    .filter(([, count]) => count >= 2)
    .map(([domain, count]) => ({ domain, label: domainLabel(domain), count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, 12);
}

export function linkStats() {
  const row = sqlite
    .prepare(
      `SELECT count(*) total,
              SUM(CASE WHEN hidden = 1 THEN 1 ELSE 0 END) hidden,
              COUNT(DISTINCT domain) domains
       FROM links`,
    )
    .get() as { total: number; hidden: number; domains: number };
  return row;
}

/**
 * 这条链接我看得到吗 —— 收藏之前要判一次。
 *
 * 没有这道判定的话，任何人都能拿一个猜到的 id 去收藏别的群的链接，
 * 然后在自己的收藏页里看到它。**收藏不能成为绕过可见性的后门。**
 */
export function canSeeLink(user: CurrentUser, linkId: string): boolean {
  const convIds = myGroupIds(user);
  if (convIds.length === 0) return false;

  const placeholders = convIds.map(() => "?").join(",");
  const row = sqlite
    .prepare(
      `SELECT 1 FROM link_mentions WHERE link_id = ? AND conv_id IN (${placeholders}) LIMIT 1`,
    )
    .get(linkId, ...convIds);
  return row !== undefined;
}

/**
 * 从明细重算某条链接的点赞数并写回。
 *
 * 这个项目对冗余计数有一条硬规矩:**从明细重算，不做 +1/-1**。
 * 加减法在并发、重试、用户连点之后会慢慢和明细对不上,
 * 而对不上的表现是「数字有点怪」—— 没有人会为一个有点怪的数字去查明细。
 *
 * 重算一次是一条 count(*)，在这个量级上没有任何代价。
 */
export function recountVotes(linkId: string): number {
  const count =
    db
      .select({ n: sql<number>`count(*)` })
      .from(linkVotes)
      .where(eq(linkVotes.linkId, linkId))
      .get()?.n ?? 0;

  db.update(links).set({ voteCount: count }).where(eq(links.id, linkId)).run();
  return count;
}

