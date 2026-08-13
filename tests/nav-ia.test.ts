import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ALL_NAV_ITEMS,
  NAV,
  activeNavKey,
  moreSheetSections,
  navItemVisible,
  sidebarMoreSections,
  sidebarPrimaryItems,
  tabBarItems,
  visibleSections,
} from "@/lib/nav";
import { FLAGS } from "@/lib/flags/registry";
import { stripComments as strip } from "./_source";

/**
 * 信息架构。
 *
 * ─────────────────────────────────────────
 * 站长报的四件事，其实是同一件
 * ─────────────────────────────────────────
 *
 * ① 侧边栏电脑端有点乱，能不能把不常用的收进「更多」
 * ② 「我关注的」能不能并进「我的」
 * ③ 社区除了成员，其他部分整合一下
 * ④ 成员那个模块不太优雅，就是单纯一个列表
 *
 * 前三件是同一个病：**这个站往导航上加东西没有代价**。
 * 手机端因为 tab 栏只有五格，早就被逼出了「更多」；
 * 桌面侧栏因为「地方够」，就一直什么都往外摆 ——
 * 一个普通成员看到 12 行、站长 13 行，分三组而其中两组没有标题。
 *
 * 而与此同时，**按天回看根本不在导航里**：站里数据最多的一页
 * （四万多条消息），只能从搜索结果和通知里撞进去。
 *
 * 所以这组测试测的不是「某几项在不在」，是**结构**：
 * 一级有代价（它一直占着那一行），「更多」用减法算（不会漏），
 * 两端同一套办法（不会一边有一边没有）。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
/** 正则会匹配到注释里的字眼 —— 先把注释剥掉再断言 */

const everything = () => true;
const asMember = (item: Parameters<typeof navItemVisible>[0]) =>
  navItemVisible(item, { loggedIn: true, hasPermission: () => true });

describe("桌面侧栏也要有「更多」", () => {
  /*
   * 这一条和 mobile-reach 那条是**镜像**的。
   *
   * 手机那条防的是「桌面上有、手机上摸不到」；这一条防的是反面 ——
   * 一级放不下的东西被收进「更多」之后，如果「更多」不是用减法算的，
   * 那么下一个新页面就会在桌面上彻底消失，而手机上一切正常。
   * 两条都在，才是「两端同一份」。
   */
  it("一级里的 + 「更多」里的 = 全部看得见的，一个都不少", () => {
    const all = visibleSections(everything).flatMap((s) => s.items.map((i) => i.key));
    const reachable = new Set([
      ...sidebarPrimaryItems(everything).map((i) => i.key),
      ...sidebarMoreSections(everything).flatMap((s) => s.items.map((i) => i.key)),
    ]);
    const missing = all.filter((k) => !reachable.has(k));
    assert.deepEqual(missing, [], "这些板块在电脑端没有任何入口");
  });

  it("一级和「更多」不重复 —— 同一个入口出现两次是噪音", () => {
    const primary = new Set(sidebarPrimaryItems(everything).map((i) => i.key));
    const more = sidebarMoreSections(everything).flatMap((s) => s.items.map((i) => i.key));
    assert.deepEqual(more.filter((k) => primary.has(k)), []);
  });

  it("**「更多」是用减法算的**，不是第二份要人手工维护的清单", () => {
    /*
     * 维护两份清单的话，加了新页面而忘了往「更多」里加，
     * 表现就是电脑上摸不到它 —— 而手机上一切正常，很难被发现。
     * 手机端那一侧由 tests/mobile-reach.test.ts 用同样的方式钉着。
     */
    const source = src("lib/nav.ts");
    const fn = source.slice(source.indexOf("export function sidebarMoreSections"));
    assert.match(fn.slice(0, 500), /!primary\.has\(item\.key\)/);
  });

  it("全部过滤掉时一级是空的，不留下一个空壳「更多」", () => {
    assert.deepEqual(sidebarPrimaryItems(() => false), []);
    assert.deepEqual(sidebarMoreSections(() => false), []);
  });
});

describe("一级放什么：判据是「多久点一次」，不是「重不重要」", () => {
  /*
   * 站长给的判据：「每天都会点」vs「一个月点一次」。
   * 后台设置很重要，但没人每天进 —— 重要和常用是两件事，
   * 而一级导航的成本是它**一直占着那一行**。
   */
  it("一级就那么几项 —— 多一项，每天要点的那几个就难找一分", () => {
    /*
     * ── 2026-08 加了「项目」 ─────────────────────
     *
     * 它原来按「一周也未必点一次」被判在「更多」里，那是按**它当时的
     * 样子**判的：一个只能看的目录。后来它成了这个社区最适合对外
     * 展示的一张脸，还加了自荐 —— 一个需要人主动走进去写点什么的
     * 地方，藏在「更多」里等于没有。
     *
     * 这是站长的决定，写在这里是为了让下一个人知道它**不是漏进来的**。
     * 判据本身没变：变的是这一项在判据上的位置。
     *
     * 手机 tab 栏没动 —— 那里只有四个目的地且已满，
     * 挤掉首页/论坛/消息/通知里的任何一个代价都更大。
     */
    const keys = sidebarPrimaryItems(everything).map((i) => i.key);
    assert.deepEqual(keys, ["home", "forum", "chat", "notifications", "me", "projects"]);
  });

  it("**后台不是一级** —— 它很重要，但没有人每天进后台", () => {
    const admin = ALL_NAV_ITEMS.find((i) => i.key === "admin")!;
    assert.notEqual(admin.primary, true);
    // 但仍然摸得到：在「更多」里
    const more = sidebarMoreSections(everything).flatMap((s) => s.items.map((i) => i.key));
    assert.ok(more.includes("admin"), "电脑端进不去管理区");
  });

  it("**榜单不是一级** —— 偶尔看一眼的东西不该占着每天的位置", () => {
    /*
     * 这和 nav.ts 里「榜单不占 tab 栏格子」是同一条判断，
     * 只是这次轮到电脑端。两端用同一个判据，人换个设备不会看到两种排布。
     */
    const board = ALL_NAV_ITEMS.find((i) => i.key === "leaderboard")!;
    assert.notEqual(board.primary, true);
  });

  it("**tab 栏里的，电脑端必须也是一级** —— 否则同一个站两种主次", () => {
    for (const item of ALL_NAV_ITEMS.filter((i) => i.inTabBar)) {
      assert.equal(
        item.primary,
        true,
        `${item.key} 在手机 tab 栏里是主角，在电脑上却被收进了「更多」`,
      );
    }
  });

  it("通知是一级但不占 tab 格 —— 手机上它的红点由「更多」代收", () => {
    /*
     * 手机只有四格，通知让位给了首页/论坛/群聊/我的。
     * 让位的前提是红点不会跟着消失 —— TabBar 把「更多」里所有条目的
     * 未读数加起来显示在「更多」上，侧栏也做了同一件事。
     * 两边都做了，这一条才成立。
     */
    const bell = ALL_NAV_ITEMS.find((i) => i.key === "notifications")!;
    assert.equal(bell.primary, true);
    assert.notEqual(bell.inTabBar, true);

    const sidebar = strip(src("components/shell/Sidebar.tsx"));
    assert.match(sidebar, /moreBadge/, "侧栏的「更多」收起来之后未读数就没了");
  });
});

describe("群聊：四个视图一个入口", () => {
  /*
   * 按天回看 / 检索 / 资源库 / 关键词雷达，问的是同一个问题的四种问法：
   * 群里说过的那件事，再找出来。数据上也确实是一条流的衍生。
   *
   * 之前它们是导航上互不相干的三项，加上一个**不在导航里**的按天回看。
   */
  it("**按天回看有了入口** —— 它曾经完全不在导航里", () => {
    /*
     * 回归测试。站里数据最多的一页（四万多条消息）曾经只能从
     * 搜索结果、@ 通知和首页那张卡片撞进去 —— 一个没有前门的房间。
     */
    const hrefs = ALL_NAV_ITEMS.map((i) => i.href);
    assert.ok(hrefs.includes("/archive"), "按天回看还是没有导航入口");
  });

  it("四个视图的地址都激活同一项 —— 切来切去侧栏那一行不会灭", () => {
    for (const path of ["/archive", "/archive?date=2026-08-01", "/search", "/links", "/radar"]) {
      assert.equal(activeNavKey(path), "chat", `${path} 没有激活「群聊」`);
    }
  });

  it("检索、资源库、雷达不再各占一项", () => {
    const keys = ALL_NAV_ITEMS.map((i) => i.key);
    for (const gone of ["search", "links", "radar"]) {
      assert.ok(!keys.includes(gone), `${gone} 还是一个独立的导航项，没有整合进去`);
    }
  });

  it("**关掉其中一个视图，入口不会跟着消失**", () => {
    /*
     * 按天回看不受任何开关管。如果「群聊」这一项挂上了检索的开关，
     * 站长在后台关掉检索的那一刻，回看就跟着从导航里消失了 ——
     * 而那一页本身还好好的、还有四万条消息。
     */
    const chat = ALL_NAV_ITEMS.find((i) => i.key === "chat")!;
    assert.equal(chat.flag, undefined, "「群聊」被单个视图的开关管着了");
    assert.equal(
      navItemVisible(chat, {
        loggedIn: true,
        hasPermission: () => true,
        featureEnabled: () => false, // 所有开关全关
      }),
      true,
      "开关全关之后连按天回看都进不去了",
    );
  });

  it("三个开关都指着「群聊」这一项 —— 清单和导航不能各说各的", () => {
    const navKeys = new Set(NAV.flatMap((s) => s.items.map((i) => i.key)));
    for (const key of ["message_search", "link_library", "keyword_radar"]) {
      const spec = FLAGS.find((f) => f.key === key)!;
      assert.deepEqual(spec.navKeys, ["chat"], `${key} 还指着一个已经不存在的导航项`);
      for (const k of spec.navKeys!) assert.ok(navKeys.has(k));
    }
  });

  it("四个视图页都挂着同一排标签 —— 少一页，那一页就是死胡同", () => {
    /*
     * 只在检索页画这排标签的话，从检索点进资源库就再也回不来了：
     * 人得靠浏览器后退。整合的意思是四种问法互相看得见，
     * 不是把四项塞进同一个折叠菜单。
     */
    for (const [page, current] of [
      ["app/(app)/archive/page.tsx", "archive"],
      ["app/(app)/search/page.tsx", "search"],
      ["app/(app)/links/page.tsx", "links"],
      ["app/(app)/radar/page.tsx", "radar"],
    ] as const) {
      assert.match(strip(src(page)), new RegExp(`<ChatTabs current="${current}"`), `${page} 没挂`);
    }
  });

  it("检索页不再自己画一颗「按天回看」—— 同一个入口不出现两次", () => {
    const page = strip(src("app/(app)/search/page.tsx"));
    assert.doesNotMatch(page, /Pill href=\{`\/archive/);
  });

  it("**群聊要登录才显示，而且中间件也拦** —— 访客点进去只会撞空", () => {
    /*
     * 群聊内容 100% 靠 visibleGroupsFor 收口，访客能拿到的只有一个空壳。
     * 导航里给访客留一个入口，就是让他点进去撞一次墙。
     * 两边要一致：导航藏起来、路径也要真的拦（见 tests/proxy.test.ts）。
     */
    const chat = ALL_NAV_ITEMS.find((i) => i.key === "chat")!;
    assert.equal(chat.requiresAuth, true);
    assert.equal(
      navItemVisible(chat, { loggedIn: false, hasPermission: () => true }),
      false,
    );
  });
});

describe("「我关注的」并进了「我的」", () => {
  it("导航上不再单列 —— 它是「我的」页面上的一行", () => {
    const keys = ALL_NAV_ITEMS.map((i) => i.key);
    assert.ok(!keys.includes("following"));
    assert.match(src("app/(app)/me/page.tsx"), /href="\/me\/following"/);
  });

  it("**旧地址还活着** —— 通知和历史链接都指着它", () => {
    /*
     * 从导航里撤下来 ≠ 删掉。站内通知、别人转发过的链接、
     * 浏览器历史里都存着 /me/following，而 404 在用户那边
     * 读起来是「这个功能没了」。
     */
    const page = readFileSync(
      new URL("../src/app/(app)/me/following/page.tsx", import.meta.url),
      "utf8",
    );
    assert.match(page, /export default async function/);
  });

  it("并进去的那一页本身要够得着 —— 「我的」在 tab 栏和一级里都在", () => {
    assert.ok(tabBarItems(everything).some((i) => i.key === "me"));
    assert.ok(sidebarPrimaryItems(everything).some((i) => i.key === "me"));
  });
});

describe("整完之后到底少了几行", () => {
  /*
   * 这一条是给下一个人看的：改动的**效果**本身也要钉住，
   * 否则半年后一项一项加回去，没有任何测试会红。
   */
  it("一个普通成员，电脑端第一眼看到的行数", () => {
    /*
     * 5 → 6：2026-08 把「项目」提上来了（理由见上面那条）。
     *
     * 这个数字**该被盯着**，所以改它要连着改这句话 ——
     * 一项一项加回去而没有任何测试变红，正是这条守卫要防的事。
     * 6 是上限：再多就该重新想「哪一项该下去」，而不是继续加。
     */
    const keys = sidebarPrimaryItems(asMember).map((i) => i.key);
    assert.equal(keys.length, 6, `一级涨到了 ${keys.length} 行：${keys.join("、")}`);
  });

  it("手机端仍然是 4 个目的地 + 一个「更多」", () => {
    assert.equal(tabBarItems(asMember).length, 4);
    // 剩下的全在「更多」里，一个不落 —— mobile-reach 那条测的是同一件事
    const inMore = moreSheetSections(asMember).flatMap((s) => s.items.map((i) => i.key));
    const all = visibleSections(asMember).flatMap((s) => s.items.map((i) => i.key));
    assert.equal(inMore.length + 4, all.length);
  });
});
