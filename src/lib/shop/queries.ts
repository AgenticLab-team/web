import "server-only";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { makeupCards, orders, posts, shopItems, users } from "@/lib/db/schema";
import { isEffectivelyPinned } from "@/lib/forum/pin";
import { itemKindLabel, orderStatusLabel, remainingStock } from "@/lib/shop/rules";
import type { OrderStatus, ShopItemKind } from "@/lib/shop/types";
import { resolveDisplayName } from "@/lib/users/display-name";

/** 商店的读取层 */

export interface ItemRow {
  id: string;
  key: string;
  kind: ShopItemKind;
  kindLabel: string;
  name: string;
  description: string | null;
  icon: string | null;
  price: number;
  stock: number | null;
  sold: number;
  remaining: number | null;
  perUserLimit: number | null;
  enabled: boolean;
  config: Record<string, unknown>;
  /** 卖出数与有效订单数不一致 */
  drifted: boolean;
}

export function listItems(includeDisabled = false): ItemRow[] {
  const rows = db
    .select()
    .from(shopItems)
    .where(isNull(shopItems.deletedAt))
    .orderBy(desc(shopItems.sort), shopItems.price)
    .all();

  const live = new Map<string, number>();
  for (const row of db
    .select({ itemId: orders.itemId, n: sql<number>`count(*)` })
    .from(orders)
    .where(sql`${orders.status} NOT IN ('cancelled','refunded')`)
    .groupBy(orders.itemId)
    .all()) {
    live.set(row.itemId, Number(row.n));
  }

  return rows
    .filter((r) => includeDisabled || r.enabled)
    .map((r) => ({
      id: r.id,
      key: r.key,
      kind: r.kind,
      kindLabel: itemKindLabel(r.kind),
      name: r.name,
      description: r.description,
      icon: r.icon,
      price: r.price,
      stock: r.stock,
      sold: r.sold,
      remaining: remainingStock(r.stock, r.sold),
      perUserLimit: r.perUserLimit,
      enabled: r.enabled,
      config: (r.config as Record<string, unknown>) ?? {},
      drifted: r.sold !== (live.get(r.id) ?? 0),
    }));
}

export interface OrderRow {
  id: string;
  itemName: string;
  itemKind: string;
  userId: string;
  userName: string;
  pricePaid: number;
  status: OrderStatus;
  statusLabel: string;
  shipping: Record<string, unknown> | null;
  trackingNo: string | null;
  fulfillResult: Record<string, unknown> | null;
  refundReason: string | null;
  createdAt: number;
}

export function listOrders(
  query: { userId?: string; status?: string; limit?: number } = {},
): OrderRow[] {
  const conditions = [];
  if (query.userId) conditions.push(eq(orders.userId, query.userId));
  if (query.status) conditions.push(eq(orders.status, query.status as "pending"));

  return db
    .select({
      order: orders,
      itemName: shopItems.name,
      itemKind: shopItems.kind,
      site: users.siteNickname,
      wx: users.wxNickname,
      wxId: users.wxId,
    })
    .from(orders)
    .innerJoin(shopItems, eq(shopItems.id, orders.itemId))
    .leftJoin(users, eq(users.id, orders.userId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(orders.createdAt))
    .limit(Math.min(query.limit ?? 100, 300))
    .all()
    .map(({ order, itemName, itemKind, site, wx, wxId }) => ({
      id: order.id,
      itemName,
      itemKind: itemKindLabel(itemKind),
      userId: order.userId,
      userName: resolveDisplayName([site, wx], { wxId, fallback: "社区成员" }),
      pricePaid: order.pricePaid,
      status: order.status,
      statusLabel: orderStatusLabel(order.status),
      shipping: (order.shipping as Record<string, unknown>) ?? null,
      trackingNo: order.trackingNo,
      fulfillResult: (order.fulfillResult as Record<string, unknown>) ?? null,
      refundReason: order.refundReason,
      createdAt: order.createdAt,
    }));
}

/** 这个人已经买过几次某个商品 —— 界面上要提前显示「已达上限」 */
export function ownedCounts(userId: string): Map<string, number> {
  const rows = db
    .select({ itemId: orders.itemId, n: sql<number>`count(*)` })
    .from(orders)
    .where(
      sql`${orders.userId} = ${userId} AND ${orders.status} NOT IN ('cancelled','refunded')`,
    )
    .groupBy(orders.itemId)
    .all();
  return new Map(rows.map((r) => [r.itemId, Number(r.n)]));
}

/** 没用掉的补签卡 */
export function unusedMakeupCards(userId: string): number {
  return db
    .select({ id: makeupCards.id })
    .from(makeupCards)
    .where(and(eq(makeupCards.userId, userId), isNull(makeupCards.usedAt)))
    .all().length;
}

/**
 * 待处理的实物订单。
 *
 * 这是后台唯一必须每天看的商店视图 ——
 * 虚拟商品自动交付，只有实物会积压，而积压久了就是失信。
 */
export function pendingShipments(): OrderRow[] {
  return listOrders({ status: "pending" }).filter((o) => o.shipping !== null);
}

/**
 * 我名下可以买置顶的帖子。
 *
 * 已经在置顶中的不列 —— 让人选一个买不了的选项，
 * 只会得到一次「兑换失败」和一次疑惑。
 */
export function pinnablePosts(userId: string, now = Date.now()) {
  return db
    .select({
      id: posts.id,
      title: posts.title,
      createdAt: posts.createdAt,
      pinnedUntil: posts.pinnedUntil,
      pinned: posts.pinned,
    })
    .from(posts)
    .where(
      and(
        eq(posts.authorId, userId),
        eq(posts.status, "published"),
        isNull(posts.deletedAt),
      ),
    )
    .orderBy(desc(posts.createdAt))
    .limit(20)
    .all()
    .filter((p) => !isEffectivelyPinned(p, now))
    .map((p) => ({ id: p.id, title: p.title, createdAt: p.createdAt }));
}
