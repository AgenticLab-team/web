import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 审核与治理。
 *
 * 设计上的一条原则：**有处罚就必须有申诉**。
 * 只罚不给申诉，管理只会积累怨气 —— 被误伤的人无处说理，
 * 最后要么退群要么在群里吵，两种结果都比多做一个申诉表贵得多。
 */

export const reports = sqliteTable(
  "reports",
  {
    id: ulidPk(),
    reporterId: text("reporter_id").notNull(),
    targetType: text("target_type", { enum: ["post", "reply", "user"] }).notNull(),
    targetId: text("target_id").notNull(),
    /** 被举报内容的作者，便于按人聚合 */
    targetUserId: text("target_user_id"),

    reasonCode: text("reason_code", {
      enum: ["spam", "abuse", "porn", "illegal", "privacy", "offtopic", "other"],
    }).notNull(),
    detail: text("detail"),

    status: text("status", {
      enum: ["open", "reviewing", "resolved", "rejected", "duplicate"],
    })
      .notNull()
      .default("open"),
    /** 0 普通 / 1 需尽快 / 2 紧急（涉法涉黄） */
    severity: integer("severity").notNull().default(0),

    assignedTo: text("assigned_to"),
    resolvedBy: text("resolved_by"),
    resolvedAt: integer("resolved_at"),
    resolution: text("resolution"),

    createdAt: now("created_at"),
  },
  (t) => [
    index("reports_status_idx").on(t.status, t.severity, t.createdAt),
    index("reports_target_idx").on(t.targetType, t.targetId),
    index("reports_reporter_idx").on(t.reporterId, t.createdAt),
  ],
);

/**
 * 处罚记录。所有处罚集中在这一张表，
 * 用户档案页直接聚合展示历史 —— 散在各处就永远拼不出一个人的完整记录。
 */
export const moderationActions = sqliteTable(
  "moderation_actions",
  {
    id: ulidPk(),
    actorId: text("actor_id").notNull(),
    targetType: text("target_type", { enum: ["post", "reply", "user"] }).notNull(),
    targetId: text("target_id").notNull(),
    targetUserId: text("target_user_id"),

    action: text("action", {
      enum: [
        "warn", "hide", "delete", "restore", "lock", "unlock",
        "pin", "unpin", "feature", "unfeature", "move", "collapse",
        "mute", "suspend", "ban", "unban",
      ],
    }).notNull(),
    /** **非空**：处罚必须说明理由，否则申诉时无从判断对错 */
    reason: text("reason").notNull(),
    detail: text("detail", { mode: "json" }),

    durationSeconds: integer("duration_seconds"),
    expiresAt: integer("expires_at"),

    reportId: text("report_id"),
    revertedBy: text("reverted_by"),
    revertedAt: integer("reverted_at"),

    createdAt: now("created_at"),
  },
  (t) => [
    index("moderation_actions_target_user_idx").on(t.targetUserId, t.createdAt),
    index("moderation_actions_target_idx").on(t.targetType, t.targetId),
    index("moderation_actions_actor_idx").on(t.actorId, t.createdAt),
  ],
);

export const appeals = sqliteTable(
  "appeals",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    actionId: text("action_id").notNull(),
    content: text("content").notNull(),

    status: text("status", { enum: ["open", "accepted", "rejected"] })
      .notNull()
      .default("open"),
    handledBy: text("handled_by"),
    handledAt: integer("handled_at"),
    response: text("response"),

    createdAt: now("created_at"),
  },
  (t) => [
    index("appeals_status_idx").on(t.status, t.createdAt),
    index("appeals_user_idx").on(t.userId),
  ],
);

/** 敏感词：拦截 / 送审 / 替换三档 */
export const sensitiveWords = sqliteTable(
  "sensitive_words",
  {
    id: ulidPk(),
    word: text("word").notNull().unique(),
    kind: text("kind", { enum: ["block", "review", "replace"] })
      .notNull()
      .default("review"),
    replacement: text("replacement"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    hitCount: integer("hit_count").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: now("created_at"),
  },
  (t) => [index("sensitive_words_enabled_idx").on(t.enabled)],
);
