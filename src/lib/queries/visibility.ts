import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { groupMembers, groups } from "@/lib/db/schema";

/**
 * 群可见性收口。
 *
 * 规则：**群列表与群相关数据都属于隐私**。
 *   - 未登录访客：一个群都看不到，连群名和群数量都不给
 *   - 已登录成员：只能看到自己所在的群
 *
 * 这不只是「首页别列群名」那么简单 —— 排行榜是跨群聚合的，
 * 一个只在 2 个群的人看到的全站榜里含着他看不到的那 8 个群的数据。
 * 所以任何按群聚合的查询都必须先过这个函数拿到可见范围。
 *
 * 收口放在服务端。前端隐藏不算数 —— 数据已经渲染进 HTML 了。
 */

export interface VisibleGroup {
  convId: string;
  name: string;
  messageCount: number;
  memberCount: number;
}

/** 这个人能看到哪些群。访客返回空数组 */
export function visibleGroupsFor(user: CurrentUser | null): VisibleGroup[] {
  if (!user?.wxId) return [];

  return db
    .select({
      convId: groups.convId,
      name: groups.name,
      messageCount: groups.messageCount,
      memberCount: groups.memberCount,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.convId, groupMembers.convId))
    .where(
      and(
        eq(groupMembers.wxId, user.wxId),
        // 退群后立即失去该群的可见权
        isNull(groupMembers.leftAt),
        eq(groups.syncEnabled, true),
      ),
    )
    .orderBy(desc(groups.messageCount))
    .all();
}

/** 只要 conv_id 列表，用于给聚合查询加 WHERE */
export function visibleGroupIds(user: CurrentUser | null): string[] {
  return visibleGroupsFor(user).map((g) => g.convId);
}

/**
 * 单个群的访问校验。任何按 conv_id 取数据的地方都要先过这里。
 * 返回 null 而不是抛错，调用方据此渲染 404 —— 用 403 会泄露「这个群存在」。
 */
export function assertGroupAccess(
  user: CurrentUser | null,
  convId: string,
): VisibleGroup | null {
  return visibleGroupsFor(user).find((g) => g.convId === convId) ?? null;
}

/**
 * 访客能看到的全局统计。
 * 只给不涉及群身份的聚合量（社区总人数），不给群数量 ——
 * 群的数量本身也是社群结构信息。
 */
export function publicCommunityShape() {
  const total = db
    .select({ convId: groups.convId })
    .from(groups)
    .where(eq(groups.syncEnabled, true))
    .all();
  return { hasGroups: total.length > 0 };
}

/** 批量校验，用于「我在哪些群」这类列表 */
export function filterToVisible<T extends { convId: string }>(
  user: CurrentUser | null,
  rows: T[],
): T[] {
  const allowed = new Set(visibleGroupIds(user));
  return rows.filter((row) => allowed.has(row.convId));
}
