/**
 * 配色的纯数据部分。
 *
 * 刻意不放在 ThemeToggle.tsx 里：那是客户端组件、会 import lucide-react，
 * 而 layout.tsx 是服务端组件，只为了取一段字符串就把整个图标库拖进来，
 * 在 react-server 条件下还会直接报 createContext is not a function。
 */

export type ThemeChoice = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "al-theme";

/**
 * 浏览器 chrome（状态栏、底部安全区）该涂成什么颜色。
 *
 * ═════════════════════════════════════════
 * 站长报的「手机端上下是黑色的很诡异」就是这里
 * ═════════════════════════════════════════
 *
 * `viewport-fit: cover` 之后，刘海和 Home Indicator 那两条安全区
 * 由 `theme-color` 上色。而原来 `theme-color` 只按
 * `prefers-color-scheme` 给两个值 —— **它跟着系统走，不跟着页面走**。
 *
 * 于是「系统深色 + 站内选了浅色」时：页面是浅的，上下两条是
 * `#0a0a0c` —— 一个浅色页面被两条黑边夹着，正是站长看到的样子。
 * 反过来（系统浅色 + 站内深色）会得到两条白边，一样怪。
 *
 * 这两个值必须和 globals.css 里的 `--canvas` 一致，
 * 由 tests/theme.test.ts 钉着不许分叉。
 */
export const CANVAS_COLOR: Record<"light" | "dark", string> = {
  light: "#f5f5f3",
  dark: "#0a0a0c",
};

/**
 * 把 localStorage 里存的原始值解析成配色选择。
 *
 * 只认 light 与 dark，其余（null、旧版本写进去的值、被别的脚本污染的值）
 * 一律当作「自动」。存了什么就用什么的话，一个脏值就能让整站配色卡死，
 * 而用户在界面上找不到任何办法改回来。
 *
 * ⚠️ 下面的 THEME_INIT_SCRIPT 必须与这个函数**结论一致**。
 * 它是要内联进 <head> 的字符串，没法调用这里的函数，
 * 所以由 tests/theme.test.ts 逐个取值断言两者不脱节。
 */
export function readThemeChoice(stored: string | null | undefined): ThemeChoice {
  return stored === "light" || stored === "dark" ? stored : "system";
}

/**
 * 在首次绘制前定好主题的内联脚本。
 *
 * 必须同步执行在 <head> 里 —— 放到 React 里跑的话，服务端渲染的是亮色，
 * 客户端 hydration 后才切成暗色，用户会看到明显的白屏闪烁。
 * 这是暗色模式实现里最常见也最刺眼的缺陷。
 *
 * try/catch 不能省：Safari 隐私模式下访问 localStorage 会直接抛异常。
 */
export const THEME_INIT_SCRIPT = `
(function () {
  var LIGHT = ${JSON.stringify(CANVAS_COLOR.light)};
  var DARK = ${JSON.stringify(CANVAS_COLOR.dark)};

  /*
   * 把 theme-color 换成**一条不带媒体查询的**，值取实际生效的主题。
   *
   * 服务端渲染出来的是两条带 media 的（对「跟随系统」是对的）——
   * 但用户显式选过之后它们就错了：页面是浅的而系统是深的时候，
   * 安全区会按系统涂成黑色，于是浅色页面上下各夹一条黑边。
   */
  function paint(theme) {
    try {
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < metas.length; i++) metas[i].remove();
      var m = document.createElement("meta");
      m.setAttribute("name", "theme-color");
      m.setAttribute("content", theme === "dark" ? DARK : LIGHT);
      document.head.appendChild(m);
    } catch (e) {}
  }

  try {
    var stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
      paint(stored);
    }
    // 「跟随系统」时什么都不做：服务端那两条带 media 的正是对的
  } catch (e) {}
})();
`.trim();

/**
 * 切换配色时同步刷 `theme-color`。客户端用。
 *
 * 不刷的话，用户在设置里从「深色」切到「浅色」，页面变白了
 * 而上下两条安全区还是黑的 —— 直到下次整页刷新。
 */
export function paintThemeColor(choice: ThemeChoice): void {
  if (typeof document === "undefined") return;
  const resolved: "light" | "dark" =
    choice === "system"
      ? window.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : choice;
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.remove();
  const meta = document.createElement("meta");
  meta.setAttribute("name", "theme-color");
  meta.setAttribute("content", CANVAS_COLOR[resolved]);
  document.head.appendChild(meta);
}
