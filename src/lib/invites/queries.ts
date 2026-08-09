import "server-only";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { inviteUses, invites, users } from "@/lib/db/schema";
import { ancestorsOf, buildTree, describeInvite, normalizeCode } from "@/lib/invites/rules";
import { paginate, type PageSlice } from "@/lib/pagination";
import { resolveDisplayName } from "@/lib/users/display-name";

/**
 * 邀请的读取层。
 *
 * 邀请树是这一块最有价值的视图：出问题时（比如发现一批小号），
 * 第一个问题永远是「他们是谁拉来的」。
 */

export interface InviteRow {
  id: string;
  code: string;
  note: string | null;
  createdBy: string;
  createdByName: string;
  maxUses: number | null;
  usedCount: number;
  expiresAt: number | null;
  grantKind: string;
  revokedAt: number | null;

  usable: boolean;
  statusLabel: string;
  remaining: number | null;

  /** 用这个码进来的人里，有多少已经拿到奖励 */
  rewarded: number;
  /** 有多少被回滚了 —— 这个数高说明这个码在被滥用 */
  reverted: number;

  createdAt: number;
}

export function listInvites(now = Date.now(), createdBy?: string): InviteRow[] {
  const rows = db
    .select()
    .from(invites)
    .where(createdBy ? eq(invites.createdBy, createdBy) : undefined)
    .orderBy(desc(invites.createdAt))
    .limit(200)
    .all();

  if (rows.length === 0) return [];

  const creatorIds = [...new Set(rows.map((r) => r.createdBy))];
  const names = new Map(
    db
      .select({ id: users.id, site: users.siteNickname, wx: users.wxNickname, wxId: users.wxId })
      .from(users)
      .where(sql`${users.id} in ${creatorIds}`)
      .all()
      .map((u) => [
        u.id,
        resolveDisplayName([u.site, u.wx], { wxId: u.wxId, fallback: "管理员" }),
      ]),
  );

  const stats = new Map<string, { rewarded: number; reverted: number }>();
  for (const use of db.select().from(inviteUses).all()) {
    const s = stats.get(use.inviteId) ?? { rewarded: 0, reverted: 0 };
    if (use.rewardedAt !== null) s.rewarded++;
    if (use.revertedAt !== null) s.reverted++;
    stats.set(use.inviteId, s);
  }

  return rows.map((row) => {
    const status = describeInvite(row, now);
    const stat = stats.get(row.id) ?? { rewarded: 0, reverted: 0 };
    return {
      id: row.id,
      code: row.code,
      note: row.note,
      createdBy: row.createdBy,
      createdByName: names.get(row.createdBy) ?? "管理员",
      maxUses: row.maxUses,
      usedCount: row.usedCount,
      expiresAt: row.expiresAt,
      grantKind: row.grantKind,
      revokedAt: row.revokedAt,

      usable: status.usable,
      statusLabel: status.label,
      remaining: status.remaining,

      rewarded: stat.rewarded,
      reverted: stat.reverted,

      createdAt: row.createdAt,
    };
  });
}

export function findByCode(code: string) {
  return db.select().from(invites).where(eq(invites.code, normalizeCode(code))).get() ?? null;
}

export function isAlreadyInvited(userId: string): boolean {
  return (
    db.select().from(inviteUses).where(eq(inviteUses.invitedUserId, userId)).get() !== undefined
  );
}

export interface TreeUser {
  id: string;
  invitedBy: string | null;
  name: string;
  status: string;
  points: number;
  createdAt: number;
  /** 这个人有没有真的用起来 —— 拉了一堆从不打卡的人是最典型的刷邀请 */
  checkedIn: boolean;
}

function loadTreeUsers(): TreeUser[] {
  return db
    .select({
      id: users.id,
      invitedBy: users.invitedBy,
      site: users.siteNickname,
      wx: users.wxNickname,
      wxId: users.wxId,
      status: users.status,
      points: users.points,
      createdAt: users.createdAt,
      lastCheckinDate: users.lastCheckinDate,
    })
    .from(users)
    .where(isNull(users.deletedAt))
    .all()
    .map((u) => ({
      id: u.id,
      invitedBy: u.invitedBy,
      name: resolveDisplayName([u.site, u.wx], { wxId: u.wxId, fallback: "社区成员" }),
      status: u.status,
      points: u.points,
      createdAt: u.createdAt,
      checkedIn: u.lastCheckinDate !== null,
    }));
}

/** 某人的下游 —— 他拉来了谁，那些人又拉来了谁 */
export function inviteTree(rootId: string) {
  return buildTree(loadTreeUsers(), rootId);
}

/** 某人的上游 —— 他是谁拉来的。出问题时这是第一个要问的 */
export function inviteAncestors(userId: string) {
  return ancestorsOf(loadTreeUsers(), userId);
}

export interface InviteUseRow {
  id: string;
  inviteId: string;
  code: string;
  inviterId: string;
  inviterName: string;
  invitedUserId: string;
  invitedName: string;
  invitedStatus: string;
  invitedCheckedIn: boolean;
  rewardedAt: number | null;
  rewardPoints: number | null;
  revertedAt: number | null;
  revertReason: string | null;
  createdAt: number;
}

export function listInviteUses(limit = 100, offset = 0): InviteUseRow[] {
  const rows = db
    .select({
      use: inviteUses,
      code: invites.code,
      inviterSite: users.siteNickname,
      inviterWx: users.wxNickname,
      inviterWxId: users.wxId,
    })
    .from(inviteUses)
    .innerJoin(invites, eq(invites.id, inviteUses.inviteId))
    .leftJoin(users, eq(users.id, inviteUses.inviterId))
    .orderBy(desc(inviteUses.createdAt), desc(inviteUses.id))
    .limit(limit)
    .offset(offset)
    .all();

  if (rows.length === 0) return [];

  const invitedIds = rows.map((r) => r.use.invitedUserId);
  const invited = new Map(
    db
      .select({
        id: users.id,
        site: users.siteNickname,
        wx: users.wxNickname,
        wxId: users.wxId,
        status: users.status,
        lastCheckinDate: users.lastCheckinDate,
      })
      .from(users)
      .where(sql`${users.id} in ${invitedIds}`)
      .all()
      .map((u) => [u.id, u]),
  );

  return rows.map(({ use, code, inviterSite, inviterWx, inviterWxId }) => {
    const target = invited.get(use.invitedUserId);
    return {
      id: use.id,
      inviteId: use.inviteId,
      code,
      inviterId: use.inviterId,
      inviterName: resolveDisplayName([inviterSite, inviterWx], {
        wxId: inviterWxId,
        fallback: "社区成员",
      }),
      invitedUserId: use.invitedUserId,
      invitedName: target
        ? resolveDisplayName([target.site, target.wx], {
            wxId: target.wxId,
            fallback: "社区成员",
          })
        : "已删除的账号",
      invitedStatus: target?.status ?? "deleted",
      invitedCheckedIn: target?.lastCheckinDate !== null && target?.lastCheckinDate !== undefined,
      rewardedAt: use.rewardedAt,
      rewardPoints: use.rewardPoints,
      revertedAt: use.revertedAt,
      revertReason: use.revertReason,
      createdAt: use.createdAt,
    };
  });
}

/** 后台「使用记录」的分页版 */
export function pagedInviteUses(
  query: { page?: unknown; perPage?: number } = {},
): { rows: InviteUseRow[]; total: number; slice: PageSlice } {
  const total = Number(db.select({ n: sql<number>`count(*)` }).from(inviteUses).get()?.n ?? 0);
  const slice = paginate(query.page, total, query.perPage ?? 50);
  return { rows: listInviteUses(slice.perPage, slice.offset), total, slice };
}

/**
 * 滥用告警要的两个数，在 SQL 里对全表算。
 *
 * 以前是把最近 50 条拉出来在页面上 filter —— 分页之后这么算的话，
 * 「N 笔奖励已被回滚」就只统计当前页，翻到第二页数字还会变，
 * 而一个随翻页变化的告警数字比没有告警更糟。
 */
export function inviteUseStats(): { total: number; reverted: number; idle: number } {
  const total = Number(db.select({ n: sql<number>`count(*)` }).from(inviteUses).get()?.n ?? 0);
  const reverted = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(inviteUses)
      .where(sql`${inviteUses.revertedAt} is not null`)
      .get()?.n ?? 0,
  );
  // 「从没打过卡」以被邀请人的 lastCheckinDate 为准 —— 和页面上逐行的判定同一把尺
  const idle = Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(inviteUses)
      .leftJoin(users, eq(users.id, inviteUses.invitedUserId))
      .where(and(isNull(inviteUses.revertedAt), isNull(users.lastCheckinDate)))
      .get()?.n ?? 0,
  );
  return { total, reverted, idle };
}

/**
 * 待结算的邀请 —— 被邀请人已经打过卡但奖励还没发。
 *
 * 结算是延迟的，所以必须有个地方能看到「欠着多少」，
 * 否则结算任务停了没人会发现。
 */
export function pendingRewards() {
  return db
    .select({ use: inviteUses, lastCheckinDate: users.lastCheckinDate, status: users.status })
    .from(inviteUses)
    .innerJoin(users, eq(users.id, inviteUses.invitedUserId))
    .where(and(isNull(inviteUses.rewardedAt), isNull(inviteUses.revertedAt)))
    .all()
    .filter((r) => r.lastCheckinDate !== null && r.status === "active");
}
