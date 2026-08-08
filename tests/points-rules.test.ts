import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collapseByMinute,
  dedupeSimilar,
  detectAnomaly,
  evaluateCheckin,
  levelOf,
  levelProgress,
  type PointsConfig,
} from "@/lib/points/rules";

/**
 * 积分规则测试。
 *
 * 规则引擎的每个分支都要覆盖 —— 积分是有价值的东西，
 * 算错一次就有人多拿或少拿，而事后追回比一开始就算对难得多。
 */

const config: PointsConfig = {
  checkinMinQuality: 3,
  checkinMinForum: 3,
  checkinBase: 10,
  qualityBonusPer: 5,
  qualityBonusStep: 5,
  qualityBonusDailyCap: 20,
  streakCap: 30,

  // 发行侧闸门。测试里给一个很大的上限，
  // 免得每条断言都要先算「有没有撞顶」—— 撞顶单独测
  dailyMintCap: 10_000,
  interactionFullUnits: 10,
  interactionDecayRatio: 0.5,
  interactionPointsPerUnit: 1,
  interactionCap: 20,
  transferFeeRatio: 0.05,
  inflationWarnRatio: 0.08,
};

const base = {
  today: "2026-08-09",
  yesterday: "2026-08-08",
  streakBefore: 0,
  lastCheckinDate: null as string | null,
  forumUnitsToday: 0,
  interactions: {},
  mintedToday: 0,
};

describe("打卡门槛", () => {
  it("**当日高质量发言不达标不能打卡**", () => {
    // 先有贡献再签到，否则积分与「让群里有好内容」完全脱钩
    const verdict = evaluateCheckin({ ...base, qualityToday: 2 }, config);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "not_enough");
    assert.match(verdict.message, /还差 1 条/);
  });

  it("刚好达标即可打卡", () => {
    const verdict = evaluateCheckin({ ...base, qualityToday: 3 }, config);
    assert.equal(verdict.ok, true);
  });

  it("同一天不能重复打卡", () => {
    const verdict = evaluateCheckin(
      { ...base, qualityToday: 10, lastCheckinDate: base.today },
      config,
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "already");
  });
});

describe("高质量加分", () => {
  it("刚达标时没有额外加分", () => {
    const v = evaluateCheckin({ ...base, qualityToday: 3 }, config);
    assert.ok(v.ok);
    assert.equal(v.qualityBonus, 0);
    assert.equal(v.total, 10 + 0 + 1, "基础 10 + 加分 0 + 连胜 1");
  });

  it("每超出一个步长加一档", () => {
    const v = evaluateCheckin({ ...base, qualityToday: 8 }, config);
    assert.ok(v.ok);
    assert.equal(v.qualityBonus, 5, "超出 5 条 = 一档");
  });

  it("加分有每日上限", () => {
    const v = evaluateCheckin({ ...base, qualityToday: 500 }, config);
    assert.ok(v.ok);
    assert.equal(v.qualityBonus, 20, "封顶 20，不能靠刷量无限拿分");
  });

  it("步长为 0 时不崩（配置写错的兜底）", () => {
    const v = evaluateCheckin({ ...base, qualityToday: 50 }, { ...config, qualityBonusStep: 0 });
    assert.ok(v.ok);
    assert.equal(v.qualityBonus, 0);
  });
});

describe("连胜", () => {
  it("首次打卡连胜为 1", () => {
    const v = evaluateCheckin({ ...base, qualityToday: 5 }, config);
    assert.ok(v.ok);
    assert.equal(v.streakAfter, 1);
    assert.equal(v.streakReset, false);
  });

  it("昨天打过则连胜加一", () => {
    const v = evaluateCheckin(
      { ...base, qualityToday: 5, lastCheckinDate: base.yesterday, streakBefore: 6 },
      config,
    );
    assert.ok(v.ok);
    assert.equal(v.streakAfter, 7);
    assert.equal(v.streakBonus, 7);
  });

  it("**断签后重置为 1**", () => {
    const v = evaluateCheckin(
      { ...base, qualityToday: 5, lastCheckinDate: "2026-08-05", streakBefore: 30 },
      config,
    );
    assert.ok(v.ok);
    assert.equal(v.streakAfter, 1, "隔了几天就断了");
    assert.equal(v.streakReset, true);
  });

  it("连胜奖励有上限，否则一年后每天白拿三百多分", () => {
    const v = evaluateCheckin(
      { ...base, qualityToday: 5, lastCheckinDate: base.yesterday, streakBefore: 200 },
      config,
    );
    assert.ok(v.ok);
    assert.equal(v.streakAfter, 201, "连胜天数照常累计");
    assert.equal(v.streakBonus, 30, "但奖励封顶");
  });
});

describe("等级", () => {
  it("零分是 1 级", () => {
    assert.equal(levelOf(0).level, 1);
  });

  it("按累计分升级", () => {
    assert.equal(levelOf(49).level, 1);
    assert.equal(levelOf(50).level, 2);
    assert.equal(levelOf(149).level, 2);
    assert.equal(levelOf(150).level, 3);
  });

  it("超出最高档仍是最高级，不会越界", () => {
    assert.equal(levelOf(999_999).level, 10);
    assert.equal(levelProgress(999_999).next, null);
    assert.equal(levelProgress(999_999).ratio, 1);
  });

  it("进度条比例在 0 到 1 之间", () => {
    for (const total of [0, 25, 50, 100, 700, 3000, 7999]) {
      const p = levelProgress(total);
      assert.ok(p.ratio >= 0 && p.ratio <= 1, `${total} 分时比例为 ${p.ratio}`);
    }
  });

  it("距下一级的差额算得对", () => {
    const p = levelProgress(120);
    assert.equal(p.current.level, 2);
    assert.equal(p.next!.level, 3);
    assert.equal(p.remaining, 30);
  });
});

describe("反作弊", () => {
  it("同一分钟内多条折叠成一条", () => {
    // 连着刷十条「这个不错」是最容易的刷分方式
    const t = 1_786_000_000_000;
    const stamps = Array.from({ length: 10 }, (_, i) => t + i * 1000);
    assert.equal(collapseByMinute(stamps), 1);
  });

  it("跨分钟的正常发言不受影响", () => {
    const t = 1_786_000_000_000;
    assert.equal(collapseByMinute([t, t + 61_000, t + 130_000]), 3);
  });

  it("复读同一句只算一条", () => {
    assert.equal(dedupeSimilar(["好的", "好的", "好的"]), 1);
  });

  it("只差标点的算同一条", () => {
    assert.equal(dedupeSimilar(["好的。", "好的！", "好的"]), 1);
  });

  it("不同内容各算各的", () => {
    assert.equal(dedupeSimilar(["今天天气不错", "我觉得这个方案可行"]), 2);
  });

  it("纯标点不计入", () => {
    assert.equal(dedupeSimilar(["。。。", "！！！", ""]), 0);
  });
});

describe("异常增长检测", () => {
  it("样本太少时不判定 —— 新人头几天必然暴涨", () => {
    const r = detectAnomaly({ todayQuality: 100, recentDaily: [1, 2], spikeThreshold: 3 });
    assert.equal(r.anomalous, false);
  });

  it("远超均值时判为异常", () => {
    const r = detectAnomaly({ todayQuality: 60, recentDaily: [5, 6, 4, 5], spikeThreshold: 3 });
    assert.equal(r.anomalous, true);
    assert.ok(r.ratio > 10);
  });

  it("正常波动不判为异常", () => {
    const r = detectAnomaly({ todayQuality: 8, recentDaily: [5, 6, 4, 5], spikeThreshold: 3 });
    assert.equal(r.anomalous, false);
  });

  it("均值为零时不判定，避免除零", () => {
    const r = detectAnomaly({ todayQuality: 10, recentDaily: [0, 0, 0, 0], spikeThreshold: 3 });
    assert.equal(r.anomalous, false);
  });
});
