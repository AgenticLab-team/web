import "server-only";

import katex from "katex";

/**
 * 数学公式。
 *
 * ─────────────────────────────────────────
 * 必须在 markdown 解析**之前**摘出来
 * ─────────────────────────────────────────
 *
 * 公式里全是 markdown 的记号：`a_1 * b_2` 里的 `_` 和 `*`
 * 会被解析成下标和强调，`\\` 会被吃掉，`|` 会被当成表格。
 * 等 markdown 跑完再找公式，找到的已经是被改烂的东西了。
 *
 * 代码块也是同样的道理，那边早就这么处理了 —— 这里跟着它走。
 *
 * ─────────────────────────────────────────
 * 只出 MathML，不出那一堆带样式的 span
 * ─────────────────────────────────────────
 *
 * KaTeX 默认输出是「HTML + MathML」两份，其中 HTML 那份靠几十个
 * 带 `position` / `top` / `left` / `margin` 的内联样式来摆位置。
 *
 * 而这个站的消毒器**只放行 color / background-color / font 那几条**
 * （见 markdown.ts 的 SAFE_STYLE_PATTERN）—— 理由写在那儿：
 * 放开 position 就能用 fixed 覆盖整页做钓鱼。
 *
 * 为了公式去放宽那条规则，是拿这个站最容易出事的地方去换排版。
 * 所以走 `output: "mathml"`：一个标签树，零内联样式，
 * 消毒规则一条都不用动，客户端也不用再下 KaTeX 那 23KB 的 CSS 和字体。
 *
 * 代价是很老的浏览器不认 MathML —— 那时候公式会退化成没有排版的
 * 一行字符（`a1+b2`），仍然读得懂。比一堆错位重叠的 span 好得多。
 */

/** 占位符前缀。真正的 token 由调用方带随机后缀，防止用户在正文里写出来 */
export const MATH_TOKEN_PREFIX = "XMATH";

export interface MathPiece {
  tex: string;
  /** 独占一行的公式（`$$…$$` / `\[…\]`），排版更舒展 */
  display: boolean;
}

/**
 * 行内 `$…$` 到底算不算公式。
 *
 * ─────────────────────────────────────────
 * `$` 在中文正文里太常见了
 * ─────────────────────────────────────────
 *
 * 「这个 $100，那个 $200」——把中间那段当成公式的话，
 * 一句正常的话会变成一坨排版古怪的符号。
 *
 * 规矩借的是通行做法：**紧挨着 `$` 的位置不能是空白**。
 * 上面那句里内容是 `100，那个 `，结尾是空格 → 不算公式。
 * 而 `$a_1$` 两头都紧贴 → 算。
 *
 * 另外挡掉纯数字（`$100$` 这种更可能是在说钱，不是在写公式）。
 */
export function looksLikeInlineMath(tex: string): boolean {
  if (!tex) return false;
  if (/^\s|\s$/.test(tex)) return false;
  // 纯数字 / 千分位 —— 更像金额
  if (/^[\d,.\s]+$/.test(tex)) return false;
  // 跨行的不算：行内公式就该在一行里
  if (tex.includes("\n")) return false;
  return true;
}

/**
 * 把公式摘出来，原地留下占位符。
 *
 * 顺序要紧：先 `$$…$$` 和 `\[…\]`（块级），再 `\(…\)`，最后 `$…$` ——
 * 先扫单个 `$` 的话，`$$x$$` 会被拆成一个空公式加一堆残渣。
 */
export function extractMath(source: string, token: string): { text: string; pieces: MathPiece[] } {
  const pieces: MathPiece[] = [];
  const put = (tex: string, display: boolean) => {
    pieces.push({ tex: tex.trim(), display });
    return `${token}${pieces.length - 1}${token}`;
  };

  let text = source;

  // 块级：$$…$$
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => put(tex, true));
  // 块级：\[…\]
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex: string) => put(tex, true));
  // 行内：\(…\) —— 无歧义，不用额外判断
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex: string) => put(tex, false));
  // 行内：$…$ —— 要过一遍「像不像公式」
  text = text.replace(/\$([^$\n]+?)\$/g, (match, tex: string) =>
    looksLikeInlineMath(tex) ? put(tex, false) : match,
  );

  return { text, pieces };
}

/**
 * 渲染一条公式。
 *
 * `throwOnError: false` —— 写错一个花括号不该让整篇帖子发不出去。
 * KaTeX 会把出错的原式用红色显示出来，作者一眼看得到哪里错了。
 *
 * `trust: false`（默认）—— 关掉 `\href`、`\htmlClass`、`\includegraphics`
 * 这类能往输出里塞任意属性的命令。它们是 KaTeX 里唯一的注入面。
 */
export function renderMath(piece: MathPiece): string {
  const html = katex.renderToString(piece.tex, {
    displayMode: piece.display,
    output: "mathml",
    throwOnError: false,
    trust: false,
    strict: false,
  });

  /*
   * 块级公式包一层，好让它能横向滚 —— 长公式在手机上必然出屏，
   * 而公式恰恰是正文里最容易超宽的东西。
   *
   * 用 `span` 而不是 `div`：**消毒器的允许清单里没有 div**，
   * 包上去会被整个剥掉（第一版就是这样，公式的滚动容器凭空消失）。
   * 而为一个排版容器去放宽那份清单，正好抵消了选 MathML 的理由。
   * span 加 `display:block` 完全够用，清单一个字都不用改。
   */
  return piece.display ? `<span class="math-block">${html}</span>` : html;
}

/**
 * MathML 用得到的标签。
 *
 * 消毒器是**允许清单**，没列出来的一律剥掉 —— 漏一个标签的表现是
 * 公式少一截，而且不会有任何报错。
 */
export const MATHML_TAGS = [
  "math", "semantics", "annotation",
  "mrow", "mi", "mn", "mo", "ms", "mtext", "mspace",
  "msub", "msup", "msubsup", "munder", "mover", "munderover",
  "mfrac", "msqrt", "mroot", "mpadded", "mphantom", "menclose", "mstyle",
  "mtable", "mtr", "mtd", "mlabeledtr", "merror", "maction", "mmultiscripts",
  "mprescripts", "none",
];

/**
 * MathML 用得到的属性。
 *
 * 这一批**全是排版参数**，没有一个能执行东西或指向外部资源 ——
 * 所以放行它们不动摇「style 只放行配色」那条线。
 */
export const MATHML_ATTRS = [
  "xmlns", "encoding", "display", "displaystyle", "scriptlevel",
  "mathvariant", "mathsize", "mathcolor", "mathbackground",
  "stretchy", "symmetric", "largeop", "movablelimits", "accent", "accentunder",
  "fence", "separator", "form", "lspace", "rspace", "minsize", "maxsize",
  "linethickness", "numalign", "denomalign", "notation",
  "columnalign", "rowalign", "columnspacing", "rowspacing", "columnlines", "rowlines",
  "width", "height", "depth", "voffset", "align",
];
