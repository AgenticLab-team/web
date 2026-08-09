import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { audit } from "@/lib/audit";
import { db, sqlite } from "@/lib/db";
import { rolePermissions, roles, userRoles, users } from "@/lib/db/schema";
import { resolveDisplayName } from "@/lib/users/display-name";

import { effectivePermissions, invalidatePermissionCache } from "./can";
import {
  KEYSTONE_PERMISSION,
  type CellChange,
  type MatrixDiff,
  type MatrixImpact,
  type MatrixState,
  summarizeImpact,
} from "./matrix-edit";

/**
 * 矩阵改动的落库与预演。
 *
 * ─────────────────────────────────────────
 * 预演的办法:真改一遍,量完,回滚
 * ─────────────────────────────────────────
 *
 * 「这次改动影响几个人」要算准,就得知道每个人**改动之后**的有效权限。
 * 而有效权限的判定链（用户级例外 → 角色显式拒绝 → scope 匹配 → 兜底拒绝）
 * 在 can.ts 里,有一百多行。
 *
 * 在预览里把那套逻辑再写一遍,是这类功能最常见的死法:
 * 两份实现会慢慢分叉,而分叉的表现是**预览说没事、保存之后出事** ——
 * 那比没有预览更糟,因为人已经信了它。
 *
 * 所以不重写。在一个事务里真的把改动写进去,调**同一个** can.ts 量一遍,
 * 然后回滚。预览和现实之间没有第二份实现,因为预览就是现实,只是短暂的。
 *
 * better-sqlite3 是同步的,Node 是单线程的 —— 这段事务执行期间
 * 没有别的请求能插进来看到中间状态。
 */

export interface MatrixEditContext {
  roleName: (roleId: string) => string;
  rolePriority: Map<string, number>;
}

/** 当前矩阵里这一格是什么 */
export function currentCells(): Map<string, Map<string, MatrixState>> {
  const out = new Map<string, Map<string, MatrixState>>();
  for (const row of db.select().from(rolePermissions).all()) {
    if (!out.has(row.roleId)) out.set(row.roleId, new Map());
    out.get(row.roleId)!.set(row.permissionKey, row.granted ? "granted" : "denied");
  }
  return out;
}

/** 会被这次改动波及的人:被改到的那些身份组的持有者 */
function affectedUserIds(changes: CellChange[]): string[] {
  const roleIds = [...new Set(changes.map((c) => c.roleId))];
  if (roleIds.length === 0) return [];

  return [
    ...new Set(
      db
        .select({ userId: userRoles.userId })
        .from(userRoles)
        .where(and(inArray(userRoles.roleId, roleIds), isNull(userRoles.revokedAt)))
        .all()
        .map((r) => r.userId),
    ),
  ];
}

function snapshot(userIds: string[]): Map<string, Set<string>> {
  invalidatePermissionCache();
  const out = new Map<string, Set<string>>();
  for (const id of userIds) {
    const user = db.select().from(users).where(eq(users.id, id)).get();
    if (!user) continue;
    out.set(id, new Set(effectivePermissions(user).keys()));
  }
  return out;
}

/** 把一串格子的改动写进 rolePermissions */
function writeCells(changes: CellChange[]) {
  for (const change of changes) {
    db.delete(rolePermissions)
      .where(
        and(
          eq(rolePermissions.roleId, change.roleId),
          eq(rolePermissions.permissionKey, change.permissionKey),
        ),
      )
      .run();

    // none 就是「这一行不存在」,不是「存一行 false」—— false 是显式拒绝
    if (change.to === "none") continue;

    db.insert(rolePermissions)
      .values({
        roleId: change.roleId,
        permissionKey: change.permissionKey,
        granted: change.to === "granted",
      })
      .run();
  }
  invalidatePermissionCache();
}

/**
 * 预演一次改动:真写、真量、真回滚。
 *
 * **回滚靠抛异常**,不靠「记得写 ROLLBACK」——
 * 中间任何一步出错都必须回滚,而 return 前的手动回滚会在
 * 抛异常的那条路上被跳过,把半个改动留在库里。
 */
export function previewMatrixChange(changes: CellChange[]): MatrixDiff {
  const userIds = affectedUserIds(changes);
  const before = snapshot(userIds);

  let after = new Map<string, Set<string>>();
  const ROLLBACK = "__preview_rollback__";
  try {
    sqlite.transaction(() => {
      writeCells(changes);
      after = snapshot(userIds);
      throw new Error(ROLLBACK);
    })();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) {
      invalidatePermissionCache();
      throw error;
    }
  }
  // 事务回滚了,但缓存里还是改动之后的样子
  invalidatePermissionCache();

  const nameOf = (id: string) => {
    const u = db.select().from(users).where(eq(users.id, id)).get();
    return u ? resolveDisplayName([u.siteNickname, u.wxNickname], { wxId: u.wxId }) : id;
  };

  const impact: MatrixImpact = { gained: [], lost: [] };
  for (const id of userIds) {
    const had = before.get(id) ?? new Set();
    const has = after.get(id) ?? new Set();

    const gained = [...has].filter((p) => !had.has(p)).sort();
    const lost = [...had].filter((p) => !has.has(p)).sort();

    if (gained.length > 0) impact.gained.push({ userId: id, name: nameOf(id), permissions: gained });
    if (lost.length > 0) impact.lost.push({ userId: id, name: nameOf(id), permissions: lost });
  }

  return { changes, impact, summary: summarizeImpact(impact) };
}

/**
 * 改完之后还有几个活跃的人能改矩阵。
 *
 * 同样用「改一遍再回滚」量 —— 靠推理算这个数太容易算错,
 * 而算错的后果是把所有人锁在门外。
 */
export function keystoneHoldersAfter(changes: CellChange[]): number {
  let count = 0;
  const ROLLBACK = "__keystone_rollback__";
  try {
    sqlite.transaction(() => {
      writeCells(changes);
      count = countKeystoneHolders();
      throw new Error(ROLLBACK);
    })();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) {
      invalidatePermissionCache();
      throw error;
    }
  }
  invalidatePermissionCache();
  return count;
}

function countKeystoneHolders(): number {
  invalidatePermissionCache();
  let n = 0;
  for (const user of db.select().from(users).where(eq(users.status, "active")).all()) {
    if (effectivePermissions(user).has(KEYSTONE_PERMISSION)) n++;
  }
  return n;
}

/**
 * 真的落库。
 *
 * 整串改动在**一个事务**里 —— 一半生效的权限矩阵是最糟的状态:
 * 它既不是改之前也不是改之后,而没有人知道它是什么。
 */
export function applyMatrixChange(
  changes: CellChange[],
  actorId: string,
  reason: string,
  impact: MatrixImpact,
): void {
  sqlite.transaction(() => {
    writeCells(changes);

    /*
     * 一次改动一条审计,不是一格一条。
     *
     * 一格一条的话,一次改了三十格就会在日志里刷出三十行,
     * 而事后要回答的问题是「那次改动做了什么」,不是「第 17 格变成了什么」。
     * 完整的格子清单在 after 里,查得到。
     */
    audit(
      { actorId },
      {
        action: "rbac.matrix.edit",
        targetType: "role",
        targetId: [...new Set(changes.map((c) => c.roleId))].join(","),
        before: changes.map((c) => `${c.roleName}/${c.permissionKey}=${c.from}`),
        after: changes.map((c) => `${c.roleName}/${c.permissionKey}=${c.to}`),
        reason: `${reason}｜${summarizeImpact(impact)}`,
      },
    );
  })();

  invalidatePermissionCache();
}

/** 操作者手上优先级最高的身份组 */
export function actorPriority(userId: string): number {
  const held = db
    .select({ priority: roles.priority })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, userId), isNull(userRoles.revokedAt)))
    .all();

  return held.reduce((max, r) => Math.max(max, r.priority ?? 0), 0);
}

export function rolePriorities(): Map<string, number> {
  return new Map(db.select().from(roles).all().map((r) => [r.id, r.priority ?? 0]));
}
