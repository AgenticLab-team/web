import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 权限点字典。由代码定义、启动时同步入库，后台只读。
 * 任何地方都不许写 `if (role === 'admin')` —— 一律走权限点。
 */
export const permissions = sqliteTable("permissions", {
  key: text("key").primaryKey(),
  category: text("category").notNull(),
  label: text("label").notNull(),
  description: text("description"),
  /** 是否支持范围限定（限某版块 / 某群 / 某活动） */
  scopable: integer("scopable", { mode: "boolean" }).notNull().default(false),
  /** 0 普通 / 1 敏感 / 2 危险（需重新验证身份）/ 3 极危（需双人复核） */
  dangerLevel: integer("danger_level").notNull().default(0),
  sort: integer("sort").notNull().default(0),
});

/**
 * 身份组。内置 8 个不可删，但结构上支持无限自定义 ——
 * 将来加「讲师」「赞助商」「元老」只需后台建组勾权限，不改代码。
 */
export const roles = sqliteTable(
  "roles",
  {
    id: ulidPk(),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),

    /** 前台视觉标识：身份组是荣誉，不只是权限容器 */
    color: text("color"),
    icon: text("icon"),
    badgeStyle: text("badge_style"),
    /** 多身份组时按此决定展示哪个 */
    priority: integer("priority").notNull().default(0),

    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    assignable: integer("assignable", { mode: "boolean" }).notNull().default(true),
    maxHolders: integer("max_holders"),
    /** 自动授予条件，复用活动系统的资格引擎规则 JSON */
    autoGrantRule: text("auto_grant_rule", { mode: "json" }),
    /** 不再满足条件时是否自动回收 */
    autoRevoke: integer("auto_revoke", { mode: "boolean" }).notNull().default(false),

    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
    createdBy: text("created_by"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("roles_priority_idx").on(t.priority)],
);

/** granted=false 表示显式拒绝，优先级高于任何允许 */
export const rolePermissions = sqliteTable(
  "role_permissions",
  {
    roleId: text("role_id").notNull(),
    permissionKey: text("permission_key").notNull(),
    granted: integer("granted", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("role_permissions_pk").on(t.roleId, t.permissionKey)],
);

/**
 * 授予记录。scope 让「#1 群的群管理员」「技术版版主」成为可能，
 * expiresAt 让临时提权到期自动回收，避免权限只增不减。
 */
export const userRoles = sqliteTable(
  "user_roles",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    roleId: text("role_id").notNull(),

    scopeType: text("scope_type", { enum: ["board", "group", "activity"] }),
    scopeId: text("scope_id"),

    grantedBy: text("granted_by"),
    grantedAt: now("granted_at"),
    grantReason: text("grant_reason"),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason"),
  },
  (t) => [
    index("user_roles_user_idx").on(t.userId),
    index("user_roles_role_idx").on(t.roleId),
    uniqueIndex("user_roles_unique_idx").on(t.userId, t.roleId, t.scopeType, t.scopeId),
  ],
);

/** 用户级例外：偶尔要给单个人开口子，不值得为此建一个角色 */
export const permissionOverrides = sqliteTable(
  "permission_overrides",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    permissionKey: text("permission_key").notNull(),
    granted: integer("granted", { mode: "boolean" }).notNull(),
    scopeType: text("scope_type"),
    scopeId: text("scope_id"),
    reason: text("reason").notNull(),
    grantedBy: text("granted_by").notNull(),
    grantedAt: now("granted_at"),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("permission_overrides_user_idx").on(t.userId)],
);

/** 权限矩阵版本快照，支持一键回滚到某个时间点 */
export const roleSnapshots = sqliteTable("role_snapshots", {
  id: ulidPk(),
  takenAt: now("taken_at"),
  takenBy: text("taken_by"),
  note: text("note"),
  payload: text("payload", { mode: "json" }).notNull(),
});
