import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUTO_PRUNE_COOLDOWN_MS,
  DEFAULT_TIER_CONFIG,
  EMPTY_PREVIEW,
  FTS_OVERHEAD_RATIO,
  INDEXABLE_TYPES,
  changesFor,
  configWarnings,
  describeTier,
  desiredState,
  estimateFtsBytes,
  formatBytes,
  isIndexable,
  isIrreversible,
  isNoop,
  shouldAutoPrune,
  tierBoundaries,
  tierFor,
  validateTierConfig,
  type TierConfig,
} from "@/lib/storage/tiers";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const cfg = DEFAULT_TIER_CONFIG;

function ago(days: number) {
  return NOW - days * DAY;
}

describe("分层边界", () => {
  it("按天数落到对应的层", () => {
    assert.equal(tierFor(ago(0), NOW, cfg), "hot");
    assert.equal(tierFor(ago(89), NOW, cfg), "hot");
    assert.equal(tierFor(ago(90), NOW, cfg), "warm");
    assert.equal(tierFor(ago(364), NOW, cfg), "warm");
    assert.equal(tierFor(ago(365), NOW, cfg), "cold");
  });

  it("边界和 tierBoundaries 算出来的一致 —— 两处分开算迟早会错开一天", () => {
    const { warmBefore, coldBefore } = tierBoundaries(NOW, cfg);
    assert.equal(tierFor(warmBefore, NOW, cfg), "warm");
    assert.equal(tierFor(warmBefore + 1, NOW, cfg), "hot");
    assert.equal(tierFor(coldBefore, NOW, cfg), "cold");
    assert.equal(tierFor(coldBefore + 1, NOW, cfg), "warm");
  });

  it("未来时间戳算热层，不会因为时钟偏差掉进冷层", () => {
    assert.equal(tierFor(NOW + DAY, NOW, cfg), "hot");
  });
});

describe("配置本身要讲得通", () => {
  it("默认配置没有问题", () => {
    assert.deepEqual(validateTierConfig(cfg), []);
  });

  it("温层不大于热层时报错 —— 中间那层是假的", () => {
    const bad: TierConfig = { ...cfg, hotDays: 90, warmDays: 90 };
    const problems = validateTierConfig(bad);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /温层/);
  });

  it("关掉归档是提醒，不是禁止 —— 被禁掉的分支等于没写过的分支", () => {
    const risky: TierConfig = { ...cfg, archiveBeforeDrop: false, coldKeepQualityOnly: true };
    assert.deepEqual(validateTierConfig(risky), [], "不该拦死，否则那道抽样检验永远不会执行");
    assert.ok(configWarnings(risky).some((w) => w.includes("抽样")));
  });

  it("关掉归档但冷层也不丢正文，连提醒都不需要", () => {
    const ok: TierConfig = { ...cfg, archiveBeforeDrop: false, coldKeepQualityOnly: false };
    assert.deepEqual(validateTierConfig(ok), []);
    assert.deepEqual(configWarnings(ok), []);
  });

  it("默认配置没有提醒", () => {
    assert.deepEqual(configWarnings(cfg), []);
  });

  it("温层长到没有意义时提醒 —— 那等于从不进冷层", () => {
    assert.ok(configWarnings({ ...cfg, warmDays: 4000 }).some((w) => w.includes("冷层")));
  });

  it("热层小于一天不合法", () => {
    assert.ok(validateTierConfig({ ...cfg, hotDays: 0 }).some((p) => p.includes("1 天")));
  });
});

describe("期望状态", () => {
  it("热层什么都留着", () => {
    const d = desiredState("hot", { isQuality: false }, cfg);
    assert.deepEqual(d, { tier: "hot", indexed: true, dropContent: false });
  });

  it("温层只索引高质量，正文全留", () => {
    assert.deepEqual(desiredState("warm", { isQuality: false }, cfg), {
      tier: "warm",
      indexed: false,
      dropContent: false,
    });
    assert.deepEqual(desiredState("warm", { isQuality: true }, cfg), {
      tier: "warm",
      indexed: true,
      dropContent: false,
    });
  });

  it("冷层丢非高质量的正文，高质量的一个字都不动", () => {
    assert.equal(desiredState("cold", { isQuality: false }, cfg).dropContent, true);
    assert.equal(desiredState("cold", { isQuality: true }, cfg).dropContent, false);
    assert.equal(desiredState("cold", { isQuality: true }, cfg).indexed, true);
  });

  it("关掉「冷层只留高质量」之后什么都不丢", () => {
    const keepAll: TierConfig = { ...cfg, coldKeepQualityOnly: false };
    assert.equal(desiredState("cold", { isQuality: false }, keepAll).dropContent, false);
  });

  it("高质量消息在任何层都能搜到 —— 那是社群真正沉淀下来的东西", () => {
    for (const tier of ["hot", "warm", "cold"] as const) {
      assert.equal(desiredState(tier, { isQuality: true }, cfg).indexed, true, `${tier} 层丢了索引`);
    }
  });
});

describe("现状与期望的差距", () => {
  it("已经就位的不产生动作 —— 幂等", () => {
    const changes = changesFor(
      { tier: "warm", indexed: false, isQuality: false, hasContent: true },
      desiredState("warm", { isQuality: false }, cfg),
    );
    assert.deepEqual(changes, []);
  });

  it("层变了要改层", () => {
    const changes = changesFor(
      { tier: "hot", indexed: true, isQuality: true, hasContent: true },
      desiredState("warm", { isQuality: true }, cfg),
    );
    assert.deepEqual(changes, ["retier"]);
  });

  it("索引还在但不该在了，要退索引", () => {
    const changes = changesFor(
      { tier: "warm", indexed: true, isQuality: false, hasContent: true },
      desiredState("warm", { isQuality: false }, cfg),
    );
    assert.deepEqual(changes, ["unindex"]);
  });

  it("已经丢过正文的不重复算 —— 否则预览一轮比一轮大", () => {
    const changes = changesFor(
      { tier: "cold", indexed: false, isQuality: false, hasContent: false },
      desiredState("cold", { isQuality: false }, cfg),
    );
    assert.deepEqual(changes, []);
  });

  it("不会把没建过的索引再退一次", () => {
    const changes = changesFor(
      { tier: "cold", indexed: false, isQuality: false, hasContent: true },
      desiredState("cold", { isQuality: false }, cfg),
    );
    assert.deepEqual(changes, ["drop"]);
  });
});

describe("索引资格和同步侧一致 —— 不一致的话两个任务会互相拆台", () => {
  it("只索引有文字的文本与引用", () => {
    assert.equal(isIndexable("text", "你好"), true);
    assert.equal(isIndexable("quote", "回复"), true);
    assert.equal(isIndexable("image", "x"), false);
    assert.equal(isIndexable("voice", "x"), false);
  });

  it("空白正文不进索引", () => {
    assert.equal(isIndexable("text", "   \n "), false);
    assert.equal(isIndexable("text", ""), false);
  });

  it("可索引类型集合就是那两个", () => {
    assert.deepEqual([...INDEXABLE_TYPES].sort(), ["quote", "text"]);
  });
});

describe("预览的呈现", () => {
  it("空预览既不是不可逆也不是有事要做", () => {
    assert.equal(isIrreversible(EMPTY_PREVIEW), false);
    assert.equal(isNoop(EMPTY_PREVIEW), true);
  });

  it("只改层和退索引不算不可逆", () => {
    const p = { ...EMPTY_PREVIEW, retier: 100, unindex: 50 };
    assert.equal(isIrreversible(p), false);
    assert.equal(isNoop(p), false);
  });

  it("一旦要丢正文就是不可逆，必须二次确认", () => {
    assert.equal(isIrreversible({ ...EMPTY_PREVIEW, drop: 1 }), true);
  });

  it("索引体积按实测比例估算", () => {
    assert.equal(estimateFtsBytes(1000), Math.round(1000 * FTS_OVERHEAD_RATIO));
    assert.equal(estimateFtsBytes(0), 0);
  });

  it("字节数说人话", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2 KB");
    assert.equal(formatBytes(5 * 1048576), "5.0 MB");
    assert.equal(formatBytes(3 * 1073741824), "3.00 GB");
  });

  it("每一层都有一句能让人看懂的说明", () => {
    for (const tier of ["hot", "warm", "cold"] as const) {
      const text = describeTier(tier, cfg);
      assert.ok(text.length > 0);
      assert.ok(/\d/.test(text), `${tier} 的说明里没有具体天数`);
    }
  });

  it("冷层说明会跟着配置变 —— 不留正文和全留是两句不同的话", () => {
    const a = describeTier("cold", cfg);
    const b = describeTier("cold", { ...cfg, coldKeepQualityOnly: false });
    assert.notEqual(a, b);
    assert.match(a, /归档/);
  });
});

describe("自动裁剪的触发条件", () => {
  const base = { diskPct: 90, prunePct: 85, lastRunAt: null, hasWork: true, now: NOW };

  it("没到线不跑", () => {
    const d = shouldAutoPrune({ ...base, diskPct: 80 });
    assert.equal(d.run, false);
    assert.match(d.reason, /没到/);
  });

  it("到线且有事可做就跑", () => {
    assert.equal(shouldAutoPrune(base).run, true);
  });

  it("到线但没东西可裁时如实说 —— 空间不是消息占的", () => {
    const d = shouldAutoPrune({ ...base, hasWork: false });
    assert.equal(d.run, false);
    assert.match(d.reason, /空间不是消息占的/);
  });

  it("冷却期内不重复跑 —— 不让自动裁剪变成刷日志的仪式", () => {
    const d = shouldAutoPrune({ ...base, lastRunAt: NOW - 3600_000 });
    assert.equal(d.run, false);
    assert.match(d.reason, /冷却/);
  });

  it("冷却结束后可以再跑", () => {
    assert.equal(
      shouldAutoPrune({ ...base, lastRunAt: NOW - AUTO_PRUNE_COOLDOWN_MS }).run,
      true,
    );
  });

  it("刚好等于阈值也算到线", () => {
    assert.equal(shouldAutoPrune({ ...base, diskPct: 85 }).run, true);
  });
});
