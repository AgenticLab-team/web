/**
 * 侧栏收起状态。
 *
 * ═════════════════════════════════════════
 * 收起是**纯 CSS 的**，React 两种状态渲染同一棵树
 * ═════════════════════════════════════════
 *
 * 很自然的写法是 `collapsed ? <IconOnly/> : <Full/>`。那样有两个坏处，
 * 而且都发生在页面加载的头 200 毫秒里 —— 也就是每一次访问：
 *
 *   · **hydration 不匹配**。服务端不知道这个人上次收没收起
 *     （偏好在 localStorage 里），只能先渲染展开的那棵树。
 *   · **闪一下**。于是收起过侧栏的人，每次都会先看见完整侧栏，
 *     再看它「啪」地缩回去 —— 主内容跟着横跳一次。
 *
 * 所以：标记永远一样，`<html data-sidebar="rail">` 由一段
 * **绘制前同步执行**的脚本打上，剩下的全交给 CSS。
 * 宽度变量本身也换掉，主内容那条 `lg:pl-[var(--sidebar-width)]`
 * 于是自动跟着走，不需要知道侧栏收没收起。
 *
 * 这和主题那一套是同一个办法，理由也是同一个 —— 见 theme.ts。
 */

export const SIDEBAR_STORAGE_KEY = "al-sidebar";

export type SidebarState = "wide" | "rail";

/**
 * 存的值 → 状态。认不出来的一律当展开。
 *
 * ⚠️ 下面的 SIDEBAR_INIT_SCRIPT 必须与这个函数**结论一致**。
 * 它是要内联进 <head> 的字符串，没法调用这里的函数，
 * 所以由测试逐个取值断言两者不脱节。
 */
export function readSidebarState(stored: string | null | undefined): SidebarState {
  return stored === "rail" ? "rail" : "wide";
}

/**
 * 在首次绘制前定好侧栏宽度的内联脚本。
 *
 * try/catch 不能省：Safari 隐私模式下访问 localStorage 会直接抛异常，
 * 而这段脚本要是抛了，它后面的一切都不会执行。
 */
export const SIDEBAR_INIT_SCRIPT = `
(function () {
  try {
    if (localStorage.getItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)}) === "rail") {
      document.documentElement.setAttribute("data-sidebar", "rail");
    }
  } catch (e) {}
})();
`.trim();
