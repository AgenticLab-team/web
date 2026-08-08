import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from "@/lib/theme";

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
