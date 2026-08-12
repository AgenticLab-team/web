import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readSource } from "./_source";

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

const CSS = readSource("app/globals.css");

describe("会被工具类覆盖的设计类要放进层里", () => {
  it("**.prose-forum 在 @layer components 里**", () => {
    /*
     * 它是确凿有受害者的那一个：正文块常常要在外面套一个
     * `t-caption2` / `text-sm` 调小，而那正是它压掉的东西。
     */
    const layerAt = CSS.indexOf("@layer components {");
    const ruleAt = CSS.indexOf(".prose-forum {");
    assert.ok(layerAt >= 0, "globals.css 里没有 @layer components");
    assert.ok(ruleAt > layerAt, ".prose-forum 又跑到层外面去了");
  });

  it("整块都在层里 —— 只搬一半更糟", () => {
    /*
     * 搬一半的话，`.prose-forum` 能被覆盖而 `.prose-forum h2` 不能，
     * 于是同一个块里字号能改、标题不能改 —— 那种不一致比全都不能改
     * 更难查，因为它看起来「有时候管用」。
     */
    const start = CSS.indexOf("@layer components {");
    const compactAt = CSS.indexOf(".prose-forum-compact");
    assert.ok(compactAt > start, ".prose-forum-compact 落在层外了");
  });
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
