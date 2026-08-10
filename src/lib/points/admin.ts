import "server-only";

import { and, desc, gte, inArray, isNotNull, like, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { pointsLedger, users } from "@/lib/db/schema";
import { resolveDisplayName } from "@/lib/users/display-name";

import { BURST_PER_DAY, severityOf, sortRisks, type RiskItem } from "./admin-rules";

/**
 * 积分流水的全站视图与风控队列。
 *
 * ─────────────────────────────────────────
 * 在这之前只有「每个人自己那一份」
 * ─────────────────────────────────────────
 *
 * `listLedger(userId)` 给的是当事人自己的账单。全站视图一个都没有 ——
 * 也就是说「这周分是怎么发出去的」「有没有人在刷」这两个问题，
 * 管理员唯一的办法是自己写 SQL。
 */

export interface LedgerRow {
  id: string;
  userId: string;
  name: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  ruleKey: string | null;
  operatorId: string | null;
  operatorName: string | null;
  revertsId: string | null;
  revertedBy: string | null;
  createdAt: number;
}

export interface LedgerFilter {
  /** 昵称或微信 ID 的模糊匹配 */
  q?: string;
  /** 只看人工调整 */
  manualOnly?: boolean;
  /** 只看冲正相关 */
  revertedOnly?: boolean;
  limit?: number;
  offset?: number;
}

/** 名字批量补齐 —— 逐条查会在一页 50 行上打出 50 次查询 */
function namesOf(ids: string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({
        id: users.id,
        wxId: users.wxId,
        siteNickname: users.siteNickname,
        wxNickname: users.wxNickname,
      })
      .from(users)
      .where(inArray(users.id, ids))
      .all()
      .map((u) => [
        u.id,
        resolveDisplayName([u.siteNickname, u.wxNickname], { wxId: u.wxId, fallback: "成员" }),
      ]),
  );
}

export function listAllLedger(filter: LedgerFilter = {}): LedgerRow[] {
  const where = [];
  if (filter.manualOnly) where.push(isNotNull(pointsLedger.operatorId));
  if (filter.revertedOnly) {
    where.push(or(isNotNull(pointsLedger.revertsId), isNotNull(pointsLedger.revertedBy))!);
  }

  /*
   * 按人筛的时候先把 id 查出来再 in ——
   * join 到 users 上做 like 的话，没有索引的模糊匹配会拖着整张流水表走。
   */
  if (filter.q?.trim()) {
    const kw = `%${filter.q.trim()}%`;
    const ids = db
      .select({ id: users.id })
      .from(users)
      .where(or(like(users.siteNickname, kw), like(users.wxNickname, kw), like(users.wxId, kw)))
      .all()
      .map((u) => u.id);
    // 一个人都没匹配上就直接返回空，别拿空数组去 in（那会匹配所有行）
    if (ids.length === 0) return [];
    where.push(inArray(pointsLedger.userId, ids));
  }

  const rows = db
    .select()
    .from(pointsLedger)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(pointsLedger.createdAt))
    .limit(filter.limit ?? 60)
    .offset(filter.offset ?? 0)
    .all();

  const names = namesOf([
    ...new Set([
      ...rows.map((r) => r.userId),
      ...rows.map((r) => r.operatorId).filter((v): v is string => Boolean(v)),
    ]),
  ]);

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: names.get(r.userId) ?? "已注销",
    delta: r.delta,
    balanceAfter: r.balanceAfter,
    reason: r.reason,
    ruleKey: r.ruleKey,
    operatorId: r.operatorId,
    // "system" 是自动回滚写的，不是真人
    operatorName: r.operatorId ? (names.get(r.operatorId) ?? "系统") : null,
    revertsId: r.revertsId,
    revertedBy: r.revertedBy,
    createdAt: r.createdAt,
  }));
}

export function ledgerTotal(filter: LedgerFilter = {}): number {
  // 只用于「还有更多」的提示，粗略即可
  return listAllLedger({ ...filter, limit: 1000, offset: 0 }).length;
}

export interface LedgerSummary {
  entries: number;
  granted: number;
  spent: number;
  manual: number;
  reverted: number;
}

export function ledgerSummary(sinceDays = 30): LedgerSummary {
  const since = Date.now() - sinceDays * 86_400_000;
  const rows = db
    .select({
      delta: pointsLedger.delta,
      operatorId: pointsLedger.operatorId,
      revertsId: pointsLedger.revertsId,
    })
    .from(pointsLedger)
    .where(gte(pointsLedger.createdAt, since))
    .all();

  return {
    entries: rows.length,
    granted: rows.filter((r) => r.delta > 0).reduce((s, r) => s + r.delta, 0),
    spent: rows.filter((r) => r.delta < 0).reduce((s, r) => s + Math.abs(r.delta), 0),
    manual: rows.filter((r) => r.operatorId).length,
    reverted: rows.filter((r) => r.revertsId).length,
  };
}

/**
 * 风控队列。
 *
 * ─────────────────────────────────────────
 * 一次扫全站，不逐人查
 * ─────────────────────────────────────────
 *
 * `auditBalance(userId)` 是单人的，拿它遍历所有账号就是 N 次查询。
 * 对账这件事本来就是一句 SQL —— 让数据库自己去比。
 */
export function riskQueue(): RiskItem[] {
  const items: RiskItem[] = [];

  /*
   * 一、余额和流水对不上。
   *
   * 这是最要紧的一条：它说明有人直接改了库，或者记账路径上有 bug ——
   * 而无论哪种，从这一刻起所有余额都不可信了。
   *
   * 用两条普通查询在内存里比，不写关联子查询。
   *
   * 第一版是 `(SELECT SUM(delta) ... WHERE user_id = users.id)` 嵌在
   * select 里 —— drizzle 渲染出来的那句对不上，所有人都被算成 0，
   * 于是**每个有分的人都被报成「对不上账」**。一个把正常情况全报成
   * 异常的风控队列，第一天就会被忽略掉。
   *
   * 账号是三位数、流水是两位数，一次 groupBy 加一次全表足够了。
   */
  const sums = new Map(
    db
      .select({
        userId: pointsLedger.userId,
        total: sql<number>`SUM(${pointsLedger.delta})`,
      })
      .from(pointsLedger)
      .groupBy(pointsLedger.userId)
      .all()
      .map((r) => [r.userId, Number(r.total)]),
  );

  const mismatched = db
    .select({
      id: users.id,
      wxId: users.wxId,
      siteNickname: users.siteNickname,
      wxNickname: users.wxNickname,
      cached: users.points,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .all()
    .map((u) => ({ ...u, computed: sums.get(u.id) ?? 0 }))
    .filter((u) => u.cached !== u.computed);

  for (const u of mismatched) {
    items.push({
      kind: "mismatch",
      userId: u.id,
      name: resolveDisplayName([u.siteNickname, u.wxNickname], { wxId: u.wxId, fallback: "成员" }),
      detail: `余额记着 ${u.cached}，流水加起来是 ${u.computed}`,
      severity: severityOf("mismatch"),
      at: u.updatedAt,
    });
  }

  // 二、余额为负 —— grantPoints 挡着不该出现，出现了就是有别的路在写
  const negative = db
    .select({
      id: users.id,
      wxId: users.wxId,
      siteNickname: users.siteNickname,
      wxNickname: users.wxNickname,
      points: users.points,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(sql`${users.points} < 0`)
    .all();

  for (const u of negative) {
    items.push({
      kind: "negative",
      userId: u.id,
      name: resolveDisplayName([u.siteNickname, u.wxNickname], { wxId: u.wxId, fallback: "成员" }),
      detail: `余额是 ${u.points}`,
      severity: severityOf("negative"),
      at: u.updatedAt,
    });
  }

  // 三、一天里涨得太快
  const since = Date.now() - 86_400_000;
  const bursts = db
    .select({
      userId: pointsLedger.userId,
      gained: sql<number>`SUM(CASE WHEN ${pointsLedger.delta} > 0 THEN ${pointsLedger.delta} ELSE 0 END)`,
      last: sql<number>`MAX(${pointsLedger.createdAt})`,
    })
    .from(pointsLedger)
    .where(gte(pointsLedger.createdAt, since))
    .groupBy(pointsLedger.userId)
    .all()
    .filter((r) => Number(r.gained) > BURST_PER_DAY);

  const burstNames = namesOf(bursts.map((b) => b.userId));
  for (const b of bursts) {
    items.push({
      kind: "burst",
      userId: b.userId,
      name: burstNames.get(b.userId) ?? "成员",
      detail: `24 小时内进账 ${Number(b.gained)} 分`,
      severity: severityOf("burst"),
      at: Number(b.last),
    });
  }

  /*
   * 四、人工调整。
   *
   * 不是错，但每一笔都该被看见 —— 它是唯一能绕过规则的路，
   * 而一条没人看的审计线索等于没有。
   */
  const manual = db
    .select()
    .from(pointsLedger)
    .where(and(isNotNull(pointsLedger.operatorId), gte(pointsLedger.createdAt, Date.now() - 7 * 86_400_000)))
    .orderBy(desc(pointsLedger.createdAt))
    .limit(20)
    .all()
    // system 是自动回滚写的，不是人工
    .filter((r) => r.operatorId !== "system");

  const manualNames = namesOf(manual.map((m) => m.userId));
  for (const m of manual) {
    items.push({
      kind: "manual",
      userId: m.userId,
      name: manualNames.get(m.userId) ?? "成员",
      detail: `${m.delta > 0 ? "+" : ""}${m.delta} · ${m.reason}`,
      severity: severityOf("manual"),
      at: m.createdAt,
    });
  }

  return sortRisks(items);
}

