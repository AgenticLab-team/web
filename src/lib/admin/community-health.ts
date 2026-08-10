import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { daysBetween, shiftDateKey, todayKey } from "@/lib/time";

/**
 * 社群健康度。
 *
 * ─────────────────────────────────────────
 * 和「群与数据源」那一页问的不是同一件事
 * ─────────────────────────────────────────
 *
 * 那一页问的是**数据有没有进来**（上游断了没有）。
 * 这一页问的是**这个群还活着吗** —— 两件事在数据上长得完全不一样：
 * 同步一切正常、消息一条不落地进来，而群本身正在凉，
 * 那一页会一路绿灯。
 *
 * 群主判断「群是不是要凉了」现在全凭感觉，而 12 个群没法凭感觉横向比。
 *
 * ─────────────────────────────────────────
 * 两个指标做不了，如实说，不糊弄
 * ─────────────────────────────────────────
 *
 * 原计划里还有两项，查过数据之后确认今天做不了：
 *
 *   · **新人 7/30 天留存率** —— `group_members.joined_at` 不是真实入群
 *     时间，而是**第一次同步到这个人的时间**：2,037 个成员里有 2,033 个
 *     挤在 2026-08-08 同一天，也就是接入那天。拿它算留存，
 *     算出来的是「接入至今有没有说过话」，和留存没有关系。
 *     （往后新入群的人会带真实时间，这个指标会自己长出来 ——
 *     所以判定里留了一道门槛，样本太少时不给结论而不是给个假的。）
 *
 *   · **话题分布与漂移** —— 站里没有任何主题抽取，
 *     中文分词也不是能顺手糊一个的东西。编一版出来，
 *     群主会照着它做判断。
 *
 * 一个写着「留存率 87%」而其实是别的东西的仪表，
 * 比没有仪表糟得多：没有仪表的时候人知道自己在猜。
 */

/** 趋势条画多少天 */
const TREND_DAYS = 14;
/** 「最近」窗口 */
const RECENT = 7;
/** 拿来做基线的那一段（最近之前的两周） */
const BASELINE = 21;
/**
 * 基线至少要有几天真实记录才给结论。
 *
 * 线上归档有 15 天的洞（2026-07-15 ~ 07-29 回填还没补），
 * 剩下三四天的时候一次群聊爆发就能把比值拉到几倍 ——
 * 那不是趋势，是噪声。
 */
const MIN_BASELINE_DAYS = 5;

export type HealthVerdict = "healthy" | "concentrated" | "quiet" | "fading" | "idle";

export const VERDICT_LABELS: Record<HealthVerdict, string> = {
  healthy: "活跃",
  concentrated: "集中",
  quiet: "冷清",
  fading: "退潮",
  idle: "停摆",
};

export interface GroupHealth {
  convId: string;
  name: string;
  /** 群里有多少人（没退群的） */
  members: number;
  /** 其中说过话的有多少 */
  everSpoke: number;
  /** 从来没说过话的比例，0~1 */
  silentRatio: number;

  messages7: number;
  messages30: number;
  speakers7: number;
  speakers30: number;

  /** 前三个人占了多少发言，0~1 —— 「是不是只有几个人在说」 */
  top3Share: number;
  /** 发言集中度，0（人人相同）~1（一个人包圆） */
  gini: number;

  /** 高质量（文本类且够长）占比，0~1 */
  qualityRatio: number;

  /** 最近 14 天每天多少条，左旧右新 */
  trend: number[];

  /** 最近一周日均相对于之前两周日均的变化，-1 ~ +∞。基线太薄时是 null */
  momentum: number | null;
  /**
   * 基线是拿几天真实记录算出来的。
   *
   * 摆到界面上，不藏起来 —— 归档有洞的时候「比之前少了 60%」
   * 和「基于 4 天」是两条完全不同的信息，
   * 只给前者等于把一个薄样本包装成了结论。
   */
  baselineDays: number;

  verdict: HealthVerdict;
  /** 为什么是这个判定 —— 只给结论的仪表没人会信 */
  reasons: string[];
}

/**
 * 基尼系数 —— 「是不是只有几个人在说」的标准答案。
 *
 * ─────────────────────────────────────────
 * 为什么不是「前三名占比」一个数就够
 * ─────────────────────────────────────────
 *
 * 前三名占比在**人数差很多**的群之间没法比：
 * 23 个人的群里前三占 40% 很正常，438 个人的群里前三占 40% 是重症。
 * 基尼把整条分布压成一个数，跨群可比 —— 而这一页的用处正是横向比。
 *
 * 两个都给：基尼可比但不直观，前三名占比直观但不可比。
 *
 * 用的是标准定义（相对平均绝对差的一半），排序后可以线性求出：
 *   G = (2·Σ i·xᵢ) / (n·Σxᵢ) − (n+1)/n     （i 从 1 开始，x 升序）
 */
export function gini(values: readonly number[]): number {
  /*
   * **只算说过话的人**，0 不进分布。
   *
   * 把 300 个从没开口的成员按 0 算进去的话，每个群的基尼都会顶到
   * 0.95 上下 —— 数字还在，但它不再区分任何东西，
   * 而这一页的全部用处就是区分。
   *
   * 沉默的那部分由 `silentRatio` 单独讲，两件事不要混成一个数。
   */
  const xs = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const n = xs.length;
  // 0 个或 1 个发言人时「不平等」没有意义 —— 返回 0，不是 1
  if (n < 2) return 0;

  let total = 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    total += xs[i];
    weighted += (i + 1) * xs[i];
  }
  if (total === 0) return 0;

  const g = (2 * weighted) / (n * total) - (n + 1) / n;
  // 浮点误差可能溢出一点点，夹回去 —— 一个 1.0000000002 的基尼会吓人
  return Math.min(1, Math.max(0, g));
}

/** 前 n 名占了多少 */
export function topShare(values: readonly number[], n = 3): number {
  const xs = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => b - a);
  const total = xs.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  return xs.slice(0, n).reduce((a, b) => a + b, 0) / total;
}

/**
 * 判定。
 *
 * ─────────────────────────────────────────
 * 阈值相对于**群自己的节奏**，不是全站统一
 * ─────────────────────────────────────────
 *
 * 这条规矩在「群与数据源」那一页已经写过一次：
 * 一天两百条的群安静半天就该查，一周三条的群安静三天很正常。
 * 用统一阈值的话，冷清的群天天报警，然后报警就会被忽略。
 *
 * 所以「退潮」比的是它自己的基线，不是别的群的绝对值。
 *
 * 顺序是有讲究的：**先判停摆再判退潮** ——
 * 一个已经完全不说话的群，说它「退潮」等于还留着余地，
 * 而它需要的是最强的那个词。
 */
export function judge(input: {
  messages7: number;
  speakers7: number;
  momentum: number | null;
  gini: number;
  top3Share: number;
  everSpoke: number;
}): { verdict: HealthVerdict; reasons: string[] } {
  const reasons: string[] = [];

  if (input.messages7 === 0) {
    return { verdict: "idle", reasons: ["最近 7 天一条消息都没有"] };
  }

  if (input.momentum !== null && input.momentum <= -0.5) {
    reasons.push(`最近一周日均比之前少了 ${Math.round(-input.momentum * 100)}%`);
    if (input.speakers7 <= 3) reasons.push(`只有 ${input.speakers7} 个人还在说话`);
    return { verdict: "fading", reasons };
  }

  if (input.speakers7 <= 3 || input.messages7 < 10) {
    reasons.push(`最近 7 天 ${input.messages7} 条、${input.speakers7} 人开口`);
    return { verdict: "quiet", reasons };
  }

  /*
   * 集中不等于不健康 —— 一个技术群里几个人挑大梁很常见。
   *
   * 但它是**最值得群主知道**的一种形态：那几个人一旦不说话，
   * 群第二天就凉，而在此之前所有的绝对数字都是好看的。
   */
  if (input.gini >= 0.6 && input.top3Share >= 0.5) {
    reasons.push(`前三个人占了 ${Math.round(input.top3Share * 100)}% 的发言`);
    reasons.push("这几个人一旦停下来，群会很快安静");
    return { verdict: "concentrated", reasons };
  }

  reasons.push(`最近 7 天 ${input.speakers7} 人开口、${input.messages7} 条`);
  if (input.momentum !== null && input.momentum >= 0.2) {
    reasons.push(`比之前两周热了 ${Math.round(input.momentum * 100)}%`);
  }
  return { verdict: "healthy", reasons };
}

/**
 * 这一段区间里，**全站有记录的天数**。
 *
 * 用来当日均的分母 —— 归档缺的那些天不该被当成「零活跃」，
 * 它们是未知，不是零。判据是全站：某一天只要有任何一个群有记录，
 * 就说明那天同步是好的，个别群在那天没记录就是真的安静。
 *
 * 区间是左开右闭 `(from, to]`，和上面几个窗口保持一致。
 */
function coveredDays(from: string, to: string): number {
  return Number(
    db.all<{ n: number }>(
      sql`SELECT count(DISTINCT date) AS n FROM daily_stats
          WHERE date > ${from} AND date <= ${to}`,
    )[0]?.n ?? 0,
  );
}

export interface ArchiveGap {
  from: string;
  to: string;
  days: number;
}

/**
 * 归档里的洞。
 *
 * ─────────────────────────────────────────
 * 线上真有一个 15 天的洞，而没有任何地方在报
 * ─────────────────────────────────────────
 *
 * 2026-07-15 到 07-29，**12 个群加起来一条消息都没有**，
 * 07-14 有、07-30 又有了。12 个群同时安静半个月不是一种可能，
 * 那是回填没补到那一段。
 *
 * 它的后果是安静的：按天回看翻到那半个月是空的，
 * 而页面只会说「这天没有消息」—— 和真的没人说话长得一模一样。
 * 同步健康那一页也不会红，因为**同步本身是好的**，
 * 缺的是历史。
 *
 * 顺带它还解释了这一页上势头为什么是空的：基线窗口正压在洞上。
 *
 * ─────────────────────────────────────────
 * 只在归档自己的范围里找
 * ─────────────────────────────────────────
 *
 * 从最早那条消息之前算起的话，会报出「1970 年到现在都缺」。
 *
 * 门槛是**连续 2 天**：12 个群同时整天不说话，一天还算罕见，
 * 两天基本不可能。定成 1 天的话，某个清晨接入的第一天会被误报。
 */
export function archiveGaps(limit = 3): ArchiveGap[] {
  const dates = db
    .all<{ date: string }>(sql`SELECT DISTINCT date FROM daily_stats ORDER BY date`)
    .map((r) => r.date);

  if (dates.length < 2) return [];

  const gaps: ArchiveGap[] = [];
  for (let i = 1; i < dates.length; i++) {
    const prev = dates[i - 1];
    const next = dates[i];
    // 相邻两个有记录的日期之间隔了几天
    const missing = daysBetween(prev, next) - 1;
    if (missing >= 2) {
      gaps.push({ from: shiftDateKey(prev, 1), to: shiftDateKey(next, -1), days: missing });
    }
  }

  return gaps.sort((a, b) => b.days - a.days).slice(0, limit);
}

/** 12 个群的健康度，按最需要看的排在前面 */
export function communityHealth(now = todayKey()): GroupHealth[] {
  const d7 = shiftDateKey(now, -RECENT);
  const d30 = shiftDateKey(now, -30);
  const dTrend = shiftDateKey(now, -TREND_DAYS);

  const groups = db.all<{ convId: string; name: string; members: number }>(
    sql`SELECT g.conv_id AS convId, g.name AS name,
               (SELECT count(*) FROM group_members m
                 WHERE m.conv_id = g.conv_id AND m.left_at IS NULL) AS members
        FROM groups g
        WHERE g.sync_enabled = 1`,
  );

  const out: GroupHealth[] = [];

  for (const g of groups) {
    const totals = db.all<{
      everSpoke: number;
      messages30: number;
      speakers30: number;
      messages7: number;
      speakers7: number;
      quality30: number;
    }>(
      sql`SELECT count(DISTINCT wx_id) AS everSpoke,
                 coalesce(sum(CASE WHEN date > ${d30} THEN messages END), 0) AS messages30,
                 count(DISTINCT CASE WHEN date > ${d30} THEN wx_id END) AS speakers30,
                 coalesce(sum(CASE WHEN date > ${d7} THEN messages END), 0) AS messages7,
                 count(DISTINCT CASE WHEN date > ${d7} THEN wx_id END) AS speakers7,
                 coalesce(sum(CASE WHEN date > ${d30} THEN quality_messages END), 0) AS quality30
          FROM daily_stats WHERE conv_id = ${g.convId}`,
    )[0];

    /*
     * 集中度按**最近 30 天**算，不按全部历史。
     *
     * 按历史算的话，早就不说话的老成员会一直摊薄分母，
     * 一个正在收缩成三个人的群看起来仍然很均匀 ——
     * 而那恰恰是这个指标要抓的情况。
     */
    const perPerson = db
      .all<{ n: number }>(
        sql`SELECT sum(messages) AS n FROM daily_stats
            WHERE conv_id = ${g.convId} AND date > ${d30}
            GROUP BY wx_id`,
      )
      .map((r) => Number(r.n));

    const trendRows = db.all<{ date: string; n: number }>(
      sql`SELECT date, sum(messages) AS n FROM daily_stats
          WHERE conv_id = ${g.convId} AND date > ${dTrend}
          GROUP BY date`,
    );
    const byDate = new Map(trendRows.map((r) => [r.date, Number(r.n)]));
    const trend: number[] = [];
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
      trend.push(byDate.get(shiftDateKey(now, -i)) ?? 0);
    }

    /*
     * ─────────────────────────────────────────
     * 势头 = 最近一周日均 ÷ 之前两周日均 − 1
     * ─────────────────────────────────────────
     *
     * **日均而不是总量**：两段窗口长度不同（7 天 vs 14 天），
     * 直接比总量的话，一个完全没有变化的群会显示「少了 50%」。
     *
     * ─────────────────────────────────────────
     * **今天不参加比较** —— 它永远是半天
     * ─────────────────────────────────────────
     *
     * 第一版把今天算进了最近那一段。测试里一个每天都是 10 条、
     * 三周纹丝不动的群，算出来是 **−14.3%**：
     * 窗口有 7 个格子，而今天那格还没攒满。
     *
     * 线上的表现会更难看 —— 早上九点看这一页，
     * 今天只有三小时的消息，**每一个群都会挂上退潮的红牌**，
     * 到晚上又自己好了。一个每天早上都误报的预警，
     * 一周之内就会被彻底忽略，那时它连真的退潮也叫不醒人。
     *
     * 所以两段窗口都只取**已经过完的整天**。
     */
    const lastComplete = shiftDateKey(now, -1);
    const recentFrom = shiftDateKey(now, -1 - RECENT);
    const baseFrom = shiftDateKey(now, -1 - BASELINE);

    const windows = db.all<{ recent: number; base: number }>(
      sql`SELECT
            coalesce(sum(CASE WHEN date > ${recentFrom} THEN messages END), 0) AS recent,
            coalesce(sum(CASE WHEN date <= ${recentFrom} THEN messages END), 0) AS base
          FROM daily_stats
          WHERE conv_id = ${g.convId}
            AND date > ${baseFrom} AND date <= ${lastComplete}`,
    )[0];

    /*
     * ─────────────────────────────────────────
     * 分母是**有记录的天**，不是日历天
     * ─────────────────────────────────────────
     *
     * 归档是有洞的：线上 2026-07-15 到 07-29 整整 15 天一条记录都没有，
     * 因为回填还没补齐。而基线窗口正好落在那一段上 ——
     * 4 天的数据除以 14 天，基线被压到真实值的三分之一，
     * 于是势头算出来是 **+1257%、+9950%**。
     *
     * 那种数字比错更糟：它一眼就假，而一个一眼就假的仪表，
     * 人会连同它旁边**真**的那些数字一起不信。
     *
     * 分不清「同步缺了这一天」和「这天真的没人说话」怎么办？
     * 用**全站**来判：某一天只要有任何一个群有记录，
     * 就说明那天同步是好的，某个群在那天没记录就是真的安静。
     * 全站都没有记录的那些天，是洞，不参与计算。
     */
    const recentDays = coveredDays(recentFrom, lastComplete);
    const baseDays = coveredDays(baseFrom, recentFrom);

    const recentPerDay = recentDays > 0 ? Number(windows?.recent ?? 0) / recentDays : 0;
    const basePerDay = baseDays > 0 ? Number(windows?.base ?? 0) / baseDays : 0;

    /*
     * 基线太薄就**不给结论**，而不是给一个不靠谱的。
     *
     * 剩下三四天的时候，一次群聊爆发就能把比值拉到几倍 ——
     * 那不是趋势，是噪声。宁可这一格显示「—」。
     */
    const momentum =
      basePerDay > 0 && baseDays >= MIN_BASELINE_DAYS ? recentPerDay / basePerDay - 1 : null;

    const messages30 = Number(totals?.messages30 ?? 0);
    const members = Number(g.members ?? 0);
    const everSpoke = Number(totals?.everSpoke ?? 0);

    const health: GroupHealth = {
      convId: g.convId,
      name: g.name,
      members,
      everSpoke,
      // 成员数比说过话的人还少时（成员表没同步全）不要报出负数
      silentRatio: members > 0 ? Math.max(0, 1 - everSpoke / members) : 0,
      messages7: Number(totals?.messages7 ?? 0),
      messages30,
      speakers7: Number(totals?.speakers7 ?? 0),
      speakers30: Number(totals?.speakers30 ?? 0),
      top3Share: topShare(perPerson),
      gini: gini(perPerson),
      qualityRatio: messages30 > 0 ? Number(totals?.quality30 ?? 0) / messages30 : 0,
      trend,
      momentum,
      baselineDays: baseDays,
      verdict: "healthy",
      reasons: [],
    };

    const verdict = judge(health);
    health.verdict = verdict.verdict;
    health.reasons = verdict.reasons;
    out.push(health);
  }

  /*
   * 排序：**最需要干预的排在最前面**。
   *
   * 按人数或消息数排的话，最大的群永远在最上面 ——
   * 而一个 400 人的健康群不需要群主每天看它，
   * 一个正在退潮的 40 人小群需要。
   */
  const ORDER: HealthVerdict[] = ["fading", "idle", "concentrated", "quiet", "healthy"];
  return out.sort((a, b) => {
    const d = ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict);
    return d !== 0 ? d : b.messages30 - a.messages30;
  });
}
