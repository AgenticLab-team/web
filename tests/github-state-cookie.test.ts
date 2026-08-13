import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

/*
 * `secret.ts`（newState 在那里）连着 env，而 env 会校验一整套
 * 环境变量。测试里只要一个随机串，所以在导入之前把它满足掉 ——
 * 和仓库里接真库的那几份测试同一套做法。
 */
/*
 * `secret.ts`（newState 在那里）连着 env，而 env 会在**导入的那一刻**
 * 校验一整套环境变量。ESM 的 import 会被提升到文件最前面，
 * 所以在这里写 `process.env.X = ...` 是来不及的 ——
 * 必须先设好、再动态导入，这也是仓库里接真库那几份测试的做法。
 */
process.env.NEKOBOT_API_KEY ??= "nk_test";

import { NextRequest, NextResponse } from "next/server";

import { GITHUB_STATE_COOKIE, safeReturnPath, stateMatches } from "@/lib/github/oauth-rules";

import { readCode } from "./_source";

/**
 * GitHub 绑定的 state cookie。
 *
 * ═════════════════════════════════════════
 * 这份测试来自一次「一次都没成功过」
 * ═════════════════════════════════════════
 *
 * 写的那一头用 `response.cookies.set()`，它会 `encodeURIComponent`
 * 整个值；读的那一头从**原始 `cookie` 请求头**里手工切。
 * 于是 `state|/me/security` 落到浏览器上是
 *
 *   al_gh_state=abc123%7C%2Fme%2Fsecurity
 *
 * 回来按 `|` 切，那个字符根本不存在 —— state 必然对不上，
 * 每一次绑定都以 `bad_state` 收场。
 *
 * 最阴的地方是**它看起来完全像是链接过期**：`bad_state` 对应的提示
 * 是我们自己写的「链接失效了，重新点一次」，于是没有人会怀疑到代码上。
 * 站长报的是「GitHub 绑定不了」，而站里没有任何一条日志是红的。
 *
 * ─────────────────────────────────────────
 * 所以这里跑的是**真的 Next API**
 * ─────────────────────────────────────────
 *
 * 断言「代码里用了 request.cookies.get」是抓不住的：下一个人
 * 完全可能换一种同样不对称的写法。这里让 `NextResponse` 真的
 * 序列化一次、再让 `NextRequest` 真的解析一次，看值有没有活着回来。
 */

let newState: () => string;

before(async () => {
  ({ newState } = await import("@/lib/github/secret"));
});

/** 把一个响应上的 Set-Cookie 原样搬到一个请求上 —— 模拟浏览器那一跳 */
function roundTrip(value: string): string | undefined {
  const out = NextResponse.redirect("https://agenticlab.sh/x", 307);
  out.cookies.set(GITHUB_STATE_COOKIE, value, { httpOnly: true, path: "/" });

  const setCookie = out.headers.get("set-cookie") ?? "";
  const pair = setCookie.split(";")[0];

  const back = new NextRequest("https://agenticlab.sh/api/auth/github/callback", {
    headers: { cookie: pair },
  });
  return back.cookies.get(GITHUB_STATE_COOKIE)?.value;
}

describe("state 和回跳地址打包进一个 cookie", () => {
  it("**转一圈之后原样回来**", () => {
    const value = "abc123DEF|/me/security";
    assert.equal(roundTrip(value), value);
  });

  it("**切出来的 state 能对上** —— 这就是当时挂掉的那一步", () => {
    /*
     * 用真的 `newState()`，不是手打一个。
     *
     * 第一版我写了个 15 个字符的假 state，测试红了 —— 而红的理由是
     * `stateMatches` 有一条 `length < 16 就拒`。**代码是对的，
     * 我的假数据不够真**。手写固定值的测试就是会这样：
     * 它测的是我以为的形状，不是真正流过去的那个。
     */
    const state = newState();
    assert.ok(state.length >= 16, "newState 短于 16 位的话 stateMatches 会一律拒绝");
    const packed = roundTrip(`${state}|/me/security`) ?? "";
    const [cookieState, cookieReturn] = packed.split("|");

    assert.equal(stateMatches(cookieState, state), true, "state 对不上，绑定会报 bad_state");
    assert.equal(safeReturnPath(cookieReturn), "/me/security");
  });

  it("带查询串的回跳地址也活得下来", () => {
    // `?` `=` `&` 都是会被编码的字符，和 `|` 同一类风险
    const packed = roundTrip(`${newState()}|/me/security?tab=github`) ?? "";
    const [, ret] = packed.split("|");
    assert.equal(safeReturnPath(ret), "/me/security?tab=github");
  });

  it("空 cookie 不炸，切出来是空 state", () => {
    const [cookieState] = "".split("|");
    assert.equal(stateMatches(cookieState, "whatever"), false);
    assert.equal(safeReturnPath(undefined), "/me/security");
  });
});

describe("读和写用同一套抽象", () => {
  it("**回调不再手工解析原始 cookie 头**", () => {
    /*
     * 手工切原始头本身不算错，错在**只有一头知道有编码这回事**。
     * 写用 response.cookies.set，读就该用 request.cookies.get。
     */
    const src = readCode("app/api/auth/github/callback/route.ts");
    assert.match(src, /request\.cookies\.get\(/);
    assert.equal(
      /headers[\s\S]{0,40}\.get\("cookie"\)/.test(src),
      false,
      "又在手工解析原始 cookie 头了 —— 那一头不会帮你解码",
    );
  });
});
