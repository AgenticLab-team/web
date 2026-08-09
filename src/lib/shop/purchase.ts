import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, sqlite } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/state";
import { makeupCards, orders, posts, shopItems, titles, userTitles } from "@/lib/db/schema";
import { findLedgerByIdempotencyKey, grantPoints, revertPoints } from "@/lib/points/ledger";
import { checkPinPurchase, pinUntil } from "@/lib/forum/pin";
import { checkPurchase, checkRefund, isInstantDelivery } from "@/lib/shop/rules";
import { expiryFor } from "@/lib/titles/rules";
import type { ShopItemKind } from "@/lib/shop/types";

/**
 * 兑换与退款。
 *
 * ─────────────────────────────────────────
 * 积分不能凭空消失，也不能凭空出现
 * ─────────────────────────────────────────
 *
 * 扣了分没下单、或者退款退出两份，都是事后极难查清的 ——
 * 用户只知道「我的分少了 300」，而流水里看不出为什么。
 *
 * 所以顺序是**先扣分拿到流水 id，再下单**：
 * 反过来的话，扣分失败会留下一张白拿的订单；
 * 而这个顺序下，下单失败会退回那笔扣分（有流水 id 就退得掉）。
 *
 * 库存扣减用与活动名额同样的手法：一条带条件的 UPDATE，
 * 「先查再改」在并发下必然超卖。
 */

export interface PurchaseResult {
  ok: boolean;
  error?: string;
  orderId?: string;
  note?: string;
}

const fail = (error: string): PurchaseResult => ({ ok: false, error });

/**
 * 置顶目标的校验。
 *
 * 全部在扣分之前跑完 —— 一个收了钱却没生效的订单，
 * 修起来要人工退款，而人工的事一定会拖。
 */
function checkPinTarget(
  buyerId: string,
  postId: string | undefined,
): { ok: true } | { ok: false; error: string } {
  if (!postId) return { ok: false, error: "要先选一个自己的帖子" };

  const post = db.select().from(posts).where(eq(posts.id, postId)).get();
  const now = Date.now();

  // 同版块当前还有效的付费置顶（不含本帖）
  const paidPins = post
    ? sqlite
        .prepare(
          `SELECT count(*) n FROM forum_posts
           WHERE board_id = ? AND id != ? AND deleted_at IS NULL
             AND pinned = 1 AND pinned_until IS NOT NULL AND pinned_until > ?`,
        )
        .get(post.boardId, postId, now)
    : { n: 0 };

  return checkPinPurchase({
    exists: Boolean(post),
    authorId: post?.authorId ?? null,
    buyerId,
    deleted: post?.deletedAt != null,
    status: post?.status ?? "",
    current: { pinned: post?.pinned ?? false, pinnedUntil: post?.pinnedUntil ?? null },
    paidPinsInBoard: (paidPins as { n: number }).n,
    now,
  });
}

export function purchaseItem(input: {
  userId: string;
  itemKey: string;
  balance: number;
  shipping?: Record<string, unknown>;
  /** 作用在某个具体对象上的商品需要它 —— 比如置顶要一个帖子 id */
  targetRef?: string;
  idempotencyKey: string;
}): PurchaseResult {
  // 关掉之后不能再下单；已有订单照常处理
  if (!isModuleEnabled("shop")) {
    return { ok: false, error: "积分商店暂时关闭了" };
  }

  const item = db
    .select()
    .from(shopItems)
    .where(and(eq(shopItems.key, input.itemKey), isNull(shopItems.deletedAt)))
    .get();
  if (!item) return fail("商品不存在");

  const owned = db
    .select({ id: orders.id })
    .from(orders)
    .where(
      sql`${orders.itemId} = ${item.id} AND ${orders.userId} = ${input.userId}
          AND ${orders.status} NOT IN ('cancelled','refunded')`,
    )
    .all().length;

  /*
   * 置顶这类「作用在某个具体东西上」的商品，要在**扣分之前**
   * 把目标验完。扣完钱再发现帖子被删了，就得走退款 —— 而退款是人工的。
   */
  if (item.kind === "highlight") {
    const pinCheck = checkPinTarget(input.userId, input.targetRef);
    if (!pinCheck.ok) return fail(pinCheck.error);
  }

  const check = checkPurchase({
    enabled: item.enabled,
    price: item.price,
    stock: item.stock,
    sold: item.sold,
    perUserLimit: item.perUserLimit,
    ownedCount: owned,
    balance: input.balance,
    kind: item.kind,
    hasShipping: Boolean(input.shipping),
  });
  if (!check.ok) return fail(check.error!);

  // 库存：一条带条件的 UPDATE，「先查再改」在并发下必然超卖
  if (item.stock !== null) {
    const claimed = db
      .update(shopItems)
      .set({ sold: sql`${shopItems.sold} + 1` })
      .where(sql`${shopItems.id} = ${item.id} AND ${shopItems.sold} < ${shopItems.stock}`)
      .run();
    if (claimed.changes === 0) return fail("刚好被抢完了");
  } else {
    db.update(shopItems)
      .set({ sold: sql`${shopItems.sold} + 1` })
      .where(eq(shopItems.id, item.id))
      .run();
  }

  /*
   * 先扣分再下单。反过来的话，扣分失败会留下一张白拿的订单；
   * 这个顺序下，下单失败可以靠流水 id 把分退回去。
   */
  const paid = grantPoints({
    userId: input.userId,
    delta: -item.price,
    reason: `兑换「${item.name}」`,
    ruleKey: "shop",
    refType: "shop_item",
    refId: item.id,
    idempotencyKey: input.idempotencyKey,
  });

  if (!paid.ok) {
    releaseStock(item.id);
    return fail(paid.error ?? "扣分失败");
  }
  if (paid.duplicate) {
    // 重复提交：分已经扣过了，订单也已经在了，直接当成功
    releaseStock(item.id);
    const existing = db.select().from(orders).where(eq(orders.ledgerId, paid.ledgerId!)).get();
    return { ok: true, orderId: existing?.id, note: "这一单已经兑换过了" };
  }

  try {
    const instant = isInstantDelivery(item.kind);
    const row = db
      .insert(orders)
      .values({
        itemId: item.id,
        userId: input.userId,
        pricePaid: item.price,
        ledgerId: paid.ledgerId,
        status: instant ? "fulfilled" : "pending",
        shipping: input.shipping ?? null,
      })
      .returning({ id: orders.id })
      .get();

    if (instant) {
      const delivered = deliver(item.kind, item.id, input.userId, row.id, {
        ...(item.config as Record<string, unknown>),
        // 目标在下单时才确定，塞进配置传给交付函数
        __postId: input.targetRef,
      });
      db.update(orders)
        .set({ fulfillResult: delivered, handledAt: Date.now() })
        .where(eq(orders.id, row.id))
        .run();
    }

    return {
      ok: true,
      orderId: row.id,
      note: instant ? "已到账" : "已下单，等管理员发货",
    };
  } catch (error) {
    /*
     * 下单失败要把**分和库存都退回去**。
     * 少退一样就是积分或库存凭空蒸发，而那是查不出来的。
     */
    releaseStock(item.id);
    if (paid.ledgerId) {
      revertPoints(paid.ledgerId, "system", "下单失败自动退回");
    }
    return fail(`下单失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function releaseStock(itemId: string) {
  db.update(shopItems)
    .set({ sold: sql`max(0, ${shopItems.sold} - 1)` })
    .where(eq(shopItems.id, itemId))
    .run();
}

/**
 * 虚拟商品的交付。
 *
 * 交付失败不抛异常 —— 抛的话整笔兑换会回滚，
 * 而有些失败（比如称号名额刚好满了）更适合留一张待人工处理的订单，
 * 而不是让用户以为「没买成」然后再点一次。
 */
function deliver(
  kind: ShopItemKind,
  itemId: string,
  userId: string,
  orderId: string,
  config: unknown,
): Record<string, unknown> {
  const cfg = (config as Record<string, unknown>) ?? {};

  if (kind === "highlight") {
    const postId = String(cfg.__postId ?? "");
    const hours = typeof cfg.hours === "number" ? cfg.hours : 24;
    const post = db.select().from(posts).where(eq(posts.id, postId)).get();
    if (!post) return { error: `找不到帖子 ${postId}，需要人工处理` };

    db.update(posts)
      .set({ pinned: true, pinnedUntil: pinUntil(hours, Date.now()) })
      .where(eq(posts.id, postId))
      .run();
    return { pinnedPost: postId, hours };
  }

  if (kind === "makeup_card") {
    const count = typeof cfg.count === "number" ? cfg.count : 1;
    for (let i = 0; i < count; i++) {
      db.insert(makeupCards).values({ userId, orderId }).run();
    }
    return { makeupCards: count };
  }

  if (kind === "title") {
    const titleKey = String(cfg.titleKey ?? "");
    const title = db.select().from(titles).where(eq(titles.key, titleKey)).get();
    if (!title) return { error: `找不到称号 ${titleKey}，需要人工处理` };

    const already = db
      .select()
      .from(userTitles)
      .where(
        and(
          eq(userTitles.userId, userId),
          eq(userTitles.titleId, title.id),
          isNull(userTitles.revokedAt),
        ),
      )
      .get();
    if (already) return { error: "已经有这个称号了，需要人工处理" };

    db.insert(userTitles)
      .values({
        userId,
        titleId: title.id,
        source: "purchase",
        pricePaid: null,
        expiresAt: expiryFor(
          {
            id: title.id,
            key: title.key,
            name: title.name,
            rarity: title.rarity,
            source: title.source,
            price: title.price,
            rentDays: title.rentDays,
            limitCount: title.limitCount,
            enabled: title.enabled,
          },
          Date.now(),
        ),
      })
      .run();
    return { title: title.key };
  }

  return { kind, note: "无需自动交付" };
}

export interface RefundResult {
  ok: boolean;
  error?: string;
}

/**
 * 退款。
 *
 * **走冲正而不是凭空加分。** 凭空加的话积分总量会悄悄多出来，
 * 而通胀体检看到的是「有人白拿了分」却查不出源头。
 */
export function refundOrder(input: {
  orderId: string;
  reason: string;
  operatorId: string;
}): RefundResult {
  const order = db.select().from(orders).where(eq(orders.id, input.orderId)).get();
  if (!order) return { ok: false, error: "订单不存在" };

  const check = checkRefund({
    status: order.status,
    ledgerId: order.ledgerId,
    reason: input.reason,
  });
  if (!check.ok) return { ok: false, error: check.error };

  const result = revertPoints(order.ledgerId!, input.operatorId, `订单退款：${input.reason}`);
  if (!result.ok) return { ok: false, error: result.error };

  db.transaction((tx) => {
    tx.update(orders)
      .set({
        status: "refunded",
        refundReason: input.reason,
        handledBy: input.operatorId,
        handledAt: Date.now(),
        updatedAt: Date.now(),
      })
      .where(eq(orders.id, input.orderId))
      .run();

    // 退了款库存要还回去，否则退一单就少一件永远卖不出去
    tx.update(shopItems)
      .set({ sold: sql`max(0, ${shopItems.sold} - 1)` })
      .where(eq(shopItems.id, order.itemId))
      .run();
  });

  return { ok: true };
}

/** 库存对账：卖出数与有效订单数是否一致 */
export function auditStock(itemId: string) {
  const item = db.select().from(shopItems).where(eq(shopItems.id, itemId)).get();
  const live = db
    .select({ id: orders.id })
    .from(orders)
    .where(
      sql`${orders.itemId} = ${itemId} AND ${orders.status} NOT IN ('cancelled','refunded')`,
    )
    .all().length;

  return {
    cached: item?.sold ?? 0,
    computed: live,
    consistent: (item?.sold ?? 0) === live,
  };
}

/** 找回幂等键对应的流水 —— 重复提交时用它定位已有订单 */
export { findLedgerByIdempotencyKey };
