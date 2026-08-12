import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ALL_NAV_ITEMS,
  activeNavKey,
  navItemVisible,
  tabBarItems,
  visibleSections,
  moreSheetSections,
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
    assert.deepEqual(keys, ["home", "forum"], "访客能看首页和论坛公开版块；检索与我的需要登录");
  });

  it("**总榜不占 tab 栏的格子，但仍然够得着**", () => {
    /*
     * tab 栏一共 5 格，第 5 格留给「更多」——
     * 5 格全是目的地的话，剩下 7 个板块在手机上就没有入口了
     * （之前就是这样：通知、资源库、活动、成员、雷达、商店、后台全都摸不到）。
     *
     * 榜单是「偶尔看一眼」的东西，让位给每天都点的那几个，
     * 它在「更多」里 —— 而「更多」是用减法算的，不会漏。
     */
    const inMore = moreSheetSections(asGuest).flatMap((s) => s.items.map((i) => i.key));
    assert.ok(inMore.includes("leaderboard"), "总榜从 tab 栏拿掉之后没进「更多」");
  });

  it("总榜对访客开放", () => {
    // 贡献排名是荣誉，公开；分群数据在页面内部收口，不靠隐藏入口保护
    const board = ALL_NAV_ITEMS.find((i) => i.key === "leaderboard")!;
    assert.equal(navItemVisible(board, { loggedIn: false, hasPermission: () => false }), true);
  });

  it("登录用户能看到需要登录的项", () => {
    const keys = tabBarItems(asMember).map((i) => i.key);
    assert.ok(keys.includes("me"));
    /*
     * 原来这里断言的是 `search`。检索现在是「群聊」这个入口下面的一个视图
     * （回看 / 检索 / 资源库 / 雷达 合成了一项，见 nav.ts），
     * 所以举的例子换成 `chat` —— 这条测的一直是
     * 「requiresAuth 的入口在登录后真的出现了」，
     * 而不是「必须存在一个叫 search 的导航项」。
     */
    assert.ok(keys.includes("chat"));
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
    for (const forbidden of ["search", "me", "admin"]) {
      assert.ok(!keys.includes(forbidden), `访客不该看到 ${forbidden}`);
    }
  });
});

describe("前台导航的图标", () => {
  it("**每个入口声明的图标都要在 ICONS 里注册**", () => {
    /*
     * 没注册的图标会静默回退，导航里出现两个一模一样的图标 ——
     * 不报错、不崩，只是谁也说不清哪个是哪个。
     * 后台导航已经有同样的断言，前台之前漏了，
     * 而漏的那次就真的漏进去一个（shop 的 gift）。
     */
    const source = readFileSync(
      new URL("../src/components/shell/icons.tsx", import.meta.url),
      "utf8",
    );
    /*
     * 字符类里**必须带数字**。
     *
     * 原来写的是 `[a-z-]+`，于是 `folder-git-2` 这种带数字的名字
     * 整个匹配不上 —— 它明明已经注册了，守卫却报「没注册」。
     *
     * 这和部署脚本那次 chunk 正则漏掉连字符是同一个病：
     * **正则漏掉一类命名，守卫照常在跑，只是看不见那一类**。
     * 那次是漏报（守卫变绿），这次是误报（守卫变红）——
     * 误报还算走运，漏报才是真的会让人赔进去。
     */
    const registered = new Set(
      [...source.matchAll(/^\s+"?([a-z0-9-]+)"?:\s+[A-Z]\w+,$/gm)].map((m) => m[1]),
    );

    for (const item of ALL_NAV_ITEMS) {
      if (!item.icon) continue;
      assert.ok(
        registered.has(item.icon),
        `${item.key} 用的图标 ${item.icon} 没在 icons.tsx 里注册，会静默回退`,
      );
    }
  });
});
