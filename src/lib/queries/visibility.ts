import "server-only";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

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
  /**
   * **站里真的有多少条** —— 不是上游报的那个数。
   *
   * ─────────────────────────────────────────
   * 两个数字差 6.5%，而且永远追不平
   * ─────────────────────────────────────────
   *
   * `groups.message_count` 来自上游的 `/conversations`，
   * 而站里的归档是从 `/messages` 拉的 —— 上游这两个接口口径不同：
   * 会话计数里含着一批 `/messages` 根本不返回的东西（撤回、系统提示之类）。
   *
   * 实测三个群：本地条数和上游 `/messages` 的 total **一条不差**，
   * 而 `/conversations` 报的比它们都多 4~11%。
   *
   * 所以拿会话计数当「这个群有多少消息」显示，
   * 等于告诉人一个他在这个站里**永远翻不到**的数字 ——
   * 他点进去按天翻，怎么数都差一截。
   */
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
      // 站里真的有多少条，不是上游会话接口报的那个（见上面那段）
      messageCount: sql<number>`(SELECT count(*) FROM messages WHERE messages.conv_id = ${groups.convId})`,
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
 * 全部已接入的群 id，用于**全站总榜**。
 *
 * 这里刻意与上面的可见性分开：总榜对所有人开放（贡献排名是荣誉），
 * 但**群的身份始终不外泄** —— 调用方只拿到 id 用于聚合，
 * 绝不能把群名或「这个人在哪些群」渲染给没权限的人。
 *
 * 换句话说：可以公开「谁贡献最多」，不可以公开「有哪些群、谁在哪个群」。
 */
export function allSyncedGroupIds(): string[] {
  return db
    .select({ convId: groups.convId })
    .from(groups)
    .where(eq(groups.syncEnabled, true))
    .all()
    .map((g) => g.convId);
}

/** 批量校验，用于「我在哪些群」这类列表 */
export function filterToVisible<T extends { convId: string }>(
  user: CurrentUser | null,
  rows: T[],
): T[] {
  const allowed = new Set(visibleGroupIds(user));
  return rows.filter((row) => allowed.has(row.convId));
}
