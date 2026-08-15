import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { refuseActivation, splitByReadiness } from "@/lib/mail/activation-rules";
import { readCode } from "./_source";

/**
 * 域名转正：**只动体检合格的那些**。
 *
 * ═════════════════════════════════════════
 * 这条路原来根本不存在
 * ═════════════════════════════════════════
 *
 * 域名按「待核」建进池子是对的：MX 还没配好之前放出去，
 * 人会申领到一个收不到信的地址。而缺的是从待核**出来**的那条路 ——
 * `updateDomain` 的参数表里没有 `status`，也没有脚本或定时任务改它。
 *
 * 于是线上一百个域名全卡在待核。申领长期地址要求「已启用」，
 * 一次性箱那条只看 `enabled` / `allowBurner`、绕过了这道卡 ——
 * 表现就成了「站上只有一次性邮箱」，而且看起来完全不像被卡住了。
 */

describe("哪些待核域名可以转正", () => {
  const rows = [
    { domain: "good-a.icu", mxOk: true },
    { domain: "good-b.icu", mxOk: true },
    { domain: "never-checked.icu", mxOk: null },
    { domain: "broken.icu", mxOk: false },
  ] as const;

  it("★ 只有三个灯全绿的进「可以转正」那一堆", () => {
    const { ready } = splitByReadiness(rows);
    assert.deepEqual(
      ready.map((r) => r.domain),
      ["good-a.icu", "good-b.icu"],
    );
  });

  it("★ 「没查过」和「查出来是错的」必须分开数", () => {
    /*
     * 混成一句「跳过了 2 个」的话，人不知道下一步干什么 ——
     * 而这两堆要做的事完全不同：
     * 一堆是「跑一次 npm run mail-dns」，另一堆是「去注册商那边改 DNS」。
     */
    const { unchecked, bad } = splitByReadiness(rows);
    assert.deepEqual(unchecked.map((r) => r.domain), ["never-checked.icu"]);
    assert.deepEqual(bad.map((r) => r.domain), ["broken.icu"]);
  });

  it("三堆加起来等于全部 —— 不许有域名凭空消失", () => {
    const { ready, unchecked, bad } = splitByReadiness(rows);
    assert.equal(ready.length + unchecked.length + bad.length, rows.length);
  });
});

describe("单个域名转「已启用」", () => {
  it("★ MX 查出来是错的 → 拦下，而且说清楚为什么", () => {
    const why = refuseActivation(false);
    assert.ok(why, "MX 错的域名被放行了");
    assert.match(why, /MX/, "拒绝理由里没提 MX，人不知道去改什么");
  });

  it("**没查过不拦** —— 拦死的话，改个备注都要先跑一遍体检", () => {
    assert.equal(refuseActivation(null), null);
  });

  it("查过而且是对的 → 放行", () => {
    assert.equal(refuseActivation(true), null);
  });
});

describe("**接线**：批量转正真的走这套规则", () => {
  /*
   * 今晚在这个仓库里反复撞见的形状：规则测得很足，
   * 而「拿到判定之后照不照做」没人守。所以这里钉住调用点。
   */
  const actions = readCode("lib/mail/admin-actions.ts");

  it("批量转正用的是 splitByReadiness，没有自己再数一遍", () => {
    assert.match(actions, /splitByReadiness\(pending\)/);
    assert.equal(
      /pending\.filter\(\(d\) => d\.mxOk === true\)/.test(actions),
      false,
      "又在 admin-actions 里自己数了一遍 —— 两处判定迟早分叉",
    );
  });

  it("单个域名转正走的是 refuseActivation", () => {
    assert.match(actions, /refuseActivation\(before\.mxOk\)/);
  });

  it("★ `updateDomain` 收得下 status —— 没有它，域名就出不了待核", () => {
    assert.match(actions, /status\?: MailDomainStatus/);
    assert.match(actions, /patch\.status = input\.status/);
  });
});
