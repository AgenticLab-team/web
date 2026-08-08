import "server-only";

import { and, desc, eq, gt, isNull, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { permissionOverrides, rolePermissions, roles, userRoles, users } from "@/lib/db/schema";
import { PERMISSIONS, type PermissionDef, type PermissionKey } from "@/lib/rbac/permissions";

/**
 * 权限矩阵与反查。
 *
 * 权限系统最大的问题不是设计不出来，是**管理员看不懂自己配了什么**。
 * 所以这里有两个功能是刻意做的：
 *
 *   矩阵  —— 行=身份组、列=权限点，三态一眼看全，改前能看到 diff
 *   反查  —— 「谁能封人」「谁能改积分」，选一个权限点列出所有持有者及来源
 *
 * 定期回顾「谁有什么权限」是最基本的治理动作。没有反查就只能靠记忆。
 */

export type MatrixState = "granted" | "denied" | "none";

export interface MatrixRole {
  id: string;
  key: string;
  name: string;
  color: string | null;
  priority: number;
  isSystem: boolean;
  holders: number;
}

export interface MatrixCategory {
  category: string;
  permissions: PermissionDef[];
}

export interface PermissionMatrix {
  roles: MatrixRole[];
  categories: MatrixCategory[];
  /** roleId -> permissionKey -> 状态 */
  cells: Map<string, Map<string, MatrixState>>;
}

const CATEGORY_LABELS: Record<string, string> = {
  forum: "论坛",
  group: "群与消息",
  user: "用户",
  role: "身份组",
  points: "积分",
  moderation: "审核",
  activity: "活动",
  module: "模块",
  shop: "商店",
  broadcast: "公告推送",
  system: "系统",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

export function buildMatrix(): PermissionMatrix {
  const roleRows = db
    .select()
    .from(roles)
    .where(isNull(roles.deletedAt))
    .orderBy(desc(roles.priority))
    .all();

  const holderCounts = new Map<string, number>();
  for (const row of db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(isNull(userRoles.revokedAt))
    .all()) {
    holderCounts.set(row.roleId, (holderCounts.get(row.roleId) ?? 0) + 1);
  }

  const cells = new Map<string, Map<string, MatrixState>>();
  for (const role of roleRows) cells.set(role.id, new Map());

  for (const row of db.select().from(rolePermissions).all()) {
    cells.get(row.roleId)?.set(row.permissionKey, row.granted ? "granted" : "denied");
  }

  const byCategory = new Map<string, PermissionDef[]>();
  for (const permission of PERMISSIONS) {
    const list = byCategory.get(permission.category) ?? [];
    list.push(permission as PermissionDef);
    byCategory.set(permission.category, list);
  }

  return {
    roles: roleRows.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      color: role.color,
      priority: role.priority,
      isSystem: role.isSystem,
      holders: holderCounts.get(role.id) ?? 0,
    })),
    categories: [...byCategory.entries()].map(([category, permissions]) => ({
      category,
      permissions,
    })),
    cells,
  };
}

export interface PermissionHolder {
  userId: string;
  name: string;
  /** 来自哪个身份组，或用户级例外 */
  source: string;
  scope: string | null;
  expiresAt: number | null;
  grantedBy: string | null;
  grantedAt: number;
}

/**
 * 权限反查：谁拥有这个权限点。
 *
 * 要同时算上三个来源：身份组授予、用户级例外、以及**显式拒绝**。
 * 只查前两个的话，会把被显式拒绝的人也列出来 ——
 * 而那正是最需要看清楚的一类。
 */
export function whoHasPermission(permission: PermissionKey): PermissionHolder[] {
  const grantingRoles = db
    .select({ roleId: rolePermissions.roleId, key: roles.key, name: roles.name })
    .from(rolePermissions)
    .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
    .where(and(eq(rolePermissions.permissionKey, permission), eq(rolePermissions.granted, true)))
    .all();

  const denyingRoleIds = new Set(
    db
      .select({ roleId: rolePermissions.roleId })
      .from(rolePermissions)
      .where(and(eq(rolePermissions.permissionKey, permission), eq(rolePermissions.granted, false)))
      .all()
      .map((r) => r.roleId),
  );

  const holders = new Map<string, PermissionHolder>();

  for (const role of grantingRoles) {
    const grants = db
      .select({
        userId: userRoles.userId,
        scopeId: userRoles.scopeId,
        expiresAt: userRoles.expiresAt,
        grantedBy: userRoles.grantedBy,
        grantedAt: userRoles.grantedAt,
        siteName: users.siteNickname,
        wxName: users.wxNickname,
      })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(
        and(
          eq(userRoles.roleId, role.roleId),
          isNull(userRoles.revokedAt),
          or(isNull(userRoles.expiresAt), gt(userRoles.expiresAt, Date.now())),
        ),
      )
      .all();

    for (const grant of grants) {
      // 已经从更高优先级的来源拿到了就不重复列
      if (holders.has(grant.userId)) continue;
      holders.set(grant.userId, {
        userId: grant.userId,
        name: grant.siteName ?? grant.wxName ?? grant.userId,
        source: `身份组「${role.name}」`,
        scope: grant.scopeId,
        expiresAt: grant.expiresAt,
        grantedBy: grant.grantedBy,
        grantedAt: grant.grantedAt,
      });
    }
  }

  // 用户级例外优先级最高，会覆盖身份组的结论
  for (const override of db
    .select({
      userId: permissionOverrides.userId,
      granted: permissionOverrides.granted,
      reason: permissionOverrides.reason,
      grantedBy: permissionOverrides.grantedBy,
      grantedAt: permissionOverrides.grantedAt,
      expiresAt: permissionOverrides.expiresAt,
      siteName: users.siteNickname,
      wxName: users.wxNickname,
    })
    .from(permissionOverrides)
    .innerJoin(users, eq(users.id, permissionOverrides.userId))
    .where(
      and(eq(permissionOverrides.permissionKey, permission), isNull(permissionOverrides.revokedAt)),
    )
    .all()) {
    if (!override.granted) {
      holders.delete(override.userId);
      continue;
    }
    holders.set(override.userId, {
      userId: override.userId,
      name: override.siteName ?? override.wxName ?? override.userId,
      source: `用户级例外：${override.reason}`,
      scope: null,
      expiresAt: override.expiresAt,
      grantedBy: override.grantedBy,
      grantedAt: override.grantedAt,
    });
  }

  // 被身份组显式拒绝的人要剔除
  for (const roleId of denyingRoleIds) {
    for (const grant of db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.roleId, roleId), isNull(userRoles.revokedAt)))
      .all()) {
      const existing = holders.get(grant.userId);
      // 用户级例外压过身份组的拒绝，其余情况剔除
      if (existing && !existing.source.startsWith("用户级例外")) {
        holders.delete(grant.userId);
      }
    }
  }

  return [...holders.values()].sort((a, b) => b.grantedAt - a.grantedAt);
}

/** 某个身份组的权限变更会影响多少人 —— 保存前给出影响面 */
export function roleHolderCount(roleId: string): number {
  return db
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(and(eq(userRoles.roleId, roleId), isNull(userRoles.revokedAt)))
    .all().length;
}
