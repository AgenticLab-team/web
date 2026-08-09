import "server-only";

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { and, desc, eq, sql } from "drizzle-orm";

import { db, sqlite } from "@/lib/db";
import { adminTasks, storageSnapshots } from "@/lib/db/schema";
import { getSettingInt } from "@/lib/settings/store";
import { archiveDir, fullContentSince, loadTierConfig, previewPrune } from "@/lib/storage/prune";
import { tierBoundaries, type Tier, type TierConfig } from "@/lib/storage/tiers";

/**
 * 存储概览。
 *
 * 后台这一页要能回答三个问题：
 *   · 空间花在哪了
 *   · 裁剪一次能省多少
 *   · **已经被裁掉的东西还找得回来吗**
 *
 * 第三个最容易被漏掉，也最要命 —— 归档文件如果没写成或者被清掉了，
 * 页面上依然会显示「已裁剪 12,000 条」，看起来一切正常。
 */

export interface TierRow {
  tier: Tier;
  messages: number;
  indexed: number;
  contentBytes: number;
  /** 正文已经被丢掉的条数 */
  dropped: number;
  oldestTs: number | null;
}

export function tierBreakdown(config: TierConfig, now = Date.now()): TierRow[] {
  const { warmBefore, coldBefore } = tierBoundaries(now, config);

  /*
   * 按**时间**分组而不是按 tier 列 —— tier 列是裁剪任务写上去的，
   * 用它分组等于用「任务自己的说法」去检查任务，
   * 任务没跑或者跑错了都看不出来。
   */
  const rows = sqlite
    .prepare(
      `SELECT
         CASE WHEN ts >= ? THEN 'hot' WHEN ts >= ? THEN 'warm' ELSE 'cold' END AS tier,
         count(*) AS messages,
         SUM(indexed) AS indexed,
         COALESCE(SUM(length(content)), 0) AS content_bytes,
         SUM(CASE WHEN content = '' THEN 1 ELSE 0 END) AS dropped,
         MIN(ts) AS oldest
       FROM messages GROUP BY 1`,
    )
    .all(warmBefore, coldBefore) as {
    tier: Tier;
    messages: number;
    indexed: number;
    content_bytes: number;
    dropped: number;
    oldest: number | null;
  }[];

  const byTier = new Map(rows.map((r) => [r.tier, r]));
  return (["hot", "warm", "cold"] as const).map((tier) => {
    const r = byTier.get(tier);
    return {
      tier,
      messages: r?.messages ?? 0,
      indexed: r?.indexed ?? 0,
      contentBytes: r?.content_bytes ?? 0,
      dropped: r?.dropped ?? 0,
      oldestTs: r?.oldest ?? null,
    };
  });
}

/**
 * tier 列和真实时间对不上的条数。
 *
 * 不为零说明裁剪任务没跑过、跑挂了，或者时间配置刚被改过。
 * 这个数字本身没有危害，但它是**任务是否真的在跑**的唯一凭据。
 */
export function tierDrift(config: TierConfig, now = Date.now()): number {
  const { warmBefore, coldBefore } = tierBoundaries(now, config);
  return (
    sqlite
      .prepare(
        `SELECT count(*) n FROM messages
         WHERE tier != CASE WHEN ts >= ? THEN 'hot' WHEN ts >= ? THEN 'warm' ELSE 'cold' END`,
      )
      .get(warmBefore, coldBefore) as { n: number }
  ).n;
}

export interface ArchiveFile {
  name: string;
  bytes: number;
  modifiedAt: number;
}

export function archiveFiles(): ArchiveFile[] {
  const dir = archiveDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ndjson.gz"))
    .map((name) => {
      const s = statSync(join(dir, name));
      return { name, bytes: s.size, modifiedAt: s.mtimeMs };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

export interface StorageOverview {
  config: TierConfig;
  tiers: TierRow[];
  drift: number;
  preview: ReturnType<typeof previewPrune>;
  archives: ArchiveFile[];
  /** 正文完整可信的时间下界；null = 从没丢过 */
  fullSince: number | null;
  /** 已经丢掉正文、但没有任何归档文件兜底 —— 这是最危险的状态 */
  droppedWithoutArchive: boolean;
  /**
   * 磁盘。
   *
   * **带上绝对值，不只是百分比。** `disk_total` / `disk_used`
   * 每次探测都写进了快照，而页面只显示 `87%` —— 一个百分比
   * 答不了「还能撑多久」，也答不了「清一次能腾出多少」，
   * 而这两个问题正是有人打开这一页的原因。
   */
  disk: {
    pct: number;
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    dbBytes: number;
    ftsBytes: number;
    takenAt: number;
  } | null;
  thresholds: { warnPct: number; prunePct: number; stopCachePct: number };
  byTable: { name: string; bytes: number }[];
}

export function storageOverview(now = Date.now()): StorageOverview {
  const config = loadTierConfig();
  const tiers = tierBreakdown(config, now);
  const archives = archiveFiles();
  const fullSince = fullContentSince();

  const snapshot = db
    .select()
    .from(storageSnapshots)
    .orderBy(desc(storageSnapshots.takenAt))
    .get();

  return {
    config,
    tiers,
    drift: tierDrift(config, now),
    preview: previewPrune(config, now),
    archives,
    fullSince,
    /*
     * 丢过正文却一个归档文件都没有 —— 那些内容是真的没了。
     * 这不该发生（丢之前必须先归档），但如果归档目录被清理脚本
     * 或者一次手滑的 rm 干掉了，页面必须立刻说出来，
     * 而不是继续显示一切正常。
     */
    droppedWithoutArchive: fullSince !== null && archives.length === 0,
    disk: snapshot
      ? {
          pct: snapshot.diskPct,
          totalBytes: snapshot.diskTotal,
          usedBytes: snapshot.diskUsed,
          // 剩余是算出来的，不再存一份 —— 存三个数迟早有一天对不上
          freeBytes: Math.max(0, snapshot.diskTotal - snapshot.diskUsed),
          dbBytes: snapshot.dbBytes,
          ftsBytes: snapshot.ftsBytes,
          takenAt: snapshot.takenAt,
        }
      : null,
    thresholds: {
      warnPct: getSettingInt("storage.disk_warn_pct", 70),
      prunePct: getSettingInt("storage.disk_prune_pct", 85),
      stopCachePct: getSettingInt("storage.disk_stop_cache_pct", 92),
    },
    byTable: ((snapshot?.byTable as { name: string; bytes: number }[] | null) ?? []).slice(0, 8),
  };
}

/**
 * 最近的裁剪任务。
 *
 * 等待确认的排最前面 —— 一个出了预览却没人点确认的任务，
 * 会让人以为「已经裁过了」。
 */
export function recentPruneTasks(limit = 10) {
  return db
    .select()
    .from(adminTasks)
    .where(eq(adminTasks.kind, "storage.prune"))
    .orderBy(desc(adminTasks.createdAt))
    .limit(limit)
    .all();
}

/** 裁剪任务总数 —— 历史列表只显示最近几条，差额要在界面上说出来 */
export function pruneTaskCount(): number {
  return Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(adminTasks)
      .where(eq(adminTasks.kind, "storage.prune"))
      .get()?.n ?? 0,
  );
}

export function pendingPruneTask() {
  return (
    db
      .select()
      .from(adminTasks)
      .where(and(eq(adminTasks.kind, "storage.prune"), eq(adminTasks.status, "awaiting_confirm")))
      .orderBy(desc(adminTasks.createdAt))
      .get() ?? null
  );
}

/** 磁盘水位对应的动作 —— 阈值不是用来看的，是用来触发的 */
export type DiskLevel = "ok" | "warn" | "prune" | "stop_cache";

export function diskLevel(
  pct: number,
  thresholds: { warnPct: number; prunePct: number; stopCachePct: number },
): DiskLevel {
  if (pct >= thresholds.stopCachePct) return "stop_cache";
  if (pct >= thresholds.prunePct) return "prune";
  if (pct >= thresholds.warnPct) return "warn";
  return "ok";
}

export const DISK_LEVEL_LABELS: Record<DiskLevel, string> = {
  ok: "水位正常",
  warn: "接近告警线",
  prune: "该裁剪了",
  stop_cache: "停止媒体缓存写入",
};
