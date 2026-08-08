/**
 * 积分经济。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────────
 * 为什么需要一套「货币策略」而不是随手定几个数字
 * ─────────────────────────────────────────────
 *
 * 积分只发不收，一年之后必然出现三件事：
 *   1. 商店里的价格变成笑话（早期用户随手就能买空）
 *   2. 新人永远追不上老人，榜单变成入群时间排序
 *   3. 积分不再代表任何东西，于是没人再为它做事
 *
 * 所以这里的核心不是「怎么发分」，是**发行总量受控**。
 * 三条结构性决定：
 *
 * ① 双轨。累计获得（pointsTotal）只增不减，用来算等级和称号 ——
 *   它是履历，不是货币。余额（points）才是货币，可以被回收。
 *   混成一个的话，花积分会掉级，等于惩罚使用积分的人，
 *   最后所有人攒着不花，商店和活动全都没人用。
 *
 * ② **每人每日发行上限，所有来源共享同一个预算**。
 *   打卡、高质量加分、连胜、互动结算都从这一个池子里出。
 *   各来源各自封顶的做法看起来更灵活，但那意味着
 *   **每加一个玩法就等于给通胀开一个新口子**。
 *   共享预算之后，加玩法只改变分配，不改变发行 —— 这是整套策略的支点。
 *
 * ③ 回收要**可持续**，不能只靠一次性消费。
 *   一次性商品买完就没了，回收随之归零。所以要有按期扣费的东西
 *   （租用型称号、置顶位、邮箱额度），让回收和时间同步发生。
 *
 * 数值全部来自 settings 表，由调用方读好传进来。
 */

export interface EconomyConfig {
  /** 每人每日发行上限 —— 所有来源共享 */
  dailyMintCap: number;
  /** 互动结算里前多少「单位」按全额计分 */
  interactionFullUnits: number;
  /** 超出部分的折算比例（0–1） */
  interactionDecayRatio: number;
  /** 每单位折算成多少分 */
  interactionPointsPerUnit: number;
  /** 互动结算自身的上限 */
  interactionCap: number;
  /** 转赠手续费比例，直接销毁 */
  transferFeeRatio: number;
  /** 月净增占流通量的比例超过这个就告警 */
  inflationWarnRatio: number;
}

/**
 * 互动的权重。
 *
 * 「收到的赞」权重刻意低于「自己发的内容」：
 * 收赞取决于别人，鼓励不了行为，而且**可以互刷**。
 * 给别人点赞权重更低但不为零 —— 它是社区里最便宜的善意，
 * 完全不计分的话就没人做了。
 */
export const INTERACTION_WEIGHTS = {
  post: 3,
  reply: 1,
  reactionReceived: 0.5,
  reactionGiven: 0.2,
  qualityMessage: 1,
} as const;

export type InteractionKind = keyof typeof INTERACTION_WEIGHTS;

export type InteractionCounts = Partial<Record<InteractionKind, number>>;

export interface Settlement {
  /** 加权后的原始单位数 */
  rawUnits: number;
  /** 打折之后实际计入的单位数 */
  creditedUnits: number;
  points: number;
  /** 是否撞到了互动结算自身的上限 */
  capped: boolean;
  /** 明细，用来在界面上逐项展示「这分是怎么来的」 */
  breakdown: { kind: InteractionKind; count: number; units: number }[];
}

/**
 * 结算当天的互动。
 *
 * 两段式递减，而不是几何衰减：
 * 前 N 个单位全额，之后按比例折算，再整体封顶。
 * 几何衰减更"平滑"，但**没法用一句话跟用户讲清楚**，
 * 而讲不清楚的规则，用户只会觉得系统在克扣。
 */
export function settleInteractions(
  counts: InteractionCounts,
  config: EconomyConfig,
): Settlement {
  const breakdown: Settlement["breakdown"] = [];
  let rawUnits = 0;

  for (const kind of Object.keys(INTERACTION_WEIGHTS) as InteractionKind[]) {
    const count = Math.max(0, Math.floor(counts[kind] ?? 0));
    if (count === 0) continue;
    const units = count * INTERACTION_WEIGHTS[kind];
    rawUnits += units;
    breakdown.push({ kind, count, units });
  }

  const full = Math.max(0, config.interactionFullUnits);
  const ratio = clamp01(config.interactionDecayRatio);
  const creditedUnits =
    rawUnits <= full ? rawUnits : full + (rawUnits - full) * ratio;

  const uncapped = Math.floor(creditedUnits * config.interactionPointsPerUnit);
  const points = Math.min(uncapped, Math.max(0, config.interactionCap));

  return {
    rawUnits,
    creditedUnits,
    points,
    capped: uncapped > points,
    breakdown,
  };
}

export interface BudgetResult {
  /** 实际能发的分 */
  granted: number;
  /** 因为撞上限被削掉的分 */
  clipped: number;
  /** 是否撞到了每日上限 */
  capped: boolean;
  /** 今天还剩多少额度 */
  remaining: number;
}

/**
 * 套用每日发行预算。
 *
 * 削掉的部分要**如实告诉用户**（clipped），不能静默少发 ——
 * 「我明明做了这么多怎么只有这点分」是最伤人的体验，
 * 而它其实只需要一句「今日上限已到」就能解释清楚。
 */
export function applyDailyBudget(
  amount: number,
  mintedToday: number,
  config: EconomyConfig,
): BudgetResult {
  const cap = Math.max(0, config.dailyMintCap);
  const used = Math.max(0, mintedToday);
  const remainingBefore = Math.max(0, cap - used);

  const granted = Math.max(0, Math.min(amount, remainingBefore));
  return {
    granted,
    clipped: Math.max(0, amount - granted),
    capped: granted < amount,
    remaining: Math.max(0, remainingBefore - granted),
  };
}

/** 转赠手续费。直接销毁，不进任何人的口袋 —— 进了就不是回收了 */
export function transferFee(amount: number, config: EconomyConfig): number {
  return Math.floor(Math.max(0, amount) * clamp01(config.transferFeeRatio));
}

export interface InflationInput {
  /** 统计窗口内的发行量 */
  minted: number;
  /** 统计窗口内的回收量（正数） */
  burned: number;
  /** 窗口开始时的流通总量 */
  circulatingBefore: number;
}

export type InflationVerdict = "healthy" | "watch" | "inflating" | "deflating";

export interface InflationReport {
  minted: number;
  burned: number;
  net: number;
  /** 净增占期初流通量的比例 */
  rate: number;
  /** 回收覆盖率：回收量 / 发行量 */
  sinkCoverage: number;
  verdict: InflationVerdict;
  message: string;
}

/**
 * 通胀体检。
 *
 * 看的是**净增占流通量的比例**，不是发行绝对值 ——
 * 社区变大发行自然变多，那不是通胀。
 *
 * 也要看回收覆盖率：净增很小但发行和回收都接近零，
 * 说明的不是健康，是**没人在用积分**，那是另一种病。
 */
export function inflationReport(
  input: InflationInput,
  config: EconomyConfig,
): InflationReport {
  const net = input.minted - input.burned;
  const base = Math.max(1, input.circulatingBefore);
  const rate = net / base;
  const sinkCoverage = input.minted > 0 ? input.burned / input.minted : 0;

  let verdict: InflationVerdict;
  let message: string;

  if (net < 0) {
    verdict = "deflating";
    message = "回收大于发行，流通量在缩小。持续下去会让人觉得积分只出不进。";
  } else if (rate > config.inflationWarnRatio) {
    verdict = "inflating";
    message = `净增占流通量的 ${pct(rate)}，超过 ${pct(config.inflationWarnRatio)} 的警戒线。要么收紧发行，要么加回收口。`;
  } else if (rate > config.inflationWarnRatio * 0.6) {
    verdict = "watch";
    message = `净增占流通量的 ${pct(rate)}，还在区间内但趋势要盯着。`;
  } else if (input.minted > 0 && sinkCoverage < 0.15) {
    // 净增比例不高也可能只是因为基数大，回收几乎不存在同样是问题
    verdict = "watch";
    message = `回收只覆盖了发行的 ${pct(sinkCoverage)}，积分基本只进不出 —— 现在看着没事，是因为流通量还大。`;
  } else {
    verdict = "healthy";
    message = `净增 ${pct(rate)}，回收覆盖 ${pct(sinkCoverage)}，在健康区间。`;
  }

  return { minted: input.minted, burned: input.burned, net, rate, sinkCoverage, verdict, message };
}

/**
 * 分配集中度。
 *
 * 用中位数与均值的比值，而不是基尼系数 ——
 * 基尼系数算得出来但没人看得懂，管理员看不懂的指标等于没有。
 * 比值接近 1 说明分布均匀；越小说明少数人握着大部分积分。
 */
export function concentration(balances: readonly number[]): {
  median: number;
  mean: number;
  ratio: number;
  topShare: number;
} {
  if (balances.length === 0) return { median: 0, mean: 0, ratio: 1, topShare: 0 };

  const sorted = [...balances].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const total = sorted.reduce((sum, n) => sum + n, 0);
  const mean = total / sorted.length;

  // 前 10% 的人握着多少
  const topCount = Math.max(1, Math.ceil(sorted.length * 0.1));
  const topTotal = sorted.slice(-topCount).reduce((sum, n) => sum + n, 0);

  return {
    median,
    mean,
    ratio: mean > 0 ? median / mean : 1,
    topShare: total > 0 ? topTotal / total : 0,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export const INTERACTION_LABELS: Record<InteractionKind, string> = {
  post: "发帖",
  reply: "回复",
  reactionReceived: "收到的赞",
  reactionGiven: "给出的赞",
  qualityMessage: "群里的高质量发言",
};
