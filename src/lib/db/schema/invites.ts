import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 邀请。
 *
 * 现阶段只有群成员能登录，邀请是**为外部用户预留的通道** ——
 * 表和流程先做好，开不开由功能开关决定。
 *
 * 两条设计上的硬决定：
 *
 * ① **奖励延迟发放。** 注册即给的话，拉一堆僵尸号就能刷分，
 *   而拉僵尸号的成本几乎为零。所以要等被邀请人**真的做了点什么**
 *   （完成首次打卡 —— 那本身就要求群里发言或论坛活跃达标）才发。
 *
 * ② **只奖励直接邀请，没有多级。** A 邀 B、B 邀 C 时 A 不从 C 身上拿好处。
 *   多级奖励是传销的结构，它会把社区变成拉人游戏，
 *   而拉来的人不是冲着社区来的。
 */
export const invites = sqliteTable(
  "invites",
  {
    id: ulidPk(),
    /** 给人念、给人抄的码，避开了形近字符 */
    code: text("code").notNull().unique(),
    createdBy: text("created_by").notNull(),
    note: text("note"),

    /** 最多能用几次。null 表示不限 —— 但界面上默认给个有限值 */
    maxUses: integer("max_uses"),
    usedCount: integer("used_count").notNull().default(0),
    expiresAt: integer("expires_at"),

    /** 用这个码注册的人自动获得的身份组 */
    grantRoleId: text("grant_role_id"),
    /** 注册成什么类型。外部用户看不到群相关的一切 */
    grantKind: text("grant_kind", { enum: ["member", "external"] })
      .notNull()
      .default("external"),

    revokedAt: integer("revoked_at"),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason"),

    createdAt: now("created_at"),
  },
  (t) => [
    index("invites_creator_idx").on(t.createdBy, t.createdAt),
    index("invites_active_idx").on(t.revokedAt, t.expiresAt),
  ],
);

/**
 * 每一次使用。
 *
 * 奖励挂在这里而不是 invites 上：一个码可以被多个人用，
 * 每个人的奖励要能**单独回滚** —— 其中一个是小号不该牵连其他人。
 */
export const inviteUses = sqliteTable(
  "invite_uses",
  {
    id: ulidPk(),
    inviteId: text("invite_id").notNull(),
    inviterId: text("inviter_id").notNull(),
    invitedUserId: text("invited_user_id").notNull(),
    ip: text("ip"),

    /** 奖励发放时间。null 表示还没到发放门槛 */
    rewardedAt: integer("rewarded_at"),
    rewardPoints: integer("reward_points"),

    /** 奖励被回滚（被邀请人被封等） */
    revertedAt: integer("reverted_at"),
    revertReason: text("revert_reason"),

    createdAt: now("created_at"),
  },
  (t) => [
    // 一个人只能被邀请一次 —— 否则可以反复注销重注册刷奖励
    uniqueIndex("invite_uses_user_idx").on(t.invitedUserId),
    index("invite_uses_invite_idx").on(t.inviteId),
    index("invite_uses_inviter_idx").on(t.inviterId),
  ],
);
