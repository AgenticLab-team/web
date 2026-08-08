import "server-only";

import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { appeals, moderationActions } from "@/lib/db/schema";

/**
 * 申诉相关的读取。
 *
 * 与 appeals.ts 分开：那个文件是 "use server"，
 * 里面只能导出 async 函数，同步查询放进去会让整个构建失败。
 * 分开之后动作与查询各归各位，也更清楚。
 */

/** 我收到的处罚与申诉状态。被处罚的人有权知道自己的完整记录 */
export function myModerationRecord(userId: string) {
  const actions = db
    .select()
    .from(moderationActions)
    .where(eq(moderationActions.targetUserId, userId))
    .orderBy(desc(moderationActions.createdAt))
    .limit(50)
    .all();

  const myAppeals = db
    .select()
    .from(appeals)
    .where(eq(appeals.userId, userId))
    .all();
  const byAction = new Map(myAppeals.map((a) => [a.actionId, a]));

  return actions.map((action) => ({
    ...action,
    appeal: byAction.get(action.id) ?? null,
  }));
}
