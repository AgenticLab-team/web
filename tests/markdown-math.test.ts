import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";

import { extractMath, looksLikeInlineMath } from "@/lib/markdown-math";

/**
 * 数学公式。
 *
 * ─────────────────────────────────────────
 * 两处必须做对，其它都是排版
 * ─────────────────────────────────────────
 *
 * **一、在 markdown 解析之前摘出来。** 公式里全是 markdown 的记号：
 * `a_1 * b_2` 里的 `_` 和 `*` 会被解析成下标和强调，`\\` 会被吃掉。
 * 等 markdown 跑完再找公式，找到的已经是被改烂的东西。
 *
 * **二、不为了它放宽消毒规则。** KaTeX 默认输出靠几十个带
 * `position` / `top` / `left` 的内联样式摆位置，而这个站的消毒器
 * 只放行配色那几条 —— 理由写在 markdown.ts 里：放开 position
 * 就能用 fixed 覆盖整页做钓鱼。
 *
 * 所以走 MathML：一个标签树，零内联样式，消毒规则一条都不用动。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const TOKEN = "XMATHTESTX";

describe("**行内 `$…$` 到底算不算公式**", () => {
  it("紧贴着的算", () => {
    assert.equal(looksLikeInlineMath("E = mc^2"), true);
    assert.equal(looksLikeInlineMath("a_1"), true);
  });

  it("**两头有空白的不算** —— 那多半是正文里的美元号", () => {
    assert.equal(looksLikeInlineMath(" 100，那个 "), false);
    assert.equal(looksLikeInlineMath("x "), false);
    assert.equal(looksLikeInlineMath(" x"), false);
  });

  it("纯数字不算 —— 更像在说钱", () => {
    assert.equal(looksLikeInlineMath("100"), false);
    assert.equal(looksLikeInlineMath("1,234.50"), false);
  });

  it("跨行的不算 —— 行内公式就该在一行里", () => {
    assert.equal(looksLikeInlineMath("a\nb"), false);
  });

  it("空的不算", () => {
    assert.equal(looksLikeInlineMath(""), false);
  });
});

describe("摘出来", () => {
  it("行内 $…$", () => {
    const { text, pieces } = extractMath("质能方程 $E=mc^2$ 很有名", TOKEN);
    assert.equal(pieces.length, 1);
    assert.equal(pieces[0].tex, "E=mc^2");
    assert.equal(pieces[0].display, false);
    assert.match(text, new RegExp(`${TOKEN}0${TOKEN}`));
  });

  it("块级 $$…$$", () => {
    const { pieces } = extractMath("$$\\int_0^1 x dx$$", TOKEN);
    assert.equal(pieces.length, 1);
    assert.equal(pieces[0].display, true);
  });

  it("块级 \\[…\\] 和行内 \\(…\\)", () => {
    const { pieces } = extractMath("\\[a+b\\] 和 \\(c+d\\)", TOKEN);
    assert.deepEqual(pieces.map((p) => p.display), [true, false]);
  });

  it("**先扫 $$ 再扫 $** —— 反过来会把 $$x$$ 拆成一个空公式加残渣", () => {
    const { pieces } = extractMath("$$x^2$$", TOKEN);
    assert.equal(pieces.length, 1);
    assert.equal(pieces[0].tex, "x^2");
    assert.equal(pieces[0].display, true);
  });

  it("**金额原样留着**", () => {
    const source = "这个 $100，那个 $200，一共 $300。";
    const { text, pieces } = extractMath(source, TOKEN);
    assert.equal(pieces.length, 0);
    assert.equal(text, source);
  });

  it("一句里多条公式各自摘", () => {
    const { pieces } = extractMath("$a$ 加 $b$ 等于 $c$", TOKEN);
    assert.deepEqual(pieces.map((p) => p.tex), ["a", "b", "c"]);
  });

  it("没有公式时原样返回", () => {
    const source = "一段没有公式的普通中文。";
    assert.equal(extractMath(source, TOKEN).text, source);
  });
});

describe("**接线的顺序**", () => {
  it("公式摘在代码块之后 —— 代码里写 $HOME 的概率比正文高得多", () => {
    const md = src("lib/markdown.ts");
    assert.ok(
      md.indexOf("const withoutCode") < md.indexOf("extractMath(withoutCode"),
      "先摘公式再摘代码块了",
    );
  });

  it("公式回填在消毒**之前** —— 我们自己生成的 HTML 也要过一遍", () => {
    const md = src("lib/markdown.ts");
    assert.ok(md.indexOf("renderMath(mathPieces[i])") < md.indexOf("sanitizeHtml(withMath)"));
  });

  it("**走 MathML，不走带样式的 span**", () => {
    /*
     * 走默认输出的话，得为几十个 position/top/left 放宽 SAFE_STYLE_PATTERN——
     * 那是拿这个站最容易出事的地方去换排版。
     */
    const math = src("lib/markdown-math.ts");
    assert.match(math, /output: "mathml"/);
    assert.match(math, /trust: false/);
    assert.match(math, /throwOnError: false/);

    // 消毒器那条 style 白名单一个字都没动
    const md = src("lib/markdown.ts");
    assert.match(
      md,
      /SAFE_STYLE_PATTERN = \/\^\(color\|background-color\|font-style\|font-weight\|text-decoration\)/,
    );
  });

  it("MathML 的标签和属性进了允许清单 —— 漏一个的表现是公式少一截", () => {
    const md = src("lib/markdown.ts");
    assert.match(md, /\.\.\.MATHML_TAGS/);
    assert.match(md, /\.\.\.MATHML_ATTRS/);
  });

  it("**放行的属性全是排版参数** —— 没有一个能执行东西或指向外部资源", () => {
    const math = src("lib/markdown-math.ts");
    const attrs = math.slice(math.indexOf("MATHML_ATTRS"));
    for (const bad of ["href", "src", "onclick", "onerror", "xlink"]) {
      assert.doesNotMatch(attrs, new RegExp(`"${bad}"`), `放行了 ${bad}`);
    }
  });

  it("摘要里公式收成一个词 —— 一串 frac 在列表里既占地方又读不懂", () => {
    assert.match(src("lib/markdown.ts"), /\[公式\]/);
  });

  it("块级公式能横着滑 —— 长积分在手机上必然出屏", () => {
    const css = src("app/globals.css");
    assert.match(css, /\.math-block \{[\s\S]*?overflow-x: auto;/);
  });

  it("老浏览器里不会把 TeX 源码也显示出来", () => {
    assert.match(src("app/globals.css"), /\.katex annotation \{\s*display: none;/);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真的跑一遍渲染 —— 上面测的是形状，这里测的是结果
 * ─────────────────────────────────────────────────────────────── */

let render: typeof import("@/lib/markdown").renderMarkdown;

before(async () => {
  ({ renderMarkdown: render } = await import("@/lib/markdown"));
});

describe("渲染结果", () => {
  it("行内公式出 MathML", async () => {
    const { html } = await render("质能方程是 $E = mc^2$。");
    assert.match(html, /<math/);
    assert.match(html, /<msup>/);
  });

  it("**下标和乘号没被 markdown 吃掉**", async () => {
    /*
     * `a_1 * b_2` 直接进 markdown 的话，`_` 会变斜体、`*` 会变强调。
     */
    const { html } = await render("设 $a_1 * b_2$ 为例。");
    assert.match(html, /<msub>/);
    assert.doesNotMatch(html, /<em>/);
  });

  it("块级公式包在 math-block 里，不留在 <p> 中", async () => {
    const { html } = await render("推导：\n\n$$\\int_0^1 x^2 dx$$\n");
    assert.match(html, /<span class="math-block">/);
    /*
     * 用 span 不用 div：消毒器的允许清单里没有 div，包上去会被整个剥掉 ——
     * 第一版就是这样，滚动容器凭空消失，而没有任何报错。
     */
    assert.doesNotMatch(src("lib/markdown-math.ts"), /<div class="math-block">/);
  });

  it("**代码块里的 $ 不动**", async () => {
    const { html } = await render("```bash\necho $HOME $PATH\n```");
    assert.doesNotMatch(html, /<math/);
    assert.match(html, /\$HOME/);
  });

  it("**金额不会变成公式**", async () => {
    const { html } = await render("这个 $100，那个 $200。");
    assert.doesNotMatch(html, /<math/);
    assert.match(html, /\$100/);
  });

  it("写错的公式不炸整篇 —— 标红显示原式", async () => {
    const { html } = await render("坏的：$\\frac{1}{$");
    assert.match(html, /katex-error/);
  });

  it("**注入一律挡住**", async () => {
    /*
     * \href / \htmlClass / \includegraphics 是 KaTeX 里唯一的注入面，
     * trust:false 把它们关掉。这里再验一次结果里没有活的属性。
     */
    for (const attack of [
      "$\\href{javascript:alert(1)}{点我}$",
      "$\\htmlClass{evil}{x}$",
      "$\\includegraphics{http://evil/x.png}$",
      "$$\\href{https://evil.com}{link}$$",
      "$\\text{<script>alert(1)</script>}$",
      "$x$ <img src=x onerror=alert(1)>",
    ]) {
      const { html } = await render(attack);
      assert.doesNotMatch(html, /<script/i, attack);
      assert.doesNotMatch(html, /\son\w+\s*=/i, attack);
      assert.doesNotMatch(html, /(href|src)\s*=\s*["']?\s*javascript:/i, attack);
    }
  });

  it("原式留在 annotation 里，而且是转义过的纯文本", async () => {
    const { html } = await render("$\\href{javascript:alert(1)}{x}$");
    const ann = html.match(/<annotation[^>]*>([\s\S]*?)<\/annotation>/);
    assert.ok(ann, "没有 annotation");
    // 是文本，不是属性 —— 不可执行
    assert.doesNotMatch(ann![1], /</);
  });
});
