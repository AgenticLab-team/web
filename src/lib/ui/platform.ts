/**
 * 这台设备上，那个组合键该怎么念。
 *
 * ═════════════════════════════════════════
 * 一个念错的快捷键提示比没有提示糟
 * ═════════════════════════════════════════
 *
 * 发布框底下原来写死着「⌘↵ 发布」：
 *
 *   · **非 Mac 上它是错的** —— 那儿是 Ctrl，而写着 ⌘ 的提示
 *     会让人去按一个不存在的键，然后以为这个功能坏了
 *   · **手机上它根本不该出现** —— 那儿没有物理键盘，
 *     一条讲键盘的提示只是在占那一行唯一的位置
 *
 * 判断放在这里而不是各组件里就地写：全站有好几处要说这句话，
 * 而各写一遍的分叉方向是「有的地方改对了、有的还写着 ⌘」——
 * 那种不一致谁也不会去报。
 */

/** 有没有触摸屏。用来决定「要不要提键盘快捷键」这件事 */
export function hasTouch(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.maxTouchPoints > 0;
}

/**
 * 修饰键的名字。**只能在客户端调**（要读 navigator）。
 *
 * 服务端拿不到平台，所以这句提示要在 `useEffect` 之后才落地 ——
 * 否则服务端给一个、客户端给另一个，React 会报水合不一致。
 */
export function modKey(): "⌘" | "Ctrl" {
  if (typeof navigator === "undefined") return "Ctrl";
  /*
   * 认 Mac 用 `platform`，不是在 userAgent 里找 "Mac"：
   * iPad 的 userAgent 里也有 "Macintosh"（它伪装成桌面版），
   * 而 iPad 上没有 ⌘ 键 —— 除非接了键盘，那种情况极少，
   * 而且说错了他一眼就知道该按什么。
   */
  const p =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac/i.test(p) && !hasTouch() ? "⌘" : "Ctrl";
}

/**
 * 要不要显示键盘快捷键提示。
 *
 * 触摸设备上不显示 —— 那一行位置有限，而讲一个按不出来的键
 * 等于把那一行浪费掉。
 */
export function showsShortcuts(): boolean {
  return !hasTouch();
}
