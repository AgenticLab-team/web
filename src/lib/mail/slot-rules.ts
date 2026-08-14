import type { MailDomainTier } from "./kinds";

/**
 * 槽位和申领的**纯规则**。不碰库、不碰积分。
 *
 * 单独一层的理由和 `address-rules.ts` 一样：这些判断错一条的后果是
 * 「有人多拿了一个好地址」或者「有人该拿的没拿到」，
 * 而两者都要能被单独测 —— 拖着 drizzle 的话没人会为一个边界多写一条断言。
 */

/**
 * 等级给几个槽位。
 *
 * ═════════════════════════════════════════
 * L5 之后不再涨
 * ═════════════════════════════════════════
 *
 * 防的是早期用户把好前缀囤成资产。这和 `ECONOMY.md` 里
 * 「新人永远追不上老人」是同一个病：额度无上限的话，两年后
 * `mail@某好域名` 全在最早那批人手里，而他们中的多数已经不来了。
 */
export const LEVEL_SLOT_CAP = 5;

/** 买来的最多几个。上限本身就是设计的一部分 —— 没有上限就是「钱能买断」 */
export const PURCHASED_SLOT_CAP = 3;

/** 一个人最多几个槽位 */
export const SLOT_HARD_CAP = LEVEL_SLOT_CAP + PURCHASED_SLOT_CAP;

/**
 * 这个人一共有几个槽位。
 *
 * ⚠️ **`mail_slots` 表里的行才是真值**，这个函数只是「按规则应该有几个」。
 * 两者要能对得上 —— 后台重算比对走的就是这个函数
 * （和活动名额、积分余额同一个办法，见 `SCHEMA.md` 零节）。
 * 名额算错在这种东西上是事故。
 */
export function slotsFor(level: number, purchased: number): number {
  const byLevel = Math.min(Math.max(0, Math.floor(level)), LEVEL_SLOT_CAP);
  const bought = Math.min(Math.max(0, Math.floor(purchased)), PURCHASED_SLOT_CAP);
  return Math.min(byLevel + bought, SLOT_HARD_CAP);
}

/**
 * 申领各档要几级。
 *
 * ─────────────────────────────────────────
 * 等级解锁「能力」，积分买「数量和好地址」
 * ─────────────────────────────────────────
 *
 * 混在一起的话两条曲线会互相抵消：攒分的人自动升级，
 * 于是花分买的东西他本来也会有。
 */
export const TIER_MIN_LEVEL: Record<MailDomainTier, number> = { b: 2, a: 3, s: 4 };

/**
 * 各档年租（分）。
 *
 * ═════════════════════════════════════════
 * S 档定成「全站最有钱的人也差一点」是**故意的**
 * ═════════════════════════════════════════
 *
 * `ECONOMY.md` 第一条要防的就是「早期用户随手买空」——
 * 一个开服当天就被扫光的靓号池，比没有靓号池糟。
 *
 * 三个数都同时标着「≈ 几天」（日常参与一天 10–25 分）：
 * 60 ≈ 3 天、150 ≈ 一周多、400 ≈ 三周。定价必须贴着经济体量，
 * 否则它要么是白送要么是永远买不起，两种都等于没有价格。
 */
export const TIER_RENT: Record<MailDomainTier, number> = { b: 60, a: 150, s: 400 };

/** 买一个额外槽位多少分。一次性 */
export const SLOT_PRICE = 60;

/** 年租的周期 */
export const RENT_DAYS = 365;

/**
 * 到期之后的宽限期。
 *
 * ═════════════════════════════════════════
 * 邮箱的宽限期是**必需的**，不是体贴
 * ═════════════════════════════════════════
 *
 * 称号到期只是不能佩戴；而邮箱到期被别人抢走的话，
 * **别人会开始收到本该给你的邮件**。那不是「失去一个装饰」，
 * 是一条还在被使用的身份线被接管。
 *
 * 30 天内补交年租原样恢复；过了才真正放回池子。
 */
export const GRACE_DAYS = 30;

/** 放回池子时原主的优先赎回期 */
export const REDEEM_DAYS = 7;

export type ClaimRefusal =
  | { code: "level"; need: number; have: number }
  | { code: "no_slot"; total: number; used: number }
  | { code: "poor"; need: number; have: number };

/**
 * 能不能申领。
 *
 * 三道闸的**顺序是有讲究的**：等级 → 槽位 → 积分。
 *
 * 反过来（先查积分）的话，一个 L1 的人会先被告知「分不够」，
 * 他攒够了再来，然后才被告知「等级不够」—— 两次拒绝，
 * 而第二次那个理由从一开始就成立。
 * 先说那个**他今天无论如何都改变不了**的。
 */
export function canClaim(input: {
  tier: MailDomainTier;
  level: number;
  slotsTotal: number;
  slotsUsed: number;
  points: number;
}): ClaimRefusal | null {
  const need = TIER_MIN_LEVEL[input.tier];
  if (input.level < need) return { code: "level", need, have: input.level };
  if (input.slotsUsed >= input.slotsTotal) {
    return { code: "no_slot", total: input.slotsTotal, used: input.slotsUsed };
  }
  const rent = TIER_RENT[input.tier];
  if (input.points < rent) return { code: "poor", need: rent, have: input.points };
  return null;
}

/** 把拒绝理由说成人话。每一句都要说出**下一步能做什么** */
export function explainRefusal(r: ClaimRefusal): string {
  switch (r.code) {
    case "level":
      return `这一档要 L${r.need}，你现在 L${r.have} —— 先升级，或者挑个低一档的域名`;
    case "no_slot":
      return `${r.total} 个槽位都占着了（用了 ${r.used} 个）。退掉一个不用的，或者花 ${SLOT_PRICE} 分买一个`;
    case "poor":
      return `年租 ${r.need} 分，你有 ${r.have} 分 —— 还差 ${r.need - r.have}`;
  }
}

/**
 * 续期从**原到期日**顺延，不是从今天。
 *
 * 从今天算的话，是在惩罚提前付钱的人：早交一天就少一天。
 * 已经过期（在宽限期里）的从今天算 —— 那段时间它本来就没在服务。
 */
export function renewedExpiry(currentExpiry: number, now: number): number {
  const base = Math.max(currentExpiry, now);
  return base + RENT_DAYS * 86_400_000;
}
