import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

import { Empty, EmptyAction } from "@/components/ui/primitives";

/**
 * 空态那个「出口」槽位 —— **渲染出来**再看它怎么排。
 *
 * ═════════════════════════════════════════
 * 起因：首页游客卡上按钮压住了链接
 * ═════════════════════════════════════════
 *
 * 未登录时首页右边那张卡传了两个孩子：一个登录按钮，
 * 下面一行「还不在群里？申请加入」。调用点写的是
 * `className="mt-3 block"` —— 按正常直觉，这就该另起一行。
 *
 * 而 `Empty` 把 action 包在 `flex justify-center` 里，
 * 于是两个孩子成了并排的 flex item，`display: block` 对 flex item
 * **不生效**，链接的左半边被按钮盖住。
 *
 * 这种错源码里搜不出来：两边的类名各自都是对的，
 * 错的是它们凑在一起之后的那层关系。所以这条测试渲染真组件，
 * 断言的是**关系本身**。
 *
 * 截图看出来的，不是读代码读出来的 —— 那张卡在线上挂了不知道多久，
 * 而它是未登录访客看到的第一屏。
 */

const render = async (node: unknown): Promise<string> => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(node as never);
};

/** 抠出包着 action 的那一层 div 的 class */
function actionWrapperClass(html: string): string {
  const match = html.match(/<div class="((?:[^"]*\b)?mt-5[^"]*)"/);
  assert.ok(match, `找不到 action 那一层（mt-5）——\n${html}`);
  return match[1];
}

describe("**空态的出口是竖着排的**", () => {
  it("包 action 的那层是 flex-col —— 横排会让第二个孩子贴在按钮右边", async () => {
    const html = await render(
      Empty({
        title: "群聊内容与分群数据仅对成员开放",
        action: EmptyAction({ href: "/login", children: "用微信身份登录" }),
      }),
    );
    const cls = actionWrapperClass(html);
    assert.match(cls, /\bflex-col\b/, `action 又变回横排了：${cls}`);
  });

  it("**横向居中还得在** —— 换成 flex-col 之后 justify-center 管的是纵轴", async () => {
    /*
     * 这一条是配套的：`justify-center` 在 row 里居中的是横向，
     * 改成 column 之后它居中的变成纵向 —— 而纵向本来就是自动高度，
     * 于是「居中」这件事静悄悄地没了，按钮会贴到左边。
     * 必须换成 `items-center`。
     */
    const html = await render(
      Empty({ title: "x", action: EmptyAction({ href: "/login", children: "登录" }) }),
    );
    const cls = actionWrapperClass(html);
    assert.match(cls, /\bitems-center\b/, `按钮不再横向居中了：${cls}`);
  });

  it("**两个孩子时不许并排** —— 这正是线上出问题的那一种", async () => {
    const html = await render(
      Empty({
        title: "群聊内容与分群数据仅对成员开放",
        hint: "登录后可以看到自己所在群的动态。",
        action: [
          EmptyAction({ href: "/login", children: "用微信身份登录" }),
          createElement("a", { key: "join", href: "/join", className: "mt-3 block" }, "还不在群里？申请加入"),
        ] as never,
      }),
    );
    // 两个孩子都在
    assert.match(html, /用微信身份登录/);
    assert.match(html, /还不在群里/);
    // 而包着它们的那层必须是纵向的
    assert.match(actionWrapperClass(html), /\bflex-col\b/);
  });

  it("**不给 gap** —— 另外几处只传一个孩子的调用点要一个像素都不变", async () => {
    /*
     * 加了 gap 的话，单孩子那 5 处（登录、回论坛……）的间距不会变，
     * 但第二个孩子自己带的 `mt-3` 会和 gap 叠起来。
     * 间距归调用方管，容器只管方向。
     */
    const html = await render(
      Empty({ title: "x", action: EmptyAction({ href: "/login", children: "登录" }) }),
    );
    const cls = actionWrapperClass(html);
    assert.equal(/\bgap-/.test(cls), false, `容器自己加了间距：${cls}`);
  });
});
