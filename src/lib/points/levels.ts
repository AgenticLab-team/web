import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getSettingJson } from "@/lib/settings/store";

import { checkLevels, LEVELS_SETTING_KEY, type LevelDef } from "./level-rules";
import { LEVELS, type LevelSpec } from "./rules";

/**
 * 现在生效的等级门槛。
 *
 * ─────────────────────────────────────────
 * 坏值退回默认，不抛异常
 * ─────────────────────────────────────────
 *
 * 写入侧是拒绝坏值的（validateSettingValue + checkLevels），
 * 所以走到兜底这条路只可能是有人直接改了库。
 * 那时候**继续用默认门槛**是唯一说得过去的行为 ——
 * 抛异常的话，一份存坏的配置会让全站每一次积分变动都失败。
 */
export function configuredLevels(): LevelSpec[] {
  const raw = getSettingJson<unknown>(LEVELS_SETTING_KEY, null);
  if (raw === null) return LEVELS;

  const verdict = checkLevels(raw);
  return verdict.ok ? (verdict.levels as LevelSpec[]) : LEVELS;
}

/** 后台要显示「现在这份表合不合法」—— 坏了得说出来，而不是默默用默认的 */
export function levelsHealth(): { ok: boolean; error?: string; usingDefault: boolean } {
  const raw = getSettingJson<unknown>(LEVELS_SETTING_KEY, null);
  if (raw === null) return { ok: true, usingDefault: true };

  const verdict = checkLevels(raw);
  return verdict.ok
    ? { ok: true, usingDefault: false }
    : { ok: false, error: verdict.error, usingDefault: true };
}

export type { LevelDef };

/**
 * 全站等级分布 —— 编辑器要显示「这一级现在有多少人」。
 *
 * 放在这里而不是 level-actions.ts：那个文件是 `"use server"`，
 * **只能导出 async 函数**。一个同步的查询放进去，构建会直接失败
 * （Server Actions must be async functions）——
 * 部署脚本因此没有重启服务，线上还是旧版本，没出事。
 */
export function levelCounts(): Record<number, number> {
  const rows = db
    .select({ level: users.level, n: sql<number>`count(*)` })
    .from(users)
    .groupBy(users.level)
    .all();
  return Object.fromEntries(rows.map((r) => [r.level, Number(r.n)]));
}
