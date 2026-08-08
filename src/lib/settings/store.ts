import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, featureFlags, settingHistory, settings } from "@/lib/db/schema";

/**
 * 配置读取走进程内缓存 —— 积分结算、同步、权限判定每秒会读很多次，
 * 每次打库没必要。写入时清缓存。
 */
let cache: Map<string, string> | null = null;
let flagCache: Map<string, boolean> | null = null;

function load(): Map<string, string> {
  if (cache) return cache;
  const rows = db.select({ key: settings.key, value: settings.value }).from(settings).all();
  cache = new Map(rows.map((r) => [r.key, r.value]));
  return cache;
}

export function invalidateSettingsCache() {
  cache = null;
  flagCache = null;
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
export function updateSetting(key: string, value: string, ctx: UpdateSettingContext) {
  const current = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!current) throw new Error(`未知配置项 ${key}`);
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

function loadFlags(): Map<string, boolean> {
  if (flagCache) return flagCache;
  const rows = db
    .select({ key: featureFlags.key, enabled: featureFlags.enabled })
    .from(featureFlags)
    .all();
  flagCache = new Map(rows.map((r) => [r.key, r.enabled]));
  return flagCache;
}

/** 功能开关。出问题时先关模块，而不是回滚整站 */
export function isFeatureEnabled(key: string): boolean {
  return loadFlags().get(key) ?? false;
}
