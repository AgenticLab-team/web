import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 论坛。规格见 FORUM.md。
 *
 * 可见性是这套表里最要紧的东西 —— 六个级别，且有三条写死在代码里
 * 不可配置绕过的硬约束（群聊派生内容永不公开等）。
 */

export const VISIBILITY_LEVELS = [
  "public",
  "unlisted",
  "member",
  "role",
  "group",
  "private",
] as const;

export type Visibility = (typeof VISIBILITY_LEVELS)[number];

export const boards = sqliteTable(
  "forum_boards",
  {
    id: ulidPk(),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon"),
    color: text("color"),
    sort: integer("sort").notNull().default(0),
    parentId: text("parent_id"),

    /** 版块本身在导航里对谁可见 */
    visibleTo: text("visible_to", { enum: VISIBILITY_LEVELS }).notNull().default("member"),
    /** 新帖默认可见性 */
    defaultVisibility: text("default_visibility", { enum: VISIBILITY_LEVELS })
      .notNull()
      .default("member"),
    /** **封顶**：该版块任何帖子都不能超过这个级别 */
    maxVisibility: text("max_visibility", { enum: VISIBILITY_LEVELS }).notNull().default("member"),

    /** 发帖 / 回帖所需的权限点，为空表示用默认 */
    postPermission: text("post_permission"),
    replyPermission: text("reply_permission"),
    postMinLevel: integer("post_min_level").notNull().default(1),
    allowAnonymous: integer("allow_anonymous", { mode: "boolean" }).notNull().default(false),
    requireTags: integer("require_tags", { mode: "boolean" }).notNull().default(false),
    /** 默认回复视图：楼层式还是树形 */
    viewMode: text("view_mode", { enum: ["flat", "threaded"] })
      .notNull()
      .default("flat"),

    locked: integer("locked", { mode: "boolean" }).notNull().default(false),
    postCount: integer("post_count").notNull().default(0),
    lastPostAt: integer("last_post_at"),

    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
    createdBy: text("created_by"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("forum_boards_sort_idx").on(t.sort)],
);

export const posts = sqliteTable(
  "forum_posts",
  {
    id: ulidPk(),
    boardId: text("board_id").notNull(),
    authorId: text("author_id").notNull(),

    title: text("title").notNull(),
    content: text("content").notNull(),
    /** 渲染后的 HTML，已消毒。存下来避免每次读取都重新渲染 */
    contentHtml: text("content_html").notNull(),
    excerpt: text("excerpt"),

    type: text("type", {
      enum: ["discussion", "question", "poll", "showcase", "announcement"],
    })
      .notNull()
      .default("discussion"),

    status: text("status", { enum: ["draft", "published", "locked", "hidden", "deleted"] })
      .notNull()
      .default("published"),

    visibility: text("visibility", { enum: VISIBILITY_LEVELS }).notNull().default("member"),
    visibilityRoleId: text("visibility_role_id"),
    visibilityGroupId: text("visibility_group_id"),
    /**
     * 群聊转帖锁定。为 true 时不能通过普通编辑改可见性 ——
     * 必须走管理员审核 + 原作者同意，见 post_sources。
     */
    visibilityLocked: integer("visibility_locked", { mode: "boolean" }).notNull().default(false),

    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    pinnedUntil: integer("pinned_until"),
    pinnedGlobally: integer("pinned_globally", { mode: "boolean" }).notNull().default(false),
    featured: integer("featured", { mode: "boolean" }).notNull().default(false),
    featuredBy: text("featured_by"),
    featuredAt: integer("featured_at"),
    anonymous: integer("anonymous", { mode: "boolean" }).notNull().default(false),

    /** 问答类：被采纳的回答 */
    solvedReplyId: text("solved_reply_id"),
    bountyPoints: integer("bounty_points").notNull().default(0),

    viewCount: integer("view_count").notNull().default(0),
    replyCount: integer("reply_count").notNull().default(0),
    reactionCount: integer("reaction_count").notNull().default(0),
    lastReplyAt: integer("last_reply_at"),

    editCount: integer("edit_count").notNull().default(0),
    lastEditedAt: integer("last_edited_at"),

    scheduledAt: integer("scheduled_at"),
    shareCode: text("share_code").unique(),

    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
    deletedAt: integer("deleted_at"),
    deletedBy: text("deleted_by"),
    deleteReason: text("delete_reason"),
  },
  (t) => [
    index("forum_posts_board_idx").on(t.boardId, t.lastReplyAt),
    index("forum_posts_author_idx").on(t.authorId),
    index("forum_posts_status_idx").on(t.status),
    index("forum_posts_visibility_idx").on(t.visibility),
    index("forum_posts_created_idx").on(t.createdAt),
  ],
);

/**
 * 编辑历史，**公开可查**。
 * 悄悄改内容是论坛信任的头号杀手 —— 有人回复了你，
 * 你把原帖改成别的意思，整串对话就废了。
 */
export const postRevisions = sqliteTable(
  "forum_post_revisions",
  {
    id: ulidPk(),
    postId: text("post_id").notNull(),
    editorId: text("editor_id").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    changeNote: text("change_note"),
    createdAt: now("created_at"),
  },
  (t) => [index("forum_post_revisions_post_idx").on(t.postId, t.createdAt)],
);

/** 群聊转帖的来源与授权状态 */
export const postSources = sqliteTable(
  "forum_post_sources",
  {
    id: ulidPk(),
    postId: text("post_id").notNull(),
    convId: text("conv_id").notNull(),
    messageIds: text("message_ids", { mode: "json" }).notNull(),
    convertedBy: text("converted_by").notNull(),
    convertedAt: now("converted_at"),
    /** 所有被引用消息的原作者是否都同意公开 */
    consentStatus: text("consent_status", { enum: ["pending", "granted", "denied", "waived"] })
      .notNull()
      .default("pending"),
    consentLog: text("consent_log", { mode: "json" }),
  },
  (t) => [index("forum_post_sources_post_idx").on(t.postId)],
);

export const replies = sqliteTable(
  "forum_replies",
  {
    id: ulidPk(),
    postId: text("post_id").notNull(),
    parentId: text("parent_id"),
    authorId: text("author_id").notNull(),

    content: text("content").notNull(),
    contentHtml: text("content_html").notNull(),

    /** 楼层号，从 1 开始。用于 #12 这样的锚点 */
    floor: integer("floor").notNull(),
    quotedReplyId: text("quoted_reply_id"),
    quotedExcerpt: text("quoted_excerpt"),

    status: text("status", { enum: ["published", "hidden", "deleted"] })
      .notNull()
      .default("published"),
    collapsed: integer("collapsed", { mode: "boolean" }).notNull().default(false),
    collapseReason: text("collapse_reason"),
    accepted: integer("accepted", { mode: "boolean" }).notNull().default(false),
    anonymous: integer("anonymous", { mode: "boolean" }).notNull().default(false),

    reactionCount: integer("reaction_count").notNull().default(0),
    editCount: integer("edit_count").notNull().default(0),
    lastEditedAt: integer("last_edited_at"),

    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
    deletedAt: integer("deleted_at"),
    deletedBy: text("deleted_by"),
    deleteReason: text("delete_reason"),
  },
  (t) => [
    uniqueIndex("forum_replies_floor_idx").on(t.postId, t.floor),
    index("forum_replies_post_idx").on(t.postId, t.createdAt),
    index("forum_replies_author_idx").on(t.authorId),
  ],
);

/** 多维反应。只有点赞的话信息量太少，分不出「有用」和「喜欢」 */
export const REACTION_KINDS = ["useful", "insight", "precise", "love"] as const;

export const reactions = sqliteTable(
  "forum_reactions",
  {
    id: ulidPk(),
    targetType: text("target_type", { enum: ["post", "reply"] }).notNull(),
    targetId: text("target_id").notNull(),
    userId: text("user_id").notNull(),
    kind: text("kind", { enum: REACTION_KINDS }).notNull(),
    createdAt: now("created_at"),
  },
  (t) => [
    uniqueIndex("forum_reactions_unique_idx").on(t.targetType, t.targetId, t.userId, t.kind),
    index("forum_reactions_target_idx").on(t.targetType, t.targetId),
  ],
);

export const tags = sqliteTable(
  "forum_tags",
  {
    id: ulidPk(),
    name: text("name").notNull().unique(),
    slug: text("slug").notNull().unique(),
    description: text("description"),
    color: text("color"),
    postCount: integer("post_count").notNull().default(0),
    locked: integer("locked", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by"),
    createdAt: now("created_at"),
  },
  (t) => [index("forum_tags_count_idx").on(t.postCount)],
);

export const postTags = sqliteTable(
  "forum_post_tags",
  {
    postId: text("post_id").notNull(),
    tagId: text("tag_id").notNull(),
  },
  (t) => [
    uniqueIndex("forum_post_tags_pk").on(t.postId, t.tagId),
    index("forum_post_tags_tag_idx").on(t.tagId),
  ],
);

/**
 * 服务端草稿。
 * 本地 IndexedDB 之外再存一份，换设备能接着写 ——
 * 丢过一次两千字的人就再也不会在这里写长文了。
 */
export const drafts = sqliteTable(
  "forum_drafts",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    targetType: text("target_type", { enum: ["post", "reply"] }).notNull(),
    /** 编辑已有内容时是目标 id；新建时是版块 id 或帖子 id */
    targetId: text("target_id"),
    boardId: text("board_id"),
    title: text("title"),
    content: text("content").notNull(),
    updatedAt: now("updated_at"),
  },
  (t) => [uniqueIndex("forum_drafts_unique_idx").on(t.userId, t.targetType, t.targetId)],
);

/** 未读标记与「跳到上次阅读位置」 */
export const postViews = sqliteTable(
  "forum_post_views",
  {
    postId: text("post_id").notNull(),
    userId: text("user_id").notNull(),
    lastReadFloor: integer("last_read_floor").notNull().default(0),
    readAt: now("read_at"),
  },
  (t) => [uniqueIndex("forum_post_views_pk").on(t.postId, t.userId)],
);

/** 可见性变更单独留痕 —— 这是论坛里最敏感的操作 */
export const visibilityAudit = sqliteTable(
  "forum_visibility_audit",
  {
    id: ulidPk(),
    targetType: text("target_type", { enum: ["post", "board"] }).notNull(),
    targetId: text("target_id").notNull(),
    fromVisibility: text("from_visibility"),
    toVisibility: text("to_visibility").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason"),
    consentSnapshot: text("consent_snapshot", { mode: "json" }),
    createdAt: now("created_at"),
  },
  (t) => [index("forum_visibility_audit_target_idx").on(t.targetType, t.targetId)],
);
