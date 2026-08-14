import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readSource, stripComments } from "./_source";

/**
 * 层叠顺序。
 *
 * ═════════════════════════════════════════
 * 无层的样式会**悄悄吃掉**工具类
 * ═════════════════════════════════════════
 *
 * CSS 的规则是：不在任何 `@layer` 里的样式，一律赢过有层的。
 * 而 Tailwind 的工具类全在 `utilities` 层。
 *
 * 于是一个写在层外的设计类，会让
 *
 *   className="prose-forum t-caption2"
 *
 * 里那个 `t-caption2` **什么也不做** —— 没有报错、没有警告，
 * 屏幕上就是 17px。公告横幅的正文这样显示了很久，
 * GitHub 提及卡片里那段也是。
 */

const RAW_CSS = readSource("app/globals.css");

/*
 * 先剥注释再判断。
 *
 * globals.css 里解释「为什么必须在层里」的那几段长注释**引用了类名本身**
 * （`.t-group-label` 的 16 处调用……），而那些注释在层块外面。
 * 不剥的话，一句讲清楚为什么的说明会把这条测试判红 ——
 * 于是下一个人删的是注释，不是 bug。
 */
const CSS = stripComments(RAW_CSS);

/*
 * 把所有 `@layer components { … }` 块整个抠掉，剩下的就是**层外**的部分。
 *
 * ─────────────────────────────────────────
 * 为什么不能再用 indexOf 比大小
 * ─────────────────────────────────────────
 *
 * 原来这两条断言是「`.prose-forum` 的下标大于 `@layer components {` 的下标」。
 * 那在全文件只有一个层块时凑合能用，但现在有两个 —— `indexOf` 只会找到
 * 第一个，于是**哪怕 `.prose-forum` 被搬回层外，它的下标依然大于第一个层块的
 * 开头，断言照样是绿的**。一条永远为真的断言比没有断言更糟。
 *
 * 层块以行首的 `}` 收尾（里面的嵌套规则都是缩进的），所以直接按这个切。
 */
const OUTSIDE_LAYERS = CSS.replace(/@layer components \{[\s\S]*?\n\}/g, "");

/** 这些类身上都有「会被工具类覆盖」的声明，必须在层里 */
const MUST_BE_LAYERED = [
  // 正文块：外面常套一个 t-caption2 / text-sm 调小，而那正是它压掉的东西
  ".prose-forum {",
  // 只搬一半更糟：字号能改、标题不能改，看起来「有时候管用」，最难查
  ".prose-forum-compact",
  // 排版阶梯：每个都声明 font-weight，压掉全站约 190 处 font-medium
  ".t-large-title",
  ".t-title1",
  ".t-title2",
  ".t-title3",
  ".t-headline",
  ".t-body",
  ".t-callout",
  ".t-subhead",
  ".t-footnote",
  ".t-caption ",
  ".t-caption2",
  ".t-group-label",
  ".tabular {",
];

describe("会被工具类覆盖的设计类要放进层里", () => {
  it("globals.css 里确实有 @layer components", () => {
    assert.ok(CSS.includes("@layer components {"), "globals.css 里没有 @layer components");
    assert.notEqual(OUTSIDE_LAYERS, CSS, "抠层块的正则没匹配上任何东西 —— 这条测试在空转");
  });

  for (const sel of MUST_BE_LAYERED) {
    it(`**${sel.trim()} 在层里**`, () => {
      assert.ok(CSS.includes(sel), `globals.css 里已经没有 ${sel} 了 —— 改名了就把这条一起改`);
      assert.equal(
        OUTSIDE_LAYERS.includes(sel),
        false,
        `${sel} 跑到 @layer 外面去了 —— 层外的样式会悄悄吃掉工具类`,
      );
    });
  }
});

describe("浮出来的返回按钮", () => {
  const src = readSource("components/ui/FloatingBack.tsx");

  it("**桌面端不出现** —— 那里三个出口都在，而它会盖住头像", () => {
    /*
     * 它整段存在理由（装成 App 之后浏览器 chrome 没了、
     * iOS 没有系统返回手势）都是手机独有的。桌面上有浏览器返回键、
     * 有一直在的侧栏、还有页首那条行内返回。
     *
     * 而它的代价是实打实的：`left-4` 正落在侧栏底部头像的位置。
     */
    assert.match(src, /lg:hidden/);
  });

  it("桌面端那条位置变量的覆盖也删了 —— 不渲染的东西不需要算位置", () => {
    // 留着的话，下一个人会以为桌面上还有它，然后调一个看不见的数
    assert.equal(
      /min-width: 64rem[\s\S]{0,200}--floating-back-bottom/.test(CSS),
      false,
      "还留着桌面端的 --floating-back-bottom 覆盖",
    );
  });
});
