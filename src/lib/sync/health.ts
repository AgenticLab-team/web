/**
 * 同步健康判定。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 这是「故障不能伪装成业务结果」的主战场
 * ─────────────────────────────────────────
 *
 * 上游隧道断掉的表现是：消息数不再增长。
 * 而「消息数不增长」和「今天大家没说话」在数据上**长得一模一样** ——
 * 榜单照常显示、首页照常显示 0，没有任何地方会红。
 * 等到有人发现「我明明发了怎么没算」，往往已经过去几天。
 *
 * 所以这里要回答的不是「有没有数据」，是「**该有的数据到了没有**」。
 *
 * ─────────────────────────────────────────
 * 为什么不能用统一的陈旧阈值
 * ─────────────────────────────────────────
 *
 * 有的群一天两百条，有的群一周三条。
 * 用「超过 6 小时没新消息就报警」的话，冷清的群天天在报警，
 * 报警就会被忽略，然后真出事的时候也被忽略。
 *
 * 判定必须相对于**这个群自己的节奏**：按历史日均推算出
 * 「按这个节奏，多久没消息才算异常」。
 */

export interface GroupPace {
  /** 最近一条消息的时间 */
  lastMessageAt: number | null;
  /** 最近若干天的日均消息数 */
  dailyAverage: number;
  /** 统计了多少天 */
  sampleDays: number;
}

export type Freshness = "fresh" | "quiet" | "stale" | "unknown";

export interface FreshnessVerdict {
  level: Freshness;
  /** 距上一条消息多久（毫秒） */
  silentMs: number | null;
  /** 按这个群的节奏，多久算异常 */
  toleranceMs: number;
  message: string;
}

const HOUR = 3600_000;
const DAY = 86_400_000;

/** 再活跃的群也允许安静这么久（夜里没人说话是正常的） */
const MIN_TOLERANCE = 12 * HOUR;
/** 再冷清的群，超过这么久也该看一眼 */
const MAX_TOLERANCE = 7 * DAY;

/**
 * 按群自己的节奏算「安静多久算异常」。
 *
 * 日均 200 条 → 平均 7 分钟一条，容忍 12 小时（下限）
 * 日均 3 条   → 平均 8 小时一条，容忍约 2.7 天
 * 日均 0.1 条 → 十天一条，容忍上限 7 天
 */
export function toleranceFor(dailyAverage: number): number {
  if (dailyAverage <= 0) return MAX_TOLERANCE;
  // 允许安静「8 倍于平均间隔」的时间
  const averageGap = DAY / dailyAverage;
  return Math.min(MAX_TOLERANCE, Math.max(MIN_TOLERANCE, averageGap * 8));
}

export function classifyFreshness(pace: GroupPace, now: number): FreshnessVerdict {
  const tolerance = toleranceFor(pace.dailyAverage);

  if (pace.lastMessageAt === null) {
    return {
      level: "unknown",
      silentMs: null,
      toleranceMs: tolerance,
      // 「从来没有过消息」和「同步坏了」区分不开，所以不谎报健康
      message: "从没同步到过消息 —— 可能是刚接入，也可能从一开始就没通",
    };
  }

  const silent = now - pace.lastMessageAt;

  /*
   * 样本太少时不下「陈旧」的判断。
   * 新接入的群历史数据不足，按不足的样本推算容忍度会得出很小的值，
   * 于是刚接入就报警 —— 那种报警只会教人忽略报警。
   */
  if (pace.sampleDays < 3) {
    return {
      level: silent < MAX_TOLERANCE ? "fresh" : "unknown",
      silentMs: silent,
      toleranceMs: tolerance,
      message: silent < MAX_TOLERANCE ? "刚接入，还在观察" : "接入以来一直没有新消息",
    };
  }

  if (silent <= tolerance) {
    return {
      level: "fresh",
      silentMs: silent,
      toleranceMs: tolerance,
      message: "正常",
    };
  }

  /*
   * 超出容忍但这个群本来就冷清 —— 报「安静」而不是「陈旧」。
   * 两者的区别是：安静需要看一眼，陈旧需要立刻查隧道。
   * 全都标成红色的话，红色就不再意味着什么。
   */
  if (pace.dailyAverage < 1) {
    return {
      level: "quiet",
      silentMs: silent,
      toleranceMs: tolerance,
      message: `这个群本来就冷清（日均 ${pace.dailyAverage.toFixed(1)} 条），安静 ${formatSpan(silent)} 未必有问题`,
    };
  }

  return {
    level: "stale",
    silentMs: silent,
    toleranceMs: tolerance,
    message: `日均 ${Math.round(pace.dailyAverage)} 条的群安静了 ${formatSpan(silent)} —— 先查上游隧道`,
  };
}

export interface JobStats {
  total: number;
  failed: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
}

export type SyncVerdict = "ok" | "degraded" | "down" | "never";

export interface SyncHealth {
  verdict: SyncVerdict;
  failureRate: number;
  sinceLastSuccessMs: number | null;
  message: string;
}

/**
 * 同步任务本身的健康。
 *
 * 看两件事：**失败率**和**距上次成功多久**。
 * 只看失败率会漏掉「任务根本没在跑」——那时失败率是 0，
 * 看起来完美，实际上定时器已经停了。
 */
export function syncHealth(stats: JobStats, now: number, intervalMs = 2 * 60_000): SyncHealth {
  const failureRate = stats.total > 0 ? stats.failed / stats.total : 0;

  if (stats.lastSuccessAt === null) {
    return {
      verdict: stats.total === 0 ? "never" : "down",
      failureRate,
      sinceLastSuccessMs: null,
      message:
        stats.total === 0
          ? "这类同步从来没跑过"
          : `跑过 ${stats.total} 次但一次都没成功：${stats.lastError ?? "无错误信息"}`,
    };
  }

  const since = now - stats.lastSuccessAt;

  // 超过 10 个周期没成功过，基本可以断定挂了
  if (since > intervalMs * 10) {
    return {
      verdict: "down",
      failureRate,
      sinceLastSuccessMs: since,
      message: `已经 ${formatSpan(since)} 没有成功过 —— 定时任务可能停了，或上游一直不通`,
    };
  }

  if (failureRate > 0.3) {
    return {
      verdict: "degraded",
      failureRate,
      sinceLastSuccessMs: since,
      message: `失败率 ${Math.round(failureRate * 100)}%，最近一次错误：${stats.lastError ?? "无"}`,
    };
  }

  return {
    verdict: "ok",
    failureRate,
    sinceLastSuccessMs: since,
    message: `${formatSpan(since)}前成功过`,
  };
}

export interface RetryCheck {
  ok: boolean;
  error?: string;
}

/** 一个任务最多重试几次 —— 一直重试打不通的上游只是在刷日志 */
export const MAX_RETRY = 3;

export function checkRetry(job: {
  status: string;
  retryCount: number;
}): RetryCheck {
  if (job.status === "running" || job.status === "pending") {
    return { ok: false, error: "这个任务还在跑" };
  }
  if (job.status === "success") return { ok: false, error: "这次已经成功了，不用重试" };
  if (job.retryCount >= MAX_RETRY) {
    return { ok: false, error: `已经重试过 ${job.retryCount} 次 —— 先查清楚原因再手动跑` };
  }
  return { ok: true };
}

/** 正在跑的时候不能再触发一次，否则两个进程会抢同一个游标 */
export function checkManualTrigger(runningCount: number): RetryCheck {
  if (runningCount > 0) return { ok: false, error: "已经有一个同步在跑了，等它结束" };
  return { ok: true };
}

export function formatSpan(ms: number): string {
  if (ms < 60_000) return "不到一分钟";
  if (ms < HOUR) return `${Math.floor(ms / 60_000)} 分钟`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} 小时`;
  return `${Math.floor(ms / DAY)} 天`;
}

export const FRESHNESS_LABELS: Record<Freshness, string> = {
  fresh: "正常",
  quiet: "安静",
  stale: "可能中断",
  unknown: "情况不明",
};

export const VERDICT_LABELS: Record<SyncVerdict, string> = {
  ok: "正常",
  degraded: "不稳定",
  down: "已中断",
  never: "从未运行",
};
