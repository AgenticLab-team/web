import {
  applyDailyBudget,
  settleInteractions,
  type EconomyConfig,
  type InteractionCounts,
  type Settlement,
} from "./economy";

/**
 * 积分规则引擎。
 *
 * **纯函数，不碰数据库** —— 所有输入显式传进来，
 * 这样每条规则的每个分支都能被测试覆盖。
 * 规则里出现魔法数字是最难查的一类 bug：数字改了没人知道影响面。
 *
 * 所有数值来自 settings 表，由调用方读好传进来（见 config 参数）。
 */

export interface PointsConfig extends EconomyConfig {
  /** 打卡所需的当日高质量消息数 */
  checkinMinQuality: number;
  /** 打卡所需的当日论坛活跃度（发帖 + 回复的加权单位） */
  checkinMinForum: number;
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

/** 打卡的两条路之一。need/have 直接用来画进度条 */
export interface CheckinPath {
  kind: "chat" | "forum";
  label: string;
  have: number;
  need: number;
}

export interface CheckinInput {
  /** 当日高质量消息数 */
  qualityToday: number;
  /** 当日论坛活跃度单位（发帖 × 权重 + 回复 × 权重） */
  forumUnitsToday: number;
  /** 当日各类互动的次数，用于结算附加分 */
  interactions: InteractionCounts;
  /** 今天已经发行给这个人多少分 —— 每日预算是全局共享的 */
  mintedToday: number;
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
  | {
      ok: false;
      reason: "not_enough";
      message: string;
      /** 两条路各自还差多少，界面上要同时给出，而不是只报一条 */
      needQuality: number;
      haveQuality: number;
      needForum: number;
      haveForum: number;
      /** 已按「谁更接近达成」排好序，界面直接渲染 */
      paths: CheckinPath[];
    }
  | {
      ok: true;
      base: number;
      qualityBonus: number;
      streakBonus: number;
      interactionBonus: number;
      settlement: Settlement;
      /** 未受每日预算限制前的总额 */
      earned: number;
      /** 实际入账 */
      total: number;
      /** 因为撞每日上限被削掉的 */
      clipped: number;
      capped: boolean;
      /** 打卡后今天还剩多少发行额度 */
      remaining: number;
      streakAfter: number;
      /** 连胜是否在这次被打断重置 */
      streakReset: boolean;
      /** 走的哪条门槛 */
      via: "chat" | "forum" | "both";
    };

/**
 * 打卡判定。
 *
 * **先有贡献再签到。** 纯签到党拿不到分，否则积分就只是
 * 「每天点一下」的奖励，与「让社区里有好内容」这个目标完全脱钩。
 *
 * 但门槛有**两条路**：群里发言达标，或者论坛活跃达标，满足任一即可。
 * 只认群聊的话，那些主要在论坛写长文的人反而打不了卡 ——
 * 而他们恰恰是沉淀内容最多的人。
 *
 * 打卡同时结算当天所有互动，给一笔附加分（有封顶）。
 * 这样「多参与」有直接回报，而封顶和每日预算保证它不会变成刷分入口。
 */
export function evaluateCheckin(input: CheckinInput, config: PointsConfig): CheckinVerdict {
  if (input.lastCheckinDate === input.today) {
    return { ok: false, reason: "already", message: "今天已经打过卡了" };
  }

  const chatOk = input.qualityToday >= config.checkinMinQuality;
  const forumOk = input.forumUnitsToday >= config.checkinMinForum;

  if (!chatOk && !forumOk) {
    const chatGap = config.checkinMinQuality - input.qualityToday;
    const forumGap = config.checkinMinForum - input.forumUnitsToday;

    /*
     * 两条路都要说出来，并且**更接近达成的那条排前面**。
     * 只报一条的话，主要在论坛写东西的人会以为自己没资格打卡；
     * 而把差得远的那条放前面，看到的是「差得远」而不是「就差一点」。
     */
    const paths: CheckinPath[] = ([
      {
        kind: "chat",
        label: "群里的高质量发言",
        have: input.qualityToday,
        need: config.checkinMinQuality,
      },
      {
        kind: "forum",
        label: "论坛发帖或回复",
        have: input.forumUnitsToday,
        need: config.checkinMinForum,
      },
    ] as CheckinPath[]).sort(
      (a, b) => Math.max(0, a.need - a.have) - Math.max(0, b.need - b.have),
    );

    return {
      ok: false,
      reason: "not_enough",
      message:
        chatGap <= forumGap
          ? `今天还差 ${chatGap} 条高质量发言，或者去论坛发 ${forumGap} 点内容也行`
          : `论坛还差 ${forumGap} 点活跃度，或者在群里再发 ${chatGap} 条高质量发言`,
      needQuality: config.checkinMinQuality,
      haveQuality: input.qualityToday,
      needForum: config.checkinMinForum,
      haveForum: input.forumUnitsToday,
      paths,
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

  const settlement = settleInteractions(input.interactions, config);

  const earned = config.checkinBase + qualityBonus + streakBonus + settlement.points;
  const budget = applyDailyBudget(earned, input.mintedToday, config);

  return {
    ok: true,
    base: config.checkinBase,
    qualityBonus,
    streakBonus,
    interactionBonus: settlement.points,
    settlement,
    earned,
    total: budget.granted,
    clipped: budget.clipped,
    capped: budget.capped,
    remaining: budget.remaining,
    streakAfter,
    streakReset,
    via: chatOk && forumOk ? "both" : chatOk ? "chat" : "forum",
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
