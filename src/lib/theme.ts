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
