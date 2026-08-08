import "server-only";

import { and, desc, eq, gt, gte, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  appeals,
  auditLogs,
  checkins,
  groups,
  messages,
  people,
  pointsAnomalies,
  pointsLedger,
  posts,
  replies,
  reports,
  sessions,
  storageSnapshots,
  syncJobs,
  users,
} from "@/lib/db/schema";
import { shiftDateKey, startOfDayMs, todayKey } from "@/lib/time";

/**
 * 后台仪表盘的数据。
 *
 * 挑指标的原则：**每个数字都要能指向一个动作**。
 * 「累计消息 41,622」看着漂亮但没人会因为它做任何事；
 * 「3 条举报待处理」「同步失败 2 次」才是要看的。
 * 所以这里把「待办」放在最前面，「规模」放在后面。
 */

export interface PendingWork {
  reports: number;
  appeals: number;
  anomalies: number;
  bindRequests: number;
}

export function pendingWork(): PendingWork {
  const count = (n: number | undefined) => n ?? 0;
  return {
    reports: count(
      db.select({ n: sql<number>`count(*)` }).from(reports).where(eq(reports.status, "open")).get()?.n,
    ),
    appeals: count(
      db.select({ n: sql<number>`count(*)` }).from(appeals).where(eq(appeals.status, "open")).get()?.n,
    ),
    anomalies: count(
      db
        .select({ n: sql<number>`count(*)` })
        .from(pointsAnomalies)
        .where(eq(pointsAnomalies.status, "open"))
        .get()?.n,
    ),
    bindRequests: 0,
  };
}

export interface ActivityStats {
  dau: number;
  wau: number;
  mau: number;
  newBindings7d: number;
  messagesToday: number;
  qualityRateToday: number;
  postsToday: number;
  repliesToday: number;
  checkinsToday: number;
  pointsGrantedToday: number;
}

export function activityStats(): ActivityStats {
  const today = todayKey();
  const dayStart = startOfDayMs(today);
  const now = Date.now();

  const activeSince = (ms: number) =>
    db
      .select({ n: sql<number>`count(distinct ${sessions.userId})` })
      .from(sessions)
      .where(and(gt(sessions.lastSeenAt, now - ms), isNull(sessions.revokedAt)))
      .get()?.n ?? 0;

  const todayMessages =
    db
      .select({
        total: sql<number>`count(*)`,
        quality: sql<number>`sum(${messages.isQuality})`,
      })
      .from(messages)
      .where(gte(messages.ts, dayStart))
      .get() ?? { total: 0, quality: 0 };

  return {
    dau: activeSince(86_400_000),
    wau: activeSince(7 * 86_400_000),
    mau: activeSince(30 * 86_400_000),
    newBindings7d:
      db
        .select({ n: sql<number>`count(*)` })
        .from(users)
        .where(gt(users.firstBoundAt, now - 7 * 86_400_000))
        .get()?.n ?? 0,
    messagesToday: Number(todayMessages.total),
    qualityRateToday:
      Number(todayMessages.total) > 0
        ? Math.round((Number(todayMessages.quality) / Number(todayMessages.total)) * 100)
        : 0,
    postsToday:
      db.select({ n: sql<number>`count(*)` }).from(posts).where(gte(posts.createdAt, dayStart)).get()
        ?.n ?? 0,
    repliesToday:
      db
        .select({ n: sql<number>`count(*)` })
        .from(replies)
        .where(gte(replies.createdAt, dayStart))
        .get()?.n ?? 0,
    checkinsToday:
      db.select({ n: sql<number>`count(*)` }).from(checkins).where(eq(checkins.date, today)).get()
        ?.n ?? 0,
    pointsGrantedToday: Number(
      db
        .select({ n: sql<number>`COALESCE(SUM(CASE WHEN ${pointsLedger.delta} > 0 THEN ${pointsLedger.delta} ELSE 0 END), 0)` })
        .from(pointsLedger)
        .where(gte(pointsLedger.createdAt, dayStart))
        .get()?.n ?? 0,
    ),
  };
}

export interface SystemStatus {
  components: { component: string; status: string; detail: string | null; checkedAt: number }[];
  /** 各组件最近一次探测距今多久，太久说明定时任务本身挂了 */
  staleSeconds: number | null;
  syncFailures24h: number;
  lastSync: { kind: string; status: string; finishedAt: number | null; error: string | null } | null;
  disk: { pct: number; dbBytes: number; takenAt: number } | null;
}

export function systemStatus(): SystemStatus {
  const components = db
    .all<{ component: string; status: string; detail: string | null; checked_at: number }>(sql`
      SELECT component, status, detail, checked_at FROM (
        SELECT component, status, detail, checked_at,
               ROW_NUMBER() OVER (PARTITION BY component ORDER BY checked_at DESC) AS rn
        FROM system_health
      ) WHERE rn = 1
    `)
    .map((row) => ({
      component: row.component,
      status: row.status,
      detail: row.detail,
      checkedAt: row.checked_at,
    }));

  const newest = components.reduce((max, c) => Math.max(max, c.checkedAt), 0);

  const lastSync = db
    .select()
    .from(syncJobs)
    .orderBy(desc(syncJobs.createdAt))
    .get();

  const disk = db.select().from(storageSnapshots).orderBy(desc(storageSnapshots.takenAt)).get();

  return {
    components,
    staleSeconds: newest > 0 ? Math.round((Date.now() - newest) / 1000) : null,
    syncFailures24h:
      db
        .select({ n: sql<number>`count(*)` })
        .from(syncJobs)
        .where(and(eq(syncJobs.status, "failed"), gt(syncJobs.createdAt, Date.now() - 86_400_000)))
        .get()?.n ?? 0,
    lastSync: lastSync
      ? {
          kind: lastSync.kind,
          status: lastSync.status,
          finishedAt: lastSync.finishedAt,
          error: lastSync.error,
        }
      : null,
    disk: disk ? { pct: disk.diskPct, dbBytes: disk.dbBytes, takenAt: disk.takenAt } : null,
  };
}

export interface CommunityScale {
  people: number;
  boundUsers: number;
  groups: number;
  messages: number;
  posts: number;
}

export function communityScale(): CommunityScale {
  return {
    people: db.select({ n: sql<number>`count(*)` }).from(people).get()?.n ?? 0,
    boundUsers:
      db.select({ n: sql<number>`count(*)` }).from(users).where(isNull(users.deletedAt)).get()?.n ?? 0,
    groups:
      db.select({ n: sql<number>`count(*)` }).from(groups).where(eq(groups.syncEnabled, true)).get()
        ?.n ?? 0,
    messages: db.select({ n: sql<number>`count(*)` }).from(messages).get()?.n ?? 0,
    posts:
      db.select({ n: sql<number>`count(*)` }).from(posts).where(isNull(posts.deletedAt)).get()?.n ?? 0,
  };
}

/** 近 14 天的每日消息量，画趋势用 */
export function messageTrend(days = 14) {
  const result: { date: string; total: number; quality: number }[] = [];
  const today = todayKey();

  for (let i = days - 1; i >= 0; i--) {
    const date = shiftDateKey(today, -i);
    const start = startOfDayMs(date);
    const row = db
      .select({
        total: sql<number>`count(*)`,
        quality: sql<number>`sum(${messages.isQuality})`,
      })
      .from(messages)
      .where(and(gte(messages.ts, start), sql`${messages.ts} < ${start + 86_400_000}`))
      .get();
    result.push({
      date,
      total: Number(row?.total ?? 0),
      quality: Number(row?.quality ?? 0),
    });
  }

  return result;
}

export function recentAuditLogs(limit = 12) {
  return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit).all();
}
