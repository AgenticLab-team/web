import type { TitleRarity, TitleSource } from "@/lib/db/schema/titles";

/**
 * 称号规则。纯函数，授予、购买、佩戴、过期都走这一份。
 *
 * 设计上的几条：
 *
 * ① **可以持有多个，只能佩戴一个。** 挂满一排等于都没挂 ——
 *   称号的价值来自「你选了这一个」，不是数量。
 *
 * ② **稀有称号要有名额上限。** 发滥了就不稀有了，
 *   而已经发出去的收不回来（收回比不发更伤人）。
 *
 * ③ **到期不等于撤销。** 租用和赛季称号到期后只是不能再佩戴，
 *   持有记录保留 —— 「我曾经拿到过」也是履历的一部分。
 */

export interface RuleResult {
  ok: boolean;
  error?: string;
}

const OK: RuleResult = { ok: true };
const no = (error: string): RuleResult => ({ ok: false, error });

export interface HeldTitle {
  titleId: string;
  expiresAt: number | null;
  revokedAt: number | null;
}

/** 现在还能不能用。撤销了、或者过期了，都不能 */
export function isTitleActive(held: HeldTitle, now: number): boolean {
  if (held.revokedAt !== null) return false;
  if (held.expiresAt !== null && held.expiresAt <= now) return false;
  return true;
}

/** 到期了但没被撤销 —— 界面上要和「从没有过」区分开 */
export function isTitleExpired(held: HeldTitle, now: number): boolean {
  return held.revokedAt === null && held.expiresAt !== null && held.expiresAt <= now;
}

export interface TitleSpec {
  id: string;
  key: string;
  name: string;
  rarity: TitleRarity;
  source: TitleSource;
  price: number | null;
  rentDays: number | null;
  limitCount: number | null;
  enabled: boolean;
}

export interface GrantInput {
  title: TitleSpec;
  /** 已经在册的持有人数（不含撤销与过期） */
  currentHolders: number;
  /** 这个人是否已经持有 */
  alreadyHeld: boolean;
  reason: string;
}

export function checkGrant(input: GrantInput): RuleResult {
  if (!input.reason.trim()) return no("必须填写理由");
  if (!input.title.enabled) return no("这个称号已停用");
  if (input.alreadyHeld) return no("这个人已经有这个称号了");

  if (input.title.limitCount !== null && input.currentHolders >= input.title.limitCount) {
    return no(`名额已满（上限 ${input.title.limitCount} 个）`);
  }

  return OK;
}

export interface PurchaseInput {
  title: TitleSpec;
  balance: number;
  currentHolders: number;
  alreadyHeld: boolean;
}

export function checkPurchase(input: PurchaseInput): RuleResult {
  if (!input.title.enabled) return no("这个称号已停用");
  if (input.title.source !== "purchase") return no("这个称号不能购买");
  if (input.title.price === null || input.title.price <= 0) return no("这个称号还没有定价");
  if (input.alreadyHeld) return no("你已经有这个称号了");

  if (input.title.limitCount !== null && input.currentHolders >= input.title.limitCount) {
    return no("名额已满");
  }

  if (input.balance < input.title.price) {
    return no(`还差 ${input.title.price - input.balance} 分`);
  }

  return OK;
}

/** 租用型称号的到期时间。非租用型返回 null（永久持有） */
export function expiryFor(title: TitleSpec, from: number): number | null {
  if (title.rentDays === null || title.rentDays <= 0) return null;
  return from + title.rentDays * 86_400_000;
}

/**
 * 续费的到期时间。
 *
 * 从**当前到期时间**往后顺延，不是从现在。
 * 从现在算的话，提前续费的人会白白损失剩余天数 ——
 * 那等于在惩罚愿意提前付钱的人。
 * 但已经过期的从现在算，不然补一次费就把空窗期也算进去了。
 */
export function renewalExpiry(currentExpiry: number | null, title: TitleSpec, now: number): number | null {
  if (title.rentDays === null || title.rentDays <= 0) return null;
  const from = currentExpiry !== null && currentExpiry > now ? currentExpiry : now;
  return from + title.rentDays * 86_400_000;
}

export interface EquipInput {
  /** 要佩戴的称号，null 表示摘下 */
  titleId: string | null;
  held: HeldTitle[];
  now: number;
}

export function checkEquip(input: EquipInput): RuleResult {
  // 摘下称号永远允许 —— 不能让人被自己的称号困住
  if (input.titleId === null) return OK;

  const held = input.held.find((h) => h.titleId === input.titleId);
  if (!held) return no("你没有这个称号");
  if (held.revokedAt !== null) return no("这个称号已被收回");
  if (isTitleExpired(held, input.now)) return no("这个称号已经过期了");

  return OK;
}

/**
 * 成就型称号的达成判定。
 *
 * 条件只用「某个指标 ≥ 某个数」这一种形态。
 * 表达力有限是刻意的：复杂条件写起来爽，但用户看不懂自己
 * 为什么拿到或没拿到，而看不懂的成就不会驱动任何行为。
 */
export interface AchievementStats {
  pointsTotal: number;
  streakBest: number;
  posts: number;
  replies: number;
  qualityMessages: number;
  checkins: number;
}

export const CONDITION_LABELS: Record<keyof AchievementStats, string> = {
  pointsTotal: "累计获得积分",
  streakBest: "最长连胜天数",
  posts: "发帖数",
  replies: "回复数",
  qualityMessages: "高质量发言数",
  checkins: "打卡天数",
};

export function meetsCondition(
  title: Pick<TitleSpec, "source"> & { conditionKind: string | null; conditionValue: number | null },
  stats: AchievementStats,
): boolean {
  if (title.source !== "achievement") return false;
  if (!title.conditionKind || title.conditionValue === null) return false;

  const value = stats[title.conditionKind as keyof AchievementStats];
  if (typeof value !== "number") return false;
  return value >= title.conditionValue;
}

export const RARITY_LABELS: Record<TitleRarity, string> = {
  common: "普通",
  rare: "稀有",
  epic: "史诗",
  legendary: "传说",
};

/** 稀有度配色。越稀有越暖，和等级的中性灰拉开区分 */
export const RARITY_COLORS: Record<TitleRarity, string> = {
  common: "var(--ink-tertiary)",
  rare: "var(--accent)",
  epic: "#a855f7",
  legendary: "#f59e0b",
};

export const SOURCE_LABELS: Record<TitleSource, string> = {
  grant: "授予",
  achievement: "成就",
  purchase: "购买",
  seasonal: "赛季",
};

export function rarityLabel(rarity: string): string {
  return RARITY_LABELS[rarity as TitleRarity] ?? rarity;
}

export function rarityColor(rarity: string): string {
  return RARITY_COLORS[rarity as TitleRarity] ?? RARITY_COLORS.common;
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source as TitleSource] ?? source;
}
