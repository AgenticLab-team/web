"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { adminTasks } from "@/lib/db/schema";

import { applyPlan, buildPlan } from "./recount";
import { describePlan, isWideImpact, type RecountPlan } from "./recount-rules";

/**
 * 积分重算：先出预览，确认之后再执行。
 *
 * ─────────────────────────────────────────
 * 复用现成的 admin_tasks，不另起一套
 * ─────────────────────────────────────────
 *
 * 存储裁剪那条路已经是「出预览 → awaiting_confirm → 执行」了，
 * 表也是通用的（kind + params + preview + result）。
 * 再造一套的话，两套任务的状态机早晚分叉，
 * 而「有没有跑过、跑成没有」这种问题要去两个地方查。
 *
 * ─────────────────────────────────────────
 * 执行时**重新算一遍**，不吃预览里那份
 * ─────────────────────────────────────────
 *
 * 预览和确认之间隔着人的一次思考，那段时间里分还在照常发。
 * 用预览那份落库的话，中间发生的所有变动会被抹掉 ——
 * 而那正是这个操作最不该做的事。
 *
 * 所以执行时重算，并且把**预览时的数**和**实际改的数**
 * 一起记进审计：两者不一致本身就是要留痕的信息。
 */

export interface RecountResult {
  ok: boolean;
  error?: string;
  taskId?: string;
  note?: string;
  plan?: RecountPlan;
  wide?: boolean;
}

const fail = (error: string): RecountResult => ({ ok: false, error });

export async function previewRecount(): Promise<RecountResult> {
  const admin = await requireWritableAdmin("points.recount");

  const plan = buildPlan();

  const task = db
    .insert(adminTasks)
    .values({
      kind: "points.recount",
      status: "awaiting_confirm",
      // 预览里只存汇总，不存每个人的明细 —— 明细可能上万行，而它执行时会重算
      preview: {
        scanned: plan.scanned,
        rows: plan.rows.length,
        balanceChanges: plan.balanceChanges,
        levelChanges: plan.levelChanges,
        netDelta: plan.netDelta,
      },
      total: plan.rows.length,
      createdBy: admin.user.id,
    })
    .returning({ id: adminTasks.id })
    .get();

  revalidatePath("/admin/points/ledger");
  return {
    ok: true,
    taskId: task.id,
    plan,
    wide: isWideImpact(plan),
    note: describePlan(plan),
  };
}

export async function executeRecount(taskId: string): Promise<RecountResult> {
  const admin = await requireWritableAdmin("points.recount");

  const task = db.select().from(adminTasks).where(eq(adminTasks.id, taskId)).get();
  if (!task) return fail("任务不存在");
  if (task.kind !== "points.recount") return fail("任务类型不对");
  if (task.status !== "awaiting_confirm") {
    return fail(`任务已经是「${task.status}」状态，不能重复执行`);
  }

  db.update(adminTasks)
    .set({ status: "running", startedAt: Date.now() })
    .where(eq(adminTasks.id, task.id))
    .run();

  try {
    // 重新算 —— 预览和确认之间那段时间里分还在照常发
    const plan = buildPlan();
    const outcome = applyPlan(plan);

    const result = {
      updated: outcome.updated,
      balanceChanges: plan.balanceChanges,
      levelChanges: plan.levelChanges,
      netDelta: plan.netDelta,
    };

    db.update(adminTasks)
      .set({ status: "success", result, progress: outcome.updated, finishedAt: Date.now() })
      .where(eq(adminTasks.id, task.id))
      .run();

    audit(
      { actorId: admin.user.id },
      {
        action: "points.recount",
        targetType: "points",
        targetId: task.id,
        // 预览时的数和实际改的数一起记 —— 两者不一致本身就是信息
        before: task.preview,
        after: result,
      },
    );

    revalidatePath("/admin/points/ledger");
    return { ok: true, taskId: task.id, note: describePlan(plan) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.update(adminTasks)
      .set({ status: "failed", error: message, finishedAt: Date.now() })
      .where(eq(adminTasks.id, task.id))
      .run();
    return fail(message);
  }
}

export async function cancelRecount(taskId: string): Promise<RecountResult> {
  const admin = await requireWritableAdmin("points.recount");

  const changed = db
    .update(adminTasks)
    .set({ status: "cancelled", finishedAt: Date.now() })
    .where(eq(adminTasks.id, taskId))
    .run();
  if (changed.changes === 0) return fail("任务不存在");

  audit(
    { actorId: admin.user.id },
    { action: "points.recount.cancel", targetType: "points", targetId: taskId },
  );

  revalidatePath("/admin/points/ledger");
  return { ok: true };
}
