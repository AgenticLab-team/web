/**
 * 社群在中国，「今天」必须按东八区切分 ——
 * 打卡、连胜、日榜全部依赖这个边界，用 UTC 会让人在晚上 8 点后打卡算到第二天。
 */
export const COMMUNITY_TIMEZONE = "Asia/Shanghai";

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: COMMUNITY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const hourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: COMMUNITY_TIMEZONE,
  hour: "2-digit",
  hour12: false,
});

/** 毫秒时间戳 → YYYY-MM-DD（东八区） */
export function dateKey(ts: number): string {
  return dateFormatter.format(new Date(ts));
}

/** 毫秒时间戳 → 0-23 小时（东八区） */
export function hourOf(ts: number): number {
  return Number(hourFormatter.format(new Date(ts)));
}

export function todayKey(): string {
  return dateKey(Date.now());
}

/** YYYY-MM-DD 往前推 n 天 */
export function shiftDateKey(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const parse = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}
