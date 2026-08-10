/**
 * 置顶。纯函数。
 *
 * ─────────────────────────────────────────
 * 「置顶了」和「现在还置顶着」是两件事
 * ─────────────────────────────────────────
 *
 * `pinned` 是个布尔，`pinned_until` 是个时间。
 * 只看前者的排序里，一次「置顶一天」会变成置顶到天荒地老 ——
 * 而且没有任何地方看得出来：帖子就在那儿，看起来一切正常。
 *
 * 所以判定统一走 isEffectivelyPinned，排序、列表、后台都用它。
 *
 * ─────────────────────────────────────────
 * 付费置顶必须有名额
 * ─────────────────────────────────────────
 *
 * 商店卖「帖子置顶一天」。不限名额的话，第一屏迟早全是买来的位置 ——
 * 那时候论坛卖掉的不是曝光，是**别人被埋掉的机会**。
 * 所以同一个版块同时只留一个付费置顶位，占着就不卖。
 *
 * 卖不出去要**当场拒绝**，不能先收钱再排队：一个收了钱却
 * 不知道什么时候生效的商品，比不卖更伤人。
 */

export interface PinState {
  pinned: boolean;
  pinnedUntil: number | null;
}

/** 现在还置顶着吗 */
export function isEffectivelyPinned(post: PinState, now: number): boolean {
  if (!post.pinned) return false;
  // 没有到期时间 = 管理员手动置顶，一直有效
  if (post.pinnedUntil === null) return true;
  return post.pinnedUntil > now;
}

/** 同一个版块同时能有几个**付费**置顶位 */
export const PAID_PIN_SLOTS = 1;

export interface PinPurchaseInput {
  /** 帖子存在吗 */
  exists: boolean;
  /** 帖子作者 */
  authorId: string | null;
  buyerId: string;
  deleted: boolean;
  status: string;
  /** 这个帖子现在的置顶状态 */
  current: PinState;
  /** 同版块当前**有效的付费置顶**数量（不含本帖） */
  paidPinsInBoard: number;
  now: number;
}

export type PinCheck = { ok: true } | { ok: false; error: string };

/**
 * 能不能买这个置顶。
 *
 * 全部在**扣分之前**判完 —— 扣完钱再发现帖子被删了，
 * 得走退款流程，而退款流程是人工的。
 */
export function checkPinPurchase(input: PinPurchaseInput): PinCheck {
  if (!input.exists) return { ok: false, error: "找不到这个帖子" };
  if (input.deleted) return { ok: false, error: "这个帖子已经被删了" };
  if (input.status !== "published") {
    return { ok: false, error: "只有已发布的帖子能置顶" };
  }
  /*
   * 只能给自己的帖子买。
   * 允许给别人买听起来友好，实际上是给「花钱把某个帖子顶上去」
   * 开了一扇门 —— 而那个帖子的作者可能根本不想被顶上去。
   */
  if (input.authorId !== input.buyerId) {
    return { ok: false, error: "只能给自己的帖子买置顶" };
  }
  if (isEffectivelyPinned(input.current, input.now)) {
    return { ok: false, error: "这个帖子已经在置顶了" };
  }
  if (input.paidPinsInBoard >= PAID_PIN_SLOTS) {
    return {
      ok: false,
      error: `这个版块的付费置顶位被占着（同时只有 ${PAID_PIN_SLOTS} 个），等它到期再来`,
    };
  }
  return { ok: true };
}

/** 买到之后置顶到什么时候 */
export function pinUntil(hours: number, now: number): number {
  return now + Math.max(1, hours) * 3600_000;
}

/** 还剩多久 —— 列表上要显示，否则买了的人不知道自己还剩多少 */
export function pinRemainingLabel(pinnedUntil: number | null, now: number): string | null {
  if (pinnedUntil === null) return null;
  const left = pinnedUntil - now;
  if (left <= 0) return null;
  if (left < 3600_000) return `置顶剩 ${Math.max(1, Math.round(left / 60_000))} 分钟`;
  return `置顶剩 ${Math.round(left / 3600_000)} 小时`;
}
