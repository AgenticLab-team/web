import "server-only";

import { and, desc, gte, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { apiUsage } from "@/lib/db/schema";
import { getSettingInt } from "@/lib/settings/store";

import { callerRole, normalizeEndpoint } from "./usage-rules";

export { callerRole, normalizeEndpoint } from "./usage-rules";

/**
 * 上游调用的账。
 *
 * ─────────────────────────────────────────
 * 这张表建了 763 天，0 行
 * ─────────────────────────────────────────
 *
 * `api_usage` 顶上写着「上游有配额，调用量要能看、能定位是谁打的」——
 * 而没有任何一处往里写过。于是「上游最近是不是在报错」
 * 这个问题，站里答不上来：健康探测只知道**此刻**通不通，
 * 而一次十分钟前的 502 潮，探测完全看不见。
 *
 * ─────────────────────────────────────────
 * 记的是**每一次 HTTP 尝试**，不是每个逻辑调用
 * ─────────────────────────────────────────
 *
 * 客户端会重试三次。按逻辑调用记的话，一次「重试两次才成功」
 * 会显示成一次干净的 200 —— 而上游那一侧确实收了三个请求、
 * 扣了三次配额、报了两次错。
 *
 * 配额和错误率都要按真实发生的请求数算，所以按尝试记。
 */

export interface CallRecord {
  path: string;
  status?: number;
  latencyMs: number;
  error?: string;
}

/**
 * 记一笔。
 *
 * **绝不能因为记账失败而让上游调用失败** —— 这是一张运维表，
 * 而它的写入路径上有磁盘、有锁、有可能正在被裁剪。
 * 一次记账异常把同步任务打断，是拿真东西换假东西。
 */
export function recordApiCall(call: CallRecord): void {
  try {
    db.insert(apiUsage)
      .values({
        endpoint: normalizeEndpoint(call.path),
        statusCode: call.status ?? null,
        latencyMs: call.latencyMs,
        triggeredBy: callerRole(),
        // 错误原文可能很长（上游会把整个 HTML 错误页塞回来），截断
        error: call.error ? call.error.slice(0, 300) : null,
      })
      .run();
  } catch {
    /* 记账失败就算了 —— 它不该影响任何一次真实调用 */
  }
}

/* ───────────────────────────────────────────────────────────────
 * 读
 * ─────────────────────────────────────────────────────────────── */

export interface EndpointStat {
  endpoint: string;
  calls: number;
  errors: number;
  /** 中位耗时。用中位数不用均值 —— 一次 20 秒超时能把均值拉到没意义 */
  medianMs: number;
  p95Ms: number;
}

export interface UsageSummary {
  since: number;
  calls: number;
  errors: number;
  /** 没拿到状态码的（连不上、超时）—— 和 5xx 是两回事，要分开看 */
  unreachable: number;
  byEndpoint: EndpointStat[];
  byCaller: { caller: string; calls: number; errors: number }[];
  recentFailures: {
    endpoint: string;
    status: number | null;
    error: string | null;
    at: number;
    caller: string | null;
  }[];
}

/**
 * 取位用「最近秩」(nearest-rank)：第 ⌈p·n⌉ 个。
 *
 * 一开始写的是 `floor((n-1)·p)` —— 五个样本 `10 11 12 13 20000`
 * 的 P95 会算成 **13**，那条 20 秒的超时被完全抹掉了。
 * 而 P95 存在的全部意义就是让人看见那条尾巴。
 *
 * 样本少的时候这个差别最大，偏偏「最近几次调用」正是样本最少的场景。
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function usageSummary(hours = 24, now = Date.now()): UsageSummary {
  const since = now - hours * 3_600_000;
  const rows = db
    .select()
    .from(apiUsage)
    .where(gte(apiUsage.createdAt, since))
    .orderBy(desc(apiUsage.createdAt))
    .all();

  /*
   * 「算不算错」在这里定义一次。
   *
   * 没有状态码 = 根本没连上（隧道断了、超时）。
   * 它和 500 的处理完全不同：一个要去看隧道，一个要去看上游服务。
   * 混在一个「错误数」里，看的人得不到任何指向。
   */
  const isError = (r: { statusCode: number | null }) =>
    r.statusCode === null || r.statusCode >= 400;

  const byEndpoint = new Map<string, { lat: number[]; errors: number }>();
  const byCaller = new Map<string, { calls: number; errors: number }>();

  for (const r of rows) {
    const e = byEndpoint.get(r.endpoint) ?? { lat: [], errors: 0 };
    if (r.latencyMs !== null) e.lat.push(r.latencyMs);
    if (isError(r)) e.errors++;
    byEndpoint.set(r.endpoint, e);

    const caller = r.triggeredBy ?? "未知";
    const c = byCaller.get(caller) ?? { calls: 0, errors: 0 };
    c.calls++;
    if (isError(r)) c.errors++;
    byCaller.set(caller, c);
  }

  return {
    since,
    calls: rows.length,
    errors: rows.filter(isError).length,
    unreachable: rows.filter((r) => r.statusCode === null).length,
    byEndpoint: [...byEndpoint]
      .map(([endpoint, v]) => {
        const sorted = [...v.lat].sort((a, b) => a - b);
        return {
          endpoint,
          calls: sorted.length || v.errors,
          errors: v.errors,
          medianMs: percentile(sorted, 0.5),
          p95Ms: percentile(sorted, 0.95),
        };
      })
      .sort((a, b) => b.calls - a.calls),
    byCaller: [...byCaller]
      .map(([caller, v]) => ({ caller, ...v }))
      .sort((a, b) => b.calls - a.calls),
    recentFailures: rows
      .filter(isError)
      .slice(0, 12)
      .map((r) => ({
        endpoint: r.endpoint,
        status: r.statusCode,
        error: r.error,
        at: r.createdAt,
        caller: r.triggeredBy,
      })),
  };
}

/**
 * 裁掉旧的。
 *
 * 同步任务每几分钟跑一次，这张表长得比谁都快。
 * 而它的价值窗口很短：没有人会关心三个月前某一次调用的耗时，
 * 要看的是「最近是不是在报错」和「这周配额用得怎么样」。
 */
export function pruneApiUsage(now = Date.now()): number {
  const days = getSettingInt("upstream.usage_retention_days", 30);
  const cutoff = now - days * 86_400_000;
  return db
    .delete(apiUsage)
    .where(and(sql`${apiUsage.createdAt} < ${cutoff}`))
    .run().changes;
}
