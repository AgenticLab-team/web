/**
 * 定时发布的规则。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * `scheduled_at` 这一列，全站零引用
 * ─────────────────────────────────────────
 *
 * 它在 schema 里躺着，没有任何地方写它、也没有任何地方读它。
 *
 * ─────────────────────────────────────────
 * 到点靠的是那个五分钟一轮的定时任务
 * ─────────────────────────────────────────
 *
 * 服务器上跑着 `agenticlab-health.timer`，五分钟一次。
 * 定时发布就挂在那一轮里 —— 也就是说**它最多会晚五分钟**。
 *
 * 这件事必须在界面上说出来。不说的话，一个把时间定在 09:00 的人
 * 会在 09:01 打开页面、发现没发出去，然后以为功能坏了 ——
 * 而实际上再等四分钟就好。一个「差不多准时」的功能，
 * 只要没人告诉你它差多少，用起来就和坏了一样。
 *
 * 也因此有了下面的最短提前量：定十秒之后发，等于让人盯着一个
 * 什么都不会发生的页面看五分钟。
 */

/** 至少要提前多久。比一轮定时任务长一点，免得「刚定完就该发了」 */
export const MIN_LEAD_MS = 10 * 60_000;

/** 最多能定到多远 */
export const MAX_AHEAD_MS = 30 * 86_400_000;

/** 定时任务多久跑一轮 —— 文案要用它，不能写死一个数字在句子里 */
export const TICK_INTERVAL_MS = 5 * 60_000;

export type ScheduleVerdict = { ok: true; at: number } | { ok: false; reason: string };

export function checkSchedule(at: number, now: number): ScheduleVerdict {
  if (!Number.isFinite(at)) return { ok: false, reason: "时间格式不对" };

  if (at <= now) {
    return { ok: false, reason: "这个时间已经过去了 —— 想现在就发的话，别勾定时" };
  }

  if (at - now < MIN_LEAD_MS) {
    /*
     * 「马上就到」的定时是个陷阱。
     *
     * 定时发布挂在五分钟一轮的定时任务上，定在三分钟后的帖子
     * 实际会在第 5 分钟发出去 —— 那两分钟里人只会觉得它坏了。
     */
    return {
      ok: false,
      reason: `至少要提前 ${Math.round(MIN_LEAD_MS / 60_000)} 分钟 —— 发布是每 ${Math.round(TICK_INTERVAL_MS / 60_000)} 分钟检查一次的`,
    };
  }

  if (at - now > MAX_AHEAD_MS) {
    return { ok: false, reason: `最多定到 ${MAX_AHEAD_MS / 86_400_000} 天以后` };
  }

  return { ok: true, at };
}

/**
 * 界面上那句说明。
 *
 * **必须把「最多晚五分钟」说出来**，理由见文件顶部。
 */
export function scheduleNote(): string {
  return `到点后最多 ${Math.round(TICK_INTERVAL_MS / 60_000)} 分钟内发出 —— 发布是定时检查的，不是掐着秒`;
}

/**
 * 定时期间这个帖子谁看得见。
 *
 * ─────────────────────────────────────────
 * 版主看得见，这一点要说出来
 * ─────────────────────────────────────────
 *
 * 等待发布的帖子存成 `status = "draft"`，而 `canSeePost` 里
 * 草稿对**版主**是放行的（他们要能处理违规草稿）。
 *
 * 也就是说定时发布不是「密封到某个时刻」。多数情况无所谓，
 * 但如果有人想定时公布一个结果，他有权先知道这件事 ——
 * 而不是在结果提前走漏之后才发现。
 */
export function whoCanSeeBeforePublish(): string {
  return "发出去之前只有你和版主看得到 —— 定时不等于密封";
}

/**
 * 发出去的那一刻，「发帖时间」算哪个。
 *
 * ─────────────────────────────────────────
 * 算发布那一刻，不算写下那一刻
 * ─────────────────────────────────────────
 *
 * 列表按 `COALESCE(last_reply_at, created_at)` 排序。
 * 保留写作时间的话，一个周一写、周五发的帖子一发出来就排在
 * 四天前的位置 —— **对所有人来说它是新的，而它出现在没人会翻到的地方**。
 *
 * 这不是篡改历史：在发布之前，这个帖子对任何人都不存在。
 * 它「发生」的时刻就是它变得可见的时刻。
 */
export function publishedCreatedAt(scheduledAt: number, actualPublishAt: number): number {
  /*
   * 取两者里晚的那个。
   *
   * 正常情况是 actual 晚一点（定时任务的延迟）。
   * 而如果服务停过一天，actual 会晚很多 —— 那时候用 actual 是对的：
   * 帖子确实是那一刻才出现的，标一个昨天的时间只会让它一发出来就沉底。
   */
  return Math.max(scheduledAt, actualPublishAt);
}
