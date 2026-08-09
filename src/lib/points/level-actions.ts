"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { updateSetting } from "@/lib/settings/store";

import { checkLevels, LEVELS_SETTING_KEY, type LevelDef } from "./level-rules";
import { levelOf } from "./rules";

/**
 * 保存等级门槛。
 *
 * ─────────────────────────────────────────
 * 改完必须把所有人的等级重算一遍
 * ─────────────────────────────────────────
 *
 * `users.level` 是缓存列，只在积分变动时更新。
 * 门槛改了而不重算的话，一个人的等级会**停在旧门槛下算出来的值**，
 * 直到他下次拿到分为止 —— 而按等级卡的版块立刻按新门槛判，
 * 于是「我明明是 L3」和「这里需要 L3」同时成立却进不去。
 *
 * 那种不一致没有任何地方会报错，只会变成一句「这个站坏了」。
 */

export interface SaveResult {
  ok: boolean;
  error?: string;
  /** 重算之后有多少人的等级变了 */
  changed?: number;
}

export async function saveLevels(levels: LevelDef[]): Promise<SaveResult> {
  const admin = await requireWritableAdmin("points.rules.manage");

  const verdict = checkLevels(levels);
  if (!verdict.ok) return { ok: false, error: verdict.error };

  /*
   * 走 setSetting 而不是直接写表 —— 它带着校验、历史和回滚。
   * 等级门槛正是最需要「改错了能退回去」的那一类配置。
   */
  try {
    updateSetting(LEVELS_SETTING_KEY, JSON.stringify(verdict.levels), { actorId: admin.user.id });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "保存失败" };
  }

  // 重算。账号是三位数，一次全表足够；到万级再谈分批
  const rows = db.select({ id: users.id, pointsTotal: users.pointsTotal, level: users.level }).from(users).all();
  let changed = 0;
  db.transaction((tx) => {
    for (const row of rows) {
      const next = levelOf(row.pointsTotal, verdict.levels).level;
      if (next === row.level) continue;
      tx.update(users).set({ level: next, updatedAt: Date.now() }).where(eq(users.id, row.id)).run();
      changed++;
    }
  });

  audit(
    { actorId: admin.user.id },
    {
      action: "points.levels.set",
      targetType: "setting",
      targetId: LEVELS_SETTING_KEY,
      after: { levels: verdict.levels, recomputed: changed },
    },
  );

  revalidatePath("/admin/points/levels");
  revalidatePath("/me/points");
  return { ok: true, changed };
}
