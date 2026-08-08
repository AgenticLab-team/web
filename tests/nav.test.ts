import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ALL_NAV_ITEMS, activeNavKey, tabBarItems, visibleSections, TAB_BAR_MAX } from "@/lib/nav";

describe("导航", () => {
  it("激活项取最长匹配", () => {
    // 不取最长匹配的话，"/" 会匹配上所有路径，每个页面都显示成在首页
    assert.equal(activeNavKey("/"), "home");
    assert.equal(activeNavKey("/leaderboard"), "leaderboard");
    assert.equal(activeNavKey("/leaderboard?period=month"), "leaderboard");
    assert.equal(activeNavKey("/me"), "me");
  });

  it("子路径也算激活", () => {
    assert.equal(activeNavKey("/forum/123"), "forum");
    assert.equal(activeNavKey("/admin/users"), "admin");
  });

  it("未知路径不激活任何项", () => {
    assert.equal(activeNavKey("/nonexistent"), null);
  });

  it("首页只在精确匹配时激活", () => {
    // href 为 "/" 的项用 startsWith 会匹配一切，必须特判
    assert.notEqual(activeNavKey("/leaderboard"), "home");
  });

  it("Tab Bar 不超过 5 项", () => {
    const all = tabBarItems(() => true);
    assert.ok(all.length <= TAB_BAR_MAX, `实际 ${all.length} 项，装不下`);
  });

  it("Tab Bar 只收 inTabBar 的项", () => {
    for (const item of tabBarItems(() => true)) {
      assert.equal(item.inTabBar, true, `${item.key} 不该出现在 Tab Bar`);
    }
  });

  it("过滤后为空的分组不显示", () => {
    const sections = visibleSections((item) => item.key === "home");
    assert.equal(sections.length, 1);
    assert.equal(sections[0].items.length, 1);
  });

  it("全部过滤掉时返回空数组而非空分组", () => {
    assert.deepEqual(visibleSections(() => false), []);
  });

  it("每个导航项的 key 唯一", () => {
    const keys = ALL_NAV_ITEMS.map((i) => i.key);
    assert.equal(new Set(keys).size, keys.length, "有重复的导航 key");
  });

  it("每个导航项的 href 唯一", () => {
    const hrefs = ALL_NAV_ITEMS.map((i) => i.href);
    assert.equal(new Set(hrefs).size, hrefs.length, "有重复的导航 href");
  });
});
