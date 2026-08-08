"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { activities, activityApplications, activityEvents } from "@/lib/db/schema";
import { evaluateEligibility, validateRule, type Rule } from "@/lib/activities/eligibility";
import { getActivity } from "@/lib/activities/queries";
import { claimQuota, releaseQuota } from "@/lib/activities/quota";
import { getModule, isKnownModule } from "@/lib/activities/registry";
import {
  canTransitionActivity,
  canTransitionApplication,
  isActivityOpen,
  quotaDelta,
} from "@/lib/activities/state";
import { computeStatsFor } from "@/lib/activities/stats";
import type { ActivityStatus, ApplicationStatus } from "@/lib/activities/types";
import { notify } from "@/lib/forum/notify";

/**
 * 活动的写操作。
 *
 * 状态流转全部走 `transition()` —— 它一次做完三件事：
 * 改状态、动名额、记事件。分开写的话总有一处会漏，
 * 而漏掉名额那次就是超卖或者名额白白蒸发。
 */

export interface ActivityResult {
  ok: boolean;
  error?: string;
  id?: string;
  note?: string;
}

const fail = (error: string): ActivityResult => ({ ok: false, error });

// ── 管理端 ────────────────────────────────────────────────────

export async function saveActivity(input: {
  id?: string;
  moduleKey: string;
  title: string;
  description?: string;
  quotaTotal: number | null;
  perUserLimit: number;
  allowWaitlist: boolean;
  opensAt: number | null;
  closesAt: number | null;
  eligibility: Rule | null;
  config: Record<string, unknown>;
}): Promise<ActivityResult> {
  const admin = await requireAdmin("activity.manage");

  if (!isKnownModule(input.moduleKey)) {
    // 指向不存在的模块会在用户点开活动页时才炸
    return fail(`没有登记过「${input.moduleKey}」这个模块`);
  }
  if (!input.title.trim()) return fail("活动要有标题");

  const ruleCheck = validateRule(input.eligibility);
  if (!ruleCheck.ok) return fail(`资格规则有问题：${ruleCheck.error}`);

  if (input.quotaTotal !== null && (!Number.isInteger(input.quotaTotal) || input.quotaTotal < 1)) {
    return fail("名额必须是正整数");
  }
  if (input.closesAt !== null && input.opensAt !== null && input.closesAt <= input.opensAt) {
    return fail("截止时间要晚于开放时间");
  }

  const values = {
    moduleKey: input.moduleKey,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    quotaTotal: input.quotaTotal,
    perUserLimit: input.perUserLimit,
    allowWaitlist: input.allowWaitlist,
    opensAt: input.opensAt,
    closesAt: input.closesAt,
    eligibility: input.eligibility,
    config: input.config,
    updatedAt: Date.now(),
  };

  if (input.id) {
    const existing = getActivity(input.id);
    if (!existing) return fail("活动不存在");

    /*
     * 已经开放之后不给改名额和资格规则。
     * 改了的话，先报名的人按一套标准、后报名的按另一套 ——
     * 而先报名的往往正是最积极的那批人。
     */
    if (existing.status !== "draft" && existing.status !== "scheduled") {
      if (existing.quotaTotal !== input.quotaTotal) {
        return fail("活动已经开放过了，不能改名额 —— 先报名的人和后报名的人会按不同标准");
      }
      if (JSON.stringify(existing.eligibility) !== JSON.stringify(input.eligibility)) {
        return fail("活动已经开放过了，不能改资格规则");
      }
    }

    db.update(activities).set(values).where(eq(activities.id, input.id)).run();
    revalidatePath("/admin/activities");
    return { ok: true, id: input.id };
  }

  const row = db
    .insert(activities)
    .values({ ...values, createdBy: admin.user.id })
    .returning({ id: activities.id })
    .get();

  audit({ actorId: admin.user.id }, {
    action: "activity.manage",
    targetType: "activity",
    targetId: row.id,
    targetLabel: input.title,
    after: { module: input.moduleKey, quota: input.quotaTotal },
  });

  revalidatePath("/admin/activities");
  return { ok: true, id: row.id };
}

export async function setActivityStatus(input: {
  id: string;
  status: ActivityStatus;
  reason?: string;
}): Promise<ActivityResult> {
  const admin = await requireAdmin("activity.manage");

  const activity = getActivity(input.id);
  if (!activity) return fail("活动不存在");

  const check = canTransitionActivity(activity.status, input.status);
  if (!check.ok) return fail(check.error!);

  if (input.status === "cancelled" && !input.reason?.trim()) {
    return fail("取消活动要写明原因 —— 报名的人会看到");
  }

  db.transaction((tx) => {
    tx.update(activities)
      .set({
        status: input.status,
        cancelledBy: input.status === "cancelled" ? admin.user.id : undefined,
        cancelReason: input.status === "cancelled" ? input.reason?.trim() : undefined,
        updatedAt: Date.now(),
      })
      .where(eq(activities.id, input.id))
      .run();

    tx.insert(activityEvents)
      .values({
        activityId: input.id,
        fromStatus: activity.status,
        toStatus: input.status,
        actorId: admin.user.id,
        actorKind: "admin",
        note: input.reason,
      })
      .run();
  });

  audit({ actorId: admin.user.id }, {
    action: "activity.manage",
    targetType: "activity",
    targetId: input.id,
    before: { status: activity.status },
    after: { status: input.status },
    reason: input.reason,
  });

  revalidatePath("/admin/activities");
  revalidatePath("/activities");
  return { ok: true };
}

// ── 用户端 ────────────────────────────────────────────────────

export async function applyToActivity(input: {
  activityId: string;
  payload: Record<string, unknown>;
}): Promise<ActivityResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const activity = getActivity(input.activityId);
  if (!activity) return fail("活动不存在");

  const openState = isActivityOpen(activity.status, activity.opensAt, activity.closesAt, Date.now());
  if (!openState.open) return fail(openState.reason ?? "活动没有开放");

  const activityModule = getModule(activity.moduleKey);
  if (!activityModule) return fail("这个活动的模块已经不可用了");

  // 资格判定
  const stats = computeStatsFor(user.id);
  if (!stats) return fail("拿不到你的统计数据，请稍后再试");

  const eligibility = evaluateEligibility((activity.eligibility as Rule | null) ?? null, stats);
  if (!eligibility.eligible) {
    // 直接告诉他差在哪，而不是笼统地说「不符合条件」
    return fail(eligibility.failures.map((f) => f.message).join("；"));
  }

  // 模块的表单校验
  const validation = activityModule.validate(input.payload as never, (activity.config as Record<string, unknown>) ?? {});
  if (!validation.ok) return fail(validation.error ?? "填写有误");

  // 每人限额
  const mine = db
    .select()
    .from(activityApplications)
    .where(
      sql`${activityApplications.activityId} = ${input.activityId}
          AND ${activityApplications.userId} = ${user.id}
          AND ${activityApplications.status} NOT IN ('invalid','rejected','cancelled','expired','failed')`,
    )
    .all();
  if (mine.length >= activity.perUserLimit) {
    return fail(`每人最多申请 ${activity.perUserLimit} 次`);
  }

  const claim = claimQuota({
    activityId: input.activityId,
    applicationId: "pending",
    reason: `申请：${user.id}`,
  });
  if (!claim.ok) return fail(claim.error ?? "占名额失败");

  const waitlisted = Boolean(claim.full);
  if (waitlisted && !activity.allowWaitlist) {
    return fail("名额已经满了");
  }

  const status: ApplicationStatus = waitlisted ? "waitlisted" : "submitted";

  try {
    const row = db
      .insert(activityApplications)
      .values({
        activityId: input.activityId,
        userId: user.id,
        payload: input.payload,
        normalizedKey: validation.normalizedKey ?? null,
        status,
        /*
         * 冻结资格快照。事后有人质疑「凭什么他能申请我不能」，
         * 翻快照即可 —— 没有快照的话，两周后数据变了就说不清了。
         */
        eligibilitySnapshot: stats as unknown as Record<string, unknown>,
        queuePosition: waitlisted ? nextQueuePosition(input.activityId) : null,
      })
      .returning({ id: activityApplications.id })
      .get();

    db.insert(activityEvents)
      .values({
        activityId: input.activityId,
        applicationId: row.id,
        toStatus: status,
        actorId: user.id,
        actorKind: "user",
      })
      .run();

    return {
      ok: true,
      id: row.id,
      note: waitlisted
        ? "名额已满，你在候补队列里 —— 前面有人放弃时会自动补上"
        : "已登记。等管理员统一处理后会通知你",
    };
  } catch (error) {
    /*
     * 唯一索引撞了 = 这个域名已经被别人登记了。
     * **必须把刚占的名额还回去** —— 不还的话，
     * 每一次撞车都会永久蒸发一个名额。
     */
    if (!waitlisted) {
      releaseQuota({
        activityId: input.activityId,
        applicationId: "pending",
        reason: "登记失败，归还名额",
      });
    }
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      return fail("这个已经被别人登记了，换一个吧");
    }
    throw error;
  } finally {
    revalidatePath("/activities");
  }
}

function nextQueuePosition(activityId: string): number {
  const max = db
    .select({ n: sql<number>`coalesce(max(${activityApplications.queuePosition}), 0)` })
    .from(activityApplications)
    .where(eq(activityApplications.activityId, activityId))
    .get();
  return Number(max?.n ?? 0) + 1;
}

export async function cancelApplication(input: { id: string }): Promise<ActivityResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const app = db
    .select()
    .from(activityApplications)
    .where(eq(activityApplications.id, input.id))
    .get();
  if (!app) return fail("申请不存在");
  if (app.userId !== user.id) return fail("这不是你的申请");

  return transition({
    application: app,
    to: "cancelled",
    actorId: user.id,
    actorKind: "user",
    note: "用户撤回",
  });
}

// ── 审批与履约 ────────────────────────────────────────────────

export async function reviewApplication(input: {
  id: string;
  to: ApplicationStatus;
  note: string;
}): Promise<ActivityResult> {
  const admin = await requireAdmin("activity.review");

  const app = db
    .select()
    .from(activityApplications)
    .where(eq(activityApplications.id, input.id))
    .get();
  if (!app) return fail("申请不存在");
  if (!input.note.trim()) return fail("必须写明理由 —— 申请人会看到");

  return transition({
    application: app,
    to: input.to,
    actorId: admin.user.id,
    actorKind: "admin",
    note: input.note.trim(),
    notifyUser: true,
  });
}

/** 回填履约结果。域名活动里就是「注册成功了没有」 */
export async function fulfillApplication(input: {
  id: string;
  success: boolean;
  note: string;
}): Promise<ActivityResult> {
  const admin = await requireAdmin("activity.fulfill");

  const app = db
    .select()
    .from(activityApplications)
    .where(eq(activityApplications.id, input.id))
    .get();
  if (!app) return fail("申请不存在");
  if (!input.note.trim()) return fail("必须写明结果 —— 申请人会看到");

  const result = await transition({
    application: app,
    to: input.success ? "fulfilled" : "failed",
    actorId: admin.user.id,
    actorKind: "admin",
    note: input.note.trim(),
    notifyUser: true,
  });

  if (result.ok) {
    db.update(activityApplications)
      .set({
        fulfilledAt: input.success ? Date.now() : null,
        failureReason: input.success ? null : input.note.trim(),
      })
      .where(eq(activityApplications.id, input.id))
      .run();
  }

  return result;
}

/**
 * 状态流转的唯一入口。
 *
 * 一次做完三件事：改状态、动名额、记事件。
 * 分开写的话总有一处会漏 —— 而漏掉名额那次就是超卖，
 * 或者名额白白蒸发（更隐蔽，因为没人会来投诉「名额太少」）。
 */
async function transition(input: {
  application: typeof activityApplications.$inferSelect;
  to: ApplicationStatus;
  actorId: string;
  actorKind: "user" | "admin" | "system" | "module";
  note?: string;
  notifyUser?: boolean;
}): Promise<ActivityResult> {
  const { application: app } = input;

  const check = canTransitionApplication(app.status, input.to);
  if (!check.ok) return fail(check.error!);

  const delta = quotaDelta(app.status, input.to);

  if (delta > 0) {
    const claim = claimQuota({
      activityId: app.activityId,
      applicationId: app.id,
      reason: `状态变为 ${input.to}`,
      operatorId: input.actorId,
    });
    // 名额满了就转不成「已通过」—— 这时候该留在候补里
    if (claim.full) return fail("名额已满，无法通过 —— 请先让其他人释放名额");
  } else if (delta < 0) {
    releaseQuota({
      activityId: app.activityId,
      applicationId: app.id,
      reason: `状态变为 ${input.to}`,
      operatorId: input.actorId,
    });
  }

  db.transaction((tx) => {
    tx.update(activityApplications)
      .set({
        status: input.to,
        reviewedBy: input.actorKind === "admin" ? input.actorId : undefined,
        reviewedAt: input.actorKind === "admin" ? Date.now() : undefined,
        reviewNote: input.note,
        updatedAt: Date.now(),
      })
      .where(eq(activityApplications.id, app.id))
      .run();

    tx.insert(activityEvents)
      .values({
        activityId: app.activityId,
        applicationId: app.id,
        fromStatus: app.status,
        toStatus: input.to,
        actorId: input.actorId,
        actorKind: input.actorKind,
        note: input.note,
      })
      .run();
  });

  if (input.notifyUser && app.userId !== input.actorId) {
    const activity = getActivity(app.activityId);
    notify({
      userId: app.userId,
      type: "system",
      groupKey: `activity:${app.id}`,
      title: `你的申请「${activity?.title ?? ""}」有新进展`,
      body: input.note ?? "",
      link: "/activities",
      actorId: input.actorId,
    });
  }

  revalidatePath("/admin/activities");
  revalidatePath("/activities");
  return { ok: true };
}
