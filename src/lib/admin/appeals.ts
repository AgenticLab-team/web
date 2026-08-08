import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { appeals, moderationActions, users } from "@/lib/db/schema";

/**
 * 申诉队列。
 *
 * 每一行都要带上**原处罚的理由**。只看申诉人怎么说，
 * 判断只能靠印象；两边摆在一起，才谈得上复核。
 *
 * 另外要标出「谁下的处罚」——不是为了追责，是因为原处罚人
 * 不能复核自己的决定，界面上得先让人看见这条约束再点按钮，
 * 而不是点完才被拒绝。
 */

export interface AppealRow {
  id: string;
  userId: string;
  userName: string;
  content: string;
  status: string;
  createdAt: number;
  waitingHours: number;

  actionId: string;
  actionKind: string;
  actionReason: string;
  actionAt: number;
  punisherId: string;
  punisherName: string;
  /** 处罚已经被撤销了（可能是别的途径撤的） */
  alreadyReverted: boolean;

  handledBy: string | null;
  handledAt: number | null;
  response: string | null;
}

const ACTION_LABELS: Record<string, string> = {
  warn: "警告",
  hide: "隐藏",
  delete: "删除",
  restore: "恢复",
  lock: "锁定",
  unlock: "解锁",
  pin: "置顶",
  unpin: "取消置顶",
  feature: "加精",
  unfeature: "取消加精",
  move: "移动",
  collapse: "折叠",
  mute: "禁言",
  suspend: "停用",
  ban: "封禁",
  unban: "解封",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export function appealQueue(
  query: { status?: string; limit?: number } = {},
  now = Date.now(),
): AppealRow[] {
  const punisher = { id: users.id, site: users.siteNickname, wx: users.wxNickname };

  const rows = db
    .select({
      appeal: appeals,
      action: moderationActions,
      appellantSite: users.siteNickname,
      appellantWx: users.wxNickname,
    })
    .from(appeals)
    .innerJoin(moderationActions, eq(moderationActions.id, appeals.actionId))
    .leftJoin(users, eq(users.id, appeals.userId))
    .where(query.status ? eq(appeals.status, query.status as "open") : eq(appeals.status, "open"))
    // 申诉一律**最老的排最前** —— 等待本身就是二次伤害，没有插队的理由
    .orderBy(appeals.createdAt)
    .limit(Math.min(query.limit ?? 100, 300))
    .all();

  if (rows.length === 0) return [];

  const punisherIds = [...new Set(rows.map((r) => r.action.actorId))];
  const punisherNames = new Map(
    db
      .select(punisher)
      .from(users)
      .where(inArray(users.id, punisherIds))
      .all()
      .map((u) => [u.id, u.site ?? u.wx ?? u.id]),
  );

  return rows.map((r) => ({
    id: r.appeal.id,
    userId: r.appeal.userId,
    userName: r.appellantSite ?? r.appellantWx ?? r.appeal.userId,
    content: r.appeal.content,
    status: r.appeal.status,
    createdAt: r.appeal.createdAt,
    waitingHours: Math.floor((now - r.appeal.createdAt) / 3600_000),

    actionId: r.action.id,
    actionKind: r.action.action,
    actionReason: r.action.reason,
    actionAt: r.action.createdAt,
    punisherId: r.action.actorId,
    punisherName: punisherNames.get(r.action.actorId) ?? r.action.actorId,
    alreadyReverted: r.action.revertedAt !== null,

    handledBy: r.appeal.handledBy,
    handledAt: r.appeal.handledAt,
    response: r.appeal.response,
  }));
}

export function appealFacets() {
  const byStatus = db
    .select({ status: appeals.status, n: sql<number>`count(*)` })
    .from(appeals)
    .groupBy(appeals.status)
    .all();

  const accepted =
    db
      .select({ n: sql<number>`count(*)` })
      .from(appeals)
      .where(eq(appeals.status, "accepted"))
      .get()?.n ?? 0;
  const handled =
    db
      .select({ n: sql<number>`count(*)` })
      .from(appeals)
      .where(sql`${appeals.status} in ('accepted','rejected')`)
      .get()?.n ?? 0;

  return {
    status: byStatus.map((r) => ({ value: r.status, count: Number(r.n) })),
    open: Number(byStatus.find((r) => r.status === "open")?.n ?? 0),
    /*
     * 采纳率是这套制度的体检指标，不是 KPI。
     * 长期为 0 说明申诉只是走过场；长期很高说明处罚本身太随意。
     * 两头都不对，所以要摆在页面上让人看见。
     */
    acceptRate: handled > 0 ? Math.round((Number(accepted) / Number(handled)) * 100) : null,
    handled: Number(handled),
  };
}

/** 尚未被申诉、且未撤销的处罚 —— 用户档案页的「可申诉」入口靠它 */
export function appealableActions(userId: string) {
  return db
    .select()
    .from(moderationActions)
    .where(and(eq(moderationActions.targetUserId, userId), isNull(moderationActions.revertedAt)))
    .orderBy(desc(moderationActions.createdAt))
    .all();
}
