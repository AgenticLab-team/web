import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readCode } from "./_source";

/**
 * 快捷键提示 —— **一个念错的提示比没有提示糟**。
 *
 * 发布框底下原来写死着「⌘↵ 发布」：
 *
 *   · 非 Mac 上它是**错的** —— 那儿是 Ctrl，而写着 ⌘ 的提示
 *     会让人去按一个不存在的键，然后以为这个功能坏了
 *   · 手机上它**根本不该出现** —— 那儿没有物理键盘，
 *     一条讲键盘的提示只是在占那一行唯一的位置
 *
 * 是在手机端截图时看见的：那一行明明白白写着 ⌘。
 */

describe("**UI 文案里不许写死 ⌘**", () => {
  it("编辑器那句提示是算出来的，不是写死的", () => {
    const code = readCode("components/forum/Editor.tsx");
    assert.match(code, /modKey\(\)/, "没用 modKey()");
    // 工具栏按钮上的 `粗体 ⌘B` 是 title 属性，那些另说（见下一条）
    const statusBar = code.slice(code.indexOf("支持 Markdown"));
    assert.equal(
      /⌘/.test(statusBar.slice(0, 300)),
      false,
      "状态栏那句里还写死着 ⌘",
    );
  });

  it("**触摸设备上整句不提快捷键**", () => {
    const code = readCode("components/forum/Editor.tsx");
    assert.match(code, /showsShortcuts\(\)/);
    // 拼接时要能整段省掉，而不是留一个空的 `· `
    assert.match(code, /hint \? ` · \$\{hint\}` : ""/);
  });

  it("**平台判断只有一份** —— 各写一遍会有的地方改对、有的还写着 ⌘", () => {
    const platform = readCode("lib/ui/platform.ts");
    assert.match(platform, /maxTouchPoints/);
    assert.match(platform, /userAgentData/);
  });

  it("**iPad 不算 Mac** —— 它的 userAgent 里也有 Macintosh", () => {
    /*
     * iPad 伪装成桌面版 Safari，userAgent 里带 "Macintosh"。
     * 只看那个字符串的话，一台没有 ⌘ 键的设备会被告知去按 ⌘。
     */
    const platform = readCode("lib/ui/platform.ts");
    assert.match(platform, /!hasTouch\(\)/, "认 Mac 时没有排除触摸设备");
  });

  it("**服务端那一份返回 null** —— 首屏不提，水合之后再补", () => {
    /*
     * 服务端拿不到 navigator。给一个猜的值的话，
     * 客户端算出另一个，React 报水合不一致 ——
     * 而那个报错指向整棵子树，一个字都不提快捷键。
     */
    const code = readCode("components/forum/Editor.tsx");
    assert.match(code, /useSyncExternalStore/);
    // 从**调用**处切，不是 import 那一行 —— 第一版就是那么切的，
    // 于是量的是文件开头那几行 import
    const call = code.slice(code.indexOf("const hint = useSyncExternalStore"));
    assert.match(call.slice(0, 400), /\(\) => null/, "服务端快照不是 null");
  });
});
