/**
 * 补签卡。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 它一直是买得到、用不掉的
 * ─────────────────────────────────────────
 *
 * 商店里能买、卡发得下来、商店页还会提示「你还有 N 张没用」——
 * 而**全站没有任何地方能消耗它**。`checkins.is_makeup` 和 `makeup_cost`
 * 两列零引用，`makeup_cards.used_for_date` / `used_at` 从来没被写过，
 * `points.makeup_card.monthly_limit` 这个设置项零读取点（改了没有任何效果）。
 *
 * 这是死开关里最糟的一种：**用户花积分买过之后才会发现**。
 *
 * ─────────────────────────────────────────
 * 补签补的是连胜，不是分
 * ─────────────────────────────────────────
 *
 * 补签**不发当天的积分**。理由不是抠门：卡是用积分买的，
 * 补签再把积分发回来，这条路就成了洗分 ——
 * 买卡花 200、补签拿回 30，虽然亏，但如果哪天参数调反了
 * （或者有人买 30 张补 30 天），它会变成一个凭空造分的入口。
 *
 * 而人买这张卡想要的本来也不是那几分，是**别让连胜归零**。
 * 断一次连胜比少几分伤人得多 —— 这句话在 checkin.ts 里已经写过一次了。
 *
 * ─────────────────────────────────────────
 * 只能补「断掉的那一天」，不能编一段历史
 * ─────────────────────────────────────────
 *
 * 补签必须是**修补一次失手**，不能是凭空制造记录。所以：
 *   · 只能补最近这几天里**漏掉的**那些
 *   · 不能补今天（今天正常打卡就行）
 *   · 不能补已经打过卡的那天
 *   · 不能补这个账号存在之前的日子
 *
 * 少了任何一条，一个买了三十张卡的人就能凭空得到一条三十天的连胜，
 * 而榜单和等级都认它。
 */

/**
 * 能往回补几天。
 *
 * 七天：一次出差、一次生病的长度。再长就不是「失手」了 ——
 * 一个月没来过的人，补回来的连胜不代表任何东西，
 * 而连胜这个数字的全部意义就是它代表了什么。
 */
export const MAKEUP_WINDOW_DAYS = 7;

export interface MakeupCandidate {
  /** YYYY-MM-DD */
  date: string;
  /** 补上它之后连胜会变成多少 —— 让人知道这一张值不值 */
  streakAfter: number;
}

export type MakeupVerdict =
  | { ok: true }
  | { ok: false; reason: "no_card" | "not_missed" | "too_old" | "today" | "monthly_limit" | "unknown"; message: string };

export interface MakeupInput {
  /** 要补哪天 */
  date: string;
  /** 今天 */
  today: string;
  /** 窗口内已经打过卡的日子 */
  checkedDates: readonly string[];
  /** 这个账号最早可能打卡的日子（注册那天）。更早的一律不许补 */
  since: string | null;
  /** 手上没用掉的卡 */
  cards: number;
  /** 这个自然月已经补过几次 */
  usedThisMonth: number;
  /** 每月上限，0 表示不限 */
  monthlyLimit: number;
}

export function checkMakeup(input: MakeupInput): MakeupVerdict {
  if (input.cards <= 0) {
    return { ok: false, reason: "no_card", message: "你没有补签卡了" };
  }

  if (input.date === input.today) {
    // 今天不用补 —— 说清楚下一步，别让人以为是坏了
    return { ok: false, reason: "today", message: "今天直接打卡就行，不用补" };
  }

  if (input.date > input.today) {
    return { ok: false, reason: "unknown", message: "补不了还没到的日子" };
  }

  if (input.checkedDates.includes(input.date)) {
    return { ok: false, reason: "not_missed", message: "这天已经打过卡了" };
  }

  const earliest = shift(input.today, -MAKEUP_WINDOW_DAYS);
  if (input.date < earliest) {
    return {
      ok: false,
      reason: "too_old",
      message: `只能补最近 ${MAKEUP_WINDOW_DAYS} 天里漏掉的`,
    };
  }

  if (input.since && input.date < input.since) {
    // 补一个账号还不存在的日子，那不是补签，是编历史
    return { ok: false, reason: "too_old", message: "这天你还没来" };
  }

  if (input.monthlyLimit > 0 && input.usedThisMonth >= input.monthlyLimit) {
    return {
      ok: false,
      reason: "monthly_limit",
      message: `这个月已经补过 ${input.usedThisMonth} 次了（上限 ${input.monthlyLimit}）`,
    };
  }

  return { ok: true };
}

/**
 * 从打卡记录算连胜。
 *
 * ─────────────────────────────────────────
 * 连胜是算出来的，不是攒出来的
 * ─────────────────────────────────────────
 *
 * `users.streak_current` 只是缓存列，真值是 `checkins` 那些行 ——
 * 和积分那边「流水是唯一真值，余额只是缓存」是同一条规矩。
 *
 * 补签**不去给那个缓存数加一**，而是插进一行之后重算。
 * 给缓存打补丁的话，「补了两天中间那一天」这种情况必然算错，
 * 而算错的表现只是一个数字不对，没有任何人查得出来。
 *
 * 从 `from` 那天往回数连续的日子。`from` 通常是今天 ——
 * 但今天还没打卡时要从昨天数起，否则一个昨天还在连胜的人
 * 会在今天打卡之前显示成 0。
 */
export function streakFrom(checkedDates: readonly string[], from: string): number {
  const set = new Set(checkedDates);
  let cursor = set.has(from) ? from : shift(from, -1);
  let streak = 0;
  while (set.has(cursor)) {
    streak++;
    cursor = shift(cursor, -1);
  }
  return streak;
}

/**
 * 窗口里所有能补的日子，新的在前。
 *
 * 顺带算出补上之后连胜会变成多少 —— **人要知道这一张值不值**。
 * 只列日期的话，他得自己在脑子里推一遍哪天补了能接上，
 * 而那正是他最容易算错、事后最容易觉得被坑了的地方。
 */
export function makeupCandidates(input: {
  today: string;
  checkedDates: readonly string[];
  since: string | null;
}): MakeupCandidate[] {
  const out: MakeupCandidate[] = [];
  const checked = new Set(input.checkedDates);

  for (let i = 1; i <= MAKEUP_WINDOW_DAYS; i++) {
    const date = shift(input.today, -i);
    if (checked.has(date)) continue;
    if (input.since && date < input.since) continue;

    out.push({
      date,
      streakAfter: streakFrom([...input.checkedDates, date], input.today),
    });
  }

  return out;
}

/** YYYY-MM-DD 加减天数。放在这里而不是引 time.ts —— 规则层不依赖时区实现 */
function shift(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export { shift as shiftDate };
