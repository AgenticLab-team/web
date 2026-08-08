import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INTERACTION_WEIGHTS,
  applyDailyBudget,
  concentration,
  inflationReport,
  settleInteractions,
  transferFee,
  type EconomyConfig,
} from "@/lib/points/economy";
import { evaluateCheckin, type PointsConfig } from "@/lib/points/rules";

/**
 * 积分经济。
 *
 * 这套东西存在的唯一理由是**发行总量受控**。
 * 只发不收的积分，一年后商店价格变成笑话、新人永远追不上老人、
 * 积分不再代表任何东西 —— 于是也没人再为它做事。
 *
 * 支点是「每人每日发行上限，所有来源共享同一个预算」：
 * 各来源各自封顶的话，**每加一个玩法就等于给通胀开一个新口子**。
 */

const econ: EconomyConfig = {
  dailyMintCap: 60,
  interactionFullUnits: 10,
  interactionDecayRatio: 0.5,
  interactionPointsPerUnit: 1,
  interactionCap: 20,
  transferFeeRatio: 0.05,
  inflationWarnRatio: 0.08,
};

describe("互动结算", () => {
  it("没有互动就是 0 分", () => {
    assert.equal(settleInteractions({}, econ).points, 0);
  });

  it("按权重折算成单位", () => {
    const s = settleInteractions({ post: 1, reply: 2 }, econ);
    assert.equal(s.rawUnits, INTERACTION_WEIGHTS.post + 2 * INTERACTION_WEIGHTS.reply);
  });

  it("**收到的赞权重低于自己发的内容**", () => {
    // 收赞取决于别人，鼓励不了行为，而且可以互刷
    assert.ok(INTERACTION_WEIGHTS.reactionReceived < INTERACTION_WEIGHTS.post);
    assert.ok(INTERACTION_WEIGHTS.reactionGiven < INTERACTION_WEIGHTS.reactionReceived);
  });

  it("给别人点赞也算分 —— 完全不计分就没人做了", () => {
    assert.ok(INTERACTION_WEIGHTS.reactionGiven > 0);
  });

  it("前若干单位全额计分", () => {
    // 3 个回复 = 3 单位，未超过 10 的全额段
    const s = settleInteractions({ reply: 3 }, econ);
    assert.equal(s.creditedUnits, 3);
    assert.equal(s.points, 3);
  });

  it("**超出部分打折** —— 刷量的边际收益递减", () => {
    // 20 个回复 = 20 单位：前 10 全额，后 10 折半 → 15
    const s = settleInteractions({ reply: 20 }, econ);
    assert.equal(s.creditedUnits, 15);
  });

  it("**再多也撞得到自己的上限**", () => {
    const s = settleInteractions({ reply: 500 }, econ);
    assert.equal(s.points, econ.interactionCap);
    assert.equal(s.capped, true);
  });

  it("负数和小数不会变成白拿的分", () => {
    assert.equal(settleInteractions({ reply: -100 }, econ).points, 0);
    assert.equal(settleInteractions({ reply: 2.9 }, econ).rawUnits, 2);
  });

  it("给出明细 —— 看不懂分怎么来的，就不会为它做事", () => {
    const s = settleInteractions({ post: 1, reply: 2 }, econ);
    assert.equal(s.breakdown.length, 2);
    assert.ok(s.breakdown.every((b) => b.units > 0));
  });
});

describe("每日发行预算", () => {
  it("额度充足时全额发放", () => {
    const r = applyDailyBudget(30, 0, econ);
    assert.equal(r.granted, 30);
    assert.equal(r.capped, false);
    assert.equal(r.remaining, 30);
  });

  it("**撞上限时削掉超出部分，并如实报出削了多少**", () => {
    // 静默少发是最伤人的：「我明明做了这么多怎么只有这点分」
    const r = applyDailyBudget(30, 50, econ);
    assert.equal(r.granted, 10);
    assert.equal(r.clipped, 20);
    assert.equal(r.capped, true);
  });

  it("额度用尽后一分也不再发", () => {
    const r = applyDailyBudget(30, 60, econ);
    assert.equal(r.granted, 0);
    assert.equal(r.clipped, 30);
    assert.equal(r.remaining, 0);
  });

  it("已发行超过上限（历史数据或改过配置）也不会算出负额度", () => {
    const r = applyDailyBudget(10, 999, econ);
    assert.equal(r.granted, 0);
    assert.equal(r.remaining, 0);
  });

  it("**所有来源共享同一个预算**", () => {
    // 分两次拿，总量仍受同一个上限约束 ——
    // 各来源各自封顶的话，加一个玩法就是开一个新口子
    const first = applyDailyBudget(40, 0, econ);
    const second = applyDailyBudget(40, first.granted, econ);
    assert.equal(first.granted + second.granted, econ.dailyMintCap);
  });
});

describe("转赠手续费", () => {
  it("按比例销毁", () => {
    assert.equal(transferFee(100, econ), 5);
  });

  it("小额转赠不会因为取整变成免费刷分通道", () => {
    // 1 分转账手续费为 0，但转 1 分本身也搬不动多少
    assert.equal(transferFee(1, econ), 0);
    assert.equal(transferFee(20, econ), 1);
  });

  it("负数不会倒贴", () => {
    assert.equal(transferFee(-100, econ), 0);
  });
});

describe("通胀体检", () => {
  it("净增在警戒线内算健康", () => {
    const r = inflationReport({ minted: 100, burned: 60, circulatingBefore: 10_000 }, econ);
    assert.equal(r.verdict, "healthy");
  });

  it("**净增超过流通量的警戒比例就告警**", () => {
    const r = inflationReport({ minted: 2000, burned: 100, circulatingBefore: 10_000 }, econ);
    assert.equal(r.verdict, "inflating");
    assert.match(r.message, /警戒线/);
  });

  it("看的是比例不是绝对值 —— 社区变大发行自然变多，那不是通胀", () => {
    const small = inflationReport({ minted: 100, burned: 20, circulatingBefore: 1_000 }, econ);
    const big = inflationReport({ minted: 10_000, burned: 2_000, circulatingBefore: 100_000 }, econ);
    assert.equal(small.rate.toFixed(4), big.rate.toFixed(4));
  });

  it("**几乎没有回收同样是问题**，哪怕净增比例不高", () => {
    // 现在看着没事，只是因为流通量还大
    const r = inflationReport({ minted: 500, burned: 5, circulatingBefore: 1_000_000 }, econ);
    assert.equal(r.verdict, "watch");
    assert.match(r.message, /只进不出/);
  });

  it("回收大于发行会被指出来 —— 只出不进也留不住人", () => {
    const r = inflationReport({ minted: 100, burned: 300, circulatingBefore: 10_000 }, econ);
    assert.equal(r.verdict, "deflating");
  });

  it("流通量为 0 时不会除以 0", () => {
    const r = inflationReport({ minted: 10, burned: 0, circulatingBefore: 0 }, econ);
    assert.ok(Number.isFinite(r.rate));
  });
});

describe("分配集中度", () => {
  it("均匀分布时中位数与均值接近", () => {
    const c = concentration([100, 100, 100, 100]);
    assert.equal(c.ratio, 1);
  });

  it("**少数人握着大部分积分时比值明显偏低**", () => {
    const c = concentration([1, 1, 1, 1, 1, 1, 1, 1, 1, 10_000]);
    assert.ok(c.ratio < 0.1, `比值 ${c.ratio} 应该很小`);
    assert.ok(c.topShare > 0.9);
  });

  it("空集合不炸", () => {
    const c = concentration([]);
    assert.equal(c.median, 0);
    assert.equal(c.ratio, 1);
  });
});

describe("打卡的两条门槛", () => {
  const config: PointsConfig = {
    ...econ,
    checkinMinQuality: 3,
    checkinMinForum: 3,
    checkinBase: 10,
    qualityBonusPer: 5,
    qualityBonusStep: 5,
    qualityBonusDailyCap: 20,
    streakCap: 30,
  };

  const base = {
    today: "2026-08-09",
    yesterday: "2026-08-08",
    streakBefore: 0,
    lastCheckinDate: null as string | null,
    qualityToday: 0,
    forumUnitsToday: 0,
    interactions: {},
    mintedToday: 0,
  };

  it("群聊达标可以打卡", () => {
    const v = evaluateCheckin({ ...base, qualityToday: 3 }, config);
    assert.equal(v.ok, true);
    assert.equal(v.ok && v.via, "chat");
  });

  it("**只在论坛活跃也能打卡**", () => {
    // 只认群聊的话，沉淀内容最多的那批人反而打不了卡
    const v = evaluateCheckin({ ...base, forumUnitsToday: 3 }, config);
    assert.equal(v.ok, true);
    assert.equal(v.ok && v.via, "forum");
  });

  it("两边都达标标记为 both", () => {
    const v = evaluateCheckin({ ...base, qualityToday: 5, forumUnitsToday: 5 }, config);
    assert.equal(v.ok && v.via, "both");
  });

  it("两边都不达标才拦下", () => {
    const v = evaluateCheckin({ ...base, qualityToday: 2, forumUnitsToday: 2 }, config);
    assert.equal(v.ok, false);
  });

  it("**拦下时两条路都要说出来**", () => {
    const v = evaluateCheckin({ ...base, qualityToday: 2, forumUnitsToday: 0 }, config);
    assert.equal(v.ok, false);
    if (v.ok || v.reason !== "not_enough") throw new Error("应该是 not_enough");
    assert.equal(v.paths.length, 2);
    assert.match(v.message, /论坛/);
  });

  it("**更接近达成的那条排在前面**", () => {
    // 让人看到「就差一点」，而不是「差得远」
    const v = evaluateCheckin({ ...base, qualityToday: 0, forumUnitsToday: 2 }, config);
    if (v.ok || v.reason !== "not_enough") throw new Error("应该是 not_enough");
    assert.equal(v.paths[0].kind, "forum");
  });
});

describe("打卡结算受每日预算约束", () => {
  const config: PointsConfig = {
    ...econ,
    dailyMintCap: 15,
    checkinMinQuality: 3,
    checkinMinForum: 3,
    checkinBase: 10,
    qualityBonusPer: 5,
    qualityBonusStep: 5,
    qualityBonusDailyCap: 20,
    streakCap: 30,
  };

  const base = {
    today: "2026-08-09",
    yesterday: "2026-08-08",
    streakBefore: 0,
    lastCheckinDate: null as string | null,
    qualityToday: 3,
    forumUnitsToday: 0,
    interactions: {},
    mintedToday: 0,
  };

  it("正常情况下拿满", () => {
    const v = evaluateCheckin(base, config);
    assert.equal(v.ok && v.total, 11); // 基础 10 + 连胜 1
    assert.equal(v.ok && v.capped, false);
  });

  it("**今天已经拿过分的话，打卡只补到上限为止**", () => {
    const v = evaluateCheckin({ ...base, mintedToday: 10 }, config);
    assert.equal(v.ok && v.earned, 11);
    assert.equal(v.ok && v.total, 5);
    assert.equal(v.ok && v.clipped, 6);
    assert.equal(v.ok && v.capped, true);
  });

  it("额度用尽时打卡仍然成立，只是拿 0 分", () => {
    // 断一次连胜比少给几分伤人得多
    const v = evaluateCheckin({ ...base, mintedToday: 15 }, config);
    assert.equal(v.ok, true);
    assert.equal(v.ok && v.total, 0);
    assert.equal(v.ok && v.streakAfter, 1);
  });

  it("互动分也从同一个预算里出", () => {
    const v = evaluateCheckin(
      { ...base, mintedToday: 0, interactions: { post: 3, reply: 10 } },
      config,
    );
    assert.equal(v.ok && v.total, config.dailyMintCap, "总额不该超过每日上限");
  });
});
