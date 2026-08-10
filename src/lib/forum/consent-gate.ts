/**
 * 「能不能把这篇群聊转帖的可见性提上去」——纯判定，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 这是这个站最硬的一条约束，而它一直没有测试
 * ─────────────────────────────────────────
 *
 * 群里说的话进论坛，原作者同意的是「给这个群看」。要往外放一档，
 * 必须**每一位被引用到的人都点过头** —— 不是多数同意，是全体同意：
 * 被拒绝的那个人的发言依然会被公开，「少数服从多数」在这里不成立。
 *
 * 判定原来是内联在 `raiseVisibility()` 里的两行 filter。
 * 一次变异普查发现：把那两行改掉，**全量测试一条都不红** ——
 * 整个 `raiseVisibility` 在测试里一次都没有被调用过。
 *
 * 那个函数带 `"use server"`、开头就要 `getCurrentUser()`，
 * 直接测要连登录一起搭。所以把判定拆到这里：
 * **它被 raiseVisibility 真正调用**（不是复述一遍），
 * 于是这条约束终于有了一个测得到的落点。
 */

export interface ConsentEntryLike {
  status: "pending" | "granted" | "denied";
}

export interface ConsentGate {
  ok: boolean;
  granted: number;
  total: number;
  /** 还没点头的人数（pending 与 denied 都算） */
  outstanding: number;
  /** 拦下来时给人看的话；放行时为 null */
  reason: string | null;
}

/**
 * `null` / 空日志 = **这篇不是群聊转帖**，不受这条约束管。
 *
 * 注意「空数组」和「没有同意记录」在这里是同一件事：
 * 一篇原生帖子根本不会有 post_sources 行。
 * 把空数组判成「没人同意 → 拦下」的话，
 * 所有普通帖子的可见性都再也改不动了。
 */
export function consentGate(log: readonly ConsentEntryLike[] | null | undefined): ConsentGate {
  const entries = log ?? [];
  const total = entries.length;

  if (total === 0) {
    return { ok: true, granted: 0, total: 0, outstanding: 0, reason: null };
  }

  const granted = entries.filter((e) => e.status === "granted").length;
  /*
   * 用「不等于 granted」而不是「等于 pending」。
   *
   * denied 必须一起拦下 —— 只数 pending 的话，一个明确拒绝过的人
   * 会被当成「已经处理完了」，而他的发言照样被公开出去。
   * 这正是这条约束要防的那一种情况。
   */
  const outstanding = entries.filter((e) => e.status !== "granted").length;

  if (outstanding > 0) {
    return {
      ok: false,
      granted,
      total,
      outstanding,
      reason: `还有 ${outstanding} 位原作者没有同意（${granted}/${total}）`,
    };
  }

  return { ok: true, granted, total, outstanding: 0, reason: null };
}
