"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { roles } from "@/lib/db/schema";

import { holderCount, listRoles } from "./role-admin";
import { canAutoGrant, canDelete, checkRole, type RoleDraft } from "./role-rules";

/**
 * 自定义身份组的增删改。
 *
 * ─────────────────────────────────────────
 * 自动授予要在**保存时**再判一次
 * ─────────────────────────────────────────
 *
 * 界面上按钮是禁着的，但界面不是授权。一个手拼的请求
 * 就能给带删帖权的组挂上「累计 10 分自动发」——
 * 而结算是每五分钟自动跑的，等有人发现时已经发出去了。
 *
 * 结算那一侧**也会再判一次**（settleAutoRoles）：
 * 保存时这个组可能还没有危险权限，而后来有人给它加了一个。
 */

export interface RoleResult {
  ok: boolean;
  error?: string;
  id?: string;
}

const fail = (error: string): RoleResult => ({ ok: false, error });

export async function createRole(draft: RoleDraft): Promise<RoleResult> {
  const admin = await requireWritableAdmin("role.manage");

  const existing = listRoles();
  const verdict = checkRole(draft, existing.map((r) => r.key));
  if (!verdict.ok) return fail(verdict.error);

  /*
   * 新建的组还没有任何权限，所以危险等级是 0 —— 这时候配自动授予
   * 是允许的。真正的把关在两处：改权限矩阵之后这里会重新算，
   * 而结算那一轮每次都重判。
   */
  if (draft.autoGrantRule != null) {
    const allowed = canAutoGrant({ isSystem: false, maxDangerLevel: 0 });
    if (!allowed.ok) return fail(allowed.error);
  }

  const row = db
    .insert(roles)
    .values({
      key: verdict.draft.key,
      name: verdict.draft.name,
      description: verdict.draft.description,
      color: verdict.draft.color ?? null,
      icon: verdict.draft.icon ?? null,
      priority: verdict.draft.priority,
      maxHolders: verdict.draft.maxHolders ?? null,
      autoGrantRule: verdict.draft.autoGrantRule ?? null,
      autoRevoke: Boolean(verdict.draft.autoRevoke),
      isSystem: false,
      createdBy: admin.user.id,
    })
    .returning({ id: roles.id })
    .get();

  audit(
    { actorId: admin.user.id },
    { action: "rbac.role.create", targetType: "role", targetId: row.id, targetLabel: verdict.draft.name, after: verdict.draft },
  );

  revalidatePath("/admin/roles");
  return { ok: true, id: row.id };
}

export async function updateRole(id: string, patch: Partial<RoleDraft>): Promise<RoleResult> {
  const admin = await requireWritableAdmin("role.manage");

  const current = listRoles().find((r) => r.id === id);
  if (!current) return fail("身份组不存在");

  /*
   * 内置组只让改外观（颜色、图标、优先级）。
   *
   * key 一改，`can()` 里按 key 找的地方会找不到 —— 而那些地方判的是
   * 「是不是管理员」，找不到的结果是**没有权限**：一次改名会把
   * 所有管理员关在门外，包括改名的那个人。
   */
  if (current.isSystem) {
    for (const field of ["key", "maxHolders", "autoGrantRule", "autoRevoke"] as const) {
      if (patch[field] !== undefined) {
        return fail("内置身份组只能改外观（名字、颜色、图标、优先级）");
      }
    }
  }

  const merged = {
    key: patch.key ?? current.key,
    name: patch.name ?? current.name,
    description: patch.description ?? current.description,
    color: patch.color ?? current.color,
    icon: patch.icon ?? current.icon,
    priority: patch.priority ?? current.priority,
    maxHolders: patch.maxHolders !== undefined ? patch.maxHolders : current.maxHolders,
    autoGrantRule: patch.autoGrantRule !== undefined ? patch.autoGrantRule : current.autoGrantRule,
    autoRevoke: patch.autoRevoke !== undefined ? patch.autoRevoke : current.autoRevoke,
  };

  const others = listRoles().filter((r) => r.id !== id).map((r) => r.key);
  const verdict = checkRole(merged, others);
  if (!verdict.ok) return fail(verdict.error);

  if (merged.autoGrantRule != null) {
    const allowed = canAutoGrant({
      isSystem: current.isSystem,
      maxDangerLevel: current.maxDangerLevel,
    });
    if (!allowed.ok) return fail(allowed.error);
  }

  db.update(roles)
    .set({
      key: verdict.draft.key,
      name: verdict.draft.name,
      description: verdict.draft.description,
      color: verdict.draft.color ?? null,
      icon: verdict.draft.icon ?? null,
      priority: verdict.draft.priority,
      maxHolders: verdict.draft.maxHolders ?? null,
      autoGrantRule: verdict.draft.autoGrantRule ?? null,
      autoRevoke: Boolean(verdict.draft.autoRevoke),
      updatedAt: Date.now(),
    })
    .where(eq(roles.id, id))
    .run();

  audit(
    { actorId: admin.user.id },
    {
      action: "rbac.role.update",
      targetType: "role",
      targetId: id,
      targetLabel: verdict.draft.name,
      before: { key: current.key, priority: current.priority, maxHolders: current.maxHolders },
      after: verdict.draft,
    },
  );

  revalidatePath("/admin/roles");
  return { ok: true, id };
}

export async function deleteRole(id: string): Promise<RoleResult> {
  const admin = await requireWritableAdmin("role.manage");

  const current = listRoles().find((r) => r.id === id);
  if (!current) return fail("身份组不存在");

  const verdict = canDelete({ isSystem: current.isSystem, holders: holderCount(id) });
  if (!verdict.ok) return fail(verdict.error);

  // 软删 —— 历史授予记录还指着这个 id，硬删会让审计日志变成一串孤儿
  db.update(roles).set({ deletedAt: Date.now() }).where(and(eq(roles.id, id), isNull(roles.deletedAt))).run();

  audit(
    { actorId: admin.user.id },
    { action: "rbac.role.delete", targetType: "role", targetId: id, targetLabel: current.name },
  );

  revalidatePath("/admin/roles");
  return { ok: true };
}
