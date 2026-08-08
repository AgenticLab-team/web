import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { userRoles } from "@/lib/db/schema";
import { can } from "@/lib/rbac/can";
import { visibleGroupIds } from "@/lib/queries/visibility";

import { GUEST, type ViewerContext } from "./visibility";

/**
 * 把会话身份翻译成可见性判定需要的上下文。
 *
 * 判定函数本身是纯的（不碰数据库），所以这一层负责把所有输入查齐。
 * 一次查完传下去，而不是让判定函数自己去查 ——
 * 否则一个列表页渲染 50 条就是 50 次重复查询。
 */
export function buildViewerContext(user: CurrentUser | null, boardId?: string): ViewerContext {
  if (!user) return GUEST;

  const roleIds = db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(and(eq(userRoles.userId, user.id), isNull(userRoles.revokedAt)))
    .all()
    .map((r) => r.roleId);

  // 版主权限是限定版块的，所以要把版块 id 作为 scope 传进去
  const canModerate =
    can(user, "forum.post.delete.any", boardId ? { scopeType: "board", scopeId: boardId } : undefined)
      .allowed;

  return {
    userId: user.id,
    kind: user.kind === "external" ? "external" : "member",
    groupIds: visibleGroupIds(user),
    roleIds,
    canModerate,
  };
}
