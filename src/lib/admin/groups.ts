import "server-only";

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { dailyStats, groups, messages, syncCursors, syncJobs } from "@/lib/db/schema";
import { classifyFreshness, syncHealth, type FreshnessVerdict, type SyncHealth } from "@/lib/sync/health";
import { isStaleRunning } from "@/lib/sync/queue";
import { getSettingInt } from "@/lib/settings/store";
import { shiftDateKey, todayKey } from "@/lib/time";

/**
 * 群与数据源的管理视图。
 *
 * 这一页要回答的核心问题是「**数据还在进来吗**」。
 * 上游断了的表现是消息数不再增长，而那和「大家今天没说话」
 * 在数据上长得一模一样 —— 所以判定必须相对于每个群自己的节奏，
 * 逻辑在 sync/health.ts（纯函数、可单测）。
 */

export interface GroupRow {
  convId: string;
  name: string;
  avatarUrl: string | null;
  bound: boolean;
  syncEnabled: boolean;
  syncExcluded: boolean;

  qualityMin: number | null;
  effectiveQualityMin: number;
  countForPoints: boolean;
  publicLeaderboard: boolean;
  retentionDays: number | null;

  memberCount: number;
  /** 冗余列 */
  messageCount: number;
  /** 真实条数 */
  liveMessages: number;
  lastMessageAt: number | null;

  /** 最近 14 天日均 */
  dailyAverage: number;
  freshness: FreshnessVerdict;
}

const SAMPLE_DAYS = 14;

export function listGroupsForAdmin(now = Date.now()): GroupRow[] {
  const rows = db.select().from(groups).orderBy(desc(groups.messageCount)).all();
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.convId);
  const globalQualityMin = getSettingInt("sync.quality_min", 15);

  const live = new Map(
    db
      .select({
        convId: messages.convId,
        n: sql<number>`count(*)`,
        last: sql<number>`max(${messages.ts})`,
      })
      .from(messages)
      .where(inArray(messages.convId, ids))
      .groupBy(messages.convId)
      .all()
      .map((r) => [r.convId, { count: Number(r.n), last: Number(r.last) }]),
  );

  /*
   * 日均从 daily_stats 算，不从 messages 现算 ——
   * 后者要扫全表，群一多这一页就慢得没法用。
   */
  const since = shiftDateKey(todayKey(), -SAMPLE_DAYS);
  const paces = new Map(
    db
      .select({
        convId: dailyStats.convId,
        total: sql<number>`sum(${dailyStats.messages})`,
        days: sql<number>`count(distinct ${dailyStats.date})`,
      })
      .from(dailyStats)
      .where(and(inArray(dailyStats.convId, ids), gte(dailyStats.date, since)))
      .groupBy(dailyStats.convId)
      .all()
      .map((r) => [r.convId, { total: Number(r.total), days: Number(r.days) }]),
  );

  return rows.map((row) => {
    const stat = live.get(row.convId);
    const pace = paces.get(row.convId);
    const sampleDays = pace?.days ?? 0;
    const dailyAverage = sampleDays > 0 ? (pace?.total ?? 0) / sampleDays : 0;
    const lastMessageAt = stat?.last ?? row.lastMessageAt ?? null;

    return {
      convId: row.convId,
      name: row.name,
      avatarUrl: row.avatarUrl,
      bound: row.bound,
      syncEnabled: row.syncEnabled,
      syncExcluded: row.syncExcluded,

      qualityMin: row.qualityMin,
      effectiveQualityMin: row.qualityMin ?? globalQualityMin,
      countForPoints: row.countForPoints,
      publicLeaderboard: row.publicLeaderboard,
      retentionDays: row.retentionDays,

      memberCount: row.memberCount,
      messageCount: row.messageCount,
      liveMessages: stat?.count ?? 0,
      lastMessageAt,

      dailyAverage,
      // 没接入同步的群不做新鲜度判定 —— 它本来就不该有数据
      freshness: row.syncEnabled
        ? classifyFreshness({ lastMessageAt, dailyAverage, sampleDays }, now)
        : {
            level: "unknown" as const,
            silentMs: null,
            toleranceMs: 0,
            message: "未接入同步",
          },
    };
  });
}

export interface SyncKindHealth {
  kind: string;
  label: string;
  health: SyncHealth;
  recent: {
    id: string;
    status: string;
    scope: string | null;
    itemsFetched: number;
    itemsWritten: number;
    durationMs: number | null;
    error: string | null;
    retryCount: number;
    triggeredBy: string;
    createdAt: number;
  }[];
}

const KIND_LABELS: Record<string, string> = {
  conversations: "会话列表",
  messages: "消息",
  members: "群成员",
  avatars: "头像",
  friend_requests: "好友申请",
  leaderboard: "上游榜单",
};

export function syncOverview(now = Date.now()): SyncKindHealth[] {
  const intervalMs = getSettingInt("sync.messages.interval_seconds", 120) * 1000;
  const kinds = Object.keys(KIND_LABELS);

  return kinds.map((kind) => {
    const all = db
      .select()
      .from(syncJobs)
      .where(eq(syncJobs.kind, kind as "messages"))
      .orderBy(desc(syncJobs.createdAt))
      .limit(200)
      .all();

    const failed = all.filter((j) => j.status === "failed").length;
    const lastSuccess = all.find((j) => j.status === "success");
    const lastFailure = all.find((j) => j.status === "failed");

    return {
      kind,
      label: KIND_LABELS[kind] ?? kind,
      health: syncHealth(
        {
          total: all.length,
          failed,
          lastSuccessAt: lastSuccess?.finishedAt ?? lastSuccess?.createdAt ?? null,
          lastFailureAt: lastFailure?.createdAt ?? null,
          lastError: lastFailure?.error ?? null,
        },
        now,
        intervalMs,
      ),
      recent: all.slice(0, 8).map((j) => ({
        id: j.id,
        status: j.status,
        scope: j.scope,
        itemsFetched: j.itemsFetched,
        itemsWritten: j.itemsWritten,
        durationMs: j.durationMs,
        error: j.error,
        retryCount: j.retryCount,
        triggeredBy: j.triggeredBy,
        createdAt: j.createdAt,
      })),
    };
  });
}

/**
 * 有没有正在跑的同步 —— 手动触发前要看。
 *
 * **要把僵死的 running 排除掉**，判定与队列清理共用同一把尺
 * （`isStaleRunning`）。同步进程被杀掉时会留下永远不收尾的 running 行，
 * 不排除的话界面会被一具尸体锁死触发按钮，
 * 而清理逻辑却在另一个阈值下认为它还活着。
 */
export function runningJobs(now = Date.now()): number {
  return db
    .select()
    .from(syncJobs)
    .where(inArray(syncJobs.status, ["running", "pending"]))
    .all()
    .filter((job) => !isStaleRunning(job, now)).length;
}

/** 失败且还能重试的任务 */
export function retryableJobs(limit = 20) {
  return db
    .select()
    .from(syncJobs)
    .where(inArray(syncJobs.status, ["failed", "partial"]))
    .orderBy(desc(syncJobs.createdAt))
    .limit(limit)
    .all();
}

/** 增量游标。落后太多说明某一轮同步没跑完 */
export function cursors() {
  return db.select().from(syncCursors).orderBy(syncCursors.kind).all();
}

/**
 * 上游接入状态。
 *
 * **拿不到就要说「不知道」，不能说「正常」** ——
 * 这一页的全部意义就是发现上游断了，它自己却谎报健康的话，
 * 就成了最坏的那种仪表盘。
 */
export interface UpstreamStatus {
  reachable: boolean | "unknown";
  boundGroups: number;
  syncedGroups: number;
  excludedGroups: number;
  totalMessages: number;
}

export function upstreamStatus(): UpstreamStatus {
  const all = db.select().from(groups).all();
  return {
    // 真实可达性由健康探测写入 system_health，这里只报结构性事实
    reachable: "unknown",
    boundGroups: all.filter((g) => g.bound).length,
    syncedGroups: all.filter((g) => g.syncEnabled).length,
    excludedGroups: all.filter((g) => g.syncExcluded).length,
    totalMessages: Number(
      db.select({ n: sql<number>`count(*)` }).from(messages).get()
        ?.n ?? 0,
    ),
  };
}
