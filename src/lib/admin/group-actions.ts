"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { retryableJobs, runningJobs } from "@/lib/admin/groups";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { groups, syncJobs } from "@/lib/db/schema";
import { checkManualTrigger, checkRetry } from "@/lib/sync/health";

/**
 * 群配置与同步的写操作。
 *
 * 一条贯穿始终的提醒：**改判定规则不会追溯已有数据**。
 * 把某个群的 quality_min 从 15 改成 20，历史消息的 is_quality
 * 还是按 15 算出来的 —— 不重跑 resync 的话，
 * 榜单上的数字和当前规则对不上，而这种不一致极难被发现。
 * 所以这类改动的返回里会明确说要重跑。
 */

export interface GroupActionResult {
  ok: boolean;
  error?: string;
  /** 需要提醒管理员做的后续动作 */
  followUp?: string;
}

const fail = (error: string): GroupActionResult => ({ ok: false, error });

export async function updateGroupConfig(input: {
  convId: string;
  qualityMin: number | null;
  countForPoints: boolean;
  publicLeaderboard: boolean;
  retentionDays: number | null;
  syncExcluded: boolean;
  reason: string;
}): Promise<GroupActionResult> {
  const admin = await requireWritableAdmin("group.manage");

  const reason = input.reason.trim();
  if (!reason) return fail("必须填写理由");

  const before = db.select().from(groups).where(eq(groups.convId, input.convId)).get();
  if (!before) return fail("群不存在");

  if (input.qualityMin !== null && (!Number.isInteger(input.qualityMin) || input.qualityMin < 1)) {
    return fail("高质量阈值必须是正整数");
  }
  if (
    input.retentionDays !== null &&
    (!Number.isInteger(input.retentionDays) || input.retentionDays < 1)
  ) {
    return fail("保留天数必须是正整数");
  }

  /*
   * sync_enabled 由上游 bound 驱动，不手工维护 ——
   * 手动打开一个上游没绑定的群，同步只会一直拉不到东西。
   * 管理员能改的只有「显式排除」，它是唯一能压过上游的开关。
   */
  const syncEnabled = before.bound && !input.syncExcluded;

  db.update(groups)
    .set({
      qualityMin: input.qualityMin,
      countForPoints: input.countForPoints,
      publicLeaderboard: input.publicLeaderboard,
      retentionDays: input.retentionDays,
      syncExcluded: input.syncExcluded,
      syncEnabled,
      updatedAt: Date.now(),
      updatedBy: admin.user.id,
    })
    .where(eq(groups.convId, input.convId))
    .run();

  audit({ actorId: admin.user.id }, {
    action: "group.manage",
    targetType: "group",
    targetId: input.convId,
    targetLabel: before.name,
    before: {
      qualityMin: before.qualityMin,
      countForPoints: before.countForPoints,
      publicLeaderboard: before.publicLeaderboard,
      syncExcluded: before.syncExcluded,
    },
    after: {
      qualityMin: input.qualityMin,
      countForPoints: input.countForPoints,
      publicLeaderboard: input.publicLeaderboard,
      syncExcluded: input.syncExcluded,
      syncEnabled,
    },
    reason,
  });

  revalidatePath("/admin/groups");

  // 改判定规则不会追溯 —— 必须说出来，否则榜单会长期与规则不一致
  const qualityChanged = before.qualityMin !== input.qualityMin;
  return {
    ok: true,
    followUp: qualityChanged
      ? "高质量阈值改了，但历史消息还是按旧阈值判定的。要让榜单与新规则一致，需要在服务器上跑 npm run resync -- <群关键词>"
      : undefined,
  };
}

/**
 * 手动触发一轮同步。
 *
 * 这里只**排队**，真正执行由后台的同步进程取走 ——
 * 在 web 请求里直接跑同步的话，请求超时会把跑到一半的任务丢下，
 * 而游标已经动过了，那一段消息就永远补不回来。
 */
export async function triggerSync(input: { kind: string; scope?: string }): Promise<GroupActionResult> {
  /*
   * 单独一个权限点，不再跟着 `group.manage` 走。
   *
   * 两件事的风险完全不同：改群配置是**改状态**（排除同步、改名），
   * 手动触发只是**排一个队** —— 后台同步进程照常按它的规矩执行。
   *
   * 合在一起的后果是：想让一个人能在同步卡住时踢一脚，
   * 就得连带把改群配置的权限给他。绝大多数时候不给，
   * 于是「同步卡住了找谁」永远只有一个答案。
   */
  const admin = await requireWritableAdmin("group.sync.trigger");

  const check = checkManualTrigger(runningJobs());
  if (!check.ok) return fail(check.error!);

  db.insert(syncJobs)
    .values({
      kind: input.kind as "messages",
      scope: input.scope ?? null,
      status: "pending",
      triggeredBy: "admin",
      triggeredByUser: admin.user.id,
    })
    .run();

  audit({ actorId: admin.user.id }, {
    action: "group.sync.trigger",
    targetType: "sync",
    targetId: input.kind,
    after: { triggered: true, scope: input.scope ?? null },
  });

  revalidatePath("/admin/groups");
  return {
    ok: true,
    followUp: "已排队。下一轮同步进程会取走它，通常在两分钟内开始。",
  };
}

export async function retrySyncJob(input: { id: string }): Promise<GroupActionResult> {
  // 重试也是「排一个队」，和手动触发同一件事，归同一个权限点
  const admin = await requireWritableAdmin("group.sync.trigger");

  const job = db.select().from(syncJobs).where(eq(syncJobs.id, input.id)).get();
  if (!job) return fail("任务不存在");

  const check = checkRetry(job);
  if (!check.ok) return fail(check.error!);

  const running = checkManualTrigger(runningJobs());
  if (!running.ok) return fail(running.error!);

  db.insert(syncJobs)
    .values({
      kind: job.kind,
      scope: job.scope,
      status: "pending",
      // 重试次数带过去，否则会无限重试同一个打不通的上游
      retryCount: job.retryCount + 1,
      triggeredBy: "admin",
      triggeredByUser: admin.user.id,
    })
    .run();

  audit({ actorId: admin.user.id }, {
    action: "group.sync.trigger",
    targetType: "sync",
    targetId: job.id,
    before: { status: job.status, error: job.error },
    after: { retried: true, retryCount: job.retryCount + 1 },
  });

  revalidatePath("/admin/groups");
  return { ok: true, followUp: "已排队重试。" };
}

/** 一键重试所有可重试的失败任务 */
export async function retryAllFailed(): Promise<GroupActionResult> {
  const admin = await requireWritableAdmin("group.sync.trigger");

  const running = checkManualTrigger(runningJobs());
  if (!running.ok) return fail(running.error!);

  const jobs = retryableJobs(20).filter((j) => checkRetry(j).ok);
  if (jobs.length === 0) return fail("没有可重试的任务");

  // 同一个 kind+scope 只排一次，否则重试十条失败记录会排出十个重复任务
  const seen = new Set<string>();
  let queued = 0;

  db.transaction((tx) => {
    for (const job of jobs) {
      const key = `${job.kind}:${job.scope ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      tx.insert(syncJobs)
        .values({
          kind: job.kind,
          scope: job.scope,
          status: "pending",
          retryCount: job.retryCount + 1,
          triggeredBy: "admin",
          triggeredByUser: admin.user.id,
        })
        .run();
      queued++;
    }
  });

  audit({ actorId: admin.user.id }, {
    action: "group.sync.trigger",
    targetType: "sync",
    targetId: "*",
    after: { retriedAll: queued, candidates: jobs.length },
  });

  revalidatePath("/admin/groups");
  return {
    ok: true,
    followUp: `已排队 ${queued} 个任务（${jobs.length} 条失败记录去重后）。`,
  };
}
