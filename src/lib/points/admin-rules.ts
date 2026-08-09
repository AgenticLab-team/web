/**
 * 积分的人工调整与风控。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 有人工调整，但没有全站视图
 * ─────────────────────────────────────────
 *
 * `adjustPoints` 在用户详情页上是有的，而**流水只能一个人一个人地看** ——
 * 「这周分是怎么发出去的」「有没有人在刷」这两个问题，
 * 管理员唯一的办法是自己写 SQL。
 *
 * 而对账（`auditBalance`）也只有单人版：一个「所有人都对得上吗」
 * 的问题，要遍历全站才答得出来，于是从来没人答过。
 *
 * ─────────────────────────────────────────
 * 风控看的是「对不上账」，不是「谁分多」
 * ─────────────────────────────────────────
 *
 * 分多是好事。真正要盯的是那几种「不该发生」：
 * 余额和流水对不上、余额为负、同一个人一天里拿到远超上限的分。
 * 把「排行榜前几名」当成风险，只会让人学会忽略这个队列。
 */

/*
 * 人工调整的校验**不在这里** —— `lib/points/rules.ts` 的
 * `checkPointsAdjust` 早就有了，而且比这里该有的更完整
 * （阈值可配、大额要额外权限）。
 *
 * 我一开始在这儿又写了一份 `checkAdjust`，那正是这个 session
 * 一路在拆的东西：同一件事两份实现，早晚有一份被改、另一份没改。
 */

/* ── 风控 ──────────────────────────────────────────────── */

export type RiskKind =
  /** 余额和流水加起来对不上 —— 有人直接改了库，或者有 bug */
  | "mismatch"
  /** 余额为负 —— 所有基于余额的判断都会失效 */
  | "negative"
  /** 一天里拿到的分远超正常上限 */
  | "burst"
  /** 人工调整 —— 不是错，但每一笔都该被看见 */
  | "manual";

export interface RiskItem {
  kind: RiskKind;
  userId: string;
  name: string;
  detail: string;
  /** 排序用：越大越该先看 */
  severity: number;
  at: number;
}

export const RISK_LABEL: Record<RiskKind, string> = {
  mismatch: "对不上账",
  negative: "余额为负",
  burst: "一天涨得太快",
  manual: "人工调整",
};

/**
 * 「一天涨得太快」的线。
 *
 * 拿生产数据定的：每日打卡一次给十几分，一天正常上限在几十分。
 * 定到 300 是留了一个数量级的余量 —— 风控队列一旦开始报正常行为，
 * 它就会被整个忽略掉，那时候真出事也没人看。
 */
export const BURST_PER_DAY = 300;

export function severityOf(kind: RiskKind): number {
  /*
   * 对不上账排最前：它说明**记账系统本身**出了问题，
   * 而其它几种都还在系统的规则之内。
   */
  return { mismatch: 100, negative: 90, burst: 50, manual: 10 }[kind];
}

export function sortRisks(items: RiskItem[]): RiskItem[] {
  return [...items].sort((a, b) => b.severity - a.severity || b.at - a.at);
}

/**
 * 队列是空的时候说什么。
 *
 * 「暂无数据」是错的 —— 这里空着是**好消息**，
 * 而一句中性的话会让人以为这一页还没做好。
 */
export function emptyRiskMessage(): string {
  return "没有异常 —— 余额和流水对得上，也没有人一天涨得离谱";
}
