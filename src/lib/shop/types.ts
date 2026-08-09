import type { ORDER_STATUSES, SHOP_ITEM_KINDS } from "@/lib/db/schema/shop";

/**
 * 商店的共享类型。
 *
 * 单独一个文件，让 rules.ts 保持纯逻辑、不把 drizzle 拖进测试。
 */

export type ShopItemKind = (typeof SHOP_ITEM_KINDS)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];
