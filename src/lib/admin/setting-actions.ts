"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/admin/guard";
import { db } from "@/lib/db";
import { settingHistory, settings } from "@/lib/db/schema";
import type { PermissionKey } from "@/lib/rbac/permissions";
import { updateSetting } from "@/lib/settings/store";
import { isDangerousSetting, needsBackfillWarning } from "@/lib/settings/validate";

/**
 * 系统设置的写操作。
 *
 * 两条：
 *   ① 每一项自己声明改它需要什么权限（requires_permission）——
 *      「能进设置页」和「能改积分规则」不是一回事。
 *   ② 危险项（改错会静默影响所有人）**不再强制走双人复核**（2026-08
 *      站长指令）。这里直接放行，但成功的返回里必须带上那句警告 ——
 *      危险的不是这次点击，是「改错之后很久才有人察觉」，
 *      而察觉的第一现场就是保存成功那一刻的提示。
 */

export interface SettingActionResult {
  ok: boolean;
  error?: string;
  note?: string;
}

const fail = (error: string): SettingActionResult => ({ ok: false, error });

export async function changeSetting(input: {
  key: string;
  value: string;
  reason: string;
}): Promise<SettingActionResult> {
  const row = db.select().from(settings).where(eq(settings.key, input.key)).get();
  if (!row) return fail("未知配置项");

  // 每一项自己声明需要什么权限，没声明的按「能改系统设置」算
  const permission = (row.requiresPermission ?? "system.settings") as PermissionKey;
  const admin = await requireAdmin(permission);

  const reason = input.reason.trim();
  if (!reason) return fail("必须填写理由");

  try {
    updateSetting(input.key, input.value, { actorId: admin.user.id, reason });
  } catch (error) {
    // 校验失败的原文直接给出去 —— 「保存失败」这四个字帮不了任何人
    return fail(error instanceof Error ? error.message : String(error));
  }

  revalidatePath("/admin/settings");

  /*
   * 警告拼在 note 里而不是各说各的：危险 + 不追溯可以同时成立
   * （比如 sync.quality_min），只提示其中一条会让人以为另一条不存在。
   */
  const warnings = [
    isDangerousSetting(input.key)
      ? "这是危险项，改错会静默影响所有人，且不会有人立刻发现 —— 记得回头验证效果。"
      : null,
    needsBackfillWarning(input.key)
      ? "注意这一项**不会追溯历史数据** —— 已经入库的记录还是按旧规则算的。"
      : null,
  ].filter((w): w is string => w !== null);

  return {
    ok: true,
    note: warnings.length > 0 ? `已保存。${warnings.join("")}` : undefined,
  };
}

/**
 * 回滚到某一次变更之前的值。
 *
 * 回滚本身也是一次变更，同样进历史 ——
 * 「回滚」不是「撤销」，历史里不能出现空洞，
 * 否则事后复盘时会看到值凭空变了。
 */
export async function rollbackSetting(input: {
  historyId: string;
  reason: string;
}): Promise<SettingActionResult> {
  const entry = db.select().from(settingHistory).where(eq(settingHistory.id, input.historyId)).get();
  if (!entry) return fail("找不到这条变更记录");

  const row = db.select().from(settings).where(eq(settings.key, entry.key)).get();
  if (!row) return fail("这个配置项已经不存在了");

  const permission = (row.requiresPermission ?? "system.settings") as PermissionKey;
  const admin = await requireAdmin(permission);

  const reason = input.reason.trim();
  if (!reason) return fail("必须填写理由");
  if (entry.oldValue === null) return fail("这条记录没有旧值，回滚不了");
  if (row.value === entry.oldValue) return fail("当前值已经就是要回滚到的值");

  try {
    updateSetting(entry.key, entry.oldValue, {
      actorId: admin.user.id,
      reason: `回滚：${reason}`,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  revalidatePath("/admin/settings");
  return {
    ok: true,
    note: `已回滚到 ${entry.oldValue}${
      isDangerousSetting(entry.key) ? "。这是危险项 —— 回滚也是一次变更，记得回头验证效果" : ""
    }`,
  };
}

/** 恢复默认值 */
export async function resetSetting(input: {
  key: string;
  reason: string;
}): Promise<SettingActionResult> {
  const row = db.select().from(settings).where(eq(settings.key, input.key)).get();
  if (!row) return fail("未知配置项");
  if (row.defaultValue === null) return fail("这一项没有记录默认值");
  if (row.value === row.defaultValue) return fail("当前已经是默认值");

  const permission = (row.requiresPermission ?? "system.settings") as PermissionKey;
  const admin = await requireAdmin(permission);

  if (!input.reason.trim()) return fail("必须填写理由");

  updateSetting(input.key, row.defaultValue, {
    actorId: admin.user.id,
    reason: `恢复默认：${input.reason.trim()}`,
  });

  revalidatePath("/admin/settings");
  return {
    ok: true,
    note: isDangerousSetting(input.key)
      ? "已恢复默认。这是危险项 —— 默认值不等于此刻合适的值，记得回头验证效果"
      : undefined,
  };
}

/** 最近的变更，用于设置页顶部的「最近有人动过什么」 */
export async function recentChanges(limit = 5) {
  await requireAdmin("system.dashboard");
  return db
    .select()
    .from(settingHistory)
    .orderBy(desc(settingHistory.createdAt))
    .limit(limit)
    .all();
}
