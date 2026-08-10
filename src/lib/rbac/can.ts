import "server-only";

import { and, eq, gt, isNull, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { permissionOverrides, rolePermissions, roles, userRoles, users } from "@/lib/db/schema";

import { type PermissionKey } from "./permissions";

/**
 * 全站唯一的权限判定入口。
 *
 * 任何地方都不许自己写 `if (role === "admin")` —— 一律调这个函数。
 * 判定链**先拒后允**，兜底是拒绝：新功能忘了配权限的结果是「没人能用」
 * 而不是「所有人都能用」，这个方向的错误才是安全的。
 */

export type Actor = typeof users.$inferSelect | null;

export interface ResourceContext {
  /** 资源归属，用于 scope 匹配 */
  scopeType?: "board" | "group" | "activity";
  scopeId?: string;
  /** 资源所有者，用于 *.own 类权限 */
  ownerId?: string;
  /** 已软删除的资源，非管理员一律看不到 */
  deleted?: boolean;
}

export interface Decision {
  allowed: boolean;
  /** 拒绝原因要能直接给用户看，也要能进审计日志 */
  reason: string;
}

const ALLOW = (reason: string): Decision => ({ allowed: true, reason });
const DENY = (reason: string): Decision => ({ allowed: false, reason });

// 角色→权限映射变动不频繁，缓存住；后台改权限时清缓存
let rolePermCache: Map<string, Map<string, boolean>> | null = null;

export function invalidatePermissionCache() {
  rolePermCache = null;
}

function loadRolePermissions(): Map<string, Map<string, boolean>> {
  if (rolePermCache) return rolePermCache;
  const rows = db
    .select({
      roleKey: roles.key,
      roleId: roles.id,
      permissionKey: rolePermissions.permissionKey,
      granted: rolePermissions.granted,
    })
    .from(rolePermissions)
    .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
    .all();

  const map = new Map<string, Map<string, boolean>>();
  for (const row of rows) {
    if (!map.has(row.roleId)) map.set(row.roleId, new Map());
    map.get(row.roleId)!.set(row.permissionKey, row.granted);
  }
  rolePermCache = map;
  return map;
}

interface EffectiveRole {
  roleId: string;
  roleKey: string;
  scopeType: string | null;
  scopeId: string | null;
}

/**
 * 一个人实际持有的身份组。
 *
 * 除了显式授予的，还要补上由账号类型推导出的隐式身份：
 * 未登录是 guest，已绑定成员是 member，外部用户是 external。
 * 否则新绑定的用户什么都做不了 —— 没人给他显式授予过 member。
 */
function effectiveRoles(actor: Actor): EffectiveRole[] {
  const roleByKey = new Map(
    db.select({ id: roles.id, key: roles.key }).from(roles).all().map((r) => [r.key, r.id]),
  );

  const implicit: EffectiveRole[] = [];
  const addImplicit = (key: string) => {
    const id = roleByKey.get(key);
    if (id) implicit.push({ roleId: id, roleKey: key, scopeType: null, scopeId: null });
  };

  if (!actor) {
    addImplicit("guest");
    return implicit;
  }
  if (actor.status === "banned" || actor.status === "deleted") {
    addImplicit("banned");
    return implicit;
  }
  addImplicit(actor.kind === "external" ? "external" : "member");

  const granted = db
    .select({
      roleId: userRoles.roleId,
      roleKey: roles.key,
      scopeType: userRoles.scopeType,
      scopeId: userRoles.scopeId,
    })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(
      and(
        eq(userRoles.userId, actor.id),
        isNull(userRoles.revokedAt),
        or(isNull(userRoles.expiresAt), gt(userRoles.expiresAt, Date.now())),
        isNull(roles.deletedAt),
      ),
    )
    .all();

  return [...implicit, ...granted];
}

/** scope 为空表示全站通用；否则必须与资源归属完全一致 */
function scopeMatches(role: EffectiveRole, resource?: ResourceContext): boolean {
  if (!role.scopeType || !role.scopeId) return true;
  if (!resource?.scopeType || !resource.scopeId) return false;
  return role.scopeType === resource.scopeType && role.scopeId === resource.scopeId;
}

export function can(
  actor: Actor,
  permission: PermissionKey,
  resource?: ResourceContext,
): Decision {
  // 1. 封禁与失效账号，一切免谈
  if (actor && (actor.status === "banned" || actor.status === "deleted")) {
    return DENY("账号已被封禁");
  }
  if (actor && actor.status === "suspended") {
    return DENY("账号已被暂停");
  }

  const roleList = effectiveRoles(actor);
  const permsByRole = loadRolePermissions();

  // 2. 用户级例外的显式拒绝，优先级最高
  if (actor) {
    const overrides = db
      .select()
      .from(permissionOverrides)
      .where(
        and(
          eq(permissionOverrides.userId, actor.id),
          eq(permissionOverrides.permissionKey, permission),
          isNull(permissionOverrides.revokedAt),
          or(
            isNull(permissionOverrides.expiresAt),
            gt(permissionOverrides.expiresAt, Date.now()),
          ),
        ),
      )
      .all();

    const denied = overrides.find((o) => !o.granted);
    if (denied) return DENY(`被单独禁止：${denied.reason}`);

    const allowedOverride = overrides.find((o) => o.granted);
    if (allowedOverride) return ALLOW(`用户级授权：${allowedOverride.reason}`);
  }

  // 3. 角色里的显式拒绝，压过任何允许
  for (const role of roleList) {
    if (permsByRole.get(role.roleId)?.get(permission) === false) {
      return DENY(`身份组「${role.roleKey}」明确禁止此操作`);
    }
  }

  // 4. 已删除资源只有能编辑任意内容的人看得到
  if (resource?.deleted && !hasAnyRole(roleList, permsByRole, "forum.post.delete.any")) {
    return DENY("资源已被删除");
  }

  // 5. 找一个 scope 匹配且授予了该权限的身份组
  for (const role of roleList) {
    if (permsByRole.get(role.roleId)?.get(permission) !== true) continue;
    if (!scopeMatches(role, resource)) continue;
    return ALLOW(`来自身份组「${role.roleKey}」`);
  }

  // 6. 兜底拒绝
  return DENY(
    actor ? "你的身份组没有此权限" : "请先登录",
  );
}

function hasAnyRole(
  roleList: EffectiveRole[],
  permsByRole: Map<string, Map<string, boolean>>,
  permission: string,
): boolean {
  return roleList.some((r) => permsByRole.get(r.roleId)?.get(permission) === true);
}

/** 抛错版本，用在 API 路由里 */
export class PermissionError extends Error {
  constructor(
    readonly permission: string,
    readonly decision: Decision,
  ) {
    super(decision.reason);
    this.name = "PermissionError";
  }
}

/** 一次性取出某人的全部有效权限，用于后台的「以某身份预览」与权限反查 */
export function effectivePermissions(actor: Actor): Map<string, string> {
  const roleList = effectiveRoles(actor);
  const permsByRole = loadRolePermissions();
  const result = new Map<string, string>();

  for (const role of roleList) {
    const perms = permsByRole.get(role.roleId);
    if (!perms) continue;
    for (const [key, granted] of perms) {
      if (!granted) {
        result.delete(key);
        continue;
      }
      if (!result.has(key)) {
        const scope = role.scopeId ? `@${role.scopeId}` : "";
        result.set(key, `${role.roleKey}${scope}`);
      }
    }
  }
  return result;
}
