import "server-only";

import { desc, eq } from "drizzle-orm";

import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { adminTasks } from "@/lib/db/schema";
import { isModuleEnabled } from "@/lib/modules/state";
import { getSettingInt } from "@/lib/settings/store";
import { loadTierConfig, previewPrune, runPrune, type PruneResult } from "@/lib/storage/prune";
import { isNoop, shouldAutoPrune } from "@/lib/storage/tiers";

/**
 * 水位到线时的自动泄压。由健康探测任务每轮调用。
 *
 * **只做可逆的两步**（改层、退索引）—— 永久删掉聊天记录这件事
 * 应该有个人按下确认，而不是某天凌晨三点由一个 cron 悄悄完成。
 *
 * 自动跑过也要落一条 admin_tasks + 审计日志。
 * 「系统自己动过手」和「没人动过」必须在事后分得清楚：
 * 否则某天发现搜不到旧消息了，没人说得出是什么时候、因为什么。
 */

export const AUTO_PRUNE_ACTOR = "system:auto-prune";

export interface AutoPruneOutcome {
  ran: boolean;
  reason: string;
  result?: PruneResult;
}

export async function autoPruneIfNeeded(
  diskPct: number,
  now = Date.now(),
): Promise<AutoPruneOutcome> {
  if (!isModuleEnabled("prune")) {
    return { ran: false, reason: "自动裁剪模块已关闭 —— 磁盘满了需要人工处理" };
  }

  const config = loadTierConfig();
  const preview = previewPrune(config, now);

  const last = db
    .select()
    .from(adminTasks)
    .where(eq(adminTasks.kind, "storage.prune.auto"))
    .orderBy(desc(adminTasks.createdAt))
    .get();

  const decision = shouldAutoPrune({
    diskPct,
    prunePct: getSettingInt("storage.disk_prune_pct", 85),
    lastRunAt: last?.createdAt ?? null,
    // 只看可逆的那部分有没有事做 —— 自动裁剪本来就不碰正文
    hasWork: !isNoop({ ...preview, drop: 0 }),
    now,
  });

  if (!decision.run) return { ran: false, reason: decision.reason };

  const task = db
    .insert(adminTasks)
    .values({
      kind: "storage.prune.auto",
      params: { config, diskPct },
      status: "running",
      preview,
      createdBy: AUTO_PRUNE_ACTOR,
      startedAt: now,
    })
    .returning({ id: adminTasks.id })
    .get();

  try {
    const result = await runPrune({ config, now, reversibleOnly: true });
    db.update(adminTasks)
      .set({ status: "success", result, finishedAt: Date.now() })
      .where(eq(adminTasks.id, task.id))
      .run();

    audit(
      { actorId: null, actorRole: AUTO_PRUNE_ACTOR },
      {
        action: "storage.prune",
        targetType: "storage",
        targetId: task.id,
        after: result,
        reason: decision.reason,
      },
    );

    return { ran: true, reason: decision.reason, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.update(adminTasks)
      .set({ status: "failed", error: message, finishedAt: Date.now() })
      .where(eq(adminTasks.id, task.id))
      .run();
    return { ran: false, reason: `自动裁剪失败：${message}` };
  }
}
