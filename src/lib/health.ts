import "server-only";

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";

import { desc, inArray, sql } from "drizzle-orm";

import { db, sqlite } from "@/lib/db";
import { storageSnapshots, systemHealth } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { NekoBotError, nekobot } from "@/lib/nekobot/client";
import { getSettingInt } from "@/lib/settings/store";

/**
 * 健康探测。
 *
 * frp 隧道是**单点** —— 家里那台机器掉线，整个数据源就断了。
 * 光有重试不够，必须留下可查的记录，否则事后只能看到「同步失败」不知道断了多久。
 */

export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthReport {
  component: string;
  status: HealthStatus;
  detail?: string;
  latencyMs?: number;
}

export async function probeUpstream(): Promise<HealthReport> {
  const started = Date.now();
  try {
    const who = await nekobot.whoami();
    const latency = Date.now() - started;
    return {
      component: "upstream_api",
      // 隧道通但很慢，通常是家里那台机器负载高或网络抖动
      status: latency > 5000 ? "degraded" : "ok",
      detail: `key=${who.prefix} 累计调用 ${who.calls}`,
      latencyMs: latency,
    };
  } catch (err) {
    const latency = Date.now() - started;
    const down = err instanceof NekoBotError && err.isUpstreamDown;
    return {
      component: down ? "frp_tunnel" : "upstream_api",
      status: "down",
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
      latencyMs: latency,
    };
  }
}

export function probeDatabase(): HealthReport {
  const started = Date.now();
  try {
    const integrity = sqlite.pragma("quick_check", { simple: true });
    return {
      component: "db",
      status: integrity === "ok" ? "ok" : "degraded",
      detail: String(integrity),
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      component: "db",
      status: "down",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function probeDisk(): HealthReport {
  const snapshot = takeStorageSnapshot();
  const warn = getSettingInt("storage.disk_warn_pct", 70);
  const prune = getSettingInt("storage.disk_prune_pct", 85);

  return {
    component: "disk",
    status: snapshot.diskPct >= prune ? "down" : snapshot.diskPct >= warn ? "degraded" : "ok",
    detail: `磁盘 ${snapshot.diskPct}% · 库 ${(snapshot.dbBytes / 1048576).toFixed(1)}MB`,
  };
}

export function takeStorageSnapshot() {
  const dbPath = resolve(env.db.path);
  const dbBytes = safeSize(dbPath) + safeSize(`${dbPath}-wal`);

  // FTS 索引占了库里多少：把 messages_fts 相关的表加起来
  const ftsBytes = Number(
    (
      sqlite
        .prepare(
          `SELECT COALESCE(SUM(pgsize), 0) AS n FROM dbstat WHERE name LIKE 'messages_fts%'`,
        )
        .get() as { n: number } | undefined
    )?.n ?? 0,
  );

  let diskTotal = 0;
  let diskUsed = 0;
  try {
    const out = execFileSync("df", ["-B1", "--output=size,used", dbPath], {
      encoding: "utf8",
    });
    const [size, used] = out.trim().split("\n")[1].trim().split(/\s+/).map(Number);
    diskTotal = size;
    diskUsed = used;
  } catch {
    /* df 不可用就留 0，不影响其它指标 */
  }

  const byTable = sqlite
    .prepare(
      `SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 12`,
    )
    .all() as { name: string; bytes: number }[];

  const snapshot = {
    dbBytes,
    ftsBytes,
    mediaCacheBytes: 0,
    thumbBytes: 0,
    diskTotal,
    diskUsed,
    diskPct: diskTotal ? Math.round((diskUsed / diskTotal) * 100) : 0,
    byTable,
  };

  db.insert(storageSnapshots).values(snapshot).run();
  return snapshot;
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** 跑一轮完整探测并落库 */
export async function runHealthChecks(): Promise<HealthReport[]> {
  const reports = [await probeUpstream(), probeDatabase(), probeDisk()];
  for (const report of reports) {
    db.insert(systemHealth)
      .values({
        component: report.component as "upstream_api" | "frp_tunnel" | "db" | "disk",
        status: report.status,
        detail: report.detail,
        latencyMs: report.latencyMs,
      })
      .run();
  }
  return reports;
}

/** 各组件的最新状态，供后台首屏与 /api/health 使用 */
export function latestHealth() {
  return db
    .all<{ component: string; status: string; detail: string; checked_at: number }>(sql`
      SELECT component, status, detail, checked_at FROM (
        SELECT component, status, detail, checked_at,
               ROW_NUMBER() OVER (PARTITION BY component ORDER BY checked_at DESC) AS rn
        FROM system_health
      ) WHERE rn = 1
    `);
}

/**
 * 从什么时候开始不正常的 —— 用来判断该不该告警。
 *
 * 算的是 `ok` 以外的**连续**记录（degraded 也算），
 * 因为「一直半死不活」和「彻底断了」都需要有人去看；
 * 只盯 down 的话，一个持续降级的上游会永远不报警。
 *
 * 传多个组件时当成一个整体看 —— frp_tunnel 和 upstream_api
 * 是同一次探测的两种归因，分开算会两边都够不到报警线。
 */
export function unhealthySince(components: string[]): number | null {
  if (components.length === 0) return null;
  const rows = db
    .select()
    .from(systemHealth)
    .where(inArray(systemHealth.component, components as ("upstream_api" | "frp_tunnel" | "db" | "disk")[]))
    .orderBy(desc(systemHealth.checkedAt))
    .limit(200)
    .all();

  let since: number | null = null;
  for (const row of rows) {
    if (row.status === "ok") break;
    since = row.checkedAt;
  }
  return since;
}

/** @deprecated 用 {@link unhealthySince} —— 只看 down 会漏掉持续降级 */
export function downSince(component: string): number | null {
  return unhealthySince([component]);
}
