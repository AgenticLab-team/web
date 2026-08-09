"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { reports } from "@/lib/db/schema";
import { notify } from "@/lib/forum/notify";
import { checkAssign, checkHandleReport } from "@/lib/moderation/rules";

/**
 * 举报队列的写操作。
 *
 * 一次处理**一个目标的所有举报**，不是一条一条点 ——
 * 队列按目标归组，动作也必须按目标收口，否则十个人举报同一条内容，
 * 处理完第一条后剩下九条还留在队列里，下一个版主会再处理一遍。
 *
 * 每次处置都要通知举报人。举报了石沉大海的人，下次就不举报了 ——
 * 到那时队列很干净，但只是因为没人再报了。
 */

export interface ReportActionResult {
  ok: boolean;
  error?: string;
}

const fail = (error: string): ReportActionResult => ({ ok: false, error });

function loadGroup(targetType: string, targetId: string) {
  return db
    .select()
    .from(reports)
    .where(and(eq(reports.targetType, targetType as "post"), eq(reports.targetId, targetId)))
    .all();
}

/** 认领：让别的版主知道这件事有人在看了，避免两个人同时处理 */
export async function claimReports(input: {
  targetType: string;
  targetId: string;
  /** 不传就是认领给自己 */
  assignTo?: string;
}): Promise<ReportActionResult> {
  const admin = await requireWritableAdmin("moderation.queue");

  const group = loadGroup(input.targetType, input.targetId);
  if (group.length === 0) return fail("找不到这批举报");

  const pending = group.filter((r) => r.status === "open" || r.status === "reviewing");
  if (pending.length === 0) return fail("这条举报已经处理过了");

  const check = checkAssign(pending[0].status);
  if (!check.ok) return fail(check.error!);

  const assignee = input.assignTo ?? admin.user.id;

  db.update(reports)
    .set({ status: "reviewing", assignedTo: assignee })
    .where(inArray(reports.id, pending.map((r) => r.id)))
    .run();

  audit({ actorId: admin.user.id }, {
    action: "moderation.report.assign",
    targetType: input.targetType,
    targetId: input.targetId,
    after: { assignedTo: assignee, count: pending.length },
  });

  revalidatePath("/admin/reports");
  return { ok: true };
}

/**
 * 处置一组举报。
 *
 * `outcome` 只描述**举报本身**成不成立；对内容的处置（删帖、禁言）
 * 走 moderatePost / setUserStatus，各自留自己的处罚记录。
 * 两者分开是刻意的 —— 「举报属实但这次只警告」是很常见的组合，
 * 合成一个动作就表达不出来了。
 */
export async function resolveReports(input: {
  targetType: string;
  targetId: string;
  outcome: "resolved" | "rejected" | "duplicate";
  resolution: string;
}): Promise<ReportActionResult> {
  const admin = await requireWritableAdmin("moderation.queue");

  const group = loadGroup(input.targetType, input.targetId);
  if (group.length === 0) return fail("找不到这批举报");

  const pending = group.filter((r) => r.status === "open" || r.status === "reviewing");
  if (pending.length === 0) return fail("这条举报已经处理过了");

  const check = checkHandleReport({
    actorId: admin.user.id,
    reporterIds: pending.map((r) => r.reporterId),
    targetUserId: pending[0].targetUserId,
    status: pending[0].status,
    resolution: input.resolution,
  });
  if (!check.ok) return fail(check.error!);

  const resolution = input.resolution.trim();
  const at = Date.now();

  db.update(reports)
    .set({
      status: input.outcome,
      resolvedBy: admin.user.id,
      resolvedAt: at,
      resolution,
    })
    .where(inArray(reports.id, pending.map((r) => r.id)))
    .run();

  // 通知每一个举报人 —— 石沉大海的举报只会教会大家别再举报
  for (const reporterId of new Set(pending.map((r) => r.reporterId))) {
    notify({
      userId: reporterId,
      type: "moderation",
      groupKey: `report:${input.targetType}:${input.targetId}`,
      title: input.outcome === "resolved" ? "你举报的内容已处理" : "你举报的内容已复核",
      body: resolution,
      actorId: admin.user.id,
    });
  }

  audit({ actorId: admin.user.id }, {
    action: "moderation.report.handle",
    targetType: input.targetType,
    targetId: input.targetId,
    before: { status: pending[0].status },
    after: { status: input.outcome, count: pending.length },
    reason: resolution,
  });

  revalidatePath("/admin/reports");
  return { ok: true };
}
