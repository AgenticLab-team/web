import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { PROTECTED_PREFIXES, isProtectedPath, safeRedirect } from "@/lib/auth/routes";

/**
 * 登录门禁与回跳地址的安全性。
 *
 * 回跳参数是最经典的开放重定向入口：允许绝对地址的话，
 * 攻击者可以拿一个看起来正常的登录链接把人导到钓鱼站。
 *
 * 这个文件以前抄了一份 isProtected / safeRedirect 在测试里，
 * 结果中间件漏掉 /admin 的时候测试照样全绿 —— 测的是抄件。
 * 现在两边引的是同一个 routes.ts。
 */

describe("回跳地址", () => {
  it("站内路径原样保留", () => {
    assert.equal(safeRedirect("/me/points"), "/me/points");
    assert.equal(safeRedirect("/forum/new"), "/forum/new");
  });

  it("**绝对地址一律拒绝**", () => {
    assert.equal(safeRedirect("https://evil.com"), "/");
    assert.equal(safeRedirect("http://evil.com"), "/");
  });

  it("协议相对地址也要拒绝", () => {
    // //evil.com 在浏览器里等价于 https://evil.com，最容易漏掉的一种
    assert.equal(safeRedirect("//evil.com"), "/");
    assert.equal(safeRedirect("//evil.com/path"), "/");
  });

  it("空值退回首页", () => {
    assert.equal(safeRedirect(undefined), "/");
    assert.equal(safeRedirect(""), "/");
    assert.equal(safeRedirect(null), "/");
  });
});

describe("受保护路径匹配", () => {
  it("精确匹配与子路径都拦", () => {
    assert.equal(isProtectedPath("/me"), true);
    assert.equal(isProtectedPath("/me/points"), true);
    assert.equal(isProtectedPath("/notifications"), true);
    assert.equal(isProtectedPath("/forum/new"), true);
  });

  it("**后台整个树都要拦**", () => {
    // 漏了这条的时候，未登录访客拿到的是 200 空壳而不是跳转 ——
    // 内容没泄露，但状态码骗人，监控和爬虫都会当成正常页面
    assert.equal(isProtectedPath("/admin"), true);
    assert.equal(isProtectedPath("/admin/users"), true);
    assert.equal(isProtectedPath("/admin/users/u_123"), true);
    assert.equal(isProtectedPath("/admin/roles"), true);
    assert.equal(isProtectedPath("/admin/audit"), true);
  });

  it("公开路径不拦", () => {
    assert.equal(isProtectedPath("/"), false);
    assert.equal(isProtectedPath("/forum"), false);
    assert.equal(isProtectedPath("/leaderboard"), false, "总榜对未登录访客公开");
    assert.equal(isProtectedPath("/login"), false);
  });

  it("**前缀相同但不是子路径的不能误拦**", () => {
    // /members 不该因为以 /me 开头就被当成 /me 的子路径
    assert.equal(isProtectedPath("/members"), false);
    assert.equal(isProtectedPath("/forum/newest"), false);
    assert.equal(isProtectedPath("/administration"), false);
  });
});

describe("matcher 与前缀表不能脱节", () => {
  /*
   * config.matcher 是构建期常量，不能用变量拼出来，
   * 所以只能手写一份。手写的东西一定会和前缀表跑偏 ——
   * 跑偏的后果是中间件根本不被调用，isProtectedPath 写得再对也没用。
   */
  const source = readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
  const matcher = [...source.matchAll(/"(\/[^"]*)"/g)]
    .map((m) => m[1])
    .filter((p) => p !== "/login");

  it("每个受保护前缀都在 matcher 里", () => {
    for (const prefix of PROTECTED_PREFIXES) {
      const covered = matcher.some((m) => m === prefix || m === `${prefix}/:path*`);
      assert.ok(covered, `${prefix} 不在 middleware 的 matcher 里，中间件不会被调用`);
    }
  });

  it("matcher 里没有多余的路径", () => {
    for (const entry of matcher) {
      const prefix = entry.replace("/:path*", "");
      assert.ok(
        (PROTECTED_PREFIXES as readonly string[]).includes(prefix),
        `matcher 里的 ${entry} 不在受保护前缀表里`,
      );
    }
  });
});
