import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 通用活动框架。规格见 MODULES.md 第三节。
 *
 * 核心洞察：**大多数活动其实是同一个状态机** ——
 * 资格判定 → 申请 → 占名额 → 审核 → 履约 → 回填 → 通知。
 * 抽奖、内测名额、周边兑换、线下报名骨架完全一样，只有三处不同：
 * 表单长什么样、校验规则是什么、履约怎么做。
 *
 * 所以核心实现状态机与资格引擎，模块只实现那三处差异。
 */

export const ACTIVITY_STATUSES = [
  "draft",
  "scheduled",
  "open",
  "closed",
  "reviewing",
  "fulfilling",
  "completed",
  "cancelled",
] as const;

export const APPLICATION_STATUSES = [
  "draft",
  "submitted",
  "validating",
  "invalid",
  "waitlisted",
  "approved",
  "rejected",
  "fulfilling",
  "fulfilled",
  "failed",
  "cancelled",
  "expired",
] as const;

export const activities = sqliteTable(
  "activities",
  {
    id: ulidPk(),
    /** 哪个模块提供这个活动的表单、校验与履约 */
    moduleKey: text("module_key").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    rulesMd: text("rules_md"),

    /** 模块专属配置 */
    config: text("config", { mode: "json" }),
    /** 资格规则，见 eligibility.ts */
    eligibility: text("eligibility", { mode: "json" }),

    /**
     * 名额。**quota_used 只是缓存列**，真值是 activity_quota_log ——
     * 名额算错在限量活动里是致命事故，必须能事后重算比对。
     */
    quotaTotal: integer("quota_total"),
    quotaUsed: integer("quota_used").notNull().default(0),
    perUserLimit: integer("per_user_limit").notNull().default(1),
    allowWaitlist: integer("allow_waitlist", { mode: "boolean" }).notNull().default(true),
    waitlistCap: integer("waitlist_cap"),

    opensAt: integer("opens_at"),
    closesAt: integer("closes_at"),
    fulfillDeadline: integer("fulfill_deadline"),

    status: text("status", { enum: ACTIVITY_STATUSES }).notNull().default("draft"),
    /** 结果是否公开（中签名单） */
    resultPublic: integer("result_public", { mode: "boolean" }).notNull().default(false),

    createdBy: text("created_by").notNull(),
    cancelledBy: text("cancelled_by"),
    cancelReason: text("cancel_reason"),

    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
  },
  (t) => [
    index("activities_status_idx").on(t.status, t.opensAt),
    index("activities_module_idx").on(t.moduleKey),
  ],
);

export const activityApplications = sqliteTable(
  "activity_applications",
  {
    id: ulidPk(),
    activityId: text("activity_id").notNull(),
    userId: text("user_id").notNull(),

    /** 模块专属字段（域名活动放域名，聚会活动放忌口） */
    payload: text("payload", { mode: "json" }),
    /** 唯一性判据。同一个域名不能被两个人登记 */
    normalizedKey: text("normalized_key"),

    status: text("status", { enum: APPLICATION_STATUSES }).notNull().default("submitted"),

    /**
     * **申请那一刻的资格快照。**
     *
     * 事后有人质疑「凭什么他能申请我不能」，翻快照即可，无从争议。
     * 没有快照的话，两周后数据变了就说不清了 ——
     * 而限量活动最容易吵的就是这个。
     */
    eligibilitySnapshot: text("eligibility_snapshot", { mode: "json" }),
    validationResult: text("validation_result", { mode: "json" }),

    /** 候补队列里的位置 */
    queuePosition: integer("queue_position"),

    reviewedBy: text("reviewed_by"),
    reviewedAt: integer("reviewed_at"),
    reviewNote: text("review_note"),

    fulfilledAt: integer("fulfilled_at"),
    fulfillResult: text("fulfill_result", { mode: "json" }),
    failureReason: text("failure_reason"),
    /** 失败后重提，指向原申请 */
    retryOf: text("retry_of"),

    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
  },
  (t) => [
    index("activity_applications_activity_idx").on(t.activityId, t.status),
    index("activity_applications_user_idx").on(t.userId),
    /*
     * 同一个活动里，同一个 normalized_key 只能有一份**在途**申请。
     *
     * 靠部分唯一索引而不是应用层查重 —— 应用层的「先查再插」
     * 在并发下必然漏：两个请求同时查到「没人占」，然后都插进去。
     *
     * 作废的状态不占名额：被判无效或撤回之后，别人应该能登记同一个域名。
     */
    uniqueIndex("activity_applications_key_idx")
      .on(t.activityId, t.normalizedKey)
      .where(
        sql`${t.normalizedKey} IS NOT NULL AND ${t.status} NOT IN ('invalid','rejected','cancelled','expired','failed')`,
      ),
  ],
);

/** 每一次状态流转。出问题时这是唯一能还原「当时发生了什么」的地方 */
export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: ulidPk(),
    activityId: text("activity_id").notNull(),
    applicationId: text("application_id"),

    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorId: text("actor_id"),
    actorKind: text("actor_kind", { enum: ["user", "admin", "system", "module"] })
      .notNull()
      .default("system"),
    note: text("note"),
    payload: text("payload", { mode: "json" }),

    createdAt: now("created_at"),
  },
  (t) => [index("activity_events_app_idx").on(t.applicationId, t.createdAt)],
);

/**
 * 名额流水 —— **名额的唯一真值**。
 *
 * activities.quota_used 只是缓存列。名额算错在限量活动里是致命事故：
 * 超卖意味着有人白高兴一场，少卖意味着名额白白浪费，
 * 两者都必须能事后查清是哪一笔出的问题。
 */
export const activityQuotaLog = sqliteTable(
  "activity_quota_log",
  {
    id: ulidPk(),
    activityId: text("activity_id").notNull(),
    delta: integer("delta").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    reason: text("reason").notNull(),
    applicationId: text("application_id"),
    operatorId: text("operator_id"),
    createdAt: now("created_at"),
  },
  (t) => [index("activity_quota_log_activity_idx").on(t.activityId, t.createdAt)],
);
