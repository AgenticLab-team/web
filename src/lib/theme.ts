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
  try {
    var stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    }
  } catch (e) {}
})();
`.trim();
