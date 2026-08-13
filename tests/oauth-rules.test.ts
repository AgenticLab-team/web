import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import {
  allowedScopesFor,
  callbackWith,
  coversScopes,
  OAUTH_BLOCKED_SCOPES,
  parseScopes,
  redirectMatches,
  validateRedirectUri,
  verifyPkce,
} from "@/lib/oauth/rules";

/**
 * OAuth 的那几条判断。
 *
 * ═════════════════════════════════════════
 * 错一条的后果是「别人的账号被别人用」
 * ═════════════════════════════════════════
 *
 * 而那种错**不会在任何日志里显形** —— 请求是合法的、令牌是有效的、
 * 用户是真的点过同意的，只是同意的不是他以为的那件事。
 * 所以这一组测的全是「能不能被绕过去」，不是「功能对不对」。
 */

const app = (over: Partial<{ allowSend: boolean }> = {}) => ({ allowSend: false, ...over });

describe("**回调地址：精确匹配，一个字符都不能差**", () => {
  const reg = "https://app.test/callback";

  it("完全相同才算", () => {
    assert.equal(redirectMatches(reg, reg), true);
  });

  it("**多一个斜杠就不算**", () => {
    /*
     * 「差不多就行」的每一点余地，都是攻击者构造地址的空间。
     * 这个仓库在 link-refs.ts 上交过同一笔学费。
     */
    assert.equal(redirectMatches(reg, `${reg}/`), false);
  });

  it("子路径不算", () => {
    assert.equal(redirectMatches(reg, `${reg}/evil`), false);
  });

  it("**同源但换个路径不算** —— 前缀匹配是最常见的那个洞", () => {
    assert.equal(redirectMatches(reg, "https://app.test/evil"), false);
  });

  it("换域名当然不算，哪怕它以注册域名开头", () => {
    assert.equal(redirectMatches(reg, "https://app.test.evil.com/callback"), false);
  });

  it("空的、null 都不算", () => {
    assert.equal(redirectMatches(reg, null), false);
    assert.equal(redirectMatches(reg, ""), false);
  });
});

describe("注册地址本身要合法", () => {
  it("必须 https", () => {
    assert.equal(validateRedirectUri("http://app.test/cb").ok, false);
    assert.equal(validateRedirectUri("https://app.test/cb").ok, true);
  });

  it("localhost 可以 http —— 本地开发要能用，而那些流量不出这台机器", () => {
    assert.equal(validateRedirectUri("http://localhost:3000/cb").ok, true);
    assert.equal(validateRedirectUri("http://127.0.0.1:3000/cb").ok, true);
  });

  it("**带用户名的地址要拒** —— 那是经典的钓鱼形状", () => {
    // `https://好域名@坏域名/` 在地址栏里看起来像前者
    assert.equal(validateRedirectUri("https://app.test@evil.com/cb").ok, false);
  });

  it("带 # 片段要拒 —— 它根本不会传给服务端，写了说明填的人搞错了", () => {
    assert.equal(validateRedirectUri("https://app.test/cb#x").ok, false);
  });

  it("不是地址的要拒", () => {
    assert.equal(validateRedirectUri("app.test/cb").ok, false);
    assert.equal(validateRedirectUri("").ok, false);
  });
});

describe("**PKCE：只认 S256**", () => {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  it("对的 verifier 过", () => {
    assert.equal(verifyPkce(challenge, verifier), true);
  });

  it("错的 verifier 不过", () => {
    assert.equal(verifyPkce(challenge, randomBytes(48).toString("base64url")), false);
  });

  it("**不认 plain** —— 那等于没有 PKCE", () => {
    /*
     * `plain` 是规范里为兼容老设备留的口子：challenge 就是 verifier 本身。
     * 能偷到授权码的人同样能偷到它，所以它的唯一作用是
     * 让一个错误的实现看起来像通过了。
     */
    assert.equal(verifyPkce(verifier, verifier), false);
  });

  it("太短的 verifier 不过 —— 规范要求 43~128", () => {
    const short = "abc";
    assert.equal(verifyPkce(createHash("sha256").update(short).digest("base64url"), short), false);
  });

  it("没给 verifier 不过", () => {
    assert.equal(verifyPkce(challenge, null), false);
  });
});

describe("**groups:send 不进 OAuth**", () => {
  it("普通应用申请不到", () => {
    /*
     * 理由不是「危险」，是它会让审计说谎：代发日志里写着那个人的名字，
     * 而真正按下发送的是一段没人 review 过的代码。
     */
    const got = parseScopes("me:read groups:send", app());
    assert.equal(got.ok, false);
    assert.match((got as { error: string }).error, /不能申请/);
  });

  it("默认可申请的里面没有它", () => {
    assert.equal(allowedScopesFor(app()).includes("groups:send"), false);
    assert.deepEqual([...OAUTH_BLOCKED_SCOPES], ["groups:send"]);
  });

  it("管理员单独勾过的应用才解锁", () => {
    assert.equal(allowedScopesFor(app({ allowSend: true })).includes("groups:send"), true);
  });
});

describe("scope 解析", () => {
  it("认不出来的**拒绝整个请求**，不是悄悄丢掉那一项", () => {
    /*
     * 悄悄丢掉的话，应用以为自己拿到了某个权限，
     * 直到某天调用返回 403 才发现 —— 而那时候它已经上线了。
     */
    const got = parseScopes("me:read no:such", app());
    assert.equal(got.ok, false);
    assert.match((got as { error: string }).error, /不认识/);
  });

  it("空的要拒", () => {
    assert.equal(parseScopes("", app()).ok, false);
    assert.equal(parseScopes(null, app()).ok, false);
  });

  it("去重，而且顺序固定 —— 同意页上每次看到的顺序要一样", () => {
    const a = parseScopes("forum:read me:read me:read", app());
    const b = parseScopes("me:read forum:read", app());
    assert.deepEqual(a, b);
  });
});

describe("**不能靠上次的同意悄悄扩权**", () => {
  it("要的比给过的多，就得重新同意", () => {
    assert.equal(coversScopes(["me:read"], ["me:read", "forum:read"]), false);
    assert.equal(coversScopes(["me:read", "forum:read"], ["me:read"]), true);
  });
});

describe("跳回去那个地址", () => {
  it("注册地址本来带 query 时不会拼出两个问号", () => {
    /*
     * 手拼字符串会得到 `...?tenant=a?code=x`，
     * 而那种地址在有些客户端上会静默失败。
     */
    const url = callbackWith("https://app.test/cb?tenant=a", { code: "x", state: "s" });
    assert.equal(new URL(url).searchParams.get("tenant"), "a");
    assert.equal(new URL(url).searchParams.get("code"), "x");
    assert.equal((url.match(/\?/g) ?? []).length, 1);
  });

  it("undefined 的参数不出现", () => {
    const url = callbackWith("https://app.test/cb", { code: "x", state: undefined });
    assert.equal(new URL(url).searchParams.has("state"), false);
  });
});
