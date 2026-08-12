import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readCode } from "./_source";
import { describe, it } from "node:test";

import { THEME_INIT_SCRIPT, THEME_STORAGE_KEY, readThemeChoice, CANVAS_COLOR } from "@/lib/theme";

describe("配色初始化脚本", () => {
  it("是可执行的合法 JS", () => {
    // 这段脚本直接 dangerouslySetInnerHTML 进 <head>，语法错了整页脚本会挂
    assert.doesNotThrow(() => new Function(THEME_INIT_SCRIPT));
  });

  it("引用的存储键与组件一致", () => {
    assert.ok(
      THEME_INIT_SCRIPT.includes(JSON.stringify(THEME_STORAGE_KEY)),
      "脚本里的键必须与 THEME_STORAGE_KEY 相同，否则读不到用户的选择",
    );
  });

  it("只接受 light 与 dark，其余一律不设属性", () => {
    const run = (stored: string | null) => {
      let attr: string | null = null;
      const doc = {
        documentElement: {
          setAttribute: (_: string, v: string) => {
            attr = v;
          },
        },
      };
      const storage = { getItem: () => stored };
      new Function("document", "localStorage", THEME_INIT_SCRIPT)(doc, storage);
      return attr;
    };

    assert.equal(run("dark"), "dark");
    assert.equal(run("light"), "light");
    // 没存过就不设属性，交给 CSS 的 prefers-color-scheme 跟随系统
    assert.equal(run(null), null);
    assert.equal(run("system"), null);
    // 存了脏数据也不能写进 DOM 属性
    assert.equal(run('"><script>alert(1)</script>'), null);
  });

  it("**内联脚本与 readThemeChoice 结论必须一致**", () => {
    /*
     * 脚本要内联进 <head>，没法调用 TS 函数，所以这段判定不可避免地存在两份。
     * 两份一旦脱节，用户会看到「切换器显示浅色但页面是深色」——
     * 而那种 bug 只在特定的存储值下出现，肉眼几乎不可能发现。
     * 这里逐个取值把两边钉在一起。
     */
    const runScript = (stored: string | null) => {
      let attr: string | null = null;
      const doc = {
        documentElement: {
          setAttribute: (_: string, v: string) => {
            attr = v;
          },
        },
      };
      new Function("document", "localStorage", THEME_INIT_SCRIPT)(doc, {
        getItem: () => stored,
      });
      return attr;
    };

    for (const stored of [null, "", "system", "light", "dark", "DARK", "auto", "{}"]) {
      const fromFunction = readThemeChoice(stored);
      // 脚本不设属性 ⇔ 函数返回 system
      const scriptAttr = runScript(stored);
      assert.equal(
        scriptAttr,
        fromFunction === "system" ? null : fromFunction,
        `存储值 ${JSON.stringify(stored)} 两边判定不一致`,
      );
    }
  });

  it("localStorage 不可用时不抛错", () => {
    // Safari 隐私模式下访问 localStorage 会直接抛异常，
    // 不兜住的话整页脚本在第一行就死了
    const doc = { documentElement: { setAttribute: () => {} } };
    const storage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    assert.doesNotThrow(() =>
      new Function("document", "localStorage", THEME_INIT_SCRIPT)(doc, storage),
    );
  });
});

describe("**状态栏和安全区的颜色**", () => {
  /*
   * 站长报两条，根子是同一个：
   *
   *   · 「手机端上下是黑色的很诡异」—— `viewport-fit: cover` 之后，
   *     刘海和 Home Indicator 那两条安全区由 `theme-color` 上色，
   *     而它原来只按 `prefers-color-scheme` 给值：**跟着系统走，
   *     不跟着页面走**。系统深色 + 站内选浅色 = 浅色页面上下夹两条黑边。
   *   · 「回复按钮和底部栏重合时冒出一条诡异的绿色」——
   *     manifest 的 `theme_color` 是 `#0d5c47`，而站内没有任何一处
   *     是这个颜色。装成 App 之后它去涂浏览器 chrome。
   */
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

  it("**CANVAS_COLOR 必须和 globals.css 的 --canvas 一模一样**", () => {
    /*
     * 抄一份颜色值是这个仓库最容易分叉的东西之一：改了 CSS 而忘了这里，
     * 表现是「安全区的颜色和页面差一点点」—— 没有人会为此提 issue，
     * 但每个人都会觉得这个 App 做得糙。
     */
    const light = css.match(/^\s*--canvas:\s*(#[0-9a-fA-F]{3,8});/m)?.[1];
    assert.equal(light?.toLowerCase(), CANVAS_COLOR.light.toLowerCase(), "浅色对不上");

    // 深色那一份在 prefers-color-scheme 和 [data-theme=dark] 里各有一次
    const darks = [...css.matchAll(/--canvas:\s*(#[0-9a-fA-F]{3,8});/g)].map((m) =>
      m[1].toLowerCase(),
    );
    assert.ok(
      darks.includes(CANVAS_COLOR.dark.toLowerCase()),
      `深色 ${CANVAS_COLOR.dark} 在 globals.css 里找不到`,
    );
  });

  it("**manifest 的 theme_color 跟着浅色 canvas 走**，不能是别的颜色", () => {
    /*
     * 读**剥掉注释**的版本：解释这条 bug 的注释里必然写着那个绿色值，
     * 按原文搜的话这条断言第一个红的就是它自己。
     * （这个仓库踩过两次同样的坑，一次 RAG、一次 not-found 文案。）
     */
    const manifest = readCode("app/manifest.ts");
    assert.match(manifest, /theme_color: CANVAS_COLOR\.light/);
    assert.equal(manifest.includes("#0d5c47"), false, "那条诡异的绿色又回来了");
  });

  it("**显式选过主题时，theme-color 要换成不带媒体查询的那一条**", () => {
    /*
     * 服务端渲染的是两条带 media 的（对「跟随系统」是对的），
     * 但用户显式选过之后它们就错了 —— 必须换掉，不能并存。
     */
    assert.match(THEME_INIT_SCRIPT, /theme-color/);
    assert.match(THEME_INIT_SCRIPT, /remove\(\)/);
    assert.match(THEME_INIT_SCRIPT, /paint\(stored\)/);
  });

  it("**「跟随系统」时不动它** —— 那时服务端那两条正是对的", () => {
    // 无脑覆盖的话，系统在浅深之间切换时颜色不会跟着变
    assert.match(THEME_INIT_SCRIPT, /跟随系统/);
  });

  it("**切换配色时同步刷** —— 不刷的话页面白了而上下还是黑的", () => {
    const toggle = readFileSync(
      new URL("../src/components/ThemeToggle.tsx", import.meta.url),
      "utf8",
    );
    assert.match(toggle, /paintThemeColor\(choice\)/);
  });

  it("paintThemeColor 对「自动」要自己解析系统偏好", () => {
    const theme = readFileSync(new URL("../src/lib/theme.ts", import.meta.url), "utf8");
    assert.match(theme, /prefers-color-scheme: dark/);
  });
});
