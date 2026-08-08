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
 *   ② 危险项**不走这里**，走双人复核。这里直接拒绝，
 *      并告诉调用方去哪儿提 —— 拒绝而不给出路，人只会去改数据库。
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

  if (isDangerousSetting(input.key)) {
    // 拒绝的同时给出路，否则人只会绕过界面去改数据库
    return fail("这一项改错会静默影响所有人，需要双人复核 —— 请在「危险操作复核」里发起");
  }

  try {
    updateSetting(input.key, input.value, { actorId: admin.user.id, reason });
  } catch (error) {
    // 校验失败的原文直接给出去 —— 「保存失败」这四个字帮不了任何人
    return fail(error instanceof Error ? error.message : String(error));
  }

  revalidatePath("/admin/settings");

  return {
    ok: true,
    note: needsBackfillWarning(input.key)
      ? "已保存。注意这一项**不会追溯历史数据** —— 已经入库的记录还是按旧规则算的。"
      : undefined,
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
  if (isDangerousSetting(entry.key)) {
    return fail("危险项的回滚同样要双人复核");
  }
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
  return { ok: true, note: `已回滚到 ${entry.oldValue}` };
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
  if (isDangerousSetting(input.key)) return fail("危险项恢复默认同样要双人复核");

  updateSetting(input.key, row.defaultValue, {
    actorId: admin.user.id,
    reason: `恢复默认：${input.reason.trim()}`,
  });

  revalidatePath("/admin/settings");
  return { ok: true };
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
