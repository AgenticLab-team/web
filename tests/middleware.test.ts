import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * 登录门禁与回跳地址的安全性。
 *
 * 回跳参数是最经典的开放重定向入口：允许绝对地址的话，
 * 攻击者可以拿一个看起来正常的登录链接把人导到钓鱼站。
 */

/** 与 login/page.tsx 一致的规则 */
function safeRedirect(next: string | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

const PROTECTED = ["/me", "/notifications", "/forum/new", "/forum/convert", "/onboarding"];

/** 与 middleware.ts 一致的匹配规则 */
function isProtected(pathname: string): boolean {
  return PROTECTED.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

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
  });
});

describe("受保护路径匹配", () => {
  it("精确匹配与子路径都拦", () => {
    assert.equal(isProtected("/me"), true);
    assert.equal(isProtected("/me/points"), true);
    assert.equal(isProtected("/notifications"), true);
    assert.equal(isProtected("/forum/new"), true);
  });

  it("公开路径不拦", () => {
    assert.equal(isProtected("/"), false);
    assert.equal(isProtected("/forum"), false);
    assert.equal(isProtected("/leaderboard"), false);
    assert.equal(isProtected("/login"), false);
  });

  it("**前缀相同但不是子路径的不能误拦**", () => {
    // /members 不该因为以 /me 开头就被当成 /me 的子路径
    assert.equal(isProtected("/members"), false);
    assert.equal(isProtected("/forum/newest"), false);
  });
});
