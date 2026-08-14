import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MIN_CORE_LENGTH,
  explainMatch,
  matchDomain,
  normalizeHandle,
  sldOf,
  type Candidate,
} from "@/lib/mail/claim-matching";

/**
 * 归属匹配。
 *
 * ═════════════════════════════════════════
 * 这一组测试大半在证明它「不匹配」
 * ═════════════════════════════════════════
 *
 * 判错的代价是不对称的：
 *   判不出来 → 域名进公共池，那个人以后再申领，损失是一次沟通
 *   **判错了** → 把 A 的域名发给了 B，而 B 一旦拿它注册了什么就收不回来
 *
 * 所以宁可漏判。下面的用例用的是**生产库里真实的那些昵称**。
 */

const alice = "01U_SHIPOWNER";
const bob = "01U_CARLEIGHT";
const carol = "01U_DOG";
const dave = "01U_YINYUAN";

const REAL: Candidate[] = [
  // 生产库里真实存在的昵称
  { userId: alice, handle: "ShipOwner", source: "nickname" },
  { userId: bob, handle: "Carleight Wu", source: "nickname" },
  { userId: carol, handle: "嗷呜嗷呜小狗", source: "nickname" },
  { userId: dave, handle: "婴源", source: "nickname" },
  { userId: "01U_LAY", handle: "Lay", source: "nickname" },
  { userId: "01U_MD", handle: "md", source: "nickname" },
  { userId: "01U_MAX", handle: "Max", source: "nickname" },
  { userId: "01U_TECH10", handle: "10科技说", source: "nickname" },
  // 已经认领过的域名
  { userId: alice, handle: "shipowner", source: "claimed-domain" },
  { userId: bob, handle: "carleightwu", source: "claimed-domain" },
  { userId: carol, handle: "tripfz-jmr", source: "claimed-domain" },
  { userId: dave, handle: "yintins-01", source: "claimed-domain" },
  { userId: "01U_LAY", handle: "layopc", source: "claimed-domain" },
  { userId: "01U_MD", handle: "md5523", source: "claimed-domain" },
  { userId: "01U_TECH10", handle: "tech10", source: "claimed-domain" },
];

describe("归一化", () => {
  it("只留字母数字", () => {
    assert.equal(normalizeHandle("Carleight Wu"), "carleightwu");
    assert.equal(normalizeHandle("tripfz-jmr"), "tripfzjmr");
    assert.equal(normalizeHandle("yintins-01"), "yintins01");
  });

  it("中文昵称归一化之后是空的 —— 于是不会误匹配任何域名", () => {
    assert.equal(normalizeHandle("嗷呜嗷呜小狗"), "");
    assert.equal(normalizeHandle("婴源"), "");
  });

  it("去后缀", () => {
    assert.equal(sldOf("ashipowner.icu"), "ashipowner");
  });
});

describe("该匹配上的（生产库里的真实情况）", () => {
  const who = (domain: string) => matchDomain(domain, REAL)?.userId ?? null;

  it("ashipowner → shipowner 的主人（已认领域名 + 前缀）", () => {
    assert.equal(who("ashipowner.icu"), alice);
  });

  it("tripfzjmr → tripfz-jmr 的主人（去掉连字符后完全一致）", () => {
    // 这个人的昵称是中文，只有靠已认领的域名才对得上
    assert.equal(who("tripfzjmr.icu"), carol);
  });

  it("yintins → yintins-01 的主人（去掉后缀）", () => {
    assert.equal(who("yintins.icu"), dave);
  });

  it("carleightwu → 昵称完全一致", () => {
    assert.equal(who("carleightwu.icu"), bob);
  });

  it("carleight → 昵称包含关系", () => {
    assert.equal(who("carleight.icu"), bob);
  });

  it("理由能说出口 —— 「凭什么是他的」要答得上", () => {
    const r = matchDomain("ashipowner.icu", REAL);
    assert.ok(r);
    assert.match(explainMatch(r), /shipowner/);
  });
});

describe("★ 坚决不匹配的", () => {
  const who = (domain: string) => matchDomain(domain, REAL)?.userId ?? null;

  it("短昵称不许匹配 —— `md` 会命中半个池子", () => {
    assert.equal(normalizeHandle("md").length < MIN_CORE_LENGTH, true);
    assert.equal(who("msadream.icu"), null);
    assert.equal(who("dailyplan.icu"), null);
  });

  it("★ `Lay` 只有三个字符，不能凭它把 lay621 判给他", () => {
    // 「lay」同样出现在 relay、display 里 —— 匹配的是巧合不是身份
    assert.equal(who("lay621.icu"), null);
  });

  it("★ 改中间字母的不算变体 —— techerng ≠ techcheng", () => {
    // 那更可能是两个不同的词，而不是同一个人的第二个域名
    assert.equal(
      matchDomain("techerng.icu", [
        { userId: "01U_X", handle: "techcheng", source: "claimed-domain" },
      ]),
      null,
    );
  });

  it("加太长的一段不算变体", () => {
    // shipowner + "company" 不该判成 shipowner 那个人的
    assert.equal(
      matchDomain("shipownercompany.icu", [
        { userId: alice, handle: "shipowner", source: "claimed-domain" },
      ]),
      null,
    );
  });

  it("★ 昵称不吃变体规则 —— 一个叫 Max 的人会匹配上任何含 max 的域名", () => {
    assert.equal(
      matchDomain("maximum.icu", [{ userId: "01U_MAX", handle: "Maximus", source: "nickname" }]),
      null,
      "Maximus 和 maximum 只是长得像",
    );
  });

  it("★ 两个人都像的时候一个都不给", () => {
    const ambiguous: Candidate[] = [
      { userId: "01U_A", handle: "sunshine", source: "nickname" },
      { userId: "01U_B", handle: "sunshine", source: "claimed-domain" },
      { userId: "01U_C", handle: "sunshiney", source: "nickname" },
    ];
    // 挑一个的期望正确率是 50%，而错一次的代价远大于漏一次
    assert.equal(matchDomain("sunshine.icu", ambiguous), null);
  });

  it("同一个人被多条证据命中，算匹配上（不是歧义）", () => {
    const r = matchDomain("shipowner.icu", REAL);
    assert.equal(r?.userId, alice);
    assert.equal(r?.kind, "exact", "取最强的那条证据当理由");
  });

  it("太短的域名主体一律不匹配", () => {
    assert.equal(matchDomain("abc.icu", REAL), null);
  });

  it("生产库里那批判不出来的，确实判不出来", () => {
    for (const d of [
      "borancui.icu",
      "ryanzhu.icu",
      "sunyuchen.icu",
      "daiyu1.icu",
      "cjl2726.icu",
      "z091127.icu",
      "tatumisin.icu",
      "cacinie.icu",
      "qific.icu",
      "awmcap.icu",
      "m78ai.icu",
      "10kjs.icu",
      "unknownuserfrommars.icu",
    ]) {
      assert.equal(who(d), null, `${d} 不该被判给任何人`);
    }
  });
});
