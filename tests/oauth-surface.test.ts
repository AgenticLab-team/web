import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readCode, readSource } from "./_source";

/**
 * OAuth 那几条路上的硬约束。
 *
 * ═════════════════════════════════════════
 * 最要紧的一条：它绝不能变成第二扇门
 * ═════════════════════════════════════════
 *
 * 这个站的门是微信群 —— 账号只能靠在群里向机器人发验证码建立。
 * 「只有群成员能登录」如果在 OAuth 这条路上被绕过去，
 * 等于把整个站对全世界开放，而且**没有任何外部症状**：
 * 站长自己点一下是能进的。
 *
 * 所以下面这几条盯的是「有没有出现建号 / 发会话的动作」，
 * 照 tests/github-oauth.test.ts 那套做法。
 */

const FILES = [
  "app/(app)/oauth/authorize/page.tsx",
  "app/api/oauth/token/route.ts",
  "lib/oauth/actions.ts",
  "lib/oauth/store.ts",
  "lib/oauth/rules.ts",
];

describe("**它绝不建账号、绝不发会话**", () => {
  for (const f of FILES) {
    it(f, () => {
      const code = readCode(f);
      for (const forbidden of ["createSession", "setSessionCookie", "insert(users)"]) {
        assert.equal(
          code.includes(forbidden),
          false,
          `${f} 里出现了 ${forbidden} —— OAuth 不能成为第二扇门`,
        );
      }
    });
  }
});

describe("同意页", () => {
  const page = readCode("app/(app)/oauth/authorize/page.tsx");
  const raw = readSource("app/(app)/oauth/authorize/page.tsx");

  it("**用 getRealUser，不用 getCurrentUser**", () => {
    /*
     * 后者在预览态下返回**被预览的那个人** —— 管理员正预览着某个用户时
     * 点一下同意，授权会落到那个人头上，而那是一条不可能解释清楚的记录。
     */
    assert.match(page, /getRealUser\(\)/);
    assert.equal(/getCurrentUser\(/.test(page), false);
  });

  it("拿不到人就跳登录 —— 不是往下走", () => {
    assert.match(page, /redirect\(`\/login\?next=/);
  });

  it("**PKCE 强制，而且只认 S256**", () => {
    /*
     * plain 等于没有 PKCE：能偷到授权码的人同样能偷到 verifier。
     * 不给「要不要开」这个选项 —— 那个选项总会被关掉。
     */
    assert.match(page, /code_challenge_method"\) !== "S256"/);
  });

  it("**应用不存在或回调对不上时不跳转**", () => {
    /*
     * 那两种情况下没有一个可信的地方可以跳。跳去一个没注册过的地址，
     * 正好是攻击者想要的 —— 他能借这个站做一次跳板。
     */
    assert.match(raw, /不跳转，就地报错/);
    assert.match(page, /function Broken/);
  });

  it("同意页上显示令牌会去哪个域名", () => {
    // 唯一决定令牌落到谁手里的东西，而用户从来不看地址栏
    assert.match(page, /new URL\(app\.redirectUri\)\.host/);
    assert.match(page, /redirectHost=\{host\}/);
  });

  it("**上次的同意不能覆盖这次多要的** ", () => {
    assert.match(page, /coversScopes\(/);
  });
});

describe("token 端点", () => {
  const route = readCode("app/api/oauth/token/route.ts");

  it("**不读 cookie、不发 cookie**", () => {
    /*
     * 调它的是应用后端，不是浏览器。一个会读 cookie 的 token 端点
     * 等于给自己开了一条 CSRF 的路。
     */
    assert.equal(/cookies\(\)|request\.cookies|Set-Cookie/i.test(route), false);
  });

  it("授权码**取出来就删**，无论后面哪一步失败", () => {
    const store = readSource("lib/oauth/store.ts");
    assert.match(store, /无论对不对都先删/);
  });

  it("redirect_uri 要和发码时逐字相同", () => {
    assert.match(route, /redirectMatches\(row\.redirectUri/);
  });

  it("**令牌响应不许被缓存**", () => {
    assert.match(route, /"Cache-Control": "no-store"/);
  });

  it("公开客户端不验 secret —— 验一个藏不住的东西只是制造错觉", () => {
    assert.match(route, /if \(app\.hasSecret\)/);
  });
});

describe("server action", () => {
  const actions = readCode("lib/oauth/actions.ts");

  it("**自己取当前用户，不收 userId**", () => {
    /*
     * 这个文件是 "use server"，每个导出都能被客户端直接调 ——
     * 收 userId 就是替别人授权。
     */
    assert.match(actions, /getRealUser\(\)/);
    assert.equal(/userId[?]?:\s*string/.test(actions), false);
  });

  it("**参数全部重新校验** —— 页面上那次发生在浏览器能改的地方", () => {
    assert.match(actions, /redirectMatches\(app\.redirectUri, input\.redirect_uri\)/);
    assert.match(actions, /parseScopes\(input\.scope, app\)/);
  });

  it("同意和拒绝都留审计", () => {
    assert.match(actions, /oauth\.approve/);
    assert.match(actions, /oauth\.deny/);
  });
});

describe("撤销要真的断得掉", () => {
  const store = readCode("lib/oauth/store.ts");

  it("**撤销应用时连它签出的令牌一起撤**", () => {
    /*
     * 光把应用标成 revoked 不够：authenticate() 认的是令牌，
     * 它不知道背后的应用已经没了 —— 于是一个「已停用」的应用
     * 还能继续用手上的令牌，而后台显示它已经被停了。
     */
    assert.match(store, /revokeAppTokens\(id, reason\)/);
  });

  it("用户断开一个应用时，授权、令牌、refresh 三样一起作废", () => {
    const fn = store.slice(store.indexOf("export function revokeGrant"));
    assert.match(fn.slice(0, 900), /delete\(oauthRefreshTokens\)/);
    assert.match(fn.slice(0, 900), /revokeToken\(/);
  });

  it("**refresh 复用要撤销整条授权**，不是只拒绝这一次", () => {
    /*
     * 复用只有两种可能：应用写错了，或者令牌被偷了。
     * 后者的话，攻击者手上那把访问令牌还能再用一个月。
     */
    const fn = store.slice(store.indexOf("export function rotateRefresh"));
    assert.match(fn.slice(0, 900), /revokeGrant\(/);
  });
});
