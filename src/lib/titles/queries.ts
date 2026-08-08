import "server-only";

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { checkins, posts, replies, titles, userTitles, users } from "@/lib/db/schema";
import { isTitleActive, isTitleExpired, type AchievementStats } from "@/lib/titles/rules";

/**
 * 称号的读取层。
 *
 * 与 actions.ts 分开：那边是 "use server"，只能导出 async 函数。
 */

export interface OwnedTitle {
  userTitleId: string;
  titleId: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  rarity: string;
  source: string;
  expiresAt: number | null;
  revokedAt: number | null;
  active: boolean;
  expired: boolean;
  equipped: boolean;
  createdAt: number;
}

export function titlesOf(userId: string, now = Date.now()): OwnedTitle[] {
  const user = db.select({ activeTitleId: users.activeTitleId }).from(users).where(eq(users.id, userId)).get();

  return db
    .select({ ut: userTitles, t: titles })
    .from(userTitles)
    .innerJoin(titles, eq(titles.id, userTitles.titleId))
    .where(and(eq(userTitles.userId, userId), isNull(titles.deletedAt)))
    .orderBy(desc(titles.sort), desc(userTitles.createdAt))
    .all()
    .map(({ ut, t }) => ({
      userTitleId: ut.id,
      titleId: t.id,
      key: t.key,
      name: t.name,
      description: t.description,
      icon: t.icon,
      rarity: t.rarity,
      source: ut.source,
      expiresAt: ut.expiresAt,
      revokedAt: ut.revokedAt,
      active: isTitleActive(ut, now),
      expired: isTitleExpired(ut, now),
      equipped: user?.activeTitleId === t.id,
      createdAt: ut.createdAt,
    }));
}

/**
 * 某人当前佩戴的称号。
 *
 * **要重新校验有效期**：activeTitleId 是一个冗余列，
 * 租用的称号到期后没有任何人会去把它清掉 ——
 * 不校验的话，过期称号会一直挂在名字后面。
 */
export function equippedTitle(userId: string, now = Date.now()) {
  const row = db
    .select({ t: titles, ut: userTitles })
    .from(users)
    .innerJoin(titles, eq(titles.id, users.activeTitleId))
    .innerJoin(
      userTitles,
      and(eq(userTitles.titleId, titles.id), eq(userTitles.userId, users.id)),
    )
    .where(eq(users.id, userId))
    .get();

  if (!row || !isTitleActive(row.ut, now)) return null;
  return { id: row.t.id, name: row.t.name, icon: row.t.icon, rarity: row.t.rarity };
}

/** 批量取佩戴称号，列表页用 —— 逐个查会打出 N+1 */
export function equippedTitles(userIds: string[], now = Date.now()) {
  if (userIds.length === 0) return new Map<string, { name: string; icon: string | null; rarity: string }>();

  const rows = db
    .select({ userId: users.id, t: titles, ut: userTitles })
    .from(users)
    .innerJoin(titles, eq(titles.id, users.activeTitleId))
    .innerJoin(userTitles, and(eq(userTitles.titleId, titles.id), eq(userTitles.userId, users.id)))
    .where(sql`${users.id} in ${userIds}`)
    .all();

  const map = new Map<string, { name: string; icon: string | null; rarity: string }>();
  for (const row of rows) {
    if (!isTitleActive(row.ut, now)) continue;
    map.set(row.userId, { name: row.t.name, icon: row.t.icon, rarity: row.t.rarity });
  }
  return map;
}

/** 在册持有人数。名额判定要用它，撤销和过期的不算 */
export function holderCount(titleId: string, now = Date.now()): number {
  return db
    .select({ ut: userTitles })
    .from(userTitles)
    .where(and(eq(userTitles.titleId, titleId), isNull(userTitles.revokedAt)))
    .all()
    .filter((r) => isTitleActive(r.ut, now)).length;
}

export function listTitles(includeDisabled = false) {
  const rows = db
    .select()
    .from(titles)
    .where(isNull(titles.deletedAt))
    .orderBy(desc(titles.sort), asc(titles.key))
    .all();
  return includeDisabled ? rows : rows.filter((t) => t.enabled);
}

export function titleByKey(key: string) {
  return db.select().from(titles).where(eq(titles.key, key)).get() ?? null;
}

/** 成就判定用的统计。指标名必须与 AchievementStats 的键一致 */
export function achievementStats(userId: string): AchievementStats {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  const count = (n: unknown) => Number(n ?? 0);

  return {
    pointsTotal: user?.pointsTotal ?? 0,
    streakBest: user?.streakBest ?? 0,
    posts: count(
      db
        .select({ n: sql<number>`count(*)` })
        .from(posts)
        .where(and(eq(posts.authorId, userId), isNull(posts.deletedAt)))
        .get()?.n,
    ),
    replies: count(
      db
        .select({ n: sql<number>`count(*)` })
        .from(replies)
        .where(and(eq(replies.authorId, userId), isNull(replies.deletedAt)))
        .get()?.n,
    ),
    qualityMessages: count(
      db
        .select({ n: sql<number>`coalesce(sum(${checkins.qualityCounted}), 0)` })
        .from(checkins)
        .where(eq(checkins.userId, userId))
        .get()?.n,
    ),
    checkins: count(
      db.select({ n: sql<number>`count(*)` }).from(checkins).where(eq(checkins.userId, userId)).get()
        ?.n,
    ),
  };
}
