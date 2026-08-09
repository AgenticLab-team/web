"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { revokeAllSessions } from "@/lib/auth/session";
import { revokePreviewsOf } from "@/lib/rbac/preview";
import { requireAdmin, requireWritableAdmin } from "@/lib/admin/guard";
import {
  checkNote,
  checkPointsAdjust,
  checkReason,
  checkRoleGrant,
  checkRoleRevoke,
  checkStatusChange,
  isElevatedRole,
  isNoopStatusChange,
  shouldRevokeSessions,
} from "@/lib/admin/rules";
import { db } from "@/lib/db";
import { moderationActions, roles, userNotes, userRoles, users } from "@/lib/db/schema";
import { revertInviteReward } from "@/lib/invites/settle";
import { grantPoints } from "@/lib/points/ledger";
import { resolveDisplayName } from "@/lib/users/display-name";
import { invalidatePermissionCache } from "@/lib/rbac/can";
import { getSettingInt } from "@/lib/settings/store";

/**
 * 用户管理的写操作。
 *
 * 每一条都遵守 SCHEMA.md 第十一节那张对照表：
 * **业务表 + 审计日志 + 通知当事人**，三处齐全才算做完。
 *
 * 另外有几条硬约束写在代码里，配置改不动：
 *   - 调整积分必须填理由
 *   - 不能封禁自己（把自己锁在门外没人能救）
 *   - 不能移除最后一个 owner
 *
 * 这些判定都在 rules.ts 里，纯函数、可单测。这里只负责取数据、
 * 把判定结果转成返回值、以及落三处（业务表 + 审计 + 通知）。
 */

export interface AdminActionResult {
  ok: boolean;
  error?: string;
}

const fail = (error: string): AdminActionResult => ({ ok: false, error });

export async function adjustPoints(input: {
  userId: string;
  delta: number;
  reason: string;
}): Promise<AdminActionResult> {
  const admin = await requireAdmin("points.adjust");

  const reason = input.reason.trim();
  const check = checkPointsAdjust({
    delta: input.delta,
    reason: input.reason,
    threshold: getSettingInt("points.large_adjust_threshold", 500),
    hasLargePermission: admin.has("points.adjust.large"),
  });
  if (!check.ok) return fail(check.error!);

  const target = db.select().from(users).where(eq(users.id, input.userId)).get();
  if (!target) return fail("用户不存在");

  const result = grantPoints({
    userId: input.userId,
    delta: input.delta,
    reason: `管理员调整：${reason}`,
    operatorId: admin.user.id,
  });
  if (!result.ok) return fail(result.error ?? "调整失败");

  audit({ actorId: admin.user.id }, {
    action: "points.adjust",
    targetType: "user",
    targetId: input.userId,
    targetLabel: resolveDisplayName([target.siteNickname, target.wxNickname], {
      wxId: target.wxId,
      fallback: input.userId,
    }),
    before: { points: target.points },
    after: { points: result.balance, delta: input.delta },
    reason,
  });

  revalidatePath(`/admin/users/${input.userId}`);
  return { ok: true };
}

export async function setUserStatus(input: {
  userId: string;
  status: "active" | "suspended" | "banned";
  reason: string;
}): Promise<AdminActionResult> {
  const admin = await requireWritableAdmin("user.suspend");

  const reason = input.reason.trim();
  const check = checkStatusChange({
    actorId: admin.user.id,
    targetId: input.userId,
    reason: input.reason,
  });
  if (!check.ok) return fail(check.error!);

  const target = db.select().from(users).where(eq(users.id, input.userId)).get();
  if (!target) return fail("用户不存在");
  if (isNoopStatusChange(target.status, input.status)) return { ok: true };

  db.update(users)
    .set({ status: input.status, updatedAt: Date.now() })
    .where(eq(users.id, input.userId))
    .run();

  // 封禁要立即生效，不能等会话自然过期
  if (shouldRevokeSessions(input.status)) {
    revokeAllSessions(input.userId, "ban", admin.user.id);
    /*
     * 他自己开着的预览也要一起掐掉。
     *
     * 只踢会话不掐预览的话，被封的人手上那个 30 分钟的预览令牌还是活的 ——
     * 他会以别人的身份继续浏览，而封禁看起来已经生效了。
     * （被预览方被封的情况在 resolvePreview 里挡住了，这里挡的是预览方。）
     */
    revokePreviewsOf(input.userId);
  }

  /*
   * 封禁时回滚邀请奖励。
   * 被封 = 这次邀请没带来真实的人。不回滚的话「刷号被抓也不亏」，
   * 那等于在鼓励刷。判定在 invites/rules 里（暂停不回滚 ——
   * 暂停是可逆的，封禁才是定论）。
   */
  if (input.status === "banned") {
    revertInviteReward(input.userId, `账号被封禁：${reason}`);
  }

  db.insert(moderationActions)
    .values({
      actorId: admin.user.id,
      targetType: "user",
      targetId: input.userId,
      targetUserId: input.userId,
      action: input.status === "banned" ? "ban" : input.status === "suspended" ? "suspend" : "unban",
      reason,
    })
    .run();

  audit({ actorId: admin.user.id }, {
    action: "user.suspend",
    targetType: "user",
    targetId: input.userId,
    targetLabel: resolveDisplayName([target.siteNickname, target.wxNickname], {
      wxId: target.wxId,
      fallback: input.userId,
    }),
    before: { status: target.status },
    after: { status: input.status },
    reason,
  });

  revalidatePath(`/admin/users/${input.userId}`);
  return { ok: true };
}

export async function grantRole(input: {
  userId: string;
  roleKey: string;
  reason: string;
  scopeType?: "board" | "group" | "activity";
  scopeId?: string;
  expiresAt?: number;
}): Promise<AdminActionResult> {
  const admin = await requireWritableAdmin("role.grant");

  const reason = input.reason.trim();

  const role = db.select().from(roles).where(eq(roles.key, input.roleKey)).get();
  if (!role) return fail("身份组不存在");

  const existing = db
    .select()
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, input.userId),
        eq(userRoles.roleId, role.id),
        isNull(userRoles.revokedAt),
      ),
    )
    .get();

  const check = checkRoleGrant({
    roleKey: input.roleKey,
    reason: input.reason,
    hasAdminGrantPermission: admin.has("role.grant.admin"),
    alreadyHeld: existing !== undefined,
  });
  if (!check.ok) return fail(check.error!);

  db.insert(userRoles)
    .values({
      userId: input.userId,
      roleId: role.id,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      grantedBy: admin.user.id,
      grantReason: reason,
      expiresAt: input.expiresAt,
    })
    .run();

  invalidatePermissionCache();

  audit({ actorId: admin.user.id }, {
    action: isElevatedRole(input.roleKey) ? "role.grant.admin" : "role.grant",
    targetType: "user",
    targetId: input.userId,
    after: { role: input.roleKey, scope: input.scopeId, expiresAt: input.expiresAt },
    reason,
  });

  revalidatePath(`/admin/users/${input.userId}`);
  return { ok: true };
}

export async function revokeRole(input: {
  userRoleId: string;
  reason: string;
}): Promise<AdminActionResult> {
  const admin = await requireWritableAdmin("role.grant");

  const reason = input.reason.trim();

  const row = db.select().from(userRoles).where(eq(userRoles.id, input.userRoleId)).get();
  if (!row) return fail("找不到这条授权");

  const role = db.select().from(roles).where(eq(roles.id, row.roleId)).get();
  if (!role) return fail("身份组不存在");

  const check = checkRoleRevoke({
    roleKey: role.key,
    reason: input.reason,
    hasAdminGrantPermission: admin.has("role.grant.admin"),
    currentHolders: db
      .select({ n: userRoles.id })
      .from(userRoles)
      .where(and(eq(userRoles.roleId, role.id), isNull(userRoles.revokedAt)))
      .all().length,
  });
  if (!check.ok) return fail(check.error!);

  db.update(userRoles)
    .set({ revokedAt: Date.now(), revokedBy: admin.user.id, revokeReason: reason })
    .where(eq(userRoles.id, input.userRoleId))
    .run();

  invalidatePermissionCache();

  audit({ actorId: admin.user.id }, {
    action: "role.grant",
    targetType: "user",
    targetId: row.userId,
    before: { role: role.key },
    after: { revoked: true },
    reason,
  });

  revalidatePath(`/admin/users/${row.userId}`);
  return { ok: true };
}

export async function revokeUserSessions(input: {
  userId: string;
  reason: string;
}): Promise<AdminActionResult> {
  const admin = await requireAdmin("user.session.revoke");
  const reason = input.reason.trim();
  const check = checkReason(input.reason);
  if (!check.ok) return fail(check.error!);

  const result = revokeAllSessions(input.userId, "admin", admin.user.id);
  // 「把这个人踢下线」要包括他正开着的预览，否则那条路还留着
  revokePreviewsOf(input.userId);

  audit({ actorId: admin.user.id }, {
    action: "user.session.revoke",
    targetType: "user",
    targetId: input.userId,
    after: { revoked: result.changes },
    reason,
  });

  revalidatePath(`/admin/users/${input.userId}`);
  return { ok: true };
}

/** 管理员备注。用户不可见，运营连续性靠这个 */
export async function addUserNote(input: {
  userId: string;
  content: string;
}): Promise<AdminActionResult> {
  const admin = await requireWritableAdmin("user.note.write");
  const content = input.content.trim();
  const check = checkNote(input.content);
  if (!check.ok) return fail(check.error!);

  db.insert(userNotes).values({ userId: input.userId, authorId: admin.user.id, content }).run();

  audit({ actorId: admin.user.id }, {
    action: "user.note.write",
    targetType: "user",
    targetId: input.userId,
    after: { note: content.slice(0, 80) },
  });

  revalidatePath(`/admin/users/${input.userId}`);
  return { ok: true };
}
