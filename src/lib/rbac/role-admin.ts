import "server-only";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { rolePermissions, roles, userRoles } from "@/lib/db/schema";
import { dangerLevelOf } from "@/lib/rbac/permissions";

import { canAutoGrant, seatsLeft, SYSTEM_ACTOR, type HolderState } from "./role-rules";

/**
 * 身份组的读取层。
 *
 * ─────────────────────────────────────────
 * 「有多少人持有」是这一页最要紧的一个数
 * ─────────────────────────────────────────
 *
 * 它决定了三件事能不能做：删（有人持有就不能删）、
 * 降名额上限（降到现有人数以下只是不再发新的）、
 * 以及自动结算这一轮还有没有位置。
 *
 * 而且必须是**有效持有** —— 撤销过的和过期的都不算。
 * 按 user_roles 直接数行数会把撤销记录也算进去，
 * 于是一个撤干净的组永远删不掉。
 */

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  priority: number;
  isSystem: boolean;
  assignable: boolean;
  maxHolders: number | null;
  autoGrantRule: unknown;
  autoRevoke: boolean;
  /** 有效持有人数（撤销过的、过期的都不算） */
  holders: number;
  /** 其中自动发出去的 */
  autoHolders: number;
  seatsLeft: number | null;
  /** 这个组挂着的最高危险等级 —— 决定它能不能配自动授予 */
  maxDangerLevel: number;
  /** 能不能配自动授予，以及不能的话为什么 */
  autoGrantAllowed: boolean;
  autoGrantBlockedReason?: string;
}

/** 有效持有：没撤销、没过期 */
function activeHolderCondition(now: number) {
  return and(
    isNull(userRoles.revokedAt),
    sql`(${userRoles.expiresAt} IS NULL OR ${userRoles.expiresAt} > ${now})`,
  );
}

export function listRoles(now = Date.now()): RoleRow[] {
  const rows = db.select().from(roles).where(isNull(roles.deletedAt)).orderBy(desc(roles.priority)).all();

  const counts = new Map<string, { total: number; auto: number }>();
  for (const h of db
    .select({ roleId: userRoles.roleId, grantedBy: userRoles.grantedBy })
    .from(userRoles)
    .where(activeHolderCondition(now))
    .all()) {
    const entry = counts.get(h.roleId) ?? { total: 0, auto: 0 };
    entry.total++;
    if (h.grantedBy === SYSTEM_ACTOR) entry.auto++;
    counts.set(h.roleId, entry);
  }

  // 每个组挂着的权限点 —— 用来算最高危险等级
  const perms = new Map<string, string[]>();
  for (const rp of db
    .select({ roleId: rolePermissions.roleId, key: rolePermissions.permissionKey, granted: rolePermissions.granted })
    .from(rolePermissions)
    .all()) {
    if (!rp.granted) continue;
    const list = perms.get(rp.roleId) ?? [];
    list.push(rp.key);
    perms.set(rp.roleId, list);
  }

  return rows.map((r) => {
    const count = counts.get(r.id) ?? { total: 0, auto: 0 };
    const maxDangerLevel = (perms.get(r.id) ?? []).reduce(
      (max, key) => Math.max(max, dangerLevelOf(key)),
      0,
    );
    const allowed = canAutoGrant({ isSystem: r.isSystem, maxDangerLevel });

    return {
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      color: r.color,
      icon: r.icon,
      priority: r.priority,
      isSystem: r.isSystem,
      assignable: r.assignable,
      maxHolders: r.maxHolders,
      autoGrantRule: r.autoGrantRule,
      autoRevoke: r.autoRevoke,
      holders: count.total,
      autoHolders: count.auto,
      seatsLeft: seatsLeft(r.maxHolders, count.total),
      maxDangerLevel,
      autoGrantAllowed: allowed.ok,
      autoGrantBlockedReason: allowed.ok ? undefined : allowed.error,
    };
  });
}

export function roleByKey(key: string) {
  return db.select().from(roles).where(and(eq(roles.key, key), isNull(roles.deletedAt))).get() ?? null;
}

export function holdersOf(roleId: string, now = Date.now()): HolderState[] {
  return db
    .select({ userId: userRoles.userId, grantedBy: userRoles.grantedBy })
    .from(userRoles)
    .where(and(eq(userRoles.roleId, roleId), activeHolderCondition(now)))
    .all()
    .map((h) => ({ userId: h.userId, auto: h.grantedBy === SYSTEM_ACTOR }));
}

export function holderCount(roleId: string, now = Date.now()): number {
  return holdersOf(roleId, now).length;
}
