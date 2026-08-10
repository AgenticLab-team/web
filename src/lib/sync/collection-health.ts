import "server-only";

import type { Freshness } from "@/lib/sync/health";

/**
 * 采集健康 —— 「数据还在不在进来」。
 *
 * ─────────────────────────────────────────
 * 15 天的归档缺口，没有任何东西报过
 * ─────────────────────────────────────────
 *
 * 线上 2026-07-15 ~ 07-29 整整 15 天，12 个群一条消息都没有。
 * 上游对账证实那段上游自己也没有 —— 机器人当时没在采集。
 *
 * 而这件事**发生的时候没有任何告警**。原因是结构性的：
 *
 *   · `classifyFreshness` 早就能逐群判断「多久没消息了」，
 *     但它只渲染在 `/admin/groups` 那一页上，**从来没有进过
 *     `system_health`**，也就够不到告警那一套
 *   · 健康探测里有 `upstream_api` 和 `frp_tunnel`，
 *     它们问的是「接口通不通」—— 而那两天接口大概率是通的，
 *     只是**没有新数据**。接口返回 200、内容为空，探测一路绿灯
 *
 * 「没有新数据」和「接口坏了」是两件事，而这个站以前只盯后者。
 *
 * ─────────────────────────────────────────
 * 判据：**一起**安静才算采集断了
 * ─────────────────────────────────────────
 *
 * 单个群安静是常态 —— 人本来就会不说话，`classifyFreshness`
 * 已经按每个群自己的节奏容忍过一轮了。
 *
 * 但 12 个群**同时**越过各自的容忍线，不是十二群人约好一起沉默，
 * 那是采集这一侧停了。这和归档缺口用的是同一条推理
 * （见 `admin/community-health.ts` 的 archiveGaps）。
 *
 * 所以门槛是**比例**，不是个数：一个只接了两个群的站，
 * 「两个都停了」同样成立。
 */

/**
 * 多大比例的群同时陈旧，才认为是采集断了。
 *
 * 拿线上 30 天的真实消息按小时回放过一遍：**非缺口期最高同时陈旧
 * 比例是 55.6%**（出现在 2026-08-02 早上 6:52 —— 正是所有人都在睡觉
 * 的时候）。0.6 的门槛在那 384 个采样点里一次都没被触发。
 *
 * 但 55.6 离 60 太近了 —— 再多接一个冷清的群就会顶上去。
 * 所以门槛提到 0.75，并且再加一条硬条件（见下面 busiest）。
 */
export const STALE_RATIO = 0.75;
/**
 * 至少要有几个群才做这个判断。
 *
 * 只接了一个群的时候，「100% 的群陈旧」和「那个群没人说话」
 * 是同一件事，分不开 —— 分不开就不要报，报了就是噪声。
 */
export const MIN_GROUPS = 2;

export interface CollectionGroup {
  level: Freshness;
  /** 这个群平时日均多少条 —— 用来找出「最活跃的那个」 */
  dailyAverage: number;
}

export interface CollectionInput {
  groups: readonly CollectionGroup[];
}

export interface CollectionVerdict {
  status: "ok" | "degraded" | "down";
  detail: string;
  /** 陈旧的群数 / 参与判定的群数 */
  stale: number;
  total: number;
}

export function classifyCollection(input: CollectionInput): CollectionVerdict {
  /*
   * `unknown` 不参与判定。
   *
   * 它的含义是「刚接入，还在观察」或「从没同步到过消息」——
   * 两者都不是「采集断了」的证据。算进分母会让一批新接入的群
   * 把比例稀释掉，算进分子则会在接入当天就报警。
   */
  const counted = input.groups.filter((g) => g.level !== "unknown");
  const total = counted.length;
  const stale = counted.filter((g) => g.level === "stale").length;

  /*
   * ─────────────────────────────────────────
   * 硬条件：**最活跃的那个群也得停**
   * ─────────────────────────────────────────
   *
   * 光看比例不够稳。凌晨的自然安静是从冷清的群开始的 ——
   * 线上回放里 06:52 有 55.6% 的群同时越线，而那时候
   * 最活跃的群（日均 701 条、历史最大静默 6.9 小时）照样在说话。
   *
   * 采集真断了的时候不是这样：它把**所有**群一起停掉，
   * 包括最热闹的那个。所以把「最活跃的群也陈旧」加成必要条件，
   * 自然安静就再也够不到这条线了 —— 而真的中断一条都不会漏。
   */
  const busiest = counted.reduce<CollectionGroup | null>(
    (best, g) => (best === null || g.dailyAverage > best.dailyAverage ? g : best),
    null,
  );
  const busiestStale = busiest?.level === "stale";

  if (total < MIN_GROUPS) {
    return {
      status: "ok",
      // 说清楚是「没法判断」，不是「一切正常」—— 两者的下一步不同
      detail: `只有 ${total} 个群在同步，样本太少，不做采集中断判定`,
      stale,
      total,
    };
  }

  const ratio = stale / total;

  if (ratio >= STALE_RATIO && busiestStale) {
    return {
      status: "down",
      detail:
        `${stale}/${total} 个群同时超过各自的容忍线没有新消息 —— ` +
        `这么多群一起安静不是巧合，多半是采集停了（机器人掉线、上游没在收）。` +
        `接口通不通请看 upstream_api`,
      stale,
      total,
    };
  }

  if (stale > 0) {
    return {
      status: "degraded",
      detail:
        `${stale}/${total} 个群超过容忍线没有新消息` +
        (busiestStale ? "（含最活跃的那个）" : "，最活跃的群还在正常说话") +
        ` —— 还不到整体中断的程度，去群页看是哪几个`,
      stale,
      total,
    };
  }

  return { status: "ok", detail: `${total} 个群都在正常进数据`, stale, total };
}
