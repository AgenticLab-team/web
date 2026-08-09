import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 商店与订单。
 *
 * 商店在这套系统里的位置不是「多一个玩法」，是**积分的主要回收口**。
 * 只发不收的积分一年后必然废掉（见 ECONOMY.md），
 * 而商店是把积分真正销毁掉的地方。
 *
 * 两类商品的差别很大：
 *   虚拟（称号、补签卡、置顶位）—— 兑换即交付，没有后续
 *   实物（周边）—— 要发货、要地址、可能寄丢，状态流转长得多
 * 所以订单的状态机按 kind 分叉。
 */

export const SHOP_ITEM_KINDS = ["title", "makeup_card", "highlight", "physical", "custom"] as const;

export const ORDER_STATUSES = [
  "pending",
  "fulfilled",
  "shipping",
  "delivered",
  "cancelled",
  "refunded",
] as const;

export const shopItems = sqliteTable(
  "shop_items",
  {
    id: ulidPk(),
    key: text("key").notNull().unique(),
    kind: text("kind", { enum: SHOP_ITEM_KINDS }).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon"),

    price: integer("price").notNull(),
    /**
     * 库存。null = 不限量。
     * **stock 是缓存列**，真值是订单数 —— 与活动名额同一个道理：
     * 数错了要能事后重算，而不是只能相信一个数字。
     */
    stock: integer("stock"),
    sold: integer("sold").notNull().default(0),
    /** 每人最多买几次。null = 不限 */
    perUserLimit: integer("per_user_limit"),

    /** 商品专属配置：称号 key、补签卡张数、置顶天数… */
    config: text("config", { mode: "json" }),

    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    sort: integer("sort").notNull().default(0),

    createdBy: text("created_by"),
    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("shop_items_enabled_idx").on(t.enabled, t.sort)],
);

export const orders = sqliteTable(
  "orders",
  {
    id: ulidPk(),
    itemId: text("item_id").notNull(),
    userId: text("user_id").notNull(),

    /** 下单时的价格。事后调价不影响已有订单的对账 */
    pricePaid: integer("price_paid").notNull(),
    /** 扣分那一笔流水。退款要靠它冲正 —— 没有它就退不了 */
    ledgerId: text("ledger_id"),

    status: text("status", { enum: ORDER_STATUSES }).notNull().default("pending"),

    /** 实物商品的收货信息。虚拟商品为空 */
    shipping: text("shipping", { mode: "json" }),
    trackingNo: text("tracking_no"),

    /** 交付结果：发了什么称号、加了几张补签卡 */
    fulfillResult: text("fulfill_result", { mode: "json" }),
    note: text("note"),

    handledBy: text("handled_by"),
    handledAt: integer("handled_at"),
    refundReason: text("refund_reason"),

    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
  },
  (t) => [
    index("orders_user_idx").on(t.userId, t.createdAt),
    index("orders_status_idx").on(t.status, t.createdAt),
    index("orders_item_idx").on(t.itemId),
    // 幂等：同一次点击重复提交不会下两单
    uniqueIndex("orders_ledger_idx").on(t.ledgerId),
  ],
);

/** 补签卡库存。买了先存着，需要时再用 */
export const makeupCards = sqliteTable(
  "makeup_cards",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    orderId: text("order_id"),
    /** 用掉的日期。null 表示还没用 */
    usedForDate: text("used_for_date"),
    usedAt: integer("used_at"),
    expiresAt: integer("expires_at"),
    createdAt: now("created_at"),
  },
  (t) => [index("makeup_cards_user_idx").on(t.userId, t.usedAt)],
);
