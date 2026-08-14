import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canClaim,
  explainRefusal,
  GRACE_DAYS,
  LEVEL_SLOT_CAP,
  PURCHASED_SLOT_CAP,
  renewedExpiry,
  RENT_DAYS,
  SLOT_HARD_CAP,
  slotsFor,
  TIER_MIN_LEVEL,
  TIER_RENT,
} from "@/lib/mail/slot-rules";

/**
 * 槽位和申领的纯规则。
 *
 * ═════════════════════════════════════════
 * 这一层错一条的后果是「谁拿到了哪个好地址」
 * ═════════════════════════════════════════
 *
 * 而那种错**改不回来**：地址一旦被开出去、被拿去注册了什么，
 * 收回来就是在动别人已经在用的东西。
 */

describe("**槽位：等级给到 5 就封顶**", () => {
  it("按等级算，L5 之后不再涨", () => {
    /*
     * 封顶防的是早期用户把好前缀囤成资产 —— 和 ECONOMY.md 里
     * 「新人永远追不上老人」是同一个病。
     */
    assert.equal(slotsFor(1, 0), 1);
    assert.equal(slotsFor(5, 0), 5);
    assert.equal(slotsFor(9, 0), LEVEL_SLOT_CAP, "L9 不该比 L5 多");
  });

  it("买来的最多 3 个", () => {
    assert.equal(slotsFor(1, 3), 4);
    assert.equal(slotsFor(1, 99), 1 + PURCHASED_SLOT_CAP, "买多少都只算 3 个");
  });

  it("**总数封顶 8**", () => {
    assert.equal(slotsFor(99, 99), SLOT_HARD_CAP);
  });

  it("负数和小数不会算出奇怪的值", () => {
    // 等级是查出来的、买的数是数出来的，理论上不会是负 —— 但兜底比排查便宜
    assert.equal(slotsFor(-3, -3), 0);
    assert.equal(slotsFor(2.7, 1.9), 3);
  });
});

describe("**三道闸的顺序：等级 → 槽位 → 积分**", () => {
  const base = { tier: "b" as const, level: 9, slotsTotal: 5, slotsUsed: 0, points: 9999 };

  it("都够就放行", () => {
    assert.equal(canClaim(base), null);
  });

  it("**先说等级** —— 那是他今天无论如何改变不了的", () => {
    /*
     * 反过来（先查积分）的话，一个 L1 的人会先被告知「分不够」，
     * 他攒够了再来，然后才被告知「等级不够」——
     * 两次拒绝，而第二次那个理由从一开始就成立。
     */
    const r = canClaim({ ...base, level: 1, slotsUsed: 99, points: 0 });
    assert.equal(r?.code, "level", "三样都不够时，先说的不是等级");
  });

  it("等级够了才说槽位", () => {
    const r = canClaim({ ...base, slotsUsed: 5, points: 0 });
    assert.equal(r?.code, "no_slot");
  });

  it("槽位也够了才说分不够", () => {
    assert.equal(canClaim({ ...base, points: 0 })?.code, "poor");
  });

  it("各档的等级门槛是递增的", () => {
    assert.ok(TIER_MIN_LEVEL.b < TIER_MIN_LEVEL.a);
    assert.ok(TIER_MIN_LEVEL.a < TIER_MIN_LEVEL.s);
  });

  it("**各档的年租也是递增的** —— 否则「档」这个词没有意义", () => {
    assert.ok(TIER_RENT.b < TIER_RENT.a);
    assert.ok(TIER_RENT.a < TIER_RENT.s);
  });
});

describe("**每一句拒绝都要说出下一步**", () => {
  it("三种拒绝都给得出话，而且都带数字", () => {
    /*
     * 「你不能申领」是一句让人无从下手的话。每一种拒绝都要说清楚
     * 差多少、以及能做什么 —— 否则他只能来问人。
     */
    for (const r of [
      { code: "level", need: 3, have: 1 },
      { code: "no_slot", total: 5, used: 5 },
      { code: "poor", need: 150, have: 20 },
    ] as const) {
      const text = explainRefusal(r);
      assert.ok(text.length > 8, `${r.code} 的说法太短`);
      assert.match(text, /\d/, `${r.code} 的说法里没有数字`);
    }
  });
});

describe("**续期从原到期日顺延**", () => {
  const DAY = 86_400_000;

  it("提前续费不吃亏", () => {
    /*
     * 从今天算的话是在惩罚提前付钱的人：早交一天就少一天。
     */
    const now = 1_000 * DAY;
    const expiry = now + 100 * DAY;
    assert.equal(renewedExpiry(expiry, now), expiry + RENT_DAYS * DAY);
  });

  it("已经过期的从今天算 —— 那段时间它本来就没在服务", () => {
    const now = 1_000 * DAY;
    const expired = now - 10 * DAY;
    assert.equal(renewedExpiry(expired, now), now + RENT_DAYS * DAY);
  });

  it("**宽限期比赎回期长** —— 先给自己人时间，再考虑放回池子", () => {
    assert.ok(GRACE_DAYS > 0);
    assert.ok(RENT_DAYS > GRACE_DAYS, "宽限期不该长得像另一个租期");
  });
});
