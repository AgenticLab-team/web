import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { now } from "./_shared";

/**
 * 谁把哪条站内公告关掉了。
 *
 * ─────────────────────────────────────────
 * 为什么记「关掉了」，而不是给每个人发一份
 * ─────────────────────────────────────────
 *
 * 另一种做法是发布时给每个目标用户插一行「未读」。那样语义更整齐，
 * 但一条全体公告要写一千六百行，而其中绝大多数永远不会被读到 ——
 * 一条挂三天就过期的通知，为它写一千六百行是不划算的。
 *
 * 反过来记「关掉了」的话，行只在**人真的做了动作**时才产生。
 * 代价是「有多少人看过」这个数字算不出来 —— 而那个数字本来也没人看，
 * 真要知道「有没有人看见」，看的是有多少人点了关。
 *
 * 主键是 (user_id, broadcast_id)：同一个人对同一条公告只可能关一次，
 * 靠主键去重比靠应用层「先查再插」可靠 ——
 * 后者在两个标签页同时点关的时候会插进去两行。
 */
export const announcementDismissals = sqliteTable(
  "announcement_dismissals",
  {
    userId: text("user_id").notNull(),
    broadcastId: text("broadcast_id").notNull(),
    dismissedAt: now("dismissed_at"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.broadcastId] }),
    // 「这个人关掉了哪些」是每次渲染都要问的，走这个索引
    index("announcement_dismissals_user_idx").on(t.userId),
    // 「这条被多少人关掉了」——后台要用它回答「有没有人看见」
    index("announcement_dismissals_broadcast_idx").on(t.broadcastId),
  ],
);

export type AnnouncementDismissal = typeof announcementDismissals.$inferSelect;
