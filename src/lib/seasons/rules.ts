/**
 * 赛季。纯函数。
 *
 * ─────────────────────────────────────────
 * 赛季**只重置排名，不重置积分**
 * ─────────────────────────────────────────
 *
 * 总榜跑久了会冻住：最早那批人永远在前面，新来的人算一下就知道
 * 这辈子追不上，于是不再参与。赛季解决的就是这个 —— 让每个季度
 * 都有一次「从零开始」的机会。
 *
 * 但它**绝不能碰余额**。积分是这个站里唯一的硬通货，
 * 清一次零就等于告诉所有人「你攒的东西随时可能没有」，
 * 而那之后没有人会再把它当回事。ECONOMY.md 里那三条致命项之一
 * 就是这个。
 *
 * 所以赛季在实现上是**一个时间窗加一份结算快照**，
 * 数据源仍然是 daily_stats —— 不新增任何计数器。
 * 新增计数器就意味着又一个会和明细对不上的冗余列。
 */

export type SeasonStatus = "upcoming" | "active" | "ended";

export interface Season {
  key: string;
  name: string;
  /** 含 */
  startsAt: number;
  /** 不含 —— 用开区间省得纠结「最后一天算不算」 */
  endsAt: number;
}

export function statusOf(season: Season, now: number): SeasonStatus {
  if (now < season.startsAt) return "upcoming";
  if (now >= season.endsAt) return "ended";
  return "active";
}

export function isActive(season: Season, now: number): boolean {
  return statusOf(season, now) === "active";
}

/** 还剩几天 —— 赛季这件事只有在「还剩几天」被看见时才起作用 */
export function daysLeft(season: Season, now: number): number {
  if (now >= season.endsAt) return 0;
  return Math.max(1, Math.ceil((season.endsAt - now) / 86_400_000));
}

/**
 * 按季度生成赛季。
 *
 * 一个季度而不是一个月：一个月太短，刚热起来就结束了；
 * 半年太长，等于没有赛季。三个月能容下一次完整的「追赶」。
 *
 * 边界按**东八区**，和签到、日统计用同一个日界 ——
 * 三处各算各的话，赛季最后一天的贡献会算进下个赛季。
 */
export const TZ_OFFSET_MS = 8 * 3600_000;

export function quarterSeasons(year: number): Season[] {
  const quarters = [
    [0, 3, "春季赛"],
    [3, 6, "夏季赛"],
    [6, 9, "秋季赛"],
    [9, 12, "冬季赛"],
  ] as const;

  return quarters.map(([startMonth, endMonth, label], index) => ({
    key: `${year}Q${index + 1}`,
    name: `${year} ${label}`,
    startsAt: Date.UTC(year, startMonth, 1) - TZ_OFFSET_MS,
    endsAt: Date.UTC(year, endMonth, 1) - TZ_OFFSET_MS,
  }));
}

/** 某个时刻落在哪个赛季 */
export function seasonAt(seasons: Season[], now: number): Season | null {
  return seasons.find((s) => now >= s.startsAt && now < s.endsAt) ?? null;
}

/**
 * 赛季区间对应的日期键范围（YYYY-MM-DD，东八区）。
 *
 * daily_stats 存的是日期字符串，所以聚合时要把毫秒边界换成日期键。
 * 结束日是**开区间**：赛季在 endsAt 那一刻结束，那一天属于下个赛季。
 */
export function dateRangeOf(season: Season): { from: string; to: string } {
  const key = (ms: number) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
  return { from: key(season.startsAt), to: key(season.endsAt - 1) };
}

// ── 结算 ────────────────────────────────────────────────────

export interface StandingInput {
  wxId: string;
  quality: number;
  messages: number;
  chars: number;
}

export interface Standing extends StandingInput {
  rank: number;
}

/**
 * 排名。
 *
 * 同分并列，且**并列之后跳号**（1,1,3）—— 不跳号的话，
 * 两个并列第一之后还有个「第二名」，而那个人其实是第三。
 */
export function rankStandings(rows: StandingInput[]): Standing[] {
  const sorted = [...rows].sort(
    (a, b) => b.quality - a.quality || b.messages - a.messages || a.wxId.localeCompare(b.wxId),
  );

  const out: Standing[] = [];
  let lastKey = "";
  let lastRank = 0;

  sorted.forEach((row, index) => {
    const key = `${row.quality}:${row.messages}`;
    const rank = key === lastKey ? lastRank : index + 1;
    lastKey = key;
    lastRank = rank;
    out.push({ ...row, rank });
  });

  return out;
}

/**
 * 名次对应的赛季称号。
 *
 * 只发前三 —— 发到前二十的话，「赛季称号」就变成了参与奖，
 * 而参与奖没有人会为它多做一件事。
 */
export const SEASON_TITLE_KEYS: Record<number, string> = {
  1: "season_champion",
  2: "season_runner_up",
  3: "season_third",
};

export function titleKeyForRank(rank: number): string | null {
  return SEASON_TITLE_KEYS[rank] ?? null;
}

/**
 * 进榜的最低门槛。
 *
 * 一个赛季只发过两条高质量消息的人排到第三名，说明这个赛季根本没人参与 ——
 * 那时候发称号只会让称号本身贬值。宁可这一季没有冠军。
 */
export const MIN_QUALITY_FOR_TITLE = 10;

export interface SettleVerdict {
  ok: boolean;
  reason: string;
  /** 该发称号的名次 */
  awards: { wxId: string; rank: number; titleKey: string }[];
}

export function planAwards(standings: Standing[]): SettleVerdict {
  const awards = standings
    .filter((s) => s.rank <= 3 && s.quality >= MIN_QUALITY_FOR_TITLE)
    .map((s) => ({ wxId: s.wxId, rank: s.rank, titleKey: titleKeyForRank(s.rank)! }))
    .filter((a) => a.titleKey);

  if (standings.length === 0) {
    return { ok: false, reason: "这个赛季没有任何人上榜", awards: [] };
  }
  if (awards.length === 0) {
    return {
      ok: true,
      reason: `上榜 ${standings.length} 人，但没有人达到 ${MIN_QUALITY_FOR_TITLE} 条高质量发言 —— 这一季不发称号`,
      awards: [],
    };
  }
  return { ok: true, reason: `${standings.length} 人上榜，发出 ${awards.length} 个称号`, awards };
}

/**
 * 赛季称号什么时候到期。
 *
 * 挂到**下个赛季结束**：一直挂着的话，三年后每个人名字后面都跟着
 * 一串「2026 春季赛冠军」，而那时候没有人在意。
 * 到期只是不能佩戴，持有记录留着 —— 「我曾经拿到过」也是履历。
 */
export function seasonTitleExpiry(season: Season): number {
  return season.endsAt + (season.endsAt - season.startsAt);
}

export const RANK_LABELS: Record<number, string> = { 1: "冠军", 2: "亚军", 3: "季军" };

export function rankLabel(rank: number): string {
  return RANK_LABELS[rank] ?? `第 ${rank} 名`;
}
