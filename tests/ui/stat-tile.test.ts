import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { StatTile } from "@/components/ui/primitives";

import { readSource } from "../_source";

/**
 * 统计格子 —— 它坏起来的方式是**坏掉别人**。
 *
 * ═════════════════════════════════════════
 * 起因：首页第三张卡被视口切掉一半
 * ═════════════════════════════════════════
 *
 * 「社区脉搏」在窄屏上是 `grid-cols-3`。390px 的手机每格约 112px，
 * 去掉内边距剩 88px，而 `60,137` 在 28px 等宽数字下要 90 出头。
 *
 * 差三个像素的后果不是「数字挤一点」：grid item 默认
 * `min-width: auto`，撑不下时它**把自己那一列顶宽**，
 * 于是整个 grid 超出容器，第三张卡被视口切掉。
 * 屏幕上看起来像是卡片本来就设计成这样，没有一处会报错。
 *
 * 两条修法各修一半，缺一条都还会犯：
 *   · `min-w-0` —— 放不下的后果回到这一格自己身上，不再顶宽整行
 *   · `.t-stat` —— 窄屏降一档，让它本来就放得下
 *
 * 也是截图看出来的。
 */

const render = async (node: unknown): Promise<string> => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(node as never);
};

describe("**统计格子不许顶宽自己那一列**", () => {
  it("根元素带 min-w-0 —— 没有它，放不下时坏的是整行不是这一格", async () => {
    const html = await render(StatTile({ label: "累计消息", value: 60137 }));
    assert.match(html, /class="[^"]*\bmin-w-0\b/, `根元素没有 min-w-0：\n${html}`);
  });

  it("**可点的那种也要有** —— 它走的是另一个分支", async () => {
    /*
     * `href` 那条路返回的是 `<Link>`，surface 字符串是共用的。
     * 共用是对的，但共用这件事要有人盯着 —— 分叉的那天，
     * 坏的只有后台仪表盘，而那里没人会往「grid 顶宽」上想。
     */
    const html = await render(StatTile({ label: "待办", value: 3, href: "/admin" }));
    assert.match(html, /class="[^"]*\bmin-w-0\b/, `可点的那种没有 min-w-0：\n${html}`);
  });

  it("数字用的是 .t-stat，不是固定的 t-title1", async () => {
    const html = await render(StatTile({ label: "累计消息", value: 60137 }));
    assert.match(html, /class="tabular t-stat/);
    assert.equal(/\bt-title1\b/.test(html), false, "又用回不随宽度变的那一档了");
  });
});

describe("**.t-stat 必须是窄屏小、宽屏大**", () => {
  const css = readSource("app/globals.css");

  /** `.t-stat` 的两次声明：窄屏那条 clamp，和断点里那个定值 */
  const decls = [...css.matchAll(/\.t-stat\s*\{([^}]*)\}/g)].map((m) => m[1]);

  it("声明了两档", () => {
    assert.equal(decls.length, 2, `.t-stat 应该有两档（窄屏 + 断点内），实际 ${decls.length} 档`);
  });

  it("**窄屏那档是 clamp，跟着视口连续变**", () => {
    /*
     * 不是又一个断点。放不放得下是连续的 —— 三栏等分时卡片宽度
     * 就是 `(视口 - 页边距 - 间隙) / 3`，随视口线性变。
     * 用断点的话，断点那一侧永远留着一段「刚好差几个像素」的宽度，
     * 而那正是这个 bug 本来的样子。
     */
    assert.match(decls[0], /font-size:\s*clamp\([^)]*vw[^)]*\)/, `窄屏那档不是 clamp：${decls[0]}`);
  });

  it("**断点里那一档更大** —— 写反了的话宽屏反而更小", () => {
    const wide = Number(decls[1].match(/font-size:\s*([\d.]+)rem/)![1]);
    const cap = Number(decls[0].match(/clamp\([^,]+,[^,]+,\s*([\d.]+)rem/)![1]);
    assert.ok(wide > cap, `宽屏 ${wide}rem 不比窄屏的上界 ${cap}rem 大`);
  });

  it("**这里不写按像素算的界** —— 字体是设备自己的，量不准", () => {
    /*
     * ═════════════════════════════════════════
     * 第一版这条测试是「七位数放得下吗」，算出 106px > 88px，红了
     * ═════════════════════════════════════════
     *
     * 然后才想起来：`--font-sans` 是系统字体栈
     * （-apple-system / PingFang SC / …）。真机上是苹方或思源，
     * 而 CI 这台 Linux 上落到的是完全另一套字形 ——
     * **在这里量出来的每一个像素都不代表用户看到的。**
     *
     * 一条算得很精确、但算的是别的机器的测试，比没有测试更坏：
     * 它会在字体换了的那天红，而那天根本没有人改坏任何东西。
     *
     * 所以这一档能保证的只有结构上的两件事，下面各一条：
     * 窄屏比宽屏小、字重不跟着降。
     * 「到底放不放得下」靠截图看，不靠算 —— 而看的时候要用
     * 320px（还在用的最小屏）而不是 390px。
     *
     * 真正兜底的是 `min-w-0`：哪天某台设备上的字形就是宽到放不下，
     * 后果是这一格里的数字被裁，而不是整行 grid 顶宽把邻居挤出视口。
     * 前者难看，后者看不出来 —— 这条测试只保证坏的是前一种。
     */
    assert.match(css, /\.t-stat/, "这一档没了的话，下面两条断言等于在断言空气");
  });

  it("**字重不跟着降** —— 换行不换声音", () => {
    /*
     * 降一档很容易顺手把 font-weight 也跟着阶梯降到 600，
     * 那样手机和电脑上这个数字会是两种字重 —— 而它要的是
     * 「大数字」那一个声音，只是尺寸不同。
     */
    assert.match(decls[0], /font-weight:\s*700/, `窄屏那档不是 700：${decls[0]}`);
  });

  it("**别人不许再写 sm:t-title1 这种** —— 排版阶梯生不出带断点的变体", () => {
    /*
     * `.t-*` 是 @layer components 里的普通类，不是 `@utility`。
     * 带断点前缀写出来 Tailwind 不会生成任何样式，**而且不报错** ——
     * 那种「写了等于没写」是这个仓库最贵的一类错。
     * 真要随宽度变，就照 .t-stat 这样在 CSS 里加一档。
     */
    const bad = [...readSource("components/ui/primitives.tsx").matchAll(/\b(sm|md|lg|xl):t-[a-z0-9-]+/g)];
    assert.deepEqual(bad.map((m) => m[0]), []);
  });
});
