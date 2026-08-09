import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { visibleAdminNav } from "@/lib/admin/nav";
import { moreSheetSections, tabBarItems, visibleSections, TAB_BAR_MAX } from "@/lib/nav";

/**
 * **手机上够得着吗。**
 *
 * ─────────────────────────────────────────
 * 这一组是为了防一类具体的退化
 * ─────────────────────────────────────────
 *
 * 之前的做法是「桌面侧栏放全部、底部 tab 栏放 5 个」。
 * 加新页面的人只会去改侧栏那份清单 —— 于是新页面在桌面上一切正常，
 * 而**手机上根本没有入口**。
 *
 * 出问题的时候有 7 个板块是这样的：通知、资源库、活动、成员、
 * 关键词雷达、商店，以及整个后台。那不是「手机端功能少一点」，
 * 是这些功能在手机上不存在 —— 而这个站大部分人是在微信里点开的。
 *
 * 所以这里不测「某几个页面在不在」，测的是**结构**：
 * 侧栏里的每一项都必须能在手机上被摸到。
 */

const everything = () => true;

describe("**桌面能到的，手机也要能到**", () => {
  it("侧栏里的每一项，要么在 tab 栏里，要么在「更多」里", () => {
    const sidebar = visibleSections(everything).flatMap((s) => s.items.map((i) => i.key));
    const reachable = new Set([
      ...tabBarItems(everything).map((i) => i.key),
      ...moreSheetSections(everything).flatMap((s) => s.items.map((i) => i.key)),
    ]);

    const unreachable = sidebar.filter((k) => !reachable.has(k));
    assert.deepEqual(unreachable, [], "这些板块在手机上没有任何入口");
  });

  it("**「更多」是用减法算的**，不是第二份要人手工维护的清单", () => {
    /*
     * 维护两份清单的话，加了新页面而忘了往「更多」里加，
     * 表现就是手机上摸不到它，而桌面上一切正常 —— 很难被发现。
     */
    const src = readFileSync(new URL("../src/lib/nav.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export function moreSheetSections"));
    assert.match(fn.slice(0, 500), /!inTabs\.has\(item\.key\)/);
  });

  it("tab 栏和「更多」不重复 —— 同一个入口出现两次是噪音", () => {
    const tabs = new Set(tabBarItems(everything).map((i) => i.key));
    const more = moreSheetSections(everything).flatMap((s) => s.items.map((i) => i.key));
    assert.deepEqual(
      more.filter((k) => tabs.has(k)),
      [],
    );
  });

  it("**第 5 格留给「更多」** —— 5 个都是目的地的话，剩下的就没地方去了", () => {
    assert.ok(
      tabBarItems(everything).length < TAB_BAR_MAX,
      `tab 栏塞了 ${tabBarItems(everything).length} 个目的地，没给「更多」留位置`,
    );
  });

  it("权限收口一致 —— 看不到的板块不该出现在「更多」里", () => {
    const nothing = () => false;
    assert.deepEqual(moreSheetSections(nothing), []);
  });

  it("**后台入口在手机上够得着**", () => {
    // 后台整体作为一个入口进「更多」，内部再用选择器
    const reachable = new Set([
      ...tabBarItems(everything).map((i) => i.key),
      ...moreSheetSections(everything).flatMap((s) => s.items.map((i) => i.key)),
    ]);
    assert.ok(reachable.has("admin"), "手机上进不去管理区");
  });
});

describe("**后台的 24 个入口不能堆在正文上面**", () => {
  it("手机上用选择器，桌面上才是侧栏", () => {
    /*
     * 之前同一个 <aside> 在手机上直接堆在正文之上，
     * 24 行链接压在每个后台页面的头顶 ——
     * 那不算有入口，那是把内容推到了第二屏。
     */
    const layout = readFileSync(
      new URL("../src/app/(app)/admin/layout.tsx", import.meta.url),
      "utf8",
    );
    assert.match(layout, /<AdminNavPicker/);
    assert.match(layout, /lg:hidden/, "选择器没有只在手机上显示");
    assert.match(layout, /hidden shrink-0 lg:block/, "侧栏在手机上还是会显示");
  });

  it("选择器覆盖了后台的全部板块", () => {
    const sections = visibleAdminNav(() => true);
    const total = sections.reduce((n, s) => n + s.items.length, 0);
    assert.ok(total > 15, `后台只有 ${total} 个入口？这条测试可能没扫到东西`);

    const picker = readFileSync(
      new URL("../src/components/admin/AdminNavPicker.tsx", import.meta.url),
      "utf8",
    );
    // 它把传进来的 sections 原样铺开，不自己挑
    assert.match(picker, /sections\.map/);
    assert.doesNotMatch(picker, /slice\(0,/, "选择器里做了截断，会有板块摸不到");
  });

  it("**显示当前在哪** —— 后台页面之间长得很像，没有它人会不确定点进来的是哪个", () => {
    const picker = readFileSync(
      new URL("../src/components/admin/AdminNavPicker.tsx", import.meta.url),
      "utf8",
    );
    assert.match(picker, /current\?\.label/);
  });
});

describe("每个后台页面都在导航里", () => {
  /*
   * 这一条防的是另一半:页面建出来了，但两份导航谁都没加它 ——
   * 于是只有知道 URL 的人进得去。
   */
  const adminRoot = new URL("../src/app/(app)/admin", import.meta.url).pathname;

  function routes(dir: string, prefix = "/admin"): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      // [id] 这类动态段是详情页，不该单独出现在导航里
      if (entry.startsWith("[")) continue;
      const href = `${prefix}/${entry}`;
      if (readdirSync(full).includes("page.tsx")) out.push(href);
      out.push(...routes(full, href));
    }
    return out;
  }

  it("**没有孤儿页面**", () => {
    const declared = new Set(visibleAdminNav(() => true).flatMap((s) => s.items.map((i) => i.href)));
    const orphans = routes(adminRoot).filter((href) => !declared.has(href));
    assert.deepEqual(orphans, [], "这些后台页面建好了但导航里没有，只有知道 URL 的人进得去");
  });
});

describe("弹层本身", () => {
  const sheet = readFileSync(
    new URL("../src/components/shell/MoreSheet.tsx", import.meta.url),
    "utf8",
  );

  it("**用原生 <dialog>** —— 焦点陷阱和 Esc 关闭是白送的", () => {
    assert.match(sheet, /<dialog/);
    assert.match(sheet, /showModal\(\)/);
  });

  it("点遮罩能关 —— 手机上「点旁边关掉」是肌肉记忆", () => {
    assert.match(sheet, /e\.target === ref\.current/);
  });

  it("点了某一项之后要关掉 —— 不然弹层盖在新页面上，人会以为卡住了", () => {
    assert.match(sheet, /onClick=\{close\}/);
  });

  it("避开底部安全区 —— 带 Home Indicator 的机型上最后一行会被横条压住", () => {
    assert.match(sheet, /safe-area-inset-bottom/);
  });

  it("**由 state 驱动 dialog**，不是在渲染期读 ref", () => {
    /*
     * 渲染期读 ref 的组件不保证会重渲 —— React 编译器拦得对。
     * 反过来写还顺带让「浏览器后退键关掉弹层」自动对上。
     */
    assert.match(sheet, /if \(isOpen && !el\.open\) el\.showModal\(\)/);
    assert.match(sheet, /onClose=\{\(\) => setIsOpen\(false\)\}/);
  });

  it("用 SVG 图标，不用 emoji", () => {
    assert.match(sheet, /lucide-react/);
    assert.doesNotMatch(sheet, /[\u{1F300}-\u{1FAFF}]/u);
  });
});
