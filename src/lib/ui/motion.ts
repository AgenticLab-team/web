/**
 * 滚动要不要平滑，**由用户的偏好说了算**。
 *
 * ═════════════════════════════════════════
 * `globals.css` 里那条规则管不住这件事
 * ═════════════════════════════════════════
 *
 * 站里认真处理过 `prefers-reduced-motion`：动画压到 0.01ms、
 * `scroll-behavior: auto !important`。前庭功能障碍的用户看到大幅位移
 * 会真的眩晕 —— 那是无障碍需求，不是偏好。
 *
 * 但 JS 里显式传的 `behavior: "smooth"` **优先级高于那条 CSS**。
 * 规范说得很清楚：ScrollOptions 给了 `smooth` 就平滑滚，
 * 只有传 `auto` 时才回去看 CSS 的 `scroll-behavior`。
 *
 * 这一条是实测过的，不是照着规范推的：
 * 打开减少动效、确认 CSS 那边已经是 `auto`，然后跑
 * `scrollTo({ top: 2420, behavior: "smooth" })` ——
 * 80 毫秒之后 `scrollY` 是 80，还在路上。
 *
 * ─────────────────────────────────────────
 * 为什么是一个函数，而不是各处自己 matchMedia
 * ─────────────────────────────────────────
 *
 * 这个站里需要平滑滚动的地方只有两处（接着读、引用回复），
 * 而它们恰好都是**跳很远**的那种 —— 正是最会引起眩晕的一类。
 * 各写一遍的话，第三处出现时不会有人记得这件事，
 * 而漏掉它的后果对当事人来说是生理上的，且他多半不会来报。
 *
 * `tests/reduced-motion.test.ts` 盯着：src 里不许再出现裸的
 * `behavior: "smooth"`。
 */

/** 服务端渲染时按 `auto` 算 —— 那一侧不滚动，而 `window` 不存在 */
export function scrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined" || !window.matchMedia) return "auto";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/**
 * 滚到某个元素，尊重偏好。
 *
 * 收 `Element | null` 是因为调用点几乎都是
 * `document.getElementById(...)?.` 那种形状 —— 让它们少写一个 `?.`，
 * 顺带把「元素不在了」这件事收在这里，而不是散在各处。
 */
export function scrollToElement(el: Element | null, opts: ScrollIntoViewOptions = {}): void {
  el?.scrollIntoView({ ...opts, behavior: scrollBehavior() });
}
