import "server-only";

import { desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { settingHistory, settings, users } from "@/lib/db/schema";
import { isDangerousSetting, needsBackfillWarning } from "@/lib/settings/validate";
import { resolveDisplayName } from "@/lib/users/display-name";

/**
 * 系统设置的读取层。
 *
 * 每一项都要带上**它现在和默认值差多少**：
 * 一屏几十个配置项里，真正被改过的往往只有三五个，
 * 而那三五个才是排查问题时该看的。全都长一样的话，
 * 「有没有人动过什么」这个问题只能靠翻历史。
 */

export interface SettingRow {
  key: string;
  value: string;
  defaultValue: string | null;
  type: string;
  category: string;
  label: string | null;
  description: string | null;
  minValue: number | null;
  maxValue: number | null;
  requiresPermission: string | null;

  /** 与默认值不同 */
  modified: boolean;
  /** 改了不会追溯历史数据 */
  retroactive: boolean;
  /** 改错会静默影响所有人 —— 界面要常驻警告（不再强制复核，站长指令） */
  dangerous: boolean;

  updatedAt: number;
  updatedBy: string | null;
  updatedByName: string | null;
  changeCount: number;
}

export interface SettingCategory {
  category: string;
  label: string;
  items: SettingRow[];
}

/*
 * ⚠️ **少一条的后果是一个英文小写单词出现在后台标题上。**
 *
 * 下面 `listSettings` 里那句 `?? category` 是个悄悄降级的兜底：
 * 认不出的分类不会报错、不会空白，它显示原始 key ——
 * 而一个写着「mail」的分组标题，看起来就像是本来就这么设计的。
 *
 * 一次截图普查时发现有四个分类是这样：`mail`（13 项）、`module`（9）、
 * `digest`（4）、`site`（2）—— 78 项设置里有 28 项顶着英文标题，
 * 而其中三个比邮件功能早得多，也就是说它一直是这样，从没有人报过。
 *
 * `tests/admin-labels.test.ts` 现在对着**库里真实存在的分类**核这张表，
 * 少一条就红 —— 把「悄悄降级」换成「当场知道」。
 */
const CATEGORY_LABELS: Record<string, string> = {
  auth: "登录与绑定",
  sync: "同步与判定",
  points: "积分",
  forum: "论坛",
  antifraud: "反作弊",
  storage: "存储",
  general: "通用",
  /** 一次性邮箱：地址额度、箱子与信件的大小上限、收信频率 */
  mail: "邮箱",
  /** 可插拔玩法的总开关。注意它和「功能开关」是两页，那边管的是整块功能 */
  module: "模块开关",
  /** 每周精选和每天那一条 —— 挑几篇、一个人最多占几条 */
  digest: "精选推送",
  /** 站点级的开放程度：论坛给不给游客看、还收不收新人 */
  site: "站点开放",
  /** 邀请码：请进来一个人给多少分 */
  invite: "邀请",
  /** 上游（NekoBot）：调用记录留多久 */
  upstream: "上游接入",
};

export function listSettings(): SettingCategory[] {
  const rows = db.select().from(settings).orderBy(settings.category, settings.key).all();

  const counts = new Map(
    db
      .select({ key: settingHistory.key, n: sql<number>`count(*)` })
      .from(settingHistory)
      .groupBy(settingHistory.key)
      .all()
      .map((r) => [r.key, Number(r.n)]),
  );

  const editorIds = [...new Set(rows.map((r) => r.updatedBy).filter(Boolean))] as string[];
  const names = new Map(
    editorIds.length
      ? db
          .select({ id: users.id, site: users.siteNickname, wx: users.wxNickname, wxId: users.wxId })
          .from(users)
          .where(sql`${users.id} in ${editorIds}`)
          .all()
          .map((u) => [
            u.id,
            resolveDisplayName([u.site, u.wx], { wxId: u.wxId, fallback: "管理员" }),
          ])
      : [],
  );

  const byCategory = new Map<string, SettingRow[]>();
  for (const row of rows) {
    const item: SettingRow = {
      key: row.key,
      value: row.value,
      defaultValue: row.defaultValue,
      type: row.type,
      category: row.category,
      label: row.label,
      description: row.description,
      minValue: row.minValue,
      maxValue: row.maxValue,
      requiresPermission: row.requiresPermission,

      modified: row.defaultValue !== null && row.value !== row.defaultValue,
      retroactive: needsBackfillWarning(row.key),
      dangerous: isDangerousSetting(row.key),

      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      updatedByName: row.updatedBy ? (names.get(row.updatedBy) ?? "管理员") : null,
      changeCount: counts.get(row.key) ?? 0,
    };
    const list = byCategory.get(row.category) ?? [];
    list.push(item);
    byCategory.set(row.category, list);
  }

  return [...byCategory.entries()].map(([category, items]) => ({
    category,
    label: CATEGORY_LABELS[category] ?? category,
    items,
  }));
}

export interface HistoryEntry {
  id: string;
  key: string;
  label: string | null;
  oldValue: string | null;
  newValue: string | null;
  changedBy: string | null;
  changedByName: string;
  reason: string | null;
  createdAt: number;
}

/** 变更历史总条数 —— 「最近的变更」只显示几条，总量要一并给出 */
export function settingHistoryCount(): number {
  return Number(db.select({ n: sql<number>`count(*)` }).from(settingHistory).get()?.n ?? 0);
}

export function settingHistoryOf(key?: string, limit = 40): HistoryEntry[] {
  const rows = db
    .select()
    .from(settingHistory)
    .where(key ? eq(settingHistory.key, key) : undefined)
    .orderBy(desc(settingHistory.createdAt))
    .limit(limit)
    .all();

  if (rows.length === 0) return [];

  const labels = new Map(
    db.select({ key: settings.key, label: settings.label }).from(settings).all().map((s) => [s.key, s.label]),
  );

  const ids = [...new Set(rows.map((r) => r.changedBy).filter(Boolean))] as string[];
  const names = new Map(
    ids.length
      ? db
          .select({ id: users.id, site: users.siteNickname, wx: users.wxNickname, wxId: users.wxId })
          .from(users)
          .where(sql`${users.id} in ${ids}`)
          .all()
          .map((u) => [
            u.id,
            resolveDisplayName([u.site, u.wx], { wxId: u.wxId, fallback: "管理员" }),
          ])
      : [],
  );

  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: labels.get(r.key) ?? null,
    oldValue: r.oldValue,
    newValue: r.newValue,
    changedBy: r.changedBy,
    changedByName: r.changedBy ? (names.get(r.changedBy) ?? "管理员") : "系统",
    reason: r.reason,
    createdAt: r.createdAt,
  }));
}

/** 被改动过的项数 —— 排查问题时先看这些 */
export function modifiedCount(): number {
  return db
    .select()
    .from(settings)
    .all()
    .filter((r) => r.defaultValue !== null && r.value !== r.defaultValue).length;
}
