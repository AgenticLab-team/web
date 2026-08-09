import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * Web Push 订阅。
 *
 * 一行对应**一台设备上的一个浏览器**，不是一个用户 ——
 * 同一个人手机和电脑各订一份是正常状态，所以唯一键是 endpoint 而非 userId。
 *
 * failCount / lastError 存在的原因：推送服务对失效订阅返回 404/410，
 * 但也会出现网络抖动这类**暂时**失败。只凭一次失败就删订阅，
 * 用户会在毫不知情的情况下静默掉线 —— 他以为自己还订着。
 * 所以 404/410（订阅确实没了）立即删，其它失败只累计，
 * 连续多次才停用，而且停用记录留着，让后台能看见「谁掉了、为什么」。
 */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    /** 推送服务分配的投递地址，全局唯一 */
    endpoint: text("endpoint").notNull(),
    /** 浏览器生成的 P-256 公钥（base64url），加密载荷用 */
    p256dh: text("p256dh").notNull(),
    /** 浏览器生成的鉴权秘密（base64url），加密载荷用 */
    auth: text("auth").notNull(),
    /** 订阅时的 UA，给用户看「这是哪台设备」用 */
    userAgent: text("user_agent"),
    createdAt: now("created_at"),
    lastOkAt: integer("last_ok_at"),
    failCount: integer("fail_count").notNull().default(0),
    lastError: text("last_error"),
    /** 连续失败太多次后停用；非 null 即不再投递 */
    disabledAt: integer("disabled_at"),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_idx").on(t.endpoint),
    index("push_subscriptions_user_idx").on(t.userId, t.disabledAt),
  ],
);
