import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/** 群。上游是数据源，这里是加速层 + 本站的每群配置 */
export const groups = sqliteTable(
  "groups",
  {
    convId: text("conv_id").primaryKey(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    isGroup: integer("is_group", { mode: "boolean" }).notNull().default(true),
    bound: integer("bound", { mode: "boolean" }).notNull().default(false),

    /**
     * 是否纳入本站。**由上游 bound 驱动**，不手工维护：
     * 机器人真正绑定了的群就是要接收与统计的群。
     * 每次同步会话列表时重算为 bound && !syncExcluded。
     */
    syncEnabled: integer("sync_enabled", { mode: "boolean" }).notNull().default(false),
    /** 管理员显式排除某个 bound 群时才置 true —— 唯一能压过上游的开关 */
    syncExcluded: integer("sync_excluded", { mode: "boolean" }).notNull().default(false),
    /** 覆盖全局默认的高质量阈值 */
    qualityMin: integer("quality_min"),
    countForPoints: integer("count_for_points", { mode: "boolean" }).notNull().default(true),
    publicLeaderboard: integer("public_leaderboard", { mode: "boolean" })
      .notNull()
      .default(false),
    /** 覆盖全局保留策略 */
    retentionDays: integer("retention_days"),

    description: text("description"),
    notice: text("notice"),

    memberCount: integer("member_count").notNull().default(0),
    messageCount: integer("message_count").notNull().default(0),
    lastMessageAt: integer("last_message_at"),

    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
    updatedBy: text("updated_by"),
  },
  (t) => [index("groups_sync_idx").on(t.syncEnabled)],
);

export const groupMembers = sqliteTable(
  "group_members",
  {
    convId: text("conv_id").notNull(),
    wxId: text("wx_id").notNull(),
    /** 群内备注名，优先展示 */
    displayName: text("display_name"),
    /** 微信昵称，群内没设备注名时用这个 */
    wxName: text("wx_name"),
    avatarUrl: text("avatar_url"),
    messages: integer("messages").notNull().default(0),
    joinedAt: integer("joined_at"),
    leftAt: integer("left_at"),
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    syncedAt: now("synced_at"),
  },
  (t) => [
    uniqueIndex("group_members_pk").on(t.convId, t.wxId),
    index("group_members_wx_idx").on(t.wxId),
  ],
);

/** 每日同步比对产生。退群要自动收回该群消息可见权，靠这张表驱动 */
export const groupMemberEvents = sqliteTable(
  "group_member_events",
  {
    id: ulidPk(),
    convId: text("conv_id").notNull(),
    wxId: text("wx_id").notNull(),
    event: text("event", { enum: ["join", "leave", "rename", "promote", "demote"] }).notNull(),
    detail: text("detail", { mode: "json" }),
    detectedAt: now("detected_at"),
    /** 是否已触发权限调整 */
    processedAt: integer("processed_at"),
  },
  (t) => [
    index("gme_conv_idx").on(t.convId, t.detectedAt),
    index("gme_unprocessed_idx").on(t.processedAt),
  ],
);

/**
 * 消息本地镜像。分层保留见 PLAN.md §7.3：
 * hot(90d) 全量+全索引 / warm(1y) 全量正文仅索引高质量 / cold 仅高质量
 */
export const messages = sqliteTable(
  "messages",
  {
    /** 上游 msg_svr_id，天然去重键 */
    id: text("id").primaryKey(),
    convId: text("conv_id").notNull(),
    senderWxId: text("sender_wx_id").notNull(),
    senderName: text("sender_name"),
    /** true = 机器人自己发的 */
    isSend: integer("is_send", { mode: "boolean" }).notNull().default(false),

    type: text("type").notNull(),
    content: text("content").notNull(),
    length: integer("length").notNull().default(0),
    isQuality: integer("is_quality", { mode: "boolean" }).notNull().default(false),

    hasMedia: integer("has_media", { mode: "boolean" }).notNull().default(false),
    ts: integer("ts").notNull(),

    tier: text("tier", { enum: ["hot", "warm", "cold"] })
      .notNull()
      .default("hot"),
    indexed: integer("indexed", { mode: "boolean" }).notNull().default(false),
    syncedAt: now("synced_at"),
  },
  (t) => [
    index("messages_conv_ts_idx").on(t.convId, t.ts),
    index("messages_sender_ts_idx").on(t.senderWxId, t.ts),
    index("messages_ts_idx").on(t.ts),
    index("messages_tier_idx").on(t.tier),
  ],
);

/** 聚合统计。冷层裁剪后唯一保留的东西，榜单与积分都读这里 */
export const dailyStats = sqliteTable(
  "daily_stats",
  {
    wxId: text("wx_id").notNull(),
    convId: text("conv_id").notNull(),
    /** YYYY-MM-DD（本地时区） */
    date: text("date").notNull(),
    messages: integer("messages").notNull().default(0),
    qualityMessages: integer("quality_messages").notNull().default(0),
    charsTotal: integer("chars_total").notNull().default(0),
    firstMsgAt: integer("first_msg_at"),
    lastMsgAt: integer("last_msg_at"),
    /** 24 长度数组，用于活跃时段热力图 */
    hourHistogram: text("hour_histogram", { mode: "json" }),
    updatedAt: now("updated_at"),
  },
  (t) => [
    uniqueIndex("daily_stats_pk").on(t.wxId, t.convId, t.date),
    index("daily_stats_date_idx").on(t.date),
    index("daily_stats_wx_date_idx").on(t.wxId, t.date),
  ],
);

/** 每一次同步的结果都要能查：拉了多少、写了多少、为什么失败、重试几次 */
export const syncJobs = sqliteTable(
  "sync_jobs",
  {
    id: ulidPk(),
    kind: text("kind", {
      enum: ["conversations", "messages", "members", "avatars", "friend_requests", "leaderboard"],
    }).notNull(),
    scope: text("scope"),
    status: text("status", {
      enum: ["pending", "running", "success", "failed", "partial"],
    })
      .notNull()
      .default("pending"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    durationMs: integer("duration_ms"),
    itemsFetched: integer("items_fetched").notNull().default(0),
    itemsWritten: integer("items_written").notNull().default(0),
    error: text("error"),
    retryCount: integer("retry_count").notNull().default(0),
    triggeredBy: text("triggered_by", { enum: ["cron", "admin", "api", "boot"] })
      .notNull()
      .default("cron"),
    triggeredByUser: text("triggered_by_user"),
    createdAt: now("created_at"),
  },
  (t) => [index("sync_jobs_kind_idx").on(t.kind, t.createdAt)],
);

/** 增量游标，避免每次全量拉取 */
export const syncCursors = sqliteTable(
  "sync_cursors",
  {
    kind: text("kind").notNull(),
    scope: text("scope").notNull().default(""),
    lastTs: integer("last_ts").notNull().default(0),
    lastId: text("last_id"),
    updatedAt: now("updated_at"),
  },
  (t) => [uniqueIndex("sync_cursors_pk").on(t.kind, t.scope)],
);

/**
 * 社群里的每一个人 —— 不管有没有在本站注册账号。
 *
 * 为什么不挂在 users 表上：1595 名群成员里绝大多数永远不会来注册，
 * 但排行榜、成员目录、消息检索都要显示他们的名字和头像。
 * users 是「账号」，people 是「人」，两者不是一回事。
 *
 * 显示名的可靠来源是群昵称与消息发送者名 —— 上游 /users/{wx_id} 的 name
 * 实测对部分账号直接返回 wx_id 本身，不能作为唯一依据。
 */
export const people = sqliteTable(
  "people",
  {
    wxId: text("wx_id").primaryKey(),
    displayName: text("display_name").notNull(),
    /** 目前只有 friend-requests 拿得到头像，多数人为空，由前端生成占位 */
    avatarUrl: text("avatar_url"),
    avatarSource: text("avatar_source", {
      enum: ["group_member", "leaderboard", "friend_request", "profile", "upload"],
    }),
    messages: integer("messages").notNull().default(0),
    qualityMessages: integer("quality_messages").notNull().default(0),
    groupCount: integer("group_count").notNull().default(0),
    firstSeen: integer("first_seen"),
    lastSeen: integer("last_seen"),
    updatedAt: now("updated_at"),
  },
  (t) => [index("people_name_idx").on(t.displayName)],
);
