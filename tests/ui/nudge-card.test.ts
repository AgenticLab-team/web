import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NudgeCard, type NudgeAction } from "@/components/home/NudgeCard";

/**
 * 首页提示卡 —— **渲染出来**再看那几个按钮。
 *
 * ═════════════════════════════════════════
 * 站长的原话：「一行两个按钮一大一小看着好丑」
 * ═════════════════════════════════════════
 *
 * 改之前那张卡是「一个实心大按钮 + 一个 32px 的 ×」，两个毛病：
 *
 *   · **一大一小是在用尺寸替人做决定** —— 而这几件事全是可选的。
 *     尺寸差把一个建议做成了半个强制。
 *   · 32px 低于 44px 触摸下限。拇指按下去有一半概率落空，
 *     **而落空的那一半会点到旁边那个实心按钮上** ——
 *     想关掉它的人反而被推着往前走了一步。
 *
 * 这两件事都是**渲染出来才看得见的**：源码里搜 `min-h-11` 只能证明
 * 那几个字符还在，证明不了每一个按钮都拿到了它，
 * 也证明不了没有哪个按钮另外又被塞了一个写死的高度。
 */

const render = async (node: unknown): Promise<string> => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(node as never);
};

const noop = () => {};

const card = (actions: NudgeAction[]) =>
  render(
    NudgeCard({
      icon: null,
      title: "标题",
      body: "说明",
      actions,
    }),
  );

/** 把渲染结果里每个 <button> 的 class 抠出来 */
const buttonClasses = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*class="([^"]*)"/g)].map((m) => m[1]);

describe("**按钮一样大**", () => {
  const three: NudgeAction[] = [
    { label: "去设置", primary: true, onClick: noop },
    { label: "以后再说", onClick: noop },
    { label: "不用了", onClick: noop },
  ];

  it("每一个都拿到了 44px 的下限", async () => {
    const classes = buttonClasses(await card(three));
    assert.equal(classes.length, 3);
    for (const c of classes) assert.match(c, /\bmin-h-11\b/, `这个按钮没有下限：${c}`);
  });

  it("**没有哪个按钮被另外塞了写死的高宽**", async () => {
    /*
     * 写死的 `h-8 w-8` 会盖过 min-h —— 那正是改之前那个 × 的样子。
     * 只搜源码搜不出这件事：`min-h-11` 和 `h-8` 可以同时存在。
     */
    for (const c of buttonClasses(await card(three))) {
      assert.equal(/(?<!min-)\bh-\d/.test(c), false, `写死了高度：${c}`);
      assert.equal(/(?<!min-)\bw-\d/.test(c), false, `写死了宽度：${c}`);
    }
  });

  /*
   * 这里比的是**它们彼此一致**，不钉具体是哪一档。
   *
   * 突变测试里把三个一起换成小一号，这条是绿的 —— 那是对的：
   * 站长指的是「一大一小」，不是「太大」或「太小」。整体调档
   * 是设计判断，钉死它只会让下一次正常的视觉调整撞上一条
   * 说不出理由的红灯。真正不能变的是**三个之间没有差别**。
   */
  it("**三个按钮的字号一模一样** —— 字号差和尺寸差是同一件事", async () => {
    const sizes = buttonClasses(await card(three)).map(
      (c) => c.match(/\bt-[a-z0-9]+\b/)?.[0] ?? "(没有)",
    );
    assert.equal(new Set(sizes).size, 1, `字号不一致：${sizes.join(" / ")}`);
  });
});

describe("**主次靠颜色，不靠尺寸**", () => {
  it("主操作有底色，其余没有", async () => {
    const html = await card([
      { label: "去设置", primary: true, onClick: noop },
      { label: "不用了", onClick: noop },
    ]);
    const tinted = [...html.matchAll(/<button[^>]*style="([^"]*)"/g)].map((m) => m[1]);
    assert.equal(tinted.length, 1, "带底色的按钮不止一个（或一个都没有）");
    assert.match(tinted[0], /color-mix/);
  });

  it("**一张卡里最多一个主操作** —— 两个主操作等于没有主操作", async () => {
    const html = await card([
      { label: "a", primary: true, onClick: noop },
      { label: "b", onClick: noop },
      { label: "c", onClick: noop },
    ]);
    assert.equal((html.match(/color-mix\(in srgb, var\(--accent\) 12%/g) ?? []).length, 2);
    // ↑ 一个是左上角图标底托，一个是主按钮；再多就是有第二个主操作了
  });

  it("主操作和次操作的**尺寸类完全相同**", async () => {
    const [primary, secondary] = buttonClasses(
      await card([
        { label: "a", primary: true, onClick: noop },
        { label: "b", onClick: noop },
      ]),
    );
    const sizing = (c: string) =>
      c
        .split(/\s+/)
        .filter((k) => /^(min-h|px|py|h|w)-/.test(k))
        .sort()
        .join(" ");
    assert.equal(sizing(primary), sizing(secondary));
  });
});

describe("按钮该有的基本属性", () => {
  it("**`type=\"button\"`** —— 不写的话在表单里会变成提交", async () => {
    const html = await card([{ label: "a", onClick: noop }]);
    assert.equal((html.match(/<button/g) ?? []).length, 1);
    assert.match(html, /type="button"/);
  });

  it("禁用的按钮真的带 disabled", async () => {
    const html = await card([{ label: "a", onClick: noop, disabled: true }]);
    assert.match(html, /disabled=""/);
  });

  it("**按钮上是文字，不是只有图标** —— 读屏念得出来", async () => {
    const html = await card([{ label: "不用了", onClick: noop }]);
    assert.match(html, />不用了</);
  });
});

describe("卡片本身", () => {
  it("标题和正文都渲染出来", async () => {
    const html = await card([{ label: "a", onClick: noop }]);
    assert.match(html, /标题/);
    assert.match(html, /说明/);
  });

  it("**窄屏上按钮会换行，不是各自压窄** —— 压窄了就点不准", async () => {
    const html = await card([{ label: "a", onClick: noop }]);
    assert.match(html, /flex-wrap/);
  });

  it("没有 error 时不渲染那一行", async () => {
    const html = await card([{ label: "a", onClick: noop }]);
    assert.equal(html.includes("var(--danger)"), false);
  });

  it("有 error 时用危险色，且是一整段", async () => {
    const html = await render(
      NudgeCard({
        icon: null,
        title: "t",
        body: "b",
        actions: [{ label: "a", onClick: noop }],
        error: "出错了",
      }),
    );
    assert.match(html, /出错了/);
    assert.match(html, /var\(--danger\)/);
  });
});
