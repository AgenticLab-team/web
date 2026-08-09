"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { adminTasks } from "@/lib/db/schema";
import {
  loadTierConfig,
  previewPrune,
  runPrune,
  verifyUpstreamRetention,
  type RetentionCheck,
} from "@/lib/storage/prune";
import {
  configWarnings,
  validateTierConfig,
  type PrunePreview,
  type TierConfig,
} from "@/lib/storage/tiers";

/**
 * 裁剪的后台动作。
 *
 * **先预览再执行**，中间隔一个 admin_tasks 行 —— 点「执行」时用的是
 * 预览当时算出来的那个任务，而不是重新算一遍。
 * 重新算的话，管理员看到的是「会丢 3 条」，实际执行时可能已经变成 3000 条
 * （比如中间有人把热层天数从 90 改成 9），而他确认的是前一个数字。
 */

export interface PruneActionResult {
  ok: boolean;
  error?: string;
  taskId?: string;
  preview?: PrunePreview;
  warnings?: string[];
  retention?: RetentionCheck;
  note?: string;
}

const fail = (error: string): PruneActionResult => ({ ok: false, error });

/** 出预览，落一个 awaiting_confirm 的任务行 */
export async function createPruneTask(): Promise<PruneActionResult> {
  const admin = await requireAdmin("system.settings");

  const config = loadTierConfig();
  const problems = validateTierConfig(config);
  if (problems.length > 0) return fail(problems.join("；"));

  const preview = previewPrune(config);

  /*
   * 没开归档的时候，预览阶段就去问一次上游 ——
   * 让管理员在**按下确认之前**就知道这次会不会真的删东西，
   * 而不是执行完看到一句「整步跳过了」。
   */
  const retention = config.archiveBeforeDrop
    ? undefined
    : await verifyUpstreamRetention(config);

  const task = db
    .insert(adminTasks)
    .values({
      kind: "storage.prune",
      params: { config, retention: retention ?? null },
      status: "awaiting_confirm",
      preview,
      createdBy: admin.user.id,
    })
    .returning({ id: adminTasks.id })
    .get();

  return {
    ok: true,
    taskId: task.id,
    preview,
    warnings: configWarnings(config),
    retention,
  };
}

/** 执行一个已经出过预览的任务 */
export async function executePruneTask(input: {
  taskId: string;
  /** 只做可逆步骤 */
  reversibleOnly?: boolean;
}): Promise<PruneActionResult> {
  const admin = await requireAdmin("system.settings");

  const task = db.select().from(adminTasks).where(eq(adminTasks.id, input.taskId)).get();
  if (!task) return fail("任务不存在");
  if (task.kind !== "storage.prune") return fail("任务类型不对");
  if (task.status !== "awaiting_confirm") {
    return fail(`任务已经是「${task.status}」状态，不能重复执行`);
  }

  const params = (task.params ?? {}) as {
    config?: TierConfig;
    retention?: RetentionCheck | null;
  };
  if (!params.config) return fail("任务里没有记下当时的配置，拒绝执行");

  db.update(adminTasks)
    .set({ status: "running", startedAt: Date.now() })
    .where(eq(adminTasks.id, task.id))
    .run();

  try {
    const result = await runPrune({
      config: params.config,
      reversibleOnly: input.reversibleOnly,
      retention: params.retention ?? undefined,
    });

    db.update(adminTasks)
      .set({ status: "success", result, finishedAt: Date.now() })
      .where(eq(adminTasks.id, task.id))
      .run();

    audit(
      { actorId: admin.user.id },
      {
        action: "storage.prune",
        targetType: "storage",
        targetId: task.id,
        // before/after 记的是**实际发生的**，不是预览里承诺的
        before: task.preview,
        after: result,
        reason: result.skipped || undefined,
      },
    );

    revalidatePath("/admin/storage");
    return {
      ok: true,
      taskId: task.id,
      note: result.skipped
        ? `改层 ${result.retiered} · 退索引 ${result.unindexed} —— ${result.skipped}`
        : `改层 ${result.retiered} · 退索引 ${result.unindexed} · 归档并丢弃正文 ${result.dropped}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.update(adminTasks)
      .set({ status: "failed", error: message, finishedAt: Date.now() })
      .where(eq(adminTasks.id, task.id))
      .run();
    return fail(message);
  }
}

export async function cancelPruneTask(taskId: string): Promise<PruneActionResult> {
  await requireAdmin("system.settings");
  const task = db.select().from(adminTasks).where(eq(adminTasks.id, taskId)).get();
  if (!task || task.status !== "awaiting_confirm") return fail("任务不在等待确认状态");

  db.update(adminTasks)
    .set({ status: "cancelled", finishedAt: Date.now() })
    .where(eq(adminTasks.id, taskId))
    .run();
  revalidatePath("/admin/storage");
  return { ok: true };
}
