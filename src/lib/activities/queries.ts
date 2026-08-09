import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  activities,
  activityApplications,
  activityEvents,
  users,
} from "@/lib/db/schema";
import { evaluateEligibility, type Rule } from "@/lib/activities/eligibility";
import { getModule } from "@/lib/activities/registry";
import { auditQuota } from "@/lib/activities/quota";
import {
  activityStatusLabel,
  applicationStatusLabel,
  isActivityOpen,
} from "@/lib/activities/state";
import { computeAllStats } from "@/lib/activities/stats";
import type { ActivityStatus, ApplicationStatus } from "@/lib/activities/types";
import { resolveDisplayName } from "@/lib/users/display-name";

/**
 * 活动的读取层。
 *
 * 最重要的一个函数是 `eligiblePreview` ——
 * 后台配规则时**实时算出符合条件的有几人**。
 * 60 个名额，是 500 人抢还是只有 12 个人够格，
 * 这两种情况的应对完全相反，而这个数字必须在开放前就拿到。
 */

export interface ActivityRow {
  id: string;
  moduleKey: string;
  moduleLabel: string;
  title: string;
  description: string | null;
  status: ActivityStatus;
  statusLabel: string;

  quotaTotal: number | null;
  quotaUsed: number;
  quotaRemaining: number | null;
  /** 缓存列与流水不一致 —— 限量活动里这是致命的 */
  quotaDrifted: boolean;

  opensAt: number | null;
  closesAt: number | null;
  open: boolean;
  openReason?: string;

  applications: number;
  waitlisted: number;
  fulfilled: number;

  eligibility: Rule | null;
  config: Record<string, unknown>;
  createdAt: number;
}

export function listActivities(now = Date.now()): ActivityRow[] {
  const rows = db.select().from(activities).orderBy(desc(activities.createdAt)).all();
  if (rows.length === 0) return [];

  const counts = new Map<string, { total: number; waitlisted: number; fulfilled: number }>();
  for (const row of db
    .select({
      activityId: activityApplications.activityId,
      status: activityApplications.status,
      n: sql<number>`count(*)`,
    })
    .from(activityApplications)
    .groupBy(activityApplications.activityId, activityApplications.status)
    .all()) {
    const c = counts.get(row.activityId) ?? { total: 0, waitlisted: 0, fulfilled: 0 };
    const n = Number(row.n);
    c.total += n;
    if (row.status === "waitlisted") c.waitlisted += n;
    if (row.status === "fulfilled") c.fulfilled += n;
    counts.set(row.activityId, c);
  }

  return rows.map((row) => {
    const openState = isActivityOpen(row.status, row.opensAt, row.closesAt, now);
    const audit = auditQuota(row.id);
    const c = counts.get(row.id) ?? { total: 0, waitlisted: 0, fulfilled: 0 };
    const activityModule = getModule(row.moduleKey);

    return {
      id: row.id,
      moduleKey: row.moduleKey,
      moduleLabel: activityModule?.label ?? row.moduleKey,
      title: row.title,
      description: row.description,
      status: row.status,
      statusLabel: activityStatusLabel(row.status),

      quotaTotal: row.quotaTotal,
      quotaUsed: row.quotaUsed,
      quotaRemaining: audit.remaining,
      quotaDrifted: !audit.consistent,

      opensAt: row.opensAt,
      closesAt: row.closesAt,
      open: openState.open,
      openReason: openState.reason,

      applications: c.total,
      waitlisted: c.waitlisted,
      fulfilled: c.fulfilled,

      eligibility: (row.eligibility as Rule | null) ?? null,
      config: (row.config as Record<string, unknown>) ?? {},
      createdAt: row.createdAt,
    };
  });
}

export function getActivity(id: string) {
  return db.select().from(activities).where(eq(activities.id, id)).get() ?? null;
}

export interface EligiblePreview {
  total: number;
  eligible: number;
  /** 差一点点就够格的人 —— 门槛调一格就能多放进来多少人 */
  nearMiss: { name: string; missing: string }[];
  /** 够格的名单，可导出 */
  names: string[];
  /** 规则本身有问题 */
  error?: string;
}

/**
 * 实时预估：现在有多少人够格。
 *
 * **这是整套资格引擎存在的主要理由。** 规则调一个数字，
 * 人数立刻重算 —— 否则「门槛定多高」只能靠猜，
 * 而猜错的两种后果（没人够格 / 所有人都够格）都要等活动开了才知道。
 *
 * 顺带给出「差一点点」的人：门槛从 50 降到 40 能多放进来几个，
 * 这个数字比任何讨论都有说服力。
 */
export function eligiblePreview(rule: Rule | null, windowDays?: number): EligiblePreview {
  const stats = computeAllStats({ windowDays });

  const eligible: string[] = [];
  const nearMiss: { name: string; missing: string; gap: number }[] = [];

  for (const s of stats) {
    const result = evaluateEligibility(rule, s);
    if (result.eligible) {
      eligible.push(String(s.name));
      continue;
    }

    // 只差一条、且差距不大的算「差一点点」
    if (result.failures.length === 1 && result.failures[0].gap !== undefined) {
      nearMiss.push({
        name: String(s.name),
        missing: result.failures[0].message,
        gap: result.failures[0].gap,
      });
    }
  }

  return {
    total: stats.length,
    eligible: eligible.length,
    names: eligible,
    nearMiss: nearMiss
      .sort((a, b) => a.gap - b.gap)
      .slice(0, 8)
      .map(({ name, missing }) => ({ name, missing })),
  };
}

export interface ApplicationRow {
  id: string;
  activityId: string;
  activityTitle: string;
  userId: string;
  userName: string;
  payload: Record<string, unknown>;
  /** 模块给的一行摘要 */
  summary: string;
  normalizedKey: string | null;
  status: ApplicationStatus;
  statusLabel: string;
  queuePosition: number | null;
  eligibilitySnapshot: Record<string, unknown> | null;
  validationResult: Record<string, unknown> | null;
  reviewNote: string | null;
  failureReason: string | null;
  createdAt: number;
}

export function listApplications(
  query: { activityId?: string; userId?: string; status?: string; limit?: number } = {},
): ApplicationRow[] {
  const conditions = [];
  if (query.activityId) conditions.push(eq(activityApplications.activityId, query.activityId));
  if (query.userId) conditions.push(eq(activityApplications.userId, query.userId));
  if (query.status) conditions.push(eq(activityApplications.status, query.status as "submitted"));

  const rows = db
    .select({
      app: activityApplications,
      title: activities.title,
      moduleKey: activities.moduleKey,
      site: users.siteNickname,
      wx: users.wxNickname,
      wxId: users.wxId,
    })
    .from(activityApplications)
    .innerJoin(activities, eq(activities.id, activityApplications.activityId))
    .leftJoin(users, eq(users.id, activityApplications.userId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(activityApplications.createdAt)
    .limit(Math.min(query.limit ?? 200, 500))
    .all();

  return rows.map(({ app, title, moduleKey, site, wx, wxId }) => {
    const activityModule = getModule(moduleKey);
    const payload = (app.payload as Record<string, unknown>) ?? {};

    let summary: string;
    try {
      summary = activityModule ? activityModule.describe(payload as never) : JSON.stringify(payload);
    } catch {
      // 模块的 describe 崩掉不能把整页带走
      summary = JSON.stringify(payload);
    }

    return {
      id: app.id,
      activityId: app.activityId,
      activityTitle: title,
      userId: app.userId,
      userName: resolveDisplayName([site, wx], { wxId, fallback: "社区成员" }),
      payload,
      summary,
      normalizedKey: app.normalizedKey,
      status: app.status,
      statusLabel: applicationStatusLabel(app.status),
      queuePosition: app.queuePosition,
      eligibilitySnapshot: (app.eligibilitySnapshot as Record<string, unknown>) ?? null,
      validationResult: (app.validationResult as Record<string, unknown>) ?? null,
      reviewNote: app.reviewNote,
      failureReason: app.failureReason,
      createdAt: app.createdAt,
    };
  });
}

export function applicationEvents(applicationId: string) {
  return db
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.applicationId, applicationId))
    .orderBy(activityEvents.createdAt)
    .all();
}

/**
 * 导出待注册清单。
 *
 * 域名活动的核心交付物 —— 管理员拿着这份清单去统一注册，
 * 所以格式要能直接复制粘贴，而不是让人从表格里一个个抄。
 */
export function exportPendingList(activityId: string): string {
  const apps = listApplications({ activityId }).filter(
    (a) => a.status === "approved" || a.status === "fulfilling",
  );

  if (apps.length === 0) return "";

  return apps
    .map((a) => `${a.normalizedKey ?? a.summary}\t${a.userName}\t${a.id}`)
    .join("\n");
}

/**
 * 给注册商的批量注册框用的域名列表：**一行一个，不带任何别的东西**。
 *
 * `exportPendingList` 带着申请人和申请 id，是给人看的对照表；
 * 把那份直接粘进注册商的批量框，会被当成一堆非法域名拒掉。
 * 两份格式服务两个动作，合成一份就两头都不好用。
 *
 * scope 的两档：
 *   - pending：还没回填过结果的（已通过 / 履约中）—— 日常用这个
 *   - all：把已成功、已失败的也带上 —— 管理员要去注册商那边对总账时用
 *
 * 没进过审核的（待审、候补）不导出：导了就等于绕过审核直接注册。
 */
export function exportRegistrarList(activityId: string, scope: "pending" | "all"): string {
  const statuses =
    scope === "pending"
      ? ["approved", "fulfilling"]
      : ["approved", "fulfilling", "fulfilled", "failed"];

  const rows = db
    .select({ key: activityApplications.normalizedKey, status: activityApplications.status })
    .from(activityApplications)
    .where(eq(activityApplications.activityId, activityId))
    // 先来先注册符合直觉；同一毫秒进来的用 id 定序 ——
    // 两次导出顺序不一样的话，人会以为列表本身变了
    .orderBy(activityApplications.createdAt, activityApplications.id)
    .all();

  const domains: string[] = [];
  for (const row of rows) {
    if (!row.key || !statuses.includes(row.status)) continue;
    // 同一域名可能挂着一条在途、一条更早失败的申请 —— 列表里出现两遍会被注册两次
    if (!domains.includes(row.key)) domains.push(row.key);
  }
  return domains.join("\n");
}
