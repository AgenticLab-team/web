"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireAdmin, requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { orders, shopItems } from "@/lib/db/schema";
import { notify } from "@/lib/forum/notify";
import { purchaseItem, refundOrder } from "@/lib/shop/purchase";
import { canTransitionOrder, checkItem } from "@/lib/shop/rules";
import type { OrderStatus, ShopItemKind } from "@/lib/shop/types";

/**
 * 商店的服务端动作。
 *
 * 兑换的实际逻辑在 purchase.ts（可单测），这里只做鉴权与通知。
 */

export interface ShopResult {
  ok: boolean;
  error?: string;
  note?: string;
}

const fail = (error: string): ShopResult => ({ ok: false, error });

export async function buyItem(input: {
  itemKey: string;
  shipping?: Record<string, unknown>;
  /** 作用在具体对象上的商品需要它 —— 置顶要一个帖子 id */
  targetRef?: string;
  /** 前端生成，防重复提交 */
  clientToken: string;
}): Promise<ShopResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const result = purchaseItem({
    userId: user.id,
    itemKey: input.itemKey,
    balance: user.points,
    shipping: input.shipping,
    targetRef: input.targetRef,
    // 幂等键带上用户与商品：换个商品应该是新的一单
    idempotencyKey: `shop:${user.id}:${input.itemKey}:${input.clientToken}`,
  });

  if (!result.ok) return fail(result.error!);

  revalidatePath("/shop");
  revalidatePath("/me");
  return { ok: true, note: result.note };
}

export async function saveItem(input: {
  id?: string;
  key: string;
  kind: ShopItemKind;
  name: string;
  description?: string;
  icon?: string;
  price: number;
  stock: number | null;
  perUserLimit: number | null;
  config: Record<string, unknown>;
  enabled: boolean;
}): Promise<ShopResult> {
  const admin = await requireWritableAdmin("shop.manage");

  const check = checkItem(input);
  if (!check.ok) return fail(check.error!);

  const values = {
    key: input.key,
    kind: input.kind,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    icon: input.icon || null,
    price: input.price,
    stock: input.stock,
    perUserLimit: input.perUserLimit,
    config: input.config,
    enabled: input.enabled,
    updatedAt: Date.now(),
  };

  if (input.id) {
    db.update(shopItems).set(values).where(eq(shopItems.id, input.id)).run();
  } else {
    const clash = db.select().from(shopItems).where(eq(shopItems.key, input.key)).get();
    if (clash) return fail("这个商品标识已经用过了");
    db.insert(shopItems).values({ ...values, createdBy: admin.user.id }).run();
  }

  audit({ actorId: admin.user.id }, {
    action: "shop.manage",
    targetType: "shop_item",
    targetId: input.key,
    after: { name: input.name, price: input.price, enabled: input.enabled },
  });

  revalidatePath("/admin/shop");
  revalidatePath("/shop");
  return { ok: true };
}

export async function updateOrderStatus(input: {
  id: string;
  status: OrderStatus;
  note: string;
  trackingNo?: string;
}): Promise<ShopResult> {
  const admin = await requireWritableAdmin("shop.order.handle");

  const order = db.select().from(orders).where(eq(orders.id, input.id)).get();
  if (!order) return fail("订单不存在");
  if (!input.note.trim()) return fail("必须写明处理说明 —— 用户会看到");

  const check = canTransitionOrder(order.status, input.status);
  if (!check.ok) return fail(check.error!);

  db.update(orders)
    .set({
      status: input.status,
      note: input.note.trim(),
      trackingNo: input.trackingNo?.trim() || order.trackingNo,
      handledBy: admin.user.id,
      handledAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(orders.id, input.id))
    .run();

  // 状态变了要通知 —— 用户不会每天来刷订单页
  notify({
    userId: order.userId,
    type: "system",
    groupKey: `order:${order.id}`,
    title: "你的兑换订单有新进展",
    body: input.note.trim(),
    link: "/shop",
    actorId: admin.user.id,
  });

  audit({ actorId: admin.user.id }, {
    action: "shop.order.handle",
    targetType: "order",
    targetId: input.id,
    before: { status: order.status },
    after: { status: input.status },
    reason: input.note,
  });

  revalidatePath("/admin/shop");
  return { ok: true };
}

export async function refund(input: { id: string; reason: string }): Promise<ShopResult> {
  const admin = await requireAdmin("shop.order.handle");

  const order = db.select().from(orders).where(eq(orders.id, input.id)).get();
  if (!order) return fail("订单不存在");

  const result = refundOrder({
    orderId: input.id,
    reason: input.reason,
    operatorId: admin.user.id,
  });
  if (!result.ok) return fail(result.error!);

  notify({
    userId: order.userId,
    type: "system",
    groupKey: `order:${order.id}`,
    title: "你的兑换已退款",
    body: `${input.reason}。${order.pricePaid} 分已经退回你的账户。`,
    link: "/shop",
    actorId: admin.user.id,
  });

  audit({ actorId: admin.user.id }, {
    action: "shop.order.handle",
    targetType: "order",
    targetId: input.id,
    after: { refunded: true, points: order.pricePaid },
    reason: input.reason,
  });

  revalidatePath("/admin/shop");
  return { ok: true, note: `已退款 ${order.pricePaid} 分` };
}
