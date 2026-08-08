import "server-only";

import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  checkins,
  dailyStats,
  groupMembers,
  posts,
  replies,
  roles,
  userRoles,
  users,
} from "@/lib/db/schema";
import type { Stats } from "@/lib/activities/eligibility";

/**
 * 把用户数据算成资格引擎能吃的指标。
 *
 * 这是「实时显示符合条件的有 N 人」那个功能的地基 ——
 * 60 个名额，你需要在开放**之前**就知道是 500 人抢 60 个，
 * 还是只有 12 个人够格。前者要考虑抽签，后者说明门槛定高了，
 * 而这两种情况的应对完全相反。
 *
 * 所以这里一次算全部人的指标，而不是逐个查 ——
 * 逐个查的话，改一次规则要等几十秒，那这个功能就没人会用。
 */

/** 带窗口的指标要按窗口分别算。`30d` 是最常用的 */
export interface StatsOptions {
  /** 统计窗口天数。不传表示全期 */
  windowDays?: number;
}

export interface UserStats extends Stats {
  userId: string;
  name: string;
}

function windowStart(days: number | undefined): string | null {
  if (!days) return null;
  const d = new Date(Date.now() - days * 86_400_000);
  // dailyStats.date 是 YYYY-MM-DD（东八区），这里按同样口径切
  const shifted = new Date(d.getTime() + 8 * 3600_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * 一次算出所有账号的指标。
 *
 * **只算注册过的账号**，不算 people 里的一千八百人 ——
 * 活动要报名，而没有账号的人报不了名。
 */
export function computeAllStats(options: StatsOptions = {}): UserStats[] {
  const since = windowStart(options.windowDays);

  const accounts = db
    .select({
      id: users.id,
      wxId: users.wxId,
      site: users.siteNickname,
      wx: users.wxNickname,
      level: users.level,
      points: users.points,
      pointsTotal: users.pointsTotal,
      streakBest: users.streakBest,
      firstBoundAt: users.firstBoundAt,
      createdAt: users.createdAt,
      status: users.status,
    })
    .from(users)
    .where(and(isNull(users.deletedAt), eq(users.status, "active")))
    .all();

  if (accounts.length === 0) return [];

  const wxIds = accounts.map((a) => a.wxId).filter(Boolean) as string[];

  // 群聊指标从 daily_stats 聚合，不扫 messages 全表 —— 后者会让这个功能慢到没人用
  const chat = new Map<string, { messages: number; quality: number; days: number }>();
  if (wxIds.length > 0) {
    const conditions = [inArray(dailyStats.wxId, wxIds)];
    if (since) conditions.push(gte(dailyStats.date, since));

    for (const row of db
      .select({
        wxId: dailyStats.wxId,
        messages: sql<number>`sum(${dailyStats.messages})`,
        quality: sql<number>`sum(${dailyStats.qualityMessages})`,
        days: sql<number>`count(distinct ${dailyStats.date})`,
      })
      .from(dailyStats)
      .where(and(...conditions))
      .groupBy(dailyStats.wxId)
      .all()) {
      chat.set(row.wxId, {
        messages: Number(row.messages),
        quality: Number(row.quality),
        days: Number(row.days),
      });
    }
  }

  const groupsOf = new Map<string, string[]>();
  if (wxIds.length > 0) {
    for (const row of db
      .select({ wxId: groupMembers.wxId, convId: groupMembers.convId })
      .from(groupMembers)
      .where(and(inArray(groupMembers.wxId, wxIds), isNull(groupMembers.leftAt)))
      .all()) {
      const list = groupsOf.get(row.wxId) ?? [];
      list.push(row.convId);
      groupsOf.set(row.wxId, list);
    }
  }

  const ids = accounts.map((a) => a.id);

  const postCounts = countBy(
    db
      .select({ id: posts.authorId, n: sql<number>`count(*)` })
      .from(posts)
      .where(and(inArray(posts.authorId, ids), isNull(posts.deletedAt)))
      .groupBy(posts.authorId)
      .all(),
  );

  const replyCounts = countBy(
    db
      .select({ id: replies.authorId, n: sql<number>`count(*)` })
      .from(replies)
      .where(and(inArray(replies.authorId, ids), isNull(replies.deletedAt)))
      .groupBy(replies.authorId)
      .all(),
  );

  const checkinCounts = countBy(
    db
      .select({ id: checkins.userId, n: sql<number>`count(*)` })
      .from(checkins)
      .where(inArray(checkins.userId, ids))
      .groupBy(checkins.userId)
      .all(),
  );

  const roleKeys = new Map<string, string[]>();
  for (const row of db
    .select({ userId: userRoles.userId, key: roles.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(inArray(userRoles.userId, ids), isNull(userRoles.revokedAt)))
    .all()) {
    const list = roleKeys.get(row.userId) ?? [];
    list.push(row.key);
    roleKeys.set(row.userId, list);
  }

  return accounts.map((a) => {
    const c = a.wxId ? chat.get(a.wxId) : undefined;
    const bound = a.firstBoundAt ?? a.createdAt;

    return {
      userId: a.id,
      name: a.site ?? a.wx ?? a.id,

      messages: c?.messages ?? 0,
      quality_messages: c?.quality ?? 0,
      active_days: c?.days ?? 0,

      level: a.level,
      points: a.points,
      points_total: a.pointsTotal,
      streak: a.streakBest,
      checkins: checkinCounts.get(a.id) ?? 0,

      forum_posts: postCounts.get(a.id) ?? 0,
      forum_replies: replyCounts.get(a.id) ?? 0,

      // 日期型指标存成 YYYY-MM-DD，与规则里的写法一致
      bound_since: new Date(bound).toISOString().slice(0, 10),
      in_group: a.wxId ? (groupsOf.get(a.wxId) ?? []) : [],
      has_role: roleKeys.get(a.id) ?? [],
    } satisfies UserStats;
  });
}

function countBy(rows: { id: string; n: number }[]): Map<string, number> {
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

/** 单个人的指标。申请时冻结快照用它 */
export function computeStatsFor(userId: string, options: StatsOptions = {}): UserStats | null {
  return computeAllStats(options).find((s) => s.userId === userId) ?? null;
}
