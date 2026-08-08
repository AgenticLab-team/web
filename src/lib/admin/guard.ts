import "server-only";

import { redirect } from "next/navigation";

import { getCurrentUser, type CurrentUser } from "@/lib/auth/session";
import { can, effectivePermissions } from "@/lib/rbac/can";
import type { PermissionKey } from "@/lib/rbac/permissions";

/**
 * 后台访问守卫。
 *
 * 两条原则：
 *   1. **每个页面各自校验自己需要的权限点**，不是「进了后台就都能看」。
 *      审计员能看数据但不能改，版主只管自己的版块 —— 一刀切的后台
 *      等于把所有权限打包发给每个能进后台的人
 *   2. 没权限时**跳走而不是显示空白页**，且不提示「你没有权限看这个」——
 *      后台的功能清单本身也是信息
 */

export interface AdminContext {
  user: CurrentUser;
  /** 这个人有效的权限点集合，key 是权限点，value 是来源 */
  permissions: Map<string, string>;
  has: (permission: PermissionKey) => boolean;
}

/** 进后台的最低门槛。没有它连仪表盘都看不到 */
export const ADMIN_ENTRY_PERMISSION: PermissionKey = "system.dashboard";

export async function requireAdmin(permission?: PermissionKey): Promise<AdminContext> {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/admin");

  const entry = can(user, ADMIN_ENTRY_PERMISSION);
  if (!entry.allowed) redirect("/");

  if (permission && !can(user, permission).allowed) {
    // 有后台入口但没有这一项的权限，回后台首页而不是登录页
    redirect("/admin");
  }

  const permissions = effectivePermissions(user);
  return {
    user,
    permissions,
    has: (key) => permissions.has(key),
  };
}

/** 不跳转的版本，用于条件渲染导航项 */
export async function adminContextOrNull(): Promise<AdminContext | null> {
  const user = await getCurrentUser();
  if (!user || !can(user, ADMIN_ENTRY_PERMISSION).allowed) return null;
  const permissions = effectivePermissions(user);
  return { user, permissions, has: (key) => permissions.has(key) };
}
