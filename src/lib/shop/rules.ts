/**
 * 商店的判定规则。纯函数。
 *
 * ─────────────────────────────────────────
 * 商店是积分的主要回收口
 * ─────────────────────────────────────────
 *
 * 只发不收的积分一年后必然废掉（见 ECONOMY.md），
 * 而商店是把积分真正销毁掉的地方。所以这里的规则要同时管两头：
 *
 *   对用户：别让他买到一个买不了的东西（库存、限购、余额）
 *   对系统：别让积分**凭空消失或凭空出现**
 *
 * 后者更要命 —— 扣了分没下单，或者退款退出两份，
 * 都是事后极难查清的。
 */

import type { OrderStatus, ShopItemKind } from "@/lib/shop/types";

export interface RuleResult {
  ok: boolean;
  error?: string;
}

const OK: RuleResult = { ok: true };
const no = (error: string): RuleResult => ({ ok: false, error });

export interface PurchaseInput {
  enabled: boolean;
  price: number;
  stock: number | null;
  sold: number;
  perUserLimit: number | null;
  /** 这个人已经买过几次 */
  ownedCount: number;
  balance: number;
  /** 实物商品要收货地址 */
  kind: ShopItemKind;
  hasShipping: boolean;
}

export function checkPurchase(input: PurchaseInput): RuleResult {
  if (!input.enabled) return no("这个商品已经下架了");
  if (input.price <= 0) return no("这个商品还没定价");

  if (input.stock !== null && input.sold >= input.stock) return no("已经卖完了");

  if (input.perUserLimit !== null && input.ownedCount >= input.perUserLimit) {
    return no(`每人最多兑换 ${input.perUserLimit} 次`);
  }

  if (input.balance < input.price) {
    // 说清楚还差多少，而不是笼统地说「积分不足」
    return no(`还差 ${input.price - input.balance} 分`);
  }

  /*
   * 实物商品没地址就不给下单。
   * 让它下单成功再问地址的话，会出现一批「已付款但发不出去」的订单，
   * 而那时积分已经扣了。
   */
  if (input.kind === "physical" && !input.hasShipping) {
    return no("实物商品要填收货信息");
  }

  return OK;
}

/** 虚拟商品兑换即交付，没有后续；实物要走发货流程 */
export function isInstantDelivery(kind: ShopItemKind): boolean {
  return kind !== "physical";
}

const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["fulfilled", "shipping", "cancelled", "refunded"],
  // 虚拟商品交付后仍可退（比如发错了），但要人工处理
  fulfilled: ["refunded"],
  shipping: ["delivered", "refunded"],
  // 已签收之后不再退 —— 东西已经在对方手里了
  delivered: [],
  cancelled: [],
  refunded: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): RuleResult {
  if (from === to) return no("状态没有变化");
  const allowed = ORDER_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return no(`不能从「${orderStatusLabel(from)}」变成「${orderStatusLabel(to)}」`);
  }
  return OK;
}

export interface RefundInput {
  status: OrderStatus;
  /** 扣分那一笔的流水 id。没有它就退不了 */
  ledgerId: string | null;
  reason: string;
}

export function checkRefund(input: RefundInput): RuleResult {
  if (!input.reason.trim()) return no("退款要写明原因");

  const transition = canTransitionOrder(input.status, "refunded");
  if (!transition.ok) return transition;

  /*
   * 没有流水 id 就退不了 —— 退款是**冲正那一笔扣分**，
   * 不是凭空加一笔。凭空加的话，积分总量会悄悄多出来，
   * 而通胀体检看到的是「有人白拿了分」却查不出源头。
   */
  if (!input.ledgerId) return no("找不到当初的扣分记录，退不了 —— 需要人工处理");

  return OK;
}

/** 库存还剩多少。不限量时返回 null 而不是 0 —— 两者含义完全不同 */
export function remainingStock(stock: number | null, sold: number): number | null {
  if (stock === null) return null;
  return Math.max(0, stock - sold);
}

export interface ItemInput {
  key: string;
  name: string;
  price: number;
  stock: number | null;
  perUserLimit: number | null;
  kind: ShopItemKind;
  config: Record<string, unknown>;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{1,40}$/;

export function checkItem(input: ItemInput): RuleResult {
  if (!KEY_PATTERN.test(input.key)) {
    return no("商品标识只能用小写字母、数字、下划线和连字符");
  }
  if (!input.name.trim()) return no("商品要有名字");

  if (!Number.isInteger(input.price) || input.price <= 0) return no("价格必须是正整数");

  if (input.stock !== null && (!Number.isInteger(input.stock) || input.stock < 0)) {
    return no("库存必须是非负整数");
  }
  if (input.perUserLimit !== null && (!Number.isInteger(input.perUserLimit) || input.perUserLimit < 1)) {
    return no("限购数必须是正整数");
  }

  /*
   * 商品的专属配置必须填对，否则兑换会成功但交付会失败 ——
   * 那时积分已经扣了，而用户什么都没拿到。
   */
  if (input.kind === "title" && typeof input.config.titleKey !== "string") {
    return no("称号类商品要指定发哪个称号");
  }
  if (input.kind === "makeup_card") {
    const count = input.config.count;
    if (count !== undefined && (!Number.isInteger(count) || (count as number) < 1)) {
      return no("补签卡张数必须是正整数");
    }
  }

  return OK;
}

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  fulfilled: "已交付",
  shipping: "已发货",
  delivered: "已签收",
  cancelled: "已取消",
  refunded: "已退款",
};

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}

export const ITEM_KIND_LABELS: Record<string, string> = {
  title: "称号",
  makeup_card: "补签卡",
  highlight: "帖子置顶",
  physical: "实物周边",
  custom: "其他",
};

export function itemKindLabel(kind: string): string {
  return ITEM_KIND_LABELS[kind] ?? kind;
}
