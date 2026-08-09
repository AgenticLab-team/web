import "server-only";

import { eq } from "drizzle-orm";

import { validateSettingValue } from "./validate";

import { db } from "@/lib/db";
import { auditLogs, settingHistory, settings } from "@/lib/db/schema";

/**
 * 配置读取走进程内缓存 —— 积分结算、同步、权限判定每秒会读很多次，
 * 每次打库没必要。写入时清缓存。
 */
let cache: Map<string, string> | null = null;

function load(): Map<string, string> {
  if (cache) return cache;
  const rows = db.select({ key: settings.key, value: settings.value }).from(settings).all();
  cache = new Map(rows.map((r) => [r.key, r.value]));
  return cache;
}

export function invalidateSettingsCache() {
  cache = null;
}

export function getSetting(key: string, fallback = ""): string {
  return load().get(key) ?? fallback;
}

export function getSettingInt(key: string, fallback: number): number {
  const raw = load().get(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function getSettingBool(key: string, fallback = false): boolean {
  const raw = load().get(key);
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

export interface UpdateSettingContext {
  actorId: string;
  actorIp?: string;
  reason?: string;
}

/**
 * 修改配置 = 写 settings + 写 setting_history + 写 audit_logs。
 * 三处齐全才算完成 —— 这是 SCHEMA.md 里「一切留痕」那条规则的落地。
 */
export function updateSetting(key: string, rawValue: string, ctx: UpdateSettingContext) {
  const current = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!current) throw new Error(`未知配置项 ${key}`);

  /*
   * **写入侧校验，不靠读取侧兜底。**
   *
   * 读取侧遇到非法值会退回代码默认值，听起来很稳，
   * 实际上制造了最难查的一类 bug：后台显示的和实际生效的不是一回事。
   * 把上限填成 "6O"（字母 O）会保存成功、页面显示 6O，
   * 而系统一直在用 60 —— 没有任何地方报错。
   */
  const verdict = validateSettingValue(
    {
      key,
      type: current.type,
      minValue: current.minValue,
      maxValue: current.maxValue,
      label: current.label,
    },
    rawValue,
  );
  if (!verdict.ok) throw new Error(`${current.label ?? key}：${verdict.error}`);

  const value = verdict.normalized!;
  if (current.value === value) return current;

  db.transaction((tx) => {
    tx.update(settings)
      .set({ value, updatedAt: Date.now(), updatedBy: ctx.actorId })
      .where(eq(settings.key, key))
      .run();

    tx.insert(settingHistory)
      .values({
        key,
        oldValue: current.value,
        newValue: value,
        changedBy: ctx.actorId,
        reason: ctx.reason,
      })
      .run();

    tx.insert(auditLogs)
      .values({
        actorId: ctx.actorId,
        actorIp: ctx.actorIp,
        action: "settings.update",
        targetType: "setting",
        targetId: key,
        targetLabel: current.label ?? key,
        before: { value: current.value },
        after: { value },
        reason: ctx.reason,
        dangerLevel: 2,
      })
      .run();
  });

  invalidateSettingsCache();
  return { ...current, value };
}

/*
 * 功能开关的判定挪到了 lib/flags/。
 *
 * 原来这里有一份 `isFeatureEnabled`，**全站零调用点**，
 * 而且 `?? false` 会让一张空表把整站功能全关掉。
 * 留着两份判定的话，早晚有一处被改、另一处没改。
 */
