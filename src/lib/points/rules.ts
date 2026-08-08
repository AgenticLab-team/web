/**
 * 积分规则引擎。
 *
 * **纯函数，不碰数据库** —— 所有输入显式传进来，
 * 这样每条规则的每个分支都能被测试覆盖。
 * 规则里出现魔法数字是最难查的一类 bug：数字改了没人知道影响面。
 *
 * 所有数值来自 settings 表，由调用方读好传进来（见 config 参数）。
 */

export interface PointsConfig {
  /** 打卡所需的当日高质量消息数 */
  checkinMinQuality: number;
  /** 打卡基础分 */
  checkinBase: number;
  /** 每多 step 条高质量消息加 per 分 */
  qualityBonusPer: number;
  qualityBonusStep: number;
  /** 高质量加分的每日上限 */
  qualityBonusDailyCap: number;
  /** 连胜奖励上限 */
  streakCap: number;
}

export interface CheckinInput {
  /** 当日高质量消息数 */
  qualityToday: number;
  /** 打卡前的连胜天数 */
  streakBefore: number;
  /** 上次打卡日期（YYYY-MM-DD），从未打卡为 null */
  lastCheckinDate: string | null;
  /** 今天的日期 */
  today: string;
  /** 昨天的日期 */
  yesterday: string;
}

export type CheckinVerdict =
  | { ok: false; reason: "already"; message: string }
  | { ok: false; reason: "not_enough"; message: string; need: number; have: number }
  | {
      ok: true;
      base: number;
      qualityBonus: number;
      streakBonus: number;
      total: number;
      streakAfter: number;
      /** 连胜是否在这次被打断重置 */
      streakReset: boolean;
    };

/**
 * 打卡判定。
 *
 * 规则：当日高质量消息达标才能打卡 —— **先有贡献再签到**。
 * 纯签到党拿不到分，否则积分就只是「每天点一下」的奖励，
 * 与「让群里有好内容」这个目标完全脱钩。
 */
export function evaluateCheckin(input: CheckinInput, config: PointsConfig): CheckinVerdict {
  if (input.lastCheckinDate === input.today) {
    return { ok: false, reason: "already", message: "今天已经打过卡了" };
  }

  if (input.qualityToday < config.checkinMinQuality) {
    return {
      ok: false,
      reason: "not_enough",
      message: `今天还差 ${config.checkinMinQuality - input.qualityToday} 条高质量发言`,
      need: config.checkinMinQuality,
      have: input.qualityToday,
    };
  }

  // 昨天打过才算连上；隔了一天以上就断了
  const continued = input.lastCheckinDate === input.yesterday;
  const streakAfter = continued ? input.streakBefore + 1 : 1;
  const streakReset = !continued && input.streakBefore > 0;

  const bonusSteps =
    config.qualityBonusStep > 0
      ? Math.floor(
          Math.max(0, input.qualityToday - config.checkinMinQuality) / config.qualityBonusStep,
        )
      : 0;
  const qualityBonus = Math.min(bonusSteps * config.qualityBonusPer, config.qualityBonusDailyCap);

  // 连胜奖励等于连胜天数，但有上限 —— 否则一年后每天白拿三百多分
  const streakBonus = Math.min(streakAfter, config.streakCap);

  return {
    ok: true,
    base: config.checkinBase,
    qualityBonus,
    streakBonus,
    total: config.checkinBase + qualityBonus + streakBonus,
    streakAfter,
    streakReset,
  };
}

/**
 * 等级。
 *
 * 用**累计获得**而不是当前余额算等级 ——
 * 否则花积分兑换东西会掉级，等于惩罚使用积分的人，
 * 最后所有人都攒着不花，商店和悬赏全都没人用。
 */
export interface LevelSpec {
  level: number;
  requires: number;
  name: string;
}

export const LEVELS: LevelSpec[] = [
  { level: 1, requires: 0, name: "新来的" },
  { level: 2, requires: 50, name: "冒泡" },
  { level: 3, requires: 150, name: "常客" },
  { level: 4, requires: 350, name: "熟面孔" },
  { level: 5, requires: 700, name: "老手" },
  { level: 6, requires: 1200, name: "中坚" },
  { level: 7, requires: 2000, name: "骨干" },
  { level: 8, requires: 3200, name: "元老" },
  { level: 9, requires: 5000, name: "旗手" },
  { level: 10, requires: 8000, name: "传奇" },
];

export function levelOf(pointsTotal: number): LevelSpec {
  let current = LEVELS[0];
  for (const spec of LEVELS) {
    if (pointsTotal >= spec.requires) current = spec;
    else break;
  }
  return current;
}

export interface LevelProgress {
  current: LevelSpec;
  next: LevelSpec | null;
  /** 距下一级还差多少分 */
  remaining: number;
  /** 当前等级内的进度 0-1 */
  ratio: number;
}

export function levelProgress(pointsTotal: number): LevelProgress {
  const current = levelOf(pointsTotal);
  const next = LEVELS.find((spec) => spec.level === current.level + 1) ?? null;

  if (!next) return { current, next: null, remaining: 0, ratio: 1 };

  const span = next.requires - current.requires;
  const done = pointsTotal - current.requires;
  return {
    current,
    next,
    remaining: next.requires - pointsTotal,
    // span 为 0 时除法会得到 Infinity，配置写错也不能让页面崩
    ratio: span > 0 ? Math.min(1, Math.max(0, done / span)) : 1,
  };
}

/**
 * 反作弊：同一分钟内的多条消息折叠成一条。
 *
 * 连着刷十条「这个不错」是最容易的刷分方式。
 * 按分钟折叠不影响正常聊天 —— 正常人不会在同一分钟里
 * 发出十条各自超过 15 字的话。
 */
export function collapseByMinute(timestamps: number[]): number {
  const minutes = new Set(timestamps.map((ts) => Math.floor(ts / 60_000)));
  return minutes.size;
}

/**
 * 近似内容去重。
 * 复读同一句话十遍在按分钟折叠之外还要再挡一道。
 */
export function dedupeSimilar(contents: string[]): number {
  const seen = new Set<string>();
  for (const content of contents) {
    // 去掉空白与标点后比较，「好的。」「好的!」算同一条
    const normalized = content.replace(/[\s\p{P}]/gu, "").toLowerCase();
    if (normalized) seen.add(normalized);
  }
  return seen.size;
}

export interface AnomalyInput {
  todayQuality: number;
  /** 最近若干天的每日高质量数（不含今天） */
  recentDaily: number[];
  /** 超过均值多少倍算异常 */
  spikeThreshold: number;
}

/**
 * 异常增长检测。
 *
 * 判定为异常不代表作弊 —— 可能只是那天特别活跃。
 * 所以进的是**人工复核队列**，不是自动扣分。
 * 自动惩罚误伤一次就会让人再也不敢多说话。
 */
export function detectAnomaly(input: AnomalyInput): { anomalous: boolean; ratio: number } {
  const samples = input.recentDaily.filter((n) => n > 0);
  // 样本太少时不判定，新人头几天必然「暴涨」
  if (samples.length < 3) return { anomalous: false, ratio: 0 };

  const mean = samples.reduce((sum, n) => sum + n, 0) / samples.length;
  if (mean <= 0) return { anomalous: false, ratio: 0 };

  const ratio = input.todayQuality / mean;
  return { anomalous: ratio >= input.spikeThreshold, ratio };
}
