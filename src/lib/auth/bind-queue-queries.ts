import "server-only";

import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, bindCodes, groupMembers, groups, messages, users } from "@/lib/db/schema";
import { NekoBotError, nekobot } from "@/lib/nekobot/client";

import {
  DAY_MS,
  acceptBudget,
  groupStuck,
  isActionable,
  judgeApplicant,
  type AcceptBudget,
  type ApplicantActivity,
  type ApplicantVerdict,
  type StuckApplicant,
} from "./bind-queue";

/**
 * 绑定审批队列要的数据。
 *
 * 两拨东西，来源完全不同：
 *
 *   · **待处理的好友申请** —— 从上游拉，我们这边没有存
 *   · **没能完成的绑定**   —— 我们自己的 bind_codes
 *
 * 混在一个页面上是因为管理员的处境是同一个：
 * 「有人进不来，我要不要放他进来」。
 */

/** 通过好友申请这件事记在审计日志里，限速也从那里算 —— 那本来就是记录之源 */
export const FRIEND_ACCEPT_ACTION = "user.bind.friend_accept";

/**
 * 一个微信号在我们这边的活跃度。
 *
 * **已退群的不算**（leftAt 不为空）—— 退了群的人不再是群成员，
 * 而这个数字的全部用途就是回答「他在不在群里」。
 */
export function applicantActivity(wxId: string): ApplicantActivity {
  const rows = db
    .select({
      convId: groupMembers.convId,
      messages: groupMembers.messages,
      joinedAt: groupMembers.joinedAt,
      groupName: groups.name,
    })
    .from(groupMembers)
    .leftJoin(groups, eq(groups.convId, groupMembers.convId))
    .where(and(eq(groupMembers.wxId, wxId), isNull(groupMembers.leftAt)))
    .all();

  const last = db
    .select({ ts: messages.ts })
    .from(messages)
    .where(eq(messages.senderWxId, wxId))
    .orderBy(desc(messages.ts))
    .limit(1)
    .get();

  const joined = rows.map((r) => r.joinedAt).filter((t): t is number => t != null);

  return {
    groups: rows.map((r) => r.groupName ?? r.convId),
    messages: rows.reduce((n, r) => n + r.messages, 0),
    lastSeenAt: last?.ts ?? null,
    joinedAt: joined.length > 0 ? Math.min(...joined) : null,
  };
}

export interface FriendRequestRow {
  wxId: string;
  nickname: string | null;
  avatarUrl: string | null;
  requestedAt: number | null;
  /** 申请理由 —— 验证码就是从这里提取的 */
  note: string | null;
  activity: ApplicantActivity;
  verdict: ApplicantVerdict;
  /** 已经有账号了就不用再处理 */
  boundUserId: string | null;
}

/**
 * 待处理的好友申请，配上本地算出来的活跃度。
 *
 * 上游挂了就返回空表加一句错误 —— **不要把上游故障显示成
 * 「没有待处理的申请」**，那会让人以为处理完了。
 */
export async function pendingFriendRequests(
  limit = 30,
): Promise<{ rows: FriendRequestRow[]; error: string | null }> {
  let raw;
  try {
    raw = await nekobot.friendRequests({ pending_only: true, limit });
  } catch (error) {
    const message =
      error instanceof NekoBotError ? error.message : error instanceof Error ? error.message : String(error);
    return { rows: [], error: `拉不到好友申请列表：${message}` };
  }

  const now = Date.now();
  const rows = (raw.items ?? []).map((item) => {
    const activity = applicantActivity(item.wx_id);
    const bound = db.select().from(users).where(eq(users.wxId, item.wx_id)).get();
    return {
      wxId: item.wx_id,
      nickname: item.nickname || null,
      avatarUrl: item.avatar || null,
      requestedAt: item.at_ms ?? null,
      note: item.reason || null,
      activity,
      verdict: judgeApplicant(activity, now),
      boundUserId: bound?.id ?? null,
    };
  });

  return { rows, error: null };
}

export interface StalledBind extends StuckApplicant {
  /** 最近那个码是不是已经过期 */
  expired: boolean;
}

/**
 * 真正卡住的人。
 *
 * ─────────────────────────────────────────
 * 「有没匹配上的码」不是卡住的信号
 * ─────────────────────────────────────────
 *
 * 打开登录页就会取一个码。生产上量了一遍:一天 392 个码、
 * 235 个从没匹配上 —— 绝大多数只是有人点开看了一眼就走了。
 *
 * 照那个口径做出来的队列每天两百多条,而**两百多条的队列没有人会看**,
 * 那就等于这个功能不存在。
 *
 * 所以按 IP 聚合,只留反复试过的（门槛见 STUCK_CODE_THRESHOLD,
 * 那个数字是量出来的:≥2 次的只有 12 个 IP，是个能处理完的量）。
 */
export function stalledBinds(): StalledBind[] {
  const now = Date.now();
  /*
   * 拉这段时间的**全部**取码记录，包括成功的。
   *
   * 只拉没匹配上的那些会漏掉一件要紧的事:一个人取了 5 次、
   * 第 5 次终于进去了,前 4 条仍然「没匹配上」——
   * 队列上就会写着「取了 4 次码」,而他早就登录进去了。
   *
   * 作废的另算:它仍然 matchedAt 为空、仍在 24 小时内,
   * 光看这两条的话点了「作废」之后那一行还留在原地,
   * 人会以为按钮没生效,于是再点一次。
   */
  const rows = db
    .select()
    .from(bindCodes)
    .where(and(gt(bindCodes.createdAt, now - DAY_MS), ne(bindCodes.status, "revoked")))
    .orderBy(desc(bindCodes.createdAt))
    .all();

  const fresh = rows
    .filter((r) => isActionable(r.createdAt, now))
    .map((r) => ({
      id: r.id,
      code: r.code,
      issuedIp: r.issuedIp,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      matched: r.matchedAt != null,
    }));

  return groupStuck(fresh).map((s) => ({ ...s, expired: s.latestExpiresAt < now }));
}

/** 最近 24 小时通过了几个好友申请 —— 限速从审计日志算 */
export function recentAccepts(now = Date.now()): number[] {
  return db
    .select({ createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, FRIEND_ACCEPT_ACTION), gt(auditLogs.createdAt, now - DAY_MS)))
    .all()
    .map((r) => r.createdAt);
}

export function currentAcceptBudget(now = Date.now()): AcceptBudget {
  return acceptBudget(recentAccepts(now), now);
}

/** 这个微信号是不是已经绑到某个账号上了 */
export function boundAccountOf(wxId: string): string | null {
  const row = db.select().from(users).where(eq(users.wxId, wxId)).get();
  return row?.id ?? null;
}

/**
 * 队列上有多少件事等着处理 —— 后台首页的待办用。
 *
 * 直接数 stalledBinds()，不另写一条 count 查询:
 * 两条查询迟早会对不上，而对不上的表现是**待办上写着 12、点进去只有 3 条**,
 * 那时候人不会怀疑数字，只会觉得这一页坏了。
 */
export function bindQueueSize(): number {
  return stalledBinds().length;
}
