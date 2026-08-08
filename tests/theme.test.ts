import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { THEME_INIT_SCRIPT, THEME_STORAGE_KEY, readThemeChoice } from "@/lib/theme";

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
