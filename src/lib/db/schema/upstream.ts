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

    /**
     * 被回复消息的 id（上游 msg_svr_id）。
     *
     * type='quote' 只说明「这是一条回复」；回复的是哪一条，
     * 上游 /v1/messages 目前不透传（实测见 src/lib/messages/reply.ts），
     * 所以现存数据这一列全为 NULL —— 这是如实的结果，不是缺陷。
     * 不加外键：被引用的消息可能早于接入时间或已被存储裁剪。
     */
    replyToId: text("reply_to_id"),

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
    // 「这条消息被回复了几次」要按目标反查，没有索引就是全表扫
    index("messages_reply_to_idx").on(t.replyToId),
  ],
);

/**
 * 消息里的 @提及，一行一个 @。
 *
 * 为什么是独立表而不是 messages 上的 JSON 列：「谁被 @ 了多少次」
 * 「他最近被 @ 的消息」都要按 wx_id 查，JSON 列做不了索引，
 * 这两个查询就只能扫全部消息 —— 而它们出现在访问最频的成员页上。
 *
 * name 存的是**解析那一刻**@ 后面的字面昵称。昵称随时会变，
 * 这一列是事后还原「当时写的是什么」的唯一证据；
 * 展示时的人名用 wx_id 查当前昵称渲染，不用这一列。
 */
export const messageMentions = sqliteTable(
  "message_mentions",
  {
    id: ulidPk(),
    messageId: text("message_id").notNull(),
    convId: text("conv_id").notNull(),
    /** 消息时间戳，冗余存一份：按时间段统计被 @ 次数不必回表 join */
    ts: integer("ts").notNull(),

    /** @ 后面的字面昵称（当时的） */
    name: text("name").notNull(),
    /**
     * resolved  — 唯一确定是谁，wx_id 非空
     * ambiguous — 多名同名成员，candidates 里列出，绝不选边
     * unknown   — 名册对不上（改名/退群/手打错），如实承认解析不出
     * all       — @所有人
     */
    status: text("status", { enum: ["resolved", "ambiguous", "unknown", "all"] }).notNull(),
    wxId: text("wx_id"),
    /** ambiguous 时的候选 wx_id 列表 */
    candidates: text("candidates", { mode: "json" }),
    /** @ 在 content 里的下标。昵称串可能在正文重复出现，渲染按位置定位 */
    position: integer("position").notNull(),
    syncedAt: now("synced_at"),
  },
  (t) => [
    /*
     * 同步与回填可能同时跑（和 keyword_hits 一样的竞态）：
     * 先查再写会两边都插进去，被 @ 次数悄悄翻倍 —— 靠唯一索引兜底。
     */
    uniqueIndex("message_mentions_msg_pos_idx").on(t.messageId, t.position),
    index("message_mentions_wx_ts_idx").on(t.wxId, t.ts),
    index("message_mentions_conv_ts_idx").on(t.convId, t.ts),
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
    /*
     * 榜单查的是「这几个群、这段日期」——
     * 只有 (wx_id,date) 和 (date) 的话它只能扫全表再临时排序。
     * 今天 3,570 行无所谓，一年后是四万行，而榜单是访问量最大的一页。
     */
    index("daily_stats_conv_date_idx").on(t.convId, t.date),
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
