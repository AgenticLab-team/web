import "server-only";

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";

import { desc, inArray, sql } from "drizzle-orm";

import { passkeyLockoutRisk } from "@/lib/auth/passkey-enforcement";
import { describeRisk } from "@/lib/auth/passkey-policy";
import { db, sqlite } from "@/lib/db";
import { storageSnapshots, systemHealth } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { NekoBotError, nekobot } from "@/lib/nekobot/client";
import { pushSubscriptionSummary } from "@/lib/notifications/push-store";
import { configProblem, webPushConfigured } from "@/lib/notifications/webpush";
import { offsiteSummary } from "@/lib/backup/offsite";
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

/**
 * 异地备份。
 *
 * 「没配置」报的是 degraded 而不是 ok —— 备份和归档都只在这一块磁盘上，
 * 这是个真实存在的缺口，不该因为「本来就没开」就显示成正常。
 * 但也不报 down：站是活的，只是没有后路。
 */
export function probeOffsite(): HealthReport {
  const summary = offsiteSummary();
  if (summary.status === "ok") {
    return { component: "offsite", status: "ok", detail: summary.detail };
  }
  return {
    component: "offsite",
    // 失败了才算 down；没配置/过期/没验证过都是 degraded —— 有区别
    status: summary.status === "failing" ? "down" : "degraded",
    detail: summary.detail,
  };
}

/**
 * 管理员的第二重保护。
 *
 * 这一项探的不是「服务活没活着」，而是**一条安全规则现在是什么状态**。
 * 放进健康检查是因为它和别的缺口一样，需要一直看得见 ——
 * 而它比别的缺口更容易被忘掉：它平时什么都不做，
 * 只在某个管理员某天登不进来的那一刻才被人想起。
 *
 * 三档的分法：
 *   · 开着、没人被挡  → ok
 *   · **开着、有人被挡** → down：这不是「有个缺口」，是有人现在进不来
 *   · 没开             → degraded：管理员账号只有一道密码，是个真实的缺口
 */
export function probeAuthPolicy(): HealthReport {
  const risk = passkeyLockoutRisk();
  return {
    component: "auth",
    status: risk.active ? "down" : risk.enforced ? "ok" : "degraded",
    detail: describeRisk(risk),
  };
}

/**
 * Web Push 的配置状态。
 *
 * 与 probeOffsite 同一条原则：「没配置」报 degraded 而不是 ok ——
 * 推送没配时用户看到的订阅界面会如实说「暂未开通」，但运维侧
 * 也必须有一个一直亮着的黄灯，否则「忘了配」和「不打算配」没法区分。
 *
 * 比没配更危险的是**配错**（比如轮换时只换了公钥）：那种状态下每次
 * 投递都被推送服务拒掉，而站内一切正常，没有任何页面会变红 ——
 * 所以配了但校验不过要报 down，它是真故障，不是缺口。
 */
export function probeWebPush(): HealthReport {
  const problem = configProblem();
  if (problem === null) {
    const subs = pushSubscriptionSummary();
    return {
      component: "web_push",
      status: "ok",
      detail: `已配置 · ${subs.active} 个订阅在投${subs.disabled ? ` · ${subs.disabled} 个已停用` : ""}`,
    };
  }
  return {
    component: "web_push",
    status: webPushConfigured() ? "down" : "degraded",
    detail: problem,
  };
}

/** 跑一轮完整探测并落库 */
export async function runHealthChecks(): Promise<HealthReport[]> {
  const reports = [
    await probeUpstream(),
    probeDatabase(),
    probeDisk(),
    probeOffsite(),
    probeAuthPolicy(),
    probeWebPush(),
  ];
  for (const report of reports) {
    db.insert(systemHealth)
      .values({
        component: report.component as
          | "upstream_api"
          | "frp_tunnel"
          | "db"
          | "disk"
          | "offsite"
          | "auth"
          | "web_push",
        status: report.status,
        detail: report.detail,
        latencyMs: report.latencyMs,
      })
      .run();
  }
  return reports;
}

/**
 * 记下这一轮定时任务本身的健康状态。
 *
 * 写完之后由**下一轮**的告警判定读到 —— 这一轮的告警投递
 * 排在所有步骤之前就结束了，它不可能知道自己这一轮的结果。
 *
 * 定时器 5 分钟一轮、cron 的报警线是 30 分钟，
 * 所以真的坏了会在半小时内报出来；偶发一次不会。
 */
export function recordTickHealth(status: HealthStatus, detail: string): void {
  db.insert(systemHealth).values({ component: "cron", status, detail }).run();
}

/** 上一轮定时任务的状态，喂给这一轮的告警判定 */
export function lastTickHealth(): HealthReport | null {
  const row = db
    .select()
    .from(systemHealth)
    .where(sql`${systemHealth.component} = 'cron'`)
    .orderBy(desc(systemHealth.checkedAt))
    .limit(1)
    .get();
  if (!row) return null;
  return { component: "cron", status: row.status, detail: row.detail ?? undefined };
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
    .where(
      inArray(
        systemHealth.component,
        components as ("upstream_api" | "frp_tunnel" | "db" | "disk" | "offsite")[],
      ),
    )
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
