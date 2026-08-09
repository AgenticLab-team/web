import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 告警。
 *
 * 一个组件同时只有一条「正在报警」的记录（靠部分唯一索引保证）——
 * 每次探测失败都插一行的话，一次两小时的故障会留下二十四条记录，
 * 而真正需要知道的只有「它从什么时候开始挂的」。
 */
export const alerts = sqliteTable(
  "alerts",
  {
    id: ulidPk(),
    component: text("component").notNull(),
    severity: text("severity", { enum: ["info", "warning", "critical"] })
      .notNull()
      .default("warning"),

    title: text("title").notNull(),
    body: text("body"),

    state: text("state", { enum: ["firing", "resolved"] })
      .notNull()
      .default("firing"),

    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    resolvedAt: integer("resolved_at"),

    /** 通知**成功**送达的时间。null 表示一次都没送到过 */
    notifiedAt: integer("notified_at"),
    /**
     * 上一次**尝试**投递的时间，不管成没成。
     *
     * 和 notifiedAt 分开是因为「试过但失败了」需要按重试节奏再试 ——
     * 只看 notifiedAt 的话，首次投递失败就等于永远沉默。
     */
    notifyAttemptedAt: integer("notify_attempted_at"),
    /**
     * 通知失败的原因。
     *
     * **上游挂掉时微信通道也发不出去** —— 报信的人和出事的人是同一个。
     * 这一列就是为了让「没收到告警」和「告警发失败了」能分得开：
     * 前者是没出事，后者是出事了但你不知道。
     */
    notifyError: text("notify_error"),

    createdAt: now("created_at"),
  },
  (t) => [
    index("alerts_state_idx").on(t.state, t.firstSeenAt),
    // 一个组件同时只能有一条 firing —— 部分唯一索引，已恢复的不占位
    uniqueIndex("alerts_firing_idx")
      .on(t.component)
      .where(sql`${t.state} = 'firing'`),
  ],
);
