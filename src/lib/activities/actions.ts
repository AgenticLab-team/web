"use server";

import { count, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireAdmin, requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { activities, activityApplications, activityEvents } from "@/lib/db/schema";
import {
  parseFulfillText,
  planBulkFulfill,
  type BulkPlan,
} from "@/lib/activities/bulk-fulfill";
import { evaluateEligibility, validateRule, type Rule } from "@/lib/activities/eligibility";
import { getActivity } from "@/lib/activities/queries";
import { claimQuota, releaseQuota } from "@/lib/activities/quota";
import { getModule, isKnownModule } from "@/lib/activities/registry";
import { canResubmit } from "@/lib/activities/resubmit-rules";
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
  const admin = await requireWritableAdmin("activity.manage");

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
  const admin = await requireWritableAdmin("activity.manage");

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

  /*
   * 查一次「是不是已经被注册了」。
   *
   * 这一步之前**从来没有被调用过** —— 模块里实现了 checkAvailability，
   * 接口里声明了它，而没有任何地方调它。而活动说明上写着
   * 「系统会查它是否已被注册」，是一句兑现不了的承诺。
   *
   * 放在占名额**之前**：占了名额再发现被注册了，那个名额要走
   * 一遍释放流程，而释放是有可能漏的。
   *
   * 查不到时（RDAP 超时、限流）**放行并说明**，不是拦下 ——
   * 上游查不通不是用户的错，而拦下来的代价是他以为自己不够格。
   */
  let availabilityNote: string | undefined;
  if (activityModule.checkAvailability && validation.normalizedKey) {
    const availability = await activityModule.checkAvailability(
      validation.normalizedKey,
      (activity.config as Record<string, unknown>) ?? {},
    );
    if (availability.available === false) {
      return fail(`${validation.normalizedKey} ${availability.detail} —— 换一个再试`);
    }
    if (availability.available === "unknown") {
      availabilityNote = `没能查到 ${validation.normalizedKey} 的注册状态（${availability.detail}），已经先帮你登记上，注册时会再确认一次`;
    }
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
      note: [
        waitlisted
          ? "名额已满，你在候补队列里 —— 前面有人放弃时会自动补上"
          : "已登记。等管理员统一处理后会通知你",
        availabilityNote,
      ]
        .filter(Boolean)
        .join("；"),
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

/**
 * 撤回之后改一改再提交。
 *
 * ─────────────────────────────────────────
 * 改的是**同一行**，不是新建一行
 * ─────────────────────────────────────────
 *
 * 每重提一次就新建一行的话，一个人在一个活动里会攒下一串申请，
 * 而名额、域名唯一性、每人限额三道判定全是按「在途的申请」数的 ——
 * 任何一道判漏，攒下的那串就变成一堆被这个人占住的域名。
 *
 * 复用同一行则天然没有这个问题：一个人在一个活动里只有一行，
 * 它要么在途（占一个名额、占住一个域名），要么作废（什么都不占）。
 *
 * ─────────────────────────────────────────
 * 重提要重新走一遍全部判定
 * ─────────────────────────────────────────
 *
 * 撤回到重提之间隔着时间，中间什么都可能变：活动截止了、名额被抢光了、
 * 那个域名被别人登记了、这个人已经不够格了。所以资格**重新算**而不是
 * 吃申请时那份快照 —— 吃快照的话，快照就成了一张永久通行证。
 */
export async function resubmitApplication(input: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<ActivityResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const app = db
    .select()
    .from(activityApplications)
    .where(eq(activityApplications.id, input.id))
    .get();
  if (!app) return fail("申请不存在");

  const activity = getActivity(app.activityId);
  if (!activity) return fail("活动不存在");

  const openState = isActivityOpen(activity.status, activity.opensAt, activity.closesAt, Date.now());

  /*
   * 这个人在这个活动里**另外**还有几条在途的。
   *
   * 口径必须和 applyToActivity 里那段完全一样 —— 两处口径不同的话，
   * 走重提这条路就能绕开每人限额，而那正是「一个人占一堆域名」的入口。
   */
  const otherActive = db
    .select({ id: activityApplications.id })
    .from(activityApplications)
    .where(
      sql`${activityApplications.activityId} = ${app.activityId}
          AND ${activityApplications.userId} = ${user.id}
          AND ${activityApplications.id} <> ${app.id}
          AND ${activityApplications.status} NOT IN ('invalid','rejected','cancelled','expired','failed')`,
    )
    .all();

  // 这一行提交过几次。事件表是唯一记全了每次流转的地方
  const submitCount =
    db
      .select({ n: count() })
      .from(activityEvents)
      .where(
        sql`${activityEvents.applicationId} = ${app.id}
            AND ${activityEvents.toStatus} IN ('submitted','waitlisted')`,
      )
      .get()?.n ?? 0;

  const verdict = canResubmit({
    isOwner: app.userId === user.id,
    status: app.status,
    activityOpen: openState.open,
    activityClosedReason: openState.reason,
    otherActiveApplications: otherActive.length,
    perUserLimit: activity.perUserLimit,
    submitCount,
  });
  if (!verdict.ok) return fail(verdict.reason!);

  const activityModule = getModule(activity.moduleKey);
  if (!activityModule) return fail("这个活动的模块已经不可用了");

  // 资格重新算，不吃快照 —— 理由见上面
  const stats = computeStatsFor(user.id);
  if (!stats) return fail("拿不到你的统计数据，请稍后再试");
  const eligibility = evaluateEligibility((activity.eligibility as Rule | null) ?? null, stats);
  if (!eligibility.eligible) return fail(eligibility.failures.map((f) => f.message).join("；"));

  const config = (activity.config as Record<string, unknown>) ?? {};
  const validation = activityModule.validate(input.payload as never, config);
  if (!validation.ok) return fail(validation.error ?? "填写有误");

  /*
   * 域名真的换了才重新查一次 RDAP。
   *
   * 没换却照查的话，一个人反复撤回—重提就是在拿站点当域名扫描器打注册局，
   * 而对他自己没有任何新信息。
   */
  let availabilityNote: string | undefined;
  if (
    activityModule.checkAvailability &&
    validation.normalizedKey &&
    validation.normalizedKey !== app.normalizedKey
  ) {
    const availability = await activityModule.checkAvailability(validation.normalizedKey, config);
    if (availability.available === false) {
      return fail(`${validation.normalizedKey} ${availability.detail} —— 换一个再试`);
    }
    if (availability.available === "unknown") {
      availabilityNote = `没能查到 ${validation.normalizedKey} 的注册状态（${availability.detail}），已经先帮你登记上，注册时会再确认一次`;
    }
  }

  /*
   * 状态、名额、内容在同一次 transition 里落下去。
   *
   * 内容单独先写的话，中间失败会留下一条「已撤回但域名已经换了」的记录，
   * 而那条记录对着的名额和唯一性都还是旧域名的。
   */
  const result = await transition({
    application: app,
    to: "submitted",
    actorId: user.id,
    actorKind: "user",
    note: "撤回后重新提交",
    // 名额在这中间被抢光了就进候补，而不是把人卡在「撤回了也回不去」
    fallbackToWaitlist: activity.allowWaitlist,
    patch: {
      payload: input.payload,
      normalizedKey: validation.normalizedKey ?? null,
      // 重提那一刻的资格才是这次的依据，旧快照留着会让事后对账对错人
      eligibilitySnapshot: stats as unknown as Record<string, unknown>,
    },
  });
  if (!result.ok) return result;

  return {
    ok: true,
    id: app.id,
    note: [result.note ?? "已重新提交。等管理员统一处理后会通知你", availabilityNote]
      .filter(Boolean)
      .join("；"),
  };
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
  const admin = await requireWritableAdmin("activity.fulfill");

  const app = db
    .select()
    .from(activityApplications)
    .where(eq(activityApplications.id, input.id))
    .get();
  if (!app) return fail("申请不存在");
  if (!input.note.trim()) return fail("必须写明结果 —— 申请人会看到");

  return fulfillOne(admin.user.id, app, input.success, input.note.trim());
}

/**
 * 履约回填的唯一实现。单条按钮和批量粘贴都走这里 ——
 * 两份逻辑意味着改名额规则时总有一份会被忘掉，
 * 而被忘掉的那份出的错（少还一个名额）没有人会来投诉。
 */
async function fulfillOne(
  actorId: string,
  app: typeof activityApplications.$inferSelect,
  success: boolean,
  note: string,
): Promise<ActivityResult> {
  const result = await transition({
    application: app,
    to: success ? "fulfilled" : "failed",
    actorId,
    actorKind: "admin",
    note,
    notifyUser: true,
  });

  if (result.ok) {
    db.update(activityApplications)
      .set({
        fulfilledAt: success ? Date.now() : null,
        failureReason: success ? null : note,
      })
      .where(eq(activityApplications.id, app.id))
      .run();

    /*
     * 履约是这条链路上唯一「东西真的给出去了」的一步。
     * 活动事件表里记了状态流转，但那是给申请人看的时间线；
     * 事后追问「这个域名是谁批的、凭什么」时，要查的是审计日志。
     */
    audit(
      { actorId },
      {
        action: "activity.fulfill",
        targetType: "activity_application",
        targetId: app.id,
        before: { status: app.status },
        after: { status: success ? "fulfilled" : "failed" },
        reason: note,
      },
    );
  }

  return result;
}

// ── 批量回填 ──────────────────────────────────────────────────

/**
 * 预览和提交拿同一段文本各算一遍计划，而不是把预览算好的计划传回来提交。
 *
 * 客户端传回来的计划谁都不该信；更重要的是这让提交天然幂等 ——
 * 同一段文本粘两遍，第二遍里每一条都落进「已处理过」，什么都不会发生，
 * 不会重复动名额、重复发通知。
 */
function planForActivity(activityId: string, text: string): BulkPlan {
  const rows = db
    .select({
      id: activityApplications.id,
      key: activityApplications.normalizedKey,
      status: activityApplications.status,
    })
    .from(activityApplications)
    .where(eq(activityApplications.activityId, activityId))
    .all();

  const apps = rows
    .filter((r): r is typeof r & { key: string } => Boolean(r.key))
    .map((r) => ({ id: r.id, domain: r.key, status: r.status }));

  return planBulkFulfill(parseFulfillText(text), apps);
}

export interface BulkPreviewResult {
  ok: boolean;
  error?: string;
  plan?: BulkPlan;
}

/** 只算不写 —— 预览态的管理员也要能看到粘贴的结果长什么样 */
export async function previewBulkFulfill(input: {
  activityId: string;
  text: string;
}): Promise<BulkPreviewResult> {
  await requireAdmin("activity.fulfill");

  if (!getActivity(input.activityId)) return { ok: false, error: "活动不存在" };
  if (!input.text.trim()) return { ok: false, error: "先把注册商那边的结果粘进来" };

  return { ok: true, plan: planForActivity(input.activityId, input.text) };
}

export interface BulkCommitResult {
  ok: boolean;
  error?: string;
  /** 真的写进去的 */
  fulfilled: number;
  failed: number;
  /** 之前处理过、这次跳过的 */
  skipped: number;
  /** 写的时候才失败的（名额、状态被并发改了）—— 和 unknown 一样不能吞 */
  errors: { domain: string; error: string }[];
  unknown: string[];
}

export async function commitBulkFulfill(input: {
  activityId: string;
  text: string;
}): Promise<BulkCommitResult> {
  const admin = await requireWritableAdmin("activity.fulfill");

  const nothing = { fulfilled: 0, failed: 0, skipped: 0, errors: [], unknown: [] };
  if (!getActivity(input.activityId)) return { ok: false, error: "活动不存在", ...nothing };

  /*
   * 预览和提交之间隔着人的确认时间，期间申请可能被撤回、被别的管理员
   * 处理掉。所以提交前按当前库里的状态**重算**计划 —— 变掉的那几条
   * 会落进 skipped 或 errors，而不是对着旧状态硬写。
   */
  const plan = planForActivity(input.activityId, input.text);

  const result: BulkCommitResult = {
    ok: true,
    fulfilled: 0,
    failed: 0,
    skipped: plan.already.length,
    errors: [],
    unknown: plan.unknown,
  };

  for (const { success, targets } of [
    { success: true, targets: plan.fulfill },
    { success: false, targets: plan.fail },
  ]) {
    for (const target of targets) {
      const app = db
        .select()
        .from(activityApplications)
        .where(eq(activityApplications.id, target.applicationId))
        .get();
      if (!app) {
        result.errors.push({ domain: target.domain, error: "申请不见了" });
        continue;
      }

      const note =
        target.note ?? (success ? "批量回填：注册成功" : "批量回填：注册失败");
      const one = await fulfillOne(admin.user.id, app, success, note);

      if (!one.ok) {
        result.errors.push({ domain: target.domain, error: one.error ?? "写入失败" });
        continue;
      }
      if (success) result.fulfilled += 1;
      else result.failed += 1;
    }
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
  /**
   * 名额满了就转候补，而不是失败。
   *
   * 只有「重新提交」这条路用得上：撤回之后名额可能已经被别人占走了，
   * 这时候把人卡在「撤回了、也回不去」是最糟的结果。
   * 审批那条路不该带这个 —— 管理员点「通过」时名额满了就该报错。
   */
  fallbackToWaitlist?: boolean;
  /**
   * 顺带改的内容。**和状态、名额在同一个事务里落。**
   *
   * 单独先写内容的话，中间失败会留下一条「状态还是旧的、内容已经换了」
   * 的记录，而名额和唯一索引对着的还是旧内容。
   */
  patch?: {
    payload?: Record<string, unknown>;
    normalizedKey?: string | null;
    eligibilitySnapshot?: Record<string, unknown>;
  };
}): Promise<ActivityResult> {
  const { application: app } = input;

  const check = canTransitionApplication(app.status, input.to);
  if (!check.ok) return fail(check.error!);

  let target = input.to;
  const delta = quotaDelta(app.status, input.to);
  let claimed = false;

  if (delta > 0) {
    const claim = claimQuota({
      activityId: app.activityId,
      applicationId: app.id,
      reason: `状态变为 ${input.to}`,
      operatorId: input.actorId,
    });
    if (claim.full) {
      // 名额满了就转不成「已通过」—— 这时候该留在候补里
      if (!input.fallbackToWaitlist) return fail("名额已满，无法通过 —— 请先让其他人释放名额");
      const waitlistCheck = canTransitionApplication(app.status, "waitlisted");
      if (!waitlistCheck.ok) return fail("名额已满 —— 请先让其他人释放名额");
      // 候补不占名额，所以没有东西要还
      target = "waitlisted";
    } else {
      claimed = true;
    }
  } else if (delta < 0) {
    releaseQuota({
      activityId: app.activityId,
      applicationId: app.id,
      reason: `状态变为 ${input.to}`,
      operatorId: input.actorId,
    });
  }

  const waitlisted = target === "waitlisted";

  try {
    db.transaction((tx) => {
      tx.update(activityApplications)
        .set({
          status: target,
          payload: input.patch?.payload ?? undefined,
          normalizedKey: input.patch ? (input.patch.normalizedKey ?? null) : undefined,
          eligibilitySnapshot: input.patch?.eligibilitySnapshot ?? undefined,
          // 排到队尾。插回原来的位置等于让撤回过的人插队
          queuePosition: waitlisted ? nextQueuePosition(app.activityId) : undefined,
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
          toStatus: target,
          actorId: input.actorId,
          actorKind: input.actorKind,
          note: input.note,
        })
        .run();
    });
  } catch (error) {
    /*
     * 部分唯一索引撞了 = 这个域名已经被别人占着。
     * **必须把刚占的名额还回去** —— 不还的话每一次撞车都会永久蒸发一个名额，
     * 而「名额变少了」没有人会来投诉。
     */
    if (claimed) {
      releaseQuota({
        activityId: app.activityId,
        applicationId: app.id,
        reason: "状态流转失败，归还名额",
        operatorId: input.actorId,
      });
    }
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      return fail("这个已经被别人登记了，换一个吧");
    }
    throw error;
  }

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
  return {
    ok: true,
    note: waitlisted && input.to !== "waitlisted"
      ? "名额已经满了，你在候补队列里 —— 前面有人放弃时会自动补上"
      : undefined,
  };
}
