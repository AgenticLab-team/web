import "server-only";

import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { describeRemaining } from "@/lib/moderation/duration-rules";
import { appeals, moderationActions } from "@/lib/db/schema";

/**
 * 申诉相关的读取。
 *
 * 与 appeals.ts 分开：那个文件是 "use server"，
 * 里面只能导出 async 函数，同步查询放进去会让整个构建失败。
 * 分开之后动作与查询各归各位，也更清楚。
 */

/** 我收到的处罚与申诉状态。被处罚的人有权知道自己的完整记录 */
export function myModerationRecord(userId: string, now = Date.now()) {
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
    /*
     * 「还有多久」在查询层算。
     *
     * 页面里读时钟既不纯（React 编译器会拦），而且一页里早晚两行
     * 会用上不同的「现在」—— 两条同时到期的记录会一条显示
     * 「还有 1 天」、另一条显示「已经到期」。
     */
    remaining:
      action.action === "ban" || action.action === "suspend"
        ? describeRemaining(action.expiresAt, now)
        : null,
  }));
}
