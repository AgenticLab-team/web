/*
 * 在页面里跑的那段：横向溢出 + 命中区大小。
 *
 * ═════════════════════════════════════════
 * 为什么这段单独一个文件
 * ═════════════════════════════════════════
 *
 * 它本来住在 `mobile-audit.mjs` 的一段模板字面量里，
 * 而我在里面写注释时**连着两次**被反引号截断 ——
 * 注释里提一句 `.tap-target`，探针的 JS 就从那儿断掉，
 * 报错还落在 Node 检查语法那一层，指向的行和真因隔着老远。
 *
 * 放进真文件之后：反引号随便写，`node --check` 管得着，
 * eslint 也看得见。`__MIN_TAP__` 由调用方替换。
 *
 * 这里是浏览器环境，不是 Node —— 没有 import，最后一行是个表达式。
 */
(() => {
  const docW = document.documentElement.clientWidth;
  const overflow = [];
  const small = [];
  const seen = new Set();

  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden") continue;

    const cls = (el.className || "").toString().slice(0, 42);
    const label = ((el.innerText || el.getAttribute("aria-label") || "") + "")
      .split(String.fromCharCode(10))
      .join("·")
      .trim()
      .slice(0, 26);

    /*
     * ① 右边越界。
     *
     * 只看**自己**越界，不看祖先 —— 一个溢出的子元素会把它每一层父元素的
     * rect 都撑出去，于是一处溢出报出七条。
     *
     * 而祖先里只要有人**接住了**横向溢出，就不是 bug：
     *
     *   `auto` / `scroll` —— 故意要横滚的（那排药丸标签、宽表格）
     *   `hidden` / `clip` —— 故意要截断的（`truncate` 就是它加省略号）
     *
     * 漏掉后两个的话，站里每一处 `truncate` 都会被报成横向溢出 ——
     * 后台域名表里那串 punycode（`xn--6qqw1eaaaa206xh6b9z6db`）
     * 就是这么被我报成「越界 587 > 390」的，而它其实老老实实
     * 带着省略号躺在行里，页面一格都没横滚。
     *
     * 真正的整页横滚由下面的 `scrollWidth > clientWidth` 兜底。
     */
    if (r.right > docW + 1) {
      let scrollable = false;
      for (let n = el.parentElement; n; n = n.parentElement) {
        const os = getComputedStyle(n).overflowX;
        if (os === "auto" || os === "scroll" || os === "hidden" || os === "clip") {
          scrollable = true;
          break;
        }
      }
      if (!scrollable) {
        const key = "o:" + cls + Math.round(r.right);
        if (!seen.has(key)) {
          seen.add(key);
          overflow.push({ cls, label, right: Math.round(r.right), docW });
        }
      }
    }

    /*
     * ② 点得到点不到。
     *
     * ═════════════════════════════════════════
     * 量的是**命中区**，不是元素的 rect
     * ═════════════════════════════════════════
     *
     * 第一版量 `getBoundingClientRect`，于是把「复制地址」按钮报成 28×28 ——
     * 而它**没有问题**：`.tap-target` 用一个 `::after` 把命中区撑到 44，
     * 伪元素上的命中算在原元素头上，而 rect 里一点都看不出来。
     *
     * 一个叫 tap-target 的类量出来 28×28，看着像铁证；
     * 实际是我问错了问题。真正该问的是：
     * **拇指落在离中心 22px 的地方，打到的是不是它。**
     *
     * 从中心往四个方向探，顺带把两件 rect 永远看不见的事也量进来了：
     * 包着复选框的 `<label>`（点标签也能勾上），
     * 以及**两个挨着的扩大命中区互相压** —— 实测「复制地址」右边 22px
     * 打到的是隔壁的删除按钮，两个 28px 的按钮各自撑到 44 就会重叠。
     */
    const tag = el.tagName.toLowerCase();
    const clickable =
      tag === "button" ||
      tag === "select" ||
      tag === "textarea" ||
      (tag === "a" && el.hasAttribute("href")) ||
      (tag === "input" && el.type !== "hidden") ||
      el.getAttribute("role") === "button";
    if (!clickable) continue;
    /*
     * 行内链接不算 —— WCAG 2.5.8 明确豁免「夹在一句话里的链接」：
     * 把它撑到 44px 会把那一行的行距撑烂，而人点它时本来就在读那句话。
     */
    if (tag === "a" && s.display === "inline") continue;
    if (el.disabled) continue;
    /*
     * 1px 见方的不算 —— 那是 `.sr-only` 的「跳到正文」这类链接。
     * 它平时被夹成 1×1 藏着，聚焦时才铺开，从来不是拇指的目标。
     * 这一条是被第一次跑当场教的：它是唯一一条 1×1，
     * 而那正好是无障碍做对了的证据。
     */
    if (r.width <= 1 && r.height <= 1) continue;

    const key = "t:" + tag + cls + Math.round(r.width) + "x" + Math.round(r.height);
    if (seen.has(key)) continue;
    seen.add(key);

    /*
     * 视口外的点 `elementFromPoint` 一律回 null，所以要先滚过去。
     *
     * 但**已经在视野里的就别滚** —— `scrollIntoView` 每次都强制重排，
     * 而后台域名表有上百行、几百个可点元素，一个一个滚下来
     * 整页要跑十分钟以上（第一次在 320 宽下跑就是这么超时的，
     * 而它的表现是「命令没有任何输出」，看着像卡死）。
     */
    let q = el.getBoundingClientRect();
    const inView =
      q.top >= 26 && q.bottom <= document.documentElement.clientHeight - 26 &&
      q.left >= 26 && q.right <= docW - 26;
    if (!inView) {
      el.scrollIntoView({ block: "center", inline: "center" });
      q = el.getBoundingClientRect();
    }
    const cx = q.left + q.width / 2;
    const cy = q.top + q.height / 2;

    /*
     * 「这一点算不算打在它身上」。
     *
     * 要**一路往上找 label** —— 复选框外面包一层 `<label>` 时，
     * 偏 30px 打到的是标签里那段文字（一个 `<code>`），
     * 而点它照样会把复选框勾上。只认 `t.tagName === "LABEL"`
     * 的话，会把一个命中区其实有整行那么大的复选框报成 13×13。
     */
    /*
     * 还要认**指向同一个地址的邻居**。
     *
     * 成员列表里，头像和名字是两个挨着的 `<a>`，点哪个都去同一个人的主页。
     * 分开量的话它们各自都不到 44（头像 40 宽、名字 25 高），
     * 而拇指落在那一整块上做的事**完全一样** —— 报出来是十一条噪音。
     *
     * 判据是 href 相等，不是「挨着」：两个相邻但去处不同的链接
     * 互相压才是真问题（那正是复制键被隔壁删除键吃掉 8px 的那种）。
     */
    const href = el.tagName === "A" ? el.href : null;
    const owns = (t) => {
      if (!t) return false;
      if (t === el || el.contains(t)) return true;
      for (let n = t; n; n = n.parentElement) {
        if (n.tagName === "LABEL" && (n.control === el || n.contains(el))) return true;
      }
      if (href && t.closest) {
        const a = t.closest("a");
        if (a && a.href === href) return true;
      }
      return false;
    };
    // 中心都被别的东西盖着，那是另一回事（弹层、遮罩），不在这一条里判
    if (!owns(document.elementFromPoint(cx, cy))) continue;

    /*
     * ⚠️ 这样探出来的尺寸**天生比真值小 1px**，所以下面按 44-1 判。
     *
     * 一个正好 44 高、以中心对齐的命中框，覆盖的是 [cy-22, cy+22)；
     * 从中心一格一格往外走，最远只能踩到 ±21 —— 22 那一点已经在框外。
     * 于是量出来是 21+21+1 = 43。
     *
     * 不容这 1px 的话，站里每一个**做对了**的 44px 命中区
     * 都会被报成 42、43 —— 我第一版就是这么报了三条假的出来，
     * 而它们看着特别像真的：几个按钮整整齐齐全是 42。
     */
    const reach = (dx, dy) => {
      let d = 0;
      for (let step = 1; step <= 24; step += 1) {
        if (!owns(document.elementFromPoint(cx + dx * step, cy + dy * step))) break;
        d = step;
      }
      return d;
    };
    const effW = q.width >= __MIN_TAP__ ? Math.round(q.width) : reach(-1, 0) + reach(1, 0) + 1;
    const effH = q.height >= __MIN_TAP__ ? Math.round(q.height) : reach(0, -1) + reach(0, 1) + 1;

    if (effW < __MIN_TAP__ - 1 || effH < __MIN_TAP__ - 1) {
      small.push({
        tag,
        cls,
        label,
        w: Math.round(q.width),
        h: Math.round(q.height),
        ew: effW,
        eh: effH,
      });
    }
  }

  return {
    docW,
    scrollW: document.documentElement.scrollWidth,
    overflow,
    small,
    total: document.querySelectorAll("body *").length,
  };
})();
