import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_RETRY,
  checkManualTrigger,
  checkRetry,
  classifyFreshness,
  formatSpan,
  syncHealth,
  toleranceFor,
} from "@/lib/sync/health";

/**
 * 同步健康。
 *
 * 上游隧道断掉的表现是「消息数不再增长」，
 * 而它和「今天大家没说话」在数据上长得一模一样 ——
 * 榜单照常显示、首页照常显示 0，没有任何地方会红。
 *
 * 这个模块要回答的不是「有没有数据」，是「**该有的数据到了没有**」。
 */

const HOUR = 3600_000;
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

describe("按群自己的节奏定容忍度", () => {
  it("**活跃的群容忍度短**", () => {
    // 日均 200 条的群安静半天就该看一眼
    assert.ok(toleranceFor(200) <= 12 * HOUR);
  });

  it("**冷清的群容忍度长**", () => {
    // 用统一阈值的话，冷清的群天天报警，然后报警就会被忽略
    assert.ok(toleranceFor(0.5) > DAY);
  });

  it("再活跃也有下限 —— 夜里没人说话是正常的", () => {
    assert.ok(toleranceFor(100_000) >= 12 * HOUR);
  });

  it("再冷清也有上限 —— 超过一周总该看一眼", () => {
    assert.ok(toleranceFor(0.001) <= 7 * DAY);
  });

  it("日均为 0 时取上限，而不是除以 0", () => {
    assert.ok(Number.isFinite(toleranceFor(0)));
    assert.equal(toleranceFor(0), 7 * DAY);
  });

  it("容忍度随活跃度单调不增", () => {
    assert.ok(toleranceFor(1) >= toleranceFor(10));
    assert.ok(toleranceFor(10) >= toleranceFor(100));
  });
});

describe("新鲜度判定", () => {
  const active = { dailyAverage: 200, sampleDays: 14 };
  const sleepy = { dailyAverage: 0.5, sampleDays: 30 };

  it("刚有消息就是正常", () => {
    const v = classifyFreshness({ ...active, lastMessageAt: NOW - HOUR }, NOW);
    assert.equal(v.level, "fresh");
  });

  it("**活跃群安静太久判为可能中断**", () => {
    const v = classifyFreshness({ ...active, lastMessageAt: NOW - 2 * DAY }, NOW);
    assert.equal(v.level, "stale");
    assert.match(v.message, /隧道/);
  });

  it("**冷清群安静太久只判为「安静」，不是中断**", () => {
    // 两者的区别是：安静需要看一眼，陈旧需要立刻查隧道。
    // 全标红的话，红色就不再意味着什么
    const v = classifyFreshness({ ...sleepy, lastMessageAt: NOW - 10 * DAY }, NOW);
    assert.equal(v.level, "quiet");
  });

  it("**从没有过消息不谎报健康**", () => {
    // 「从来没有过消息」和「同步从一开始就没通」区分不开
    const v = classifyFreshness({ ...active, lastMessageAt: null }, NOW);
    assert.equal(v.level, "unknown");
    assert.equal(v.silentMs, null);
  });

  it("**样本太少时不下陈旧的判断**", () => {
    // 新接入的群按不足的样本推算会得出很小的容忍度，
    // 刚接入就报警只会教人忽略报警
    const v = classifyFreshness(
      { dailyAverage: 200, sampleDays: 1, lastMessageAt: NOW - 2 * DAY },
      NOW,
    );
    assert.notEqual(v.level, "stale");
  });

  it("样本少但极久没消息时也会被标出来", () => {
    const v = classifyFreshness(
      { dailyAverage: 200, sampleDays: 1, lastMessageAt: NOW - 30 * DAY },
      NOW,
    );
    assert.equal(v.level, "unknown");
  });

  it("给出容忍度本身，便于界面解释判断依据", () => {
    const v = classifyFreshness({ ...active, lastMessageAt: NOW }, NOW);
    assert.ok(v.toleranceMs > 0);
  });
});

describe("同步任务健康", () => {
  const interval = 2 * 60_000;

  it("最近成功过就是正常", () => {
    const h = syncHealth(
      { total: 100, failed: 2, lastSuccessAt: NOW - 60_000, lastFailureAt: null, lastError: null },
      NOW,
      interval,
    );
    assert.equal(h.verdict, "ok");
  });

  it("**很久没成功过判为已中断**", () => {
    const h = syncHealth(
      { total: 100, failed: 0, lastSuccessAt: NOW - DAY, lastFailureAt: null, lastError: null },
      NOW,
      interval,
    );
    assert.equal(h.verdict, "down");
  });

  it("**只看失败率会漏掉「任务根本没在跑」**", () => {
    // 定时器停了的话失败率是 0，看起来完美
    const h = syncHealth(
      { total: 100, failed: 0, lastSuccessAt: NOW - DAY, lastFailureAt: null, lastError: null },
      NOW,
      interval,
    );
    assert.equal(h.failureRate, 0);
    assert.equal(h.verdict, "down", "失败率为 0 也可能是挂了");
  });

  it("失败率高判为不稳定，并带上最近的错误", () => {
    const h = syncHealth(
      {
        total: 10,
        failed: 5,
        lastSuccessAt: NOW - 60_000,
        lastFailureAt: NOW - 30_000,
        lastError: "ECONNREFUSED",
      },
      NOW,
      interval,
    );
    assert.equal(h.verdict, "degraded");
    assert.match(h.message, /ECONNREFUSED/);
  });

  it("从没跑过与跑过但从没成功要分开", () => {
    const never = syncHealth(
      { total: 0, failed: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null },
      NOW,
      interval,
    );
    assert.equal(never.verdict, "never");

    const broken = syncHealth(
      { total: 5, failed: 5, lastSuccessAt: null, lastFailureAt: NOW, lastError: "超时" },
      NOW,
      interval,
    );
    assert.equal(broken.verdict, "down");
    assert.match(broken.message, /超时/);
  });

  it("没有错误信息时不显示 undefined", () => {
    const h = syncHealth(
      { total: 5, failed: 5, lastSuccessAt: null, lastFailureAt: NOW, lastError: null },
      NOW,
      interval,
    );
    assert.ok(!h.message.includes("undefined"));
  });
});

describe("重试", () => {
  it("失败的可以重试", () => {
    assert.equal(checkRetry({ status: "failed", retryCount: 0 }).ok, true);
  });

  it("部分成功的也可以重试", () => {
    assert.equal(checkRetry({ status: "partial", retryCount: 1 }).ok, true);
  });

  it("正在跑的不能重试 —— 会抢同一个游标", () => {
    assert.equal(checkRetry({ status: "running", retryCount: 0 }).ok, false);
    assert.equal(checkRetry({ status: "pending", retryCount: 0 }).ok, false);
  });

  it("成功的不用重试", () => {
    assert.equal(checkRetry({ status: "success", retryCount: 0 }).ok, false);
  });

  it("**重试次数有上限** —— 一直重试打不通的上游只是在刷日志", () => {
    const r = checkRetry({ status: "failed", retryCount: MAX_RETRY });
    assert.equal(r.ok, false);
    assert.match(r.error!, /查清楚原因/);
  });
});

describe("手动触发", () => {
  it("没有在跑的时候可以触发", () => {
    assert.equal(checkManualTrigger(0).ok, true);
  });

  it("**已经有一个在跑就不能再触发** —— 两个进程会抢同一个游标", () => {
    assert.equal(checkManualTrigger(1).ok, false);
  });
});

describe("时长文案", () => {
  it("各量级都有合适的说法", () => {
    assert.match(formatSpan(30_000), /不到一分钟/);
    assert.match(formatSpan(5 * 60_000), /5 分钟/);
    assert.match(formatSpan(3 * HOUR), /3 小时/);
    assert.match(formatSpan(2 * DAY), /2 天/);
  });

  it("不会出现「0 分钟」这种读起来像坏了的说法", () => {
    assert.ok(!formatSpan(1000).includes("0 分钟"));
  });
});
