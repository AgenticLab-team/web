import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 审计日志：只增不改不删，**没有删除接口，owner 也没有**。
 * 写入方式是在数据访问层统一拦截，不靠每个接口自觉调用 —— 靠自觉一定会漏。
 */
export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: ulidPk(),
    actorId: text("actor_id"),
    actorRole: text("actor_role"),
    actorIp: text("actor_ip"),
    actorUa: text("actor_ua"),

    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    targetLabel: text("target_label"),

    /** 变更前后快照，出问题时唯一能复原真相的东西 */
    before: text("before", { mode: "json" }),
    after: text("after", { mode: "json" }),
    reason: text("reason"),

    dangerLevel: integer("danger_level").notNull().default(0),
    approvalId: text("approval_id"),
    requestId: text("request_id"),
    createdAt: now("created_at"),
  },
  (t) => [
    index("audit_logs_actor_idx").on(t.actorId, t.createdAt),
    index("audit_logs_action_idx").on(t.action, t.createdAt),
    index("audit_logs_target_idx").on(t.targetType, t.targetId),
    index("audit_logs_created_idx").on(t.createdAt),
  ],
);

/** 一切可配。积分数值、阈值、保留天数、限流全在这，不写进代码 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  type: text("type", { enum: ["string", "int", "bool", "json"] })
    .notNull()
    .default("string"),
  category: text("category").notNull().default("general"),
  label: text("label"),
  description: text("description"),
  defaultValue: text("default_value"),
  minValue: integer("min_value"),
  maxValue: integer("max_value"),
  /** 修改此项所需的权限点 */
  requiresPermission: text("requires_permission"),
  updatedAt: now("updated_at"),
  updatedBy: text("updated_by"),
});

/** 配置变更历史，可回滚 */
export const settingHistory = sqliteTable(
  "setting_history",
  {
    id: ulidPk(),
    key: text("key").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    changedBy: text("changed_by"),
    reason: text("reason"),
    createdAt: now("created_at"),
  },
  (t) => [index("setting_history_key_idx").on(t.key, t.createdAt)],
);

/** 模块开关。出问题时先关模块，而不是回滚整站 */
export const featureFlags = sqliteTable("feature_flags", {
  key: text("key").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  rollout: text("rollout", { enum: ["all", "role", "user", "percent"] })
    .notNull()
    .default("all"),
  rolloutValue: text("rollout_value", { mode: "json" }),
  description: text("description"),
  updatedAt: now("updated_at"),
  updatedBy: text("updated_by"),
});

/**
 * 危险操作双人复核。dangerLevel >= 3 的操作不直接执行，
 * 先落待批记录，需另一名管理员批准 —— 防误操作和内鬼的唯一手段。
 */
export const approvals = sqliteTable(
  "approvals",
  {
    id: ulidPk(),
    action: text("action").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    dangerLevel: integer("danger_level").notNull().default(3),

    requestedBy: text("requested_by").notNull(),
    requestedAt: now("requested_at"),
    reason: text("reason").notNull(),

    status: text("status", {
      enum: ["pending", "approved", "rejected", "expired", "executed", "failed"],
    })
      .notNull()
      .default("pending"),
    approvedBy: text("approved_by"),
    approvedAt: integer("approved_at"),
    approveNote: text("approve_note"),
    executedAt: integer("executed_at"),
    executeResult: text("execute_result", { mode: "json" }),
    expiresAt: integer("expires_at"),
  },
  (t) => [index("approvals_status_idx").on(t.status, t.requestedAt)],
);

/** 后台发起的长任务。危险批量操作必须先出 preview 再执行 */
export const adminTasks = sqliteTable(
  "admin_tasks",
  {
    id: ulidPk(),
    kind: text("kind").notNull(),
    params: text("params", { mode: "json" }),
    status: text("status", {
      enum: ["queued", "previewing", "awaiting_confirm", "running", "success", "failed", "cancelled"],
    })
      .notNull()
      .default("queued"),
    progress: integer("progress").notNull().default(0),
    total: integer("total").notNull().default(0),
    /** 执行前的影响预估：「将释放 820 MB / 影响 3,412 条」 */
    preview: text("preview", { mode: "json" }),
    result: text("result", { mode: "json" }),
    error: text("error"),
    createdBy: text("created_by"),
    createdAt: now("created_at"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("admin_tasks_status_idx").on(t.status, t.createdAt)],
);

/** frp 隧道是单点，必须持续探测并告警 */
export const systemHealth = sqliteTable(
  "system_health",
  {
    id: ulidPk(),
    component: text("component", {
      enum: ["upstream_api", "frp_tunnel", "db", "disk", "offsite", "mail", "cron", "auth"],
    }).notNull(),
    status: text("status", { enum: ["ok", "degraded", "down"] }).notNull(),
    detail: text("detail"),
    latencyMs: integer("latency_ms"),
    checkedAt: now("checked_at"),
  },
  (t) => [index("system_health_component_idx").on(t.component, t.checkedAt)],
);

/** 磁盘水位趋势，放后台首屏 */
export const storageSnapshots = sqliteTable("storage_snapshots", {
  id: ulidPk(),
  takenAt: now("taken_at"),
  dbBytes: integer("db_bytes").notNull().default(0),
  ftsBytes: integer("fts_bytes").notNull().default(0),
  mediaCacheBytes: integer("media_cache_bytes").notNull().default(0),
  thumbBytes: integer("thumb_bytes").notNull().default(0),
  diskTotal: integer("disk_total").notNull().default(0),
  diskUsed: integer("disk_used").notNull().default(0),
  diskPct: integer("disk_pct").notNull().default(0),
  byTable: text("by_table", { mode: "json" }),
});

/** 上游有配额，调用量要能看、能定位是谁打的 */
export const apiUsage = sqliteTable(
  "api_usage",
  {
    id: ulidPk(),
    endpoint: text("endpoint").notNull(),
    statusCode: integer("status_code"),
    latencyMs: integer("latency_ms"),
    triggeredBy: text("triggered_by"),
    error: text("error"),
    createdAt: now("created_at"),
  },
  (t) => [index("api_usage_created_idx").on(t.createdAt)],
);
