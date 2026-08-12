import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { FloatingBack } from "@/components/ui/FloatingBack";

/**
 * 划下去之后仍然回得来的那个返回。
 *
 * ═════════════════════════════════════════
 * 站长报的两条是同一条
 * ═════════════════════════════════════════
 *
 *   ·「回到上级页面的按钮在最上面，读完长文章要回去就得翻回最上面」
 *   ·「我在手机上不能回到上一页」
 *
 * 第二条尤其要紧：manifest 里 `display: standalone`，装成 App 之后
 * **浏览器那一整条 chrome 都没有了，连返回按钮一起没了**。
 * 站内那个只在页首的返回链接就是唯一的出口，而长文读到底它在两屏之外。
 */

/*
 * 这个组件**带 hook**（useRef / useState / useEffect），所以不能像
 * 别的纯组件那样直接当函数调 —— 必须让 React 来驱动，
 * 否则 `useRef` 会在没有 dispatcher 的情况下崩掉。
 */
const render = async (props: { href: string; children: React.ReactNode }): Promise<string> => {
  const [{ renderToStaticMarkup }, { createElement }] = await Promise.all([
    import("react-dom/server"),
    import("react"),
  ]);
  return renderToStaticMarkup(createElement(FloatingBack, props));
};

const html = () => render({ href: "/forum/general", children: "闲聊" });

describe("渲染出来", () => {
  it("是一个真的链接，去处和行内那条一致", async () => {
    const out = await html();
    assert.match(out, /href="\/forum\/general"/);
    assert.match(out, /闲聊/);
  });

  it("**首屏是藏起来的** —— 和页首那条同时出现就是同一个动作给了两个按钮", async () => {
    const out = await html();
    assert.match(out, /opacity-0/);
    assert.match(out, /pointer-events-none/);
  });

  it("**藏着的时候键盘也跳不到** —— 不然 Tab 会停在一个看不见的东西上", async () => {
    assert.match(await html(), /tabindex="-1"/i);
  });

  it("藏着时对读屏也隐藏", async () => {
    assert.match(await html(), /aria-hidden="true"/);
  });

  it("**用 invisible 不用不渲染** —— 出现和消失才有得过渡", async () => {
    // 直接挂上/摘掉是一次生硬的跳变
    const out = await html();
    assert.match(out, /transition-all/);
  });

  it("长标题要截断，不能撑出屏幕", async () => {
    const out = await render({ href: "/x", children: "一个特别特别长的版块名字".repeat(5) });
    assert.match(out, /truncate/);
    assert.match(out, /max-w-\[min\(60vw,14rem\)\]/);
  });
});

describe("**位置：不能压在底部 Tab Bar 上**", () => {
  /*
   * 压上去正是站长抱怨过的另一种叠加（回复框和底部栏重合）。
   */
  it("底距走 CSS 变量，不写死", async () => {
    assert.match(await html(), /var\(--floating-back-bottom\)/);
  });

  it("**那个变量在手机上让开 Tab Bar 和 Home Indicator**", () => {
    const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
    // 不用 /s：那个标志要 es2018，而这里 [^;] 本来就跨行
    const m = css.match(/--floating-back-bottom:\s*calc\(([^;]*)\)/);
    assert.ok(m, "变量没了");
    assert.match(m[1], /--tabbar-height/);
    assert.match(m[1], /safe-area-inset-bottom/);
  });

  it("**桌面端整个不出现** —— 它在那儿本来就没有理由", () => {
    /*
     * 这一条以前测的是反面：「桌面端要单独覆盖那个位置变量」。
     * 那时候的想法是把它挪到不碍事的地方，而站长问的是更根子的问题 ——
     * 「为啥电脑端要返回按钮呢」。
     *
     * 它整段存在理由（装成 App 之后浏览器 chrome 没了、
     * iOS 没有系统返回手势）**都是手机独有的**。桌面上有浏览器返回键、
     * 有一直在的侧栏、还有页首那条行内返回，三个出口都在。
     *
     * 而它的代价是实打实的：`left-4` 正落在侧栏底部头像那一格上，
     * 盖在人脸上。侧栏那一列从上到下都是内容，桌面上没有空地给它 ——
     * 所以这不是「调位置」能解决的。
     */
    const src = readFileSync(
      new URL("../../src/components/ui/FloatingBack.tsx", import.meta.url),
      "utf8",
    );
    assert.match(src, /lg:hidden/);

    // 不渲染的东西不需要有人替它算位置，留着会让下一个人去调一个看不见的数
    const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
    const desktop = css.slice(css.indexOf("@media (min-width: 64rem)"));
    assert.equal(
      /--floating-back-bottom:/.test(desktop.slice(0, 400)),
      false,
      "桌面端那条覆盖该删了",
    );
  });
});

describe("**二十个页面一次全好**", () => {
  it("挂在 BackLink 里，不是逐页去加", () => {
    /*
     * 逐页加是二十次漏掉一处的机会 —— 而漏掉的那一页
     * 恰好可能就是最长的那一篇。
     */
    const primitives = readFileSync(
      new URL("../../src/components/ui/primitives.tsx", import.meta.url),
      "utf8",
    );
    assert.match(primitives, /<FloatingBack href=\{href\}>\{children\}<\/FloatingBack>/);
  });

  it("行内那条一个字没改 —— 它仍然是页首那个入口", () => {
    const primitives = readFileSync(
      new URL("../../src/components/ui/primitives.tsx", import.meta.url),
      "utf8",
    );
    assert.match(primitives, /t-subhead -ml-1 mt-6 inline-flex/);
  });
});
