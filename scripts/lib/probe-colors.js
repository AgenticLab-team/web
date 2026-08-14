/*
 * 在页面里跑的那段：录下每个元素的底色、字色，以及文字的对比度。
 *
 * ═════════════════════════════════════════
 * 为什么这段单独一个文件
 * ═════════════════════════════════════════
 *
 * 它本来住在 `dark-audit.mjs` 的一段模板字面量里，而我在里面写注释时
 * **被反引号截断了三次** —— 注释里提一句 `rgb()`，探针的 JS 就从那儿断掉，
 * 报错还落在 Node 检查语法那一层，指向的行和真因隔着老远。
 *
 * 前两次我都是把反引号删掉了事。第三次才承认这不是手滑，是这个位置本身有问题。
 *
 * 放进真文件之后：反引号随便写，`node --check` 管得着，eslint 也看得见。
 *
 * 这里是浏览器环境，不是 Node —— 没有 import，最后一行是个表达式。
 */
(() => {
  /*
   * ⚠️ 计算样式里不只有 `rgb()`。
   *
   * 用了 `color-mix()` 的地方，浏览器给回来的是
   * `color(srgb 0.827451 0.637255 0.496078)` —— 分量是 **0–1**，不是 0–255。
   *
   * 照着 rgb 那样抓数字的话，0.83 会被当成 0.83/255，
   * 于是一个亮米色被读成近黑 —— 我因此把一个**修好了的**角色徽章
   * 报成「对比度 1.13」，差点回去把那个修改撤掉。
   */
  const parse = (c) => {
    const str = String(c);
    const m = str.match(/[\d.]+/g);
    if (!m) return null;
    const scale = str.startsWith("color(") ? 255 : 1;
    return [+m[0] * scale, +m[1] * scale, +m[2] * scale, m[3] === undefined ? 1 : +m[3]];
  };
  /** 把 fg 叠在 bg 上 —— 半透明的颜色单看没有意义 */
  const over = (fg, bg) => [
    fg[0] * fg[3] + bg[0] * (1 - fg[3]),
    fg[1] * fg[3] + bg[1] * (1 - fg[3]),
    fg[2] * fg[3] + bg[2] * (1 - fg[3]),
    1,
  ];
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  /*
   * 有效背景：从元素往上走，把每一层的底色叠起来。
   *
   * 直接读 backgroundColor 绝大多数时候拿到的是 rgba(0,0,0,0) ——
   * 站里的卡片、行、标签几乎都是透明底加一层浅浅的 overlay，
   * 真正的底色在祖先身上。不往上走的话，几乎每一段文字都会被
   * 当成「透明底」而算不出对比度。
   */
  const effBg = (el) => {
    const stack = [];
    let n = el;
    while (n && n.nodeType === 1) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) stack.push(c);
      n = n.parentElement;
    }
    const scheme = getComputedStyle(document.documentElement).colorScheme || "";
    let acc = scheme.indexOf("dark") !== -1 ? [18, 18, 18, 1] : [255, 255, 255, 1];
    for (let i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc);
    return acc;
  };

  /** 一路乘下来的 opacity —— 半透明的容器会把里面的字一起拉淡 */
  const cumulativeOpacity = (el) => {
    let o = 1, n = el;
    while (n && n.nodeType === 1) {
      o *= Number(getComputedStyle(n).opacity || 1);
      n = n.parentElement;
    }
    return o;
  };

  const surfaces = {};
  const text = [];

  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 12) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden") continue;

    const key = el.tagName + "@" + Math.round(r.x) + "," + Math.round(r.y) + "," + Math.round(r.width);
    const cls = (el.className || "").toString().slice(0, 45);
    surfaces[key] = s.backgroundColor + "|" + s.color + "|" + cls;

    /*
     * 只看**自己直接带文字**的元素。
     *
     * 不加这一条的话，一段文字会被它的每一层祖先重复报一遍
     * （color 是继承的），而那些祖先的有效背景还各不相同 ——
     * 同一句话报出五条互相矛盾的对比度。
     */
    let own = "";
    for (const node of el.childNodes) {
      if (node.nodeType === 3) own += node.nodeValue;
    }
    own = own.trim();
    if (own.length < 2) continue;

    const fg = parse(s.color);
    if (!fg) continue;
    const bg = effBg(el);
    const alpha = fg[3] * cumulativeOpacity(el);
    if (alpha <= 0.05) continue;   // 基本是隐藏的，不是对比度问题
    const composed = over([fg[0], fg[1], fg[2], alpha], bg);

    const size = parseFloat(s.fontSize) || 16;
    const weight = Number(s.fontWeight) || 400;
    // WCAG：大字（≥24px，或 ≥18.66px 且加粗）门槛是 3:1，其余 4.5:1
    const large = size >= 24 || (size >= 18.66 && weight >= 700);

    text.push({
      key,
      cls,
      sample: own.slice(0, 24),
      ratio: Math.round(ratio(composed, bg) * 100) / 100,
      need: large ? 3 : 4.5,
      fg: s.color,
      bg: "rgb(" + Math.round(bg[0]) + ", " + Math.round(bg[1]) + ", " + Math.round(bg[2]) + ")",
    });
  }
  /*
   * 顺手数一下有多少可交互元素**挂上了 React**。
   *
   * 没水合的页面在配色上和水合过的一模一样（HTML 是服务端渲染的），
   * 于是这一整份颜色报告照样会全绿 —— 而客户端渲染的那部分界面
   * 一个都没出现在里面。那是最像成功的一种失败。
   */
  const inter = [...document.querySelectorAll("button, a[href], input")];
  const live = inter.filter((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber$"))).length;

  return { surfaces, text, inter: inter.length, live };
})();
