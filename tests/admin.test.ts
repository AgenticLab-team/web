import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ADMIN_NAV, ALL_ADMIN_ITEMS, visibleAdminNav } from "@/lib/admin/nav";
import { PERMISSION_KEYS } from "@/lib/rbac/permissions";

/**
 * 后台导航与权限的一致性。
 *
 * 后台最容易出的问题不是功能不通，是**权限配漏了** ——
 * 加一个页面时忘了声明权限点，结果谁都能进。
 * 所以这里逐条断言每个入口都声明了、且声明的是真实存在的权限点。
 */

describe("后台导航的权限声明", () => {
  it("**每一项都必须声明权限点**", () => {
    for (const item of ALL_ADMIN_ITEMS) {
      assert.ok(item.permission, `${item.key} 没有声明权限点`);
    }
  });

  it("声明的权限点必须真实存在", () => {
    // 拼错权限点名会让这一项永远显示不出来，而且不报错
    for (const item of ALL_ADMIN_ITEMS) {
      assert.ok(
        PERMISSION_KEYS.includes(item.permission),
        `${item.key} 声明的 ${item.permission} 不在权限点字典里`,
      );
    }
  });

  it("key 与 href 都唯一", () => {
    const keys = ALL_ADMIN_ITEMS.map((i) => i.key);
    const hrefs = ALL_ADMIN_ITEMS.map((i) => i.href);
    assert.equal(new Set(keys).size, keys.length, "有重复的 key");
    assert.equal(new Set(hrefs).size, hrefs.length, "有重复的 href");
  });

  it("所有 href 都在 /admin 之下", () => {
    for (const item of ALL_ADMIN_ITEMS) {
      assert.ok(item.href.startsWith("/admin"), `${item.key} 的路径不在后台下：${item.href}`);
    }
  });

  it("**标了 ready 的入口必须真的有页面**", () => {
    /*
     * ready 是给人看的标记，但页面在不在是文件系统说了算。
     * 两者脱节的表现是点进去 404 —— 而后台是最不该出现死链的地方，
     * 管理员会以为是自己权限不够。
     */
    for (const item of ALL_ADMIN_ITEMS) {
      if (!item.ready) continue;
      const route = item.href.replace(/^\/admin/, "");
      const page = new URL(`../src/app/(app)/admin${route}/page.tsx`, import.meta.url);
      assert.ok(existsSync(page), `${item.key} 标了 ready，但 ${item.href} 没有页面文件`);
    }
  });

  it("**每个入口声明的图标都要在 ICONS 里注册**", () => {
    /*
     * 没注册的图标会静默回退成默认那个仪表盘图标 —— 不报错、不崩，
     * 只是导航里出现两个一模一样的图标，而谁也说不清哪个是哪个。
     * ICONS 在 "use client" 组件里，测试直接 import 会把 lucide 拖进来，
     * 所以读源码断言。
     */
    const source = readFileSync(
      new URL("../src/components/admin/AdminNav.tsx", import.meta.url),
      "utf8",
    );
    const registered = new Set(
      [...source.matchAll(/^\s+"?([a-z-]+)"?:\s+[A-Z]\w+,$/gm)].map((m) => m[1]),
    );

    for (const item of ALL_ADMIN_ITEMS) {
      assert.ok(
        registered.has(item.icon),
        `${item.key} 用的图标 ${item.icon} 没在 AdminNav 的 ICONS 里注册，会静默回退`,
      );
    }
  });

  it("已实现的页面不该还标着未完成", () => {
    // 反向也要查：页面做好了却忘了翻 ready，入口就一直藏着
    for (const item of ALL_ADMIN_ITEMS) {
      if (item.ready) continue;
      const route = item.href.replace(/^\/admin/, "");
      const page = new URL(`../src/app/(app)/admin${route}/page.tsx`, import.meta.url);
      assert.ok(!existsSync(page), `${item.href} 已经有页面了，但 ready 还是 false`);
    }
  });
});

describe("按权限过滤", () => {
  it("没有任何权限时看不到任何入口", () => {
    assert.deepEqual(visibleAdminNav(() => false), []);
  });

  it("只有仪表盘权限时只看得到只读的总览入口", () => {
    // 健康告警、存储概览和仪表盘同级：都是「看系统在不在」，不改任何东西。
    // 存储页上的裁剪按钮另有 system.settings 把关，不在导航这一层
    const sections = visibleAdminNav((p) => p === "system.dashboard");
    const keys = sections.flatMap((s) => s.items.map((i) => i.key));
    assert.deepEqual(keys, ["dashboard", "health", "storage"]);
  });

  it("**审计员只看得到只读入口**", () => {
    // auditor 的定位是「看数据不需要给写权限」，
    // 如果他能看到用户管理入口，这个角色就失去意义了
    const auditorPerms = new Set([
      "system.dashboard",
      "audit.read",
      "user.list",
      "user.detail.read",
      "points.read",
      "role.read",
      "module.read",
    ]);
    const sections = visibleAdminNav((p) => auditorPerms.has(p));
    const keys = sections.flatMap((s) => s.items.map((i) => i.key));

    assert.ok(keys.includes("dashboard"));
    assert.ok(keys.includes("audit"));
    assert.ok(!keys.includes("settings"), "审计员不该看到系统设置");
    assert.ok(!keys.includes("broadcast"), "审计员不该看到群发");
    assert.ok(!keys.includes("approvals"), "审计员不该看到危险操作复核");
  });

  it("过滤后为空的分组不显示", () => {
    const sections = visibleAdminNav((p) => p === "system.dashboard");
    assert.equal(sections.length, 1, "只该剩下总览这一组");
    assert.ok(sections.every((s) => s.items.length > 0));
  });

  it("全权限时所有分组都在", () => {
    const sections = visibleAdminNav(() => true);
    assert.equal(sections.length, ADMIN_NAV.length);
  });
});
