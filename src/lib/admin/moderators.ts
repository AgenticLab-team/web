import "server-only";

import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { roles, userRoles, users } from "@/lib/db/schema";
import { resolveDisplayName } from "@/lib/users/display-name";

/**
 * 版主任免。
 *
 * 版主权限是**限定版块**的，且支持到期自动回收 ——
 * 「临时帮忙看两周」是最常见的情形，而不设到期的话，
 * 一年后没人记得当初为什么给了这个人权限，也没人好意思去收。
 *
 * 所以列表里到期时间要显眼：快到期的提前提醒，
 * 已过期的仍然列出来（灰掉），让人看得见「这个人的权限已经没了」，
 * 而不是悄悄消失 —— 悄悄消失会让人以为系统弄丢了配置。
 */

export interface BoardModerator {
  userRoleId: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  grantedAt: number;
  grantedBy: string | null;
  grantReason: string | null;
  expiresAt: number | null;
  /** 已经过期 */
  expired: boolean;
  /** 七天内到期 */
  expiringSoon: boolean;
}

const SOON_MS = 7 * 86_400_000;

export function moderatorsOf(boardId: string, now = Date.now()): BoardModerator[] {
  const role = db.select().from(roles).where(eq(roles.key, "moderator")).get();
  if (!role) return [];

  return db
    .select({
      ur: userRoles,
      site: users.siteNickname,
      wx: users.wxNickname,
      wxId: users.wxId,
      avatar: users.wxAvatarUrl,
    })
    .from(userRoles)
    .leftJoin(users, eq(users.id, userRoles.userId))
    .where(
      and(
        eq(userRoles.roleId, role.id),
        eq(userRoles.scopeType, "board"),
        eq(userRoles.scopeId, boardId),
        isNull(userRoles.revokedAt),
      ),
    )
    .orderBy(desc(userRoles.grantedAt))
    .all()
    .map(({ ur, site, wx, wxId, avatar }) => {
      const expired = ur.expiresAt !== null && ur.expiresAt <= now;
      return {
        userRoleId: ur.id,
        userId: ur.userId,
        name: resolveDisplayName([site, wx], { wxId, fallback: "社区成员" }),
        avatarUrl: avatar,
        grantedAt: ur.grantedAt,
        grantedBy: ur.grantedBy,
        grantReason: ur.grantReason,
        expiresAt: ur.expiresAt,
        expired,
        expiringSoon: !expired && ur.expiresAt !== null && ur.expiresAt - now < SOON_MS,
      };
    });
}

/** 全站的版主任命概览，用于「谁在管哪个版块」 */
export function allBoardModerators(now = Date.now()) {
  const role = db.select().from(roles).where(eq(roles.key, "moderator")).get();
  if (!role) return [];

  return db
    .select({
      scopeId: userRoles.scopeId,
      userId: userRoles.userId,
      expiresAt: userRoles.expiresAt,
    })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.roleId, role.id),
        eq(userRoles.scopeType, "board"),
        isNull(userRoles.revokedAt),
        // 过期的不算「在任」
        or(isNull(userRoles.expiresAt), gt(userRoles.expiresAt, now)),
      ),
    )
    .all();
}

/**
 * 可任命的候选人。
 *
 * 只列**已经在用这个站的人**（登录过），而不是全部一千六百个群成员 ——
 * 从没打开过网站的人当版主，等于没有版主。
 */
export function moderatorCandidates(boardId: string, limit = 60) {
  const existing = new Set(moderatorsOf(boardId).map((m) => m.userId));

  return db
    .select({
      id: users.id,
      site: users.siteNickname,
      wx: users.wxNickname,
      wxId: users.wxId,
      lastActiveAt: users.lastActiveAt,
    })
    .from(users)
    .where(and(isNull(users.deletedAt), eq(users.status, "active"), sql`${users.lastActiveAt} is not null`))
    .orderBy(desc(users.lastActiveAt))
    .limit(limit)
    .all()
    .filter((u) => !existing.has(u.id))
    .map((u) => ({
      id: u.id,
      name: resolveDisplayName([u.site, u.wx], { wxId: u.wxId, fallback: u.id }),
    }));
}
