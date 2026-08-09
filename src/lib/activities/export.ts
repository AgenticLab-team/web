import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { activities, activityApplications, users } from "@/lib/db/schema";
import { EXPORT_SCOPES, type ExportRow, type ExportScope } from "@/lib/activities/export-rules";

/**
 * 把一个活动的申请捞出来给导出用。
 *
 * ─────────────────────────────────────────
 * 排序要和「复制给注册商」那份一模一样
 * ─────────────────────────────────────────
 *
 * 两份东西描述的是同一批申请。顺序不一致的话，管理员拿 CSV
 * 去核对剪贴板里那一列，会以为中间少了几条 ——
 * 而实际上只是排法不同。都按「先来先注册」，同毫秒用 id 定序。
 */
export function domainExportRows(activityId: string, scope: ExportScope): ExportRow[] {
  const allowed = EXPORT_SCOPES[scope];

  const rows = db
    .select({
      domain: activityApplications.normalizedKey,
      status: activityApplications.status,
      userId: activityApplications.userId,
      site: users.siteNickname,
      wx: users.wxNickname,
      createdAt: activityApplications.createdAt,
      reviewedAt: activityApplications.reviewedAt,
      fulfilledAt: activityApplications.fulfilledAt,
      failureReason: activityApplications.failureReason,
    })
    .from(activityApplications)
    /*
     * leftJoin 而不是 innerJoin：用户注销之后申请还在，
     * 而那条申请对应的域名可能已经注册出去了。
     * innerJoin 会让它**从导出里消失** —— 一个已经存在于世界上的域名
     * 在对账表里查无此条，是最难查的那种账。
     */
    .leftJoin(users, eq(users.id, activityApplications.userId))
    .where(eq(activityApplications.activityId, activityId))
    .orderBy(activityApplications.createdAt, activityApplications.id)
    .all();

  return rows
    .filter((row) => allowed === null || (allowed as readonly string[]).includes(row.status))
    .map((row) => ({
      domain: row.domain,
      status: row.status,
      // 自设昵称优先，没有就用微信昵称；都没有留空，让「用户 ID」那列去认人
      applicantName: row.site ?? row.wx ?? null,
      userId: row.userId,
      createdAt: row.createdAt,
      reviewedAt: row.reviewedAt,
      fulfilledAt: row.fulfilledAt,
      failureReason: row.failureReason,
    }));
}

/**
 * 每一档各有多少条。
 *
 * 按钮上写着数字，人才知道自己点的是什么 ——
 * 「待注册」下面是 0 条的时候，直接告诉他 0，
 * 比让他下一个空文件再回来问「是不是坏了」强。
 */
export function domainExportCounts(activityId: string): Record<ExportScope, number> {
  const rows = db
    .select({ status: activityApplications.status })
    .from(activityApplications)
    .where(eq(activityApplications.activityId, activityId))
    .all();

  const counts = { pending: 0, fulfilled: 0, all: rows.length } as Record<ExportScope, number>;
  for (const row of rows) {
    for (const scope of ["pending", "fulfilled"] as const) {
      const allowed = EXPORT_SCOPES[scope] as readonly string[];
      if (allowed.includes(row.status)) counts[scope]++;
    }
  }
  return counts;
}

/** 导出文件名要用活动标题。查不到就返回 null —— 调用方据此回 404 */
export function activityTitle(activityId: string): string | null {
  const row = db
    .select({ title: activities.title })
    .from(activities)
    .where(eq(activities.id, activityId))
    .get();
  return row?.title ?? null;
}
