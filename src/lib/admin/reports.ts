import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { moderationActions, posts, replies, reports, users } from "@/lib/db/schema";
import {
  compareQueue,
  escalatedSeverity,
  isOverdue,
  reasonLabel,
  type Severity,
} from "@/lib/moderation/rules";

/**
 * 举报队列。
 *
 * 关键设计：**按目标归组，不按举报条数列表**。
 *
 * 十个人举报同一条内容，如果列成十行，版主会把同一个帖子处理十遍，
 * 而队列里真正需要看的其他九件事被挤到第二页。归组之后一行一个目标，
 * 举报人数反过来变成升级信号 —— 三个互不相识的人同时举报，
 * 基本不会同时看错。
 */

export interface QueueRow {
  key: string;
  targetType: "post" | "reply" | "user";
  targetId: string;
  targetUserId: string | null;
  targetUserName: string | null;
  /** 被举报内容的摘要，队列里直接能看，不用点进去 */
  preview: string | null;
  /** 内容是否已经被处理掉了（删除/隐藏） */
  targetGone: boolean;
  reportIds: string[];
  reporterCount: number;
  reasons: { code: string; label: string; count: number }[];
  details: string[];
  severity: number;
  baseSeverity: number;
  status: string;
  assignedTo: string | null;
  firstReportedAt: number;
  lastReportedAt: number;
  overdue: boolean;
  /** 这个人此前被处罚过几次 —— 惯犯和初犯不该同样处理 */
  priorActions: number;
}

export interface ReportQuery {
  status?: string;
  targetType?: string;
  reasonCode?: string;
  assignedTo?: string;
  /** 只看超时的 */
  overdueOnly?: boolean;
  limit?: number;
}

const PREVIEW_LEN = 120;

/**
 * 内容是否已经不在了。
 *
 * 只算删除和隐藏 —— **锁定的帖子仍然看得见**，
 * 把它当成「已处理」的话，被举报的内容会挂着不动而队列显示已经处置。
 */
function isGone(deletedAt: number | null, status: string): boolean {
  return deletedAt !== null || status === "deleted" || status === "hidden";
}

export function reportQueue(query: ReportQuery = {}, now = Date.now()): QueueRow[] {
  const conditions = [];
  // 默认只看待处理的 —— 打开队列看到的应该是「要干的活」，不是全部历史
  conditions.push(
    query.status
      ? eq(reports.status, query.status as "open")
      : inArray(reports.status, ["open", "reviewing"]),
  );
  if (query.targetType) conditions.push(eq(reports.targetType, query.targetType as "post"));
  if (query.reasonCode) conditions.push(eq(reports.reasonCode, query.reasonCode as "spam"));
  if (query.assignedTo) conditions.push(eq(reports.assignedTo, query.assignedTo));

  const rows = db
    .select()
    .from(reports)
    .where(and(...conditions))
    .orderBy(desc(reports.createdAt))
    .limit(Math.min(query.limit ?? 200, 500) * 4)
    .all();

  if (rows.length === 0) return [];

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.targetType}:${row.targetId}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const postIds = rows.filter((r) => r.targetType === "post").map((r) => r.targetId);
  const replyIds = rows.filter((r) => r.targetType === "reply").map((r) => r.targetId);
  const userIds = [...new Set(rows.map((r) => r.targetUserId).filter(Boolean) as string[])];

  const postMap = new Map(
    postIds.length
      ? db
          .select({
            id: posts.id,
            title: posts.title,
            content: posts.content,
            deletedAt: posts.deletedAt,
            status: posts.status,
          })
          .from(posts)
          .where(inArray(posts.id, postIds))
          .all()
          .map((p) => [p.id, p])
      : [],
  );

  const replyMap = new Map(
    replyIds.length
      ? db
          .select({
            id: replies.id,
            content: replies.content,
            deletedAt: replies.deletedAt,
            status: replies.status,
          })
          .from(replies)
          .where(inArray(replies.id, replyIds))
          .all()
          .map((r) => [r.id, r])
      : [],
  );

  const nameMap = new Map(
    userIds.length
      ? db
          .select({ id: users.id, site: users.siteNickname, wx: users.wxNickname })
          .from(users)
          .where(inArray(users.id, userIds))
          .all()
          .map((u) => [u.id, u.site ?? u.wx ?? u.id])
      : [],
  );

  const priorMap = new Map(
    userIds.length
      ? db
          .select({ userId: moderationActions.targetUserId, n: sql<number>`count(*)` })
          .from(moderationActions)
          .where(
            and(
              inArray(moderationActions.targetUserId, userIds),
              isNull(moderationActions.revertedAt),
            ),
          )
          .groupBy(moderationActions.targetUserId)
          .all()
          .map((r) => [r.userId!, Number(r.n)])
      : [],
  );

  const out: QueueRow[] = [];

  for (const [key, list] of groups) {
    const head = list[0];
    const reporters = new Set(list.map((r) => r.reporterId));
    const baseSeverity = Math.max(...list.map((r) => r.severity)) as Severity;
    const severity = escalatedSeverity(baseSeverity, reporters.size);

    const reasonCounts = new Map<string, number>();
    for (const r of list) reasonCounts.set(r.reasonCode, (reasonCounts.get(r.reasonCode) ?? 0) + 1);

    let preview: string | null = null;
    let targetGone = false;
    if (head.targetType === "post") {
      const p = postMap.get(head.targetId);
      preview = p ? `${p.title}\n${p.content}`.slice(0, PREVIEW_LEN) : null;
      targetGone = !p || isGone(p.deletedAt, p.status);
    } else if (head.targetType === "reply") {
      const r = replyMap.get(head.targetId);
      preview = r ? r.content.slice(0, PREVIEW_LEN) : null;
      targetGone = !r || isGone(r.deletedAt, r.status);
    } else {
      preview = null;
      targetGone = false;
    }

    const firstReportedAt = Math.min(...list.map((r) => r.createdAt));

    out.push({
      key,
      targetType: head.targetType,
      targetId: head.targetId,
      targetUserId: head.targetUserId,
      targetUserName: head.targetUserId ? (nameMap.get(head.targetUserId) ?? null) : null,
      preview,
      targetGone,
      reportIds: list.map((r) => r.id),
      reporterCount: reporters.size,
      reasons: [...reasonCounts.entries()]
        .map(([code, count]) => ({ code, label: reasonLabel(code), count }))
        .sort((a, b) => b.count - a.count),
      details: list.map((r) => r.detail).filter(Boolean) as string[],
      severity,
      baseSeverity,
      status: list.some((r) => r.status === "open") ? "open" : "reviewing",
      assignedTo: list.find((r) => r.assignedTo)?.assignedTo ?? null,
      firstReportedAt,
      lastReportedAt: Math.max(...list.map((r) => r.createdAt)),
      // 超时按**最早**那条算 —— 按最新算的话，持续被举报的内容永远不超时
      overdue: isOverdue(firstReportedAt, severity, now),
      priorActions: head.targetUserId ? (priorMap.get(head.targetUserId) ?? 0) : 0,
    });
  }

  return out
    .sort((a, b) =>
      compareQueue(
        { severity: a.severity, createdAt: a.firstReportedAt, reportCount: a.reporterCount },
        { severity: b.severity, createdAt: b.firstReportedAt, reportCount: b.reporterCount },
      ),
    )
    .slice(0, query.limit ?? 200);
}

/** 队列顶部的分桶计数，每个数字都是一个筛选入口 */
export function reportFacets(now = Date.now()) {
  const byStatus = db
    .select({ status: reports.status, n: sql<number>`count(*)` })
    .from(reports)
    .groupBy(reports.status)
    .all();

  const byReason = db
    .select({ code: reports.reasonCode, n: sql<number>`count(*)` })
    .from(reports)
    .where(inArray(reports.status, ["open", "reviewing"]))
    .groupBy(reports.reasonCode)
    .all();

  const open = reportQueue({ limit: 500 }, now);

  return {
    status: byStatus.map((r) => ({ value: r.status, count: Number(r.n) })),
    reasons: byReason.map((r) => ({
      code: r.code,
      label: reasonLabel(r.code),
      count: Number(r.n),
    })),
    pending: open.length,
    overdue: open.filter((r) => r.overdue).length,
    urgent: open.filter((r) => r.severity >= 2).length,
    unassigned: open.filter((r) => !r.assignedTo).length,
  };
}

/** 某个目标的举报全文，处理面板里展开看 */
export function reportsForTarget(targetType: string, targetId: string) {
  return db
    .select({
      id: reports.id,
      reporterId: reports.reporterId,
      reporterName: users.siteNickname,
      reporterWxName: users.wxNickname,
      reasonCode: reports.reasonCode,
      detail: reports.detail,
      status: reports.status,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .leftJoin(users, eq(users.id, reports.reporterId))
    .where(and(eq(reports.targetType, targetType as "post"), eq(reports.targetId, targetId)))
    .orderBy(desc(reports.createdAt))
    .all()
    .map((r) => ({
      ...r,
      reporterName: r.reporterName ?? r.reporterWxName ?? r.reporterId,
      reasonLabel: reasonLabel(r.reasonCode),
    }));
}
