import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/** 账号主体。wx_id 为空表示尚未绑定微信（external 用户或绑定流程未完成） */
export const users = sqliteTable(
  "users",
  {
    id: ulidPk(),
    wxId: text("wx_id").unique(),

    /** 上游同步，用户不可编辑 */
    wxNickname: text("wx_nickname"),
    wxAvatarUrl: text("wx_avatar_url"),
    /** 用户自设，覆盖显示 */
    siteNickname: text("site_nickname"),
    bio: text("bio"),

    /**
     * 从成员目录里隐身。
     *
     * 默认**不隐身** —— 目录只对同群的人可见，而同群的人本来就在微信里
     * 看得到你的名字，所以这不构成新的暴露；默认隐身则会让目录一直是空的，
     * 而一个空目录没人会再打开第二次。
     * 想彻底不出现的人有这个开关。
     */
    directoryHidden: integer("directory_hidden", { mode: "boolean" })
      .notNull()
      .default(false),

    /**
     * 自己起的登录名。
     *
     * 微信 ID 记不住 —— 真实的那个长这样：`wxid_examplemember01`，
     * 系统分配、绝大多数人从来没见过。于是「密码兜底登录」
     * 对最需要它的人等于不存在。
     *
     * **统一存小写**：不统一的话 `Admin` 和 `admin` 是两个账号，
     * 而它们在页面上长得几乎一样，这是最省事的一种冒充。
     * 格式与保留词见 lib/auth/login-name.ts。
     */
    username: text("username").unique(),

    /**
     * 手机号。**没有经过验证** —— 这个站没有短信通道。
     *
     * 所以它的地位和登录名完全一样：一个自己挑的、恰好好记的字符串。
     * 由此有两条线：不能用它找回账号（否则等于填上别人的号码就能接管），
     * 也不在任何地方显示或用它搜人（它是真实世界的身份）。
     */
    phone: text("phone").unique(),
    /** 留给真有短信通道的那天。在那之前永远是 null —— 比一个假装验证过的布尔安全 */
    phoneVerifiedAt: integer("phone_verified_at"),

    email: text("email").unique(),
    emailVerifiedAt: integer("email_verified_at"),

    /**
     * 明确表过态：「这个账号就是不设密码」。
     *
     * 没有这一列的话，「还没设密码」和「决定不设密码」在数据上
     * 长得一模一样 —— 于是安全页只能对着后者反复劝设密码，
     * 而被反复劝的人最后会把真正重要的提醒也一起无视掉。
     * 存时间戳而不是布尔：翻旧账时「什么时候决定的」就是证据。
     * 设置密码时必须清掉它（见 password-actions），两个状态不能并存。
     */
    passwordOptOutAt: integer("password_opt_out_at"),

    /**
     * 「加个 Passkey 吧」这条提醒被推掉的时刻（「以后再说」）。
     *
     * 存在服务端而不是 localStorage，是因为**两份状态迟早会分叉**，
     * 而分叉那天用户看到的是一个点不掉的东西：他在手机上划掉了，
     * 换到电脑上它还在；清一次缓存，它又回来了。
     * 这个项目刚修过一个同源的 bug（通知重复弹出，根因是「已读」没落库），
     * 不必再踩第二遍。
     *
     * 存的是**推掉的那一刻**，不是「推到哪天」——「隔多久再提」是条规则
     * （见 passkey-nudge-rules.ts 的 SNOOZE_DAYS），规则改了不用迁移数据。
     */
    passkeyNudgeSnoozedAt: integer("passkey_nudge_snoozed_at"),

    /**
     * 「不用了」——明确表过态，这条提醒永远不再出现。
     *
     * 它说的是**「别再提醒我」，不是「这个账号永不使用 Passkey」**。
     * 两者差别很实在：这个人随时可以自己去 /me/security 加一个；
     * 而他哪天被授了危险级权限，管理员强制 Passkey 那条线照常生效 ——
     * 那条线读的是权限和凭证，从来不读这一列。
     *
     * 和 passwordOptOutAt 一样存时间戳而不是布尔：翻旧账时
     * 「什么时候决定的」就是证据。
     */
    passkeyNudgeDeclinedAt: integer("passkey_nudge_declined_at"),

    kind: text("kind", { enum: ["member", "external", "bot", "system"] })
      .notNull()
      .default("member"),
    status: text("status", {
      enum: ["pending", "active", "suspended", "banned", "left", "deleted"],
    })
      .notNull()
      .default("pending"),

    level: integer("level").notNull().default(1),
    /** 当前佩戴的称号。可以持有多个，但只展示一个 —— 挂满一排等于都没挂 */
    activeTitleId: text("active_title_id"),
    /** 冗余缓存列，真值是 points_ledger 之和；后台可重算比对 */
    points: integer("points").notNull().default(0),
    /** 累计获得（只增不减），用于等级计算 */
    pointsTotal: integer("points_total").notNull().default(0),

    streakCurrent: integer("streak_current").notNull().default(0),
    streakBest: integer("streak_best").notNull().default(0),
    lastCheckinDate: text("last_checkin_date"),

    invitedBy: text("invited_by"),
    firstBoundAt: integer("first_bound_at"),
    lastActiveAt: integer("last_active_at"),

    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
    deletedAt: integer("deleted_at"),
    deletedBy: text("deleted_by"),
    deleteReason: text("delete_reason"),
    meta: text("meta", { mode: "json" }),
  },
  (t) => [
    index("users_status_idx").on(t.status),
    index("users_kind_idx").on(t.kind),
    index("users_points_idx").on(t.points),
    index("users_last_active_idx").on(t.lastActiveAt),
  ],
);

/** 登录凭证。绑定成功后强制引导设置至少一种，之后不再依赖微信 */
export const credentials = sqliteTable(
  "credentials",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    type: text("type", { enum: ["passkey", "password", "email_magic", "totp"] }).notNull(),
    /** 用户可命名，如「我的 iPhone」 */
    name: text("name"),

    /** passkey: credentialID(base64url) */
    credentialId: text("credential_id").unique(),
    /** passkey 公钥 或 password 的 argon2id 哈希 */
    secret: text("secret").notNull(),
    /** WebAuthn 签名计数器，用于检测凭证克隆 */
    counter: integer("counter").notNull().default(0),
    transports: text("transports", { mode: "json" }),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),

    lastUsedAt: integer("last_used_at"),
    lastUsedIp: text("last_used_ip"),

    createdAt: now("created_at"),
    revokedAt: integer("revoked_at"),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason"),
  },
  (t) => [index("credentials_user_idx").on(t.userId, t.type)],
);

/** 会话与设备。后台可远程下线 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    deviceName: text("device_name"),
    ip: text("ip"),
    userAgent: text("user_agent"),

    createdAt: now("created_at"),
    lastSeenAt: now("last_seen_at"),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    revokedBy: text("revoked_by"),
    /**
     * 为什么下线的。**是一张封闭的表，不是自由文本** ——
     * 用户在「登录历史」里看到「这台被下线了」时，
     * 得到的必须是一个说得清的原因，而不是某次实现里顺手写的一句话。
     *
     * `session_cap` = 同时登录的设备太多，自动下线了最久没用的那几台。
     */
    revokeReason: text("revoke_reason", {
      enum: ["logout", "admin", "credential_change", "expired", "ban", "session_cap"],
    }),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

/** 登录尝试，成功失败都记；用于限流、异常告警、用户自查 */
export const loginAttempts = sqliteTable(
  "login_attempts",
  {
    id: ulidPk(),
    userId: text("user_id"),
    identifier: text("identifier"),
    method: text("method").notNull(),
    success: integer("success", { mode: "boolean" }).notNull(),
    failureReason: text("failure_reason"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: now("created_at"),
  },
  (t) => [
    index("login_attempts_ip_idx").on(t.ip, t.createdAt),
    index("login_attempts_user_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * 绑定验证码。三条通道共用一张表：
 *   friend_request — 加机器人好友，验证码写在申请理由里（无需通过好友）
 *   direct_message — 私聊机器人发送验证码
 *   group_message  — 在任意含机器人的群里发送「登录 <码>」（兜底，15 秒后提示）
 *
 * matchedSource 保留命中的原文，绑定纠纷时这是唯一证据。
 */
export const bindCodes = sqliteTable(
  "bind_codes",
  {
    id: ulidPk(),
    code: text("code").notNull(),
    /** 预创建的待绑定账号；绑定成功后写入 wx_id */
    userId: text("user_id"),
    sessionNonce: text("session_nonce").notNull(),

    status: text("status", { enum: ["pending", "used", "expired", "revoked"] })
      .notNull()
      .default("pending"),
    matchedChannel: text("matched_channel", {
      enum: ["friend_request", "direct_message", "group_message"],
    }),
    matchedWxId: text("matched_wx_id"),
    matchedConvId: text("matched_conv_id"),
    /** 命中的申请理由或消息原文 */
    matchedSource: text("matched_source"),
    matchedAt: integer("matched_at"),

    issuedIp: text("issued_ip"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: now("created_at"),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
  },
  (t) => [
    index("bind_codes_code_idx").on(t.code, t.status),
    index("bind_codes_expires_idx").on(t.expiresAt),
  ],
);

/** 隐私开关。群聊可检索这件事需要它来平衡 */
export const userPrivacy = sqliteTable("user_privacy", {
  userId: text("user_id").primaryKey(),
  hideFromLeaderboard: integer("hide_from_leaderboard", { mode: "boolean" })
    .notNull()
    .default(false),
  hideActivityHours: integer("hide_activity_hours", { mode: "boolean" }).notNull().default(false),
  searchableByOthers: integer("searchable_by_others", { mode: "boolean" }).notNull().default(true),
  updatedAt: now("updated_at"),
});

/** 管理员对用户的备注，用户不可见。运营连续性靠这个 */
export const userNotes = sqliteTable(
  "user_notes",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    authorId: text("author_id").notNull(),
    content: text("content").notNull(),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    createdAt: now("created_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("user_notes_user_idx").on(t.userId)],
);

/**
 * WebAuthn 挑战值。
 *
 * 注册与验证是两次独立请求，挑战值必须服务端留存 ——
 * 放在 cookie 里等于让客户端自己保管自己的考题。
 *
 * TTL 很短（默认 5 分钟），用完即焚：同一个挑战值被复用就是重放攻击的入口。
 */
export const webauthnChallenges = sqliteTable(
  "webauthn_challenges",
  {
    id: ulidPk(),
    challenge: text("challenge").notNull(),
    kind: text("kind", { enum: ["registration", "authentication"] }).notNull(),
    /** 注册时是目标用户；无用户名登录时为空 */
    userId: text("user_id"),
    ip: text("ip"),
    createdAt: now("created_at"),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
  },
  (t) => [
    index("webauthn_challenges_challenge_idx").on(t.challenge),
    index("webauthn_challenges_expires_idx").on(t.expiresAt),
  ],
);
