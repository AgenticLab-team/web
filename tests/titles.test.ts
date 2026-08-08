import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkEquip,
  checkGrant,
  checkPurchase,
  expiryFor,
  isTitleActive,
  isTitleExpired,
  meetsCondition,
  rarityColor,
  rarityLabel,
  renewalExpiry,
  sourceLabel,
  type TitleSpec,
} from "@/lib/titles/rules";
import { BUILTIN_TITLES } from "@/lib/titles/builtin";

/**
 * 称号。
 *
 * 等级是连续的，称号是离散的 —— 等级回答「你来多久了」，
 * 称号回答「你是谁」。只有等级的社区里，人和人的区别只是数字大小。
 */

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

const spec = (over: Partial<TitleSpec> = {}): TitleSpec => ({
  id: "t1",
  key: "seed_user",
  name: "种子用户",
  rarity: "legendary",
  source: "grant",
  price: null,
  rentDays: null,
  limitCount: null,
  enabled: true,
  ...over,
});

describe("是否生效", () => {
  it("正常持有的生效", () => {
    assert.equal(isTitleActive({ titleId: "t1", expiresAt: null, revokedAt: null }, T0), true);
  });

  it("被收回的不生效", () => {
    assert.equal(isTitleActive({ titleId: "t1", expiresAt: null, revokedAt: T0 }, T0), false);
  });

  it("过期的不生效", () => {
    assert.equal(isTitleActive({ titleId: "t1", expiresAt: T0 - 1, revokedAt: null }, T0), false);
  });

  it("**到期和被收回要分得开**", () => {
    // 「我曾经拿到过」也是履历的一部分，不该和「被收回」显示成一样
    const expired = { titleId: "t1", expiresAt: T0 - 1, revokedAt: null };
    const revoked = { titleId: "t1", expiresAt: null, revokedAt: T0 };
    assert.equal(isTitleExpired(expired, T0), true);
    assert.equal(isTitleExpired(revoked, T0), false);
  });

  it("尚未到期的还生效", () => {
    assert.equal(isTitleActive({ titleId: "t1", expiresAt: T0 + DAY, revokedAt: null }, T0), true);
  });
});

describe("授予", () => {
  const base = { title: spec(), currentHolders: 0, alreadyHeld: false, reason: "内测参与者" };

  it("正常授予通过", () => {
    assert.equal(checkGrant(base).ok, true);
  });

  it("必须填理由", () => {
    assert.equal(checkGrant({ ...base, reason: "  " }).ok, false);
  });

  it("不能重复授予", () => {
    assert.equal(checkGrant({ ...base, alreadyHeld: true }).ok, false);
  });

  it("停用的称号不能再发", () => {
    assert.equal(checkGrant({ ...base, title: spec({ enabled: false }) }).ok, false);
  });

  it("**名额满了就发不出去** —— 发滥了就不稀有了", () => {
    const limited = spec({ limitCount: 100 });
    assert.equal(checkGrant({ ...base, title: limited, currentHolders: 99 }).ok, true);
    const full = checkGrant({ ...base, title: limited, currentHolders: 100 });
    assert.equal(full.ok, false);
    assert.match(full.error!, /名额/);
  });

  it("没设上限的可以一直发", () => {
    assert.equal(checkGrant({ ...base, currentHolders: 99_999 }).ok, true);
  });
});

describe("购买", () => {
  const buyable = spec({ key: "custom", source: "purchase", price: 300, rentDays: 30 });
  const base = { title: buyable, balance: 500, currentHolders: 0, alreadyHeld: false };

  it("余额够就能买", () => {
    assert.equal(checkPurchase(base).ok, true);
  });

  it("**余额不够时直接说还差多少**", () => {
    const r = checkPurchase({ ...base, balance: 100 });
    assert.equal(r.ok, false);
    assert.match(r.error!, /还差 200 分/);
  });

  it("刚好够也能买", () => {
    assert.equal(checkPurchase({ ...base, balance: 300 }).ok, true);
  });

  it("非购买型的称号买不了", () => {
    assert.equal(checkPurchase({ ...base, title: spec({ source: "grant" }) }).ok, false);
  });

  it("没定价的买不了 —— 不能因为配置漏填就变成白送", () => {
    assert.equal(checkPurchase({ ...base, title: spec({ source: "purchase", price: null }) }).ok, false);
    assert.equal(checkPurchase({ ...base, title: spec({ source: "purchase", price: 0 }) }).ok, false);
  });

  it("已经有了就不能重复买", () => {
    assert.equal(checkPurchase({ ...base, alreadyHeld: true }).ok, false);
  });
});

describe("租期与续费", () => {
  const rental = spec({ source: "purchase", price: 300, rentDays: 30 });

  it("租用型算出到期时间", () => {
    assert.equal(expiryFor(rental, T0), T0 + 30 * DAY);
  });

  it("非租用型永久持有", () => {
    assert.equal(expiryFor(spec(), T0), null);
  });

  it("**提前续费从原到期日顺延**", () => {
    // 从现在算的话，提前续费的人白白损失剩余天数 ——
    // 等于在惩罚愿意提前付钱的人
    const currentExpiry = T0 + 10 * DAY;
    assert.equal(renewalExpiry(currentExpiry, rental, T0), currentExpiry + 30 * DAY);
  });

  it("**已经过期的从现在算**", () => {
    // 不然补一次费会把空窗期也算进去，等于花钱买了已经过去的日子
    assert.equal(renewalExpiry(T0 - 5 * DAY, rental, T0), T0 + 30 * DAY);
  });

  it("从没有过到期时间的按现在算", () => {
    assert.equal(renewalExpiry(null, rental, T0), T0 + 30 * DAY);
  });
});

describe("佩戴", () => {
  const held = [
    { titleId: "t1", expiresAt: null, revokedAt: null },
    { titleId: "t2", expiresAt: T0 - 1, revokedAt: null },
    { titleId: "t3", expiresAt: null, revokedAt: T0 - 1 },
  ];

  it("持有的可以戴", () => {
    assert.equal(checkEquip({ titleId: "t1", held, now: T0 }).ok, true);
  });

  it("**摘下称号永远允许** —— 不能让人被自己的称号困住", () => {
    assert.equal(checkEquip({ titleId: null, held: [], now: T0 }).ok, true);
  });

  it("没有的戴不了", () => {
    assert.equal(checkEquip({ titleId: "t9", held, now: T0 }).ok, false);
  });

  it("过期的戴不了，但提示是「过期」不是「你没有」", () => {
    const r = checkEquip({ titleId: "t2", held, now: T0 });
    assert.equal(r.ok, false);
    assert.match(r.error!, /过期/);
  });

  it("被收回的戴不了", () => {
    const r = checkEquip({ titleId: "t3", held, now: T0 });
    assert.equal(r.ok, false);
    assert.match(r.error!, /收回/);
  });
});

describe("成就达成", () => {
  const stats = {
    pointsTotal: 1000,
    streakBest: 30,
    posts: 5,
    replies: 200,
    qualityMessages: 120,
    checkins: 40,
  };

  it("达到条件就算达成", () => {
    assert.equal(
      meetsCondition(
        { source: "achievement", conditionKind: "streakBest", conditionValue: 30 },
        stats,
      ),
      true,
    );
  });

  it("差一点就不算", () => {
    assert.equal(
      meetsCondition(
        { source: "achievement", conditionKind: "streakBest", conditionValue: 31 },
        stats,
      ),
      false,
    );
  });

  it("**非成就型的称号不会被自动发出去**", () => {
    // 种子用户这类必须人工授予，条件字段写了也不算数
    assert.equal(
      meetsCondition({ source: "grant", conditionKind: "posts", conditionValue: 1 }, stats),
      false,
    );
  });

  it("条件字段没填就不达成，而不是当成 0 全员发放", () => {
    assert.equal(
      meetsCondition({ source: "achievement", conditionKind: null, conditionValue: 1 }, stats),
      false,
    );
    assert.equal(
      meetsCondition({ source: "achievement", conditionKind: "posts", conditionValue: null }, stats),
      false,
    );
  });

  it("未知指标不达成，不会因为字段名写错就全员发放", () => {
    assert.equal(
      meetsCondition(
        { source: "achievement", conditionKind: "not_a_real_stat", conditionValue: 1 },
        stats,
      ),
      false,
    );
  });
});

describe("内置称号", () => {
  it("key 唯一", () => {
    const keys = BUILTIN_TITLES.map((t) => t.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  it("**种子用户有名额上限** —— 后面再发就不叫种子用户了", () => {
    const seed = BUILTIN_TITLES.find((t) => t.key === "seed_user")!;
    assert.equal(seed.source, "grant", "必须人工授予，不能自动发");
    assert.ok(seed.limitCount && seed.limitCount > 0);
  });

  it("成就型都写了条件，否则永远发不出去", () => {
    for (const t of BUILTIN_TITLES.filter((t) => t.source === "achievement")) {
      assert.ok(t.conditionKind, `${t.key} 没写条件指标`);
      assert.ok(t.conditionValue && t.conditionValue > 0, `${t.key} 没写条件数值`);
    }
  });

  it("购买型都有价格", () => {
    for (const t of BUILTIN_TITLES.filter((t) => t.source === "purchase")) {
      assert.ok(t.price && t.price > 0, `${t.key} 没定价`);
    }
  });

  it("**至少有一个按期续费的称号** —— 那是可持续的回收口", () => {
    // 一次性买断的话回收只发生一次，之后积分照样越攒越多
    assert.ok(BUILTIN_TITLES.some((t) => t.rentDays && t.rentDays > 0));
  });

  it("数量克制 —— 称号一多就变成徽章墙，每个都不值钱了", () => {
    assert.ok(BUILTIN_TITLES.length <= 12, `内置了 ${BUILTIN_TITLES.length} 个，太多了`);
  });
});

describe("展示用文案", () => {
  it("稀有度有中文名和配色", () => {
    assert.equal(rarityLabel("legendary"), "传说");
    assert.ok(rarityColor("legendary").length > 0);
  });

  it("来源有中文名", () => {
    assert.equal(sourceLabel("achievement"), "成就");
  });

  it("未知值不显示成 undefined", () => {
    assert.equal(rarityLabel("mythic"), "mythic");
    assert.equal(sourceLabel("gift"), "gift");
    assert.ok(rarityColor("mythic").length > 0);
  });
});
