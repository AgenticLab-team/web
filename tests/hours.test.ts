import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MIN_MESSAGES,
  addHistograms,
  formatWindow,
  normalizeHistogram,
  summarizeHours,
} from "@/lib/members/hours";

/**
 * 「他一般什么时候说话」。
 *
 * ═════════════════════════════════════════
 * 这份测试盯的是「别算命」
 * ═════════════════════════════════════════
 *
 * 作息这种东西，人天生愿意相信。一句「夜猫子」摆在主页上，
 * 看的人不会去想它是根据几条消息算的 —— **所以说不出来的时候
 * 必须闭嘴**，而不是给一个听起来很确定的标签。
 *
 * 下面一半的条目问的都是这件事：数据不够、作息很散的时候，
 * 它会不会硬凑一句。
 */

/** 造一个直方图：`{0: 10, 1: 5}` → 0 点 10 条、1 点 5 条 */
const hist = (spec: Record<number, number>): number[] =>
  Array.from({ length: 24 }, (_, i) => spec[i] ?? 0);

/** 平摊 n 条到 24 小时 */
const flat = (per: number): number[] => Array.from({ length: 24 }, () => per);

describe("收拾直方图", () => {
  it("正常的原样通过", () => {
    assert.deepEqual(normalizeHistogram(hist({ 3: 5 })), hist({ 3: 5 }));
  });

  it("**不是数组就当没有** —— 库里那一列是 JSON，什么都可能存进去", () => {
    for (const bad of [null, undefined, "0,1,2", 42, {}]) {
      assert.equal(normalizeHistogram(bad), null, `${JSON.stringify(bad)} 被当成了直方图`);
    }
  });

  it("长度不对时补齐到 24，多的截掉", () => {
    assert.equal(normalizeHistogram([1, 2, 3])?.length, 24);
    assert.equal(normalizeHistogram(new Array(50).fill(1))?.length, 24);
  });

  it("负数、小数、脏值一律当 0", () => {
    const got = normalizeHistogram([-5, 1.7, "x", NaN, Infinity])!;
    assert.equal(got[0], 0);
    assert.equal(got[1], 1);
    assert.equal(got[2], 0);
    assert.equal(got[3], 0);
    assert.equal(got[4], 0);
  });

  it("相加", () => {
    assert.deepEqual(addHistograms(hist({ 1: 2 }), hist({ 1: 3, 5: 1 })), hist({ 1: 5, 5: 1 }));
  });
});

describe("**说不出来的时候闭嘴**", () => {
  it("消息太少 → null", () => {
    assert.equal(summarizeHours(hist({ 12: MIN_MESSAGES - 1 })), null);
  });

  it("**作息很散 → 有窗口但没有标签**", () => {
    /*
     * 三小时占全天 12.5% 是完全平均。一个各时段都说话的人
     * 没有「作息」可言 —— 硬给一句「下午最活跃」是编的，
     * 而编出来的标签看上去和真的一模一样。
     */
    const got = summarizeHours(flat(10))!;
    assert.ok(got, "整个返回了 null，那也不对 —— 条形图还是该画");
    assert.equal(got.label, null, `散着也给了标签：${got.label}`);
  });

  it("全零 → null", () => {
    assert.equal(summarizeHours(hist({})), null);
  });

  it("够集中才给标签", () => {
    const got = summarizeHours(hist({ 22: 40, 23: 40, 0: 40, 12: 10 }))!;
    assert.ok(got.label, "够集中却没给标签");
  });
});

describe("找最活跃的那三小时", () => {
  it("挑出连续三小时里加起来最多的", () => {
    const got = summarizeHours(hist({ 9: 30, 10: 40, 11: 30, 20: 20, 21: 20 }))!;
    assert.equal(got.from, 9);
    assert.equal(got.to, 11);
  });

  it("**窗口要能绕过零点**", () => {
    /*
     * 不绕的话，23:00–1:00 说话的人会被切成两半：
     * 两边各拿一半、都不突出，于是判成「作息太散」——
     * 而他恰恰是最规律的那一类。
     */
    const got = summarizeHours(hist({ 23: 50, 0: 50, 1: 50, 12: 5 }))!;
    assert.equal(got.from, 23);
    assert.equal(got.to, 1);
    assert.ok(got.label);
  });

  it("share 是这三小时占全天的比例", () => {
    const got = summarizeHours(hist({ 1: 75, 2: 0, 3: 0, 12: 25 }))!;
    assert.ok(Math.abs(got.share - 0.75) < 0.01, `share=${got.share}`);
  });

  it("总数报的是真的总数", () => {
    assert.equal(summarizeHours(hist({ 5: 60, 18: 40 }))!.total, 100);
  });
});

describe("条形高度", () => {
  it("最高的那根是 1，其余按比例", () => {
    const got = summarizeHours(hist({ 3: 100, 4: 50, 5: 0, 6: 60 }))!;
    assert.equal(got.bars[3], 1);
    assert.equal(got.bars[4], 0.5);
    assert.equal(got.bars[5], 0);
  });

  it("**24 根一根不少** —— 少一根图就和小时对不上了", () => {
    assert.equal(summarizeHours(hist({ 3: 100 }))!.bars.length, 24);
  });
});

describe("标签", () => {
  for (const [from, want] of [
    [1, "夜里最活跃"],
    [6, "早起型"],
    [10, "上午最活跃"],
    [14, "下午最活跃"],
    [19, "傍晚最活跃"],
    [22, "深夜型"],
  ] as const) {
    it(`${from} 点起 → ${want}`, () => {
      const h = hist({ [from]: 60, [(from + 1) % 24]: 60, [(from + 2) % 24]: 60 });
      assert.equal(summarizeHours(h)!.label, want);
    });
  }
});

describe("窗口怎么写", () => {
  it("21–23 写成 21:00–24:00", () => {
    // 终点用开区间的写法读起来才对：说到 24:00 而不是 23:00
    assert.equal(formatWindow(21, 23), "21:00–24:00");
  });

  it("跨零点也写得出来", () => {
    assert.equal(formatWindow(23, 1), "23:00–02:00");
  });

  it("补零", () => {
    assert.equal(formatWindow(6, 8), "06:00–09:00");
  });
});
