import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db, sqlite } from "@/lib/db";
import { groupMembers, linkSaves, links } from "@/lib/db/schema";
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
  shareCount: number;
  firstSharedAt: number;
  lastSharedAt: number;
  /** 在**你看得到的群里**被分享过几次 —— 不是全站次数 */
  visibleShares: number;
  sharers: string[];
  saved: boolean;
}

export interface DomainFacet {
  domain: string;
  label: string;
  count: number;
}

export interface LinkQuery {
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
      `SELECT l.id, l.url, l.domain, l.title, l.note, l.share_count AS shareCount,
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

  let items: LinkItem[] = rows.map((row) => ({
    id: row.id,
    url: row.url,
    domain: row.domain,
    domainLabel: domainLabel(row.domain),
    title: row.title,
    note: row.note,
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
  if (query.q) {
    const needle = query.q.trim().toLowerCase();
    if (needle) {
      items = items.filter(
        (i) =>
          i.title.toLowerCase().includes(needle) ||
          i.url.toLowerCase().includes(needle) ||
          (i.note ?? "").toLowerCase().includes(needle),
      );
    }
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

/** 后台看全站，前台看同群 —— 两者不同是对的 */
export function allLinksForAdmin(limit = 200) {
  return db
    .select()
    .from(links)
    .orderBy(sql`${links.lastSharedAt} DESC`)
    .limit(limit)
    .all()
    .map((l) => ({ ...l, domainLabel: domainLabel(l.domain) }));
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

export function isSaved(userId: string, linkIds: string[]): Set<string> {
  if (linkIds.length === 0) return new Set();
  return new Set(
    db
      .select({ linkId: linkSaves.linkId })
      .from(linkSaves)
      .where(and(eq(linkSaves.userId, userId), inArray(linkSaves.linkId, linkIds)))
      .all()
      .map((s) => s.linkId),
  );
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
