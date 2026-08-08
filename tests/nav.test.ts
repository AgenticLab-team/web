import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALL_NAV_ITEMS,
  activeNavKey,
  navItemVisible,
  tabBarItems,
  visibleSections,
  TAB_BAR_MAX,
} from "@/lib/nav";

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

describe("导航可见性", () => {
  // 用生产代码的同一个判定函数，不在测试里重写一遍
  const asGuest = (item: Parameters<typeof navItemVisible>[0]) =>
    navItemVisible(item, { loggedIn: false, hasPermission: () => false });
  const asMember = (item: Parameters<typeof navItemVisible>[0]) =>
    navItemVisible(item, { loggedIn: true, hasPermission: () => true });

  it("需要登录的项对访客隐藏", () => {
    const keys = tabBarItems(asGuest).map((i) => i.key);
    assert.ok(!keys.includes("me"), "访客不该看到「我的」");
    assert.ok(!keys.includes("leaderboard"), "访客不该看到「排行」——榜单按所在群统计");
    assert.deepEqual(keys, ["home"], "访客只剩首页");
  });

  it("登录用户能看到需要登录的项", () => {
    const keys = tabBarItems(asMember).map((i) => i.key);
    assert.ok(keys.includes("me"));
    assert.ok(keys.includes("leaderboard"));
  });

  it("未实现的入口对谁都不显示", () => {
    for (const item of ALL_NAV_ITEMS.filter((i) => !i.ready)) {
      assert.equal(navItemVisible(item, { loggedIn: true, hasPermission: () => true }), false,
        `${item.key} 还没实现，不该出现在导航里`);
    }
  });

  it("有权限但未登录仍然不显示需要登录的项", () => {
    // 权限判定与登录状态是两个独立条件，不能只查一个
    const me = ALL_NAV_ITEMS.find((i) => i.key === "me")!;
    assert.equal(navItemVisible(me, { loggedIn: false, hasPermission: () => true }), false);
  });

  it("访客看到的分组里不含任何群相关入口", () => {
    const sections = visibleSections(asGuest);
    const keys = sections.flatMap((s) => s.items.map((i) => i.key));
    for (const forbidden of ["search", "leaderboard", "me", "admin"]) {
      assert.ok(!keys.includes(forbidden), `访客不该看到 ${forbidden}`);
    }
  });
});
