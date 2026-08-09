import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  MIN_QUALITY_FOR_TITLE,
  SEASON_TITLE_KEYS,
  dateRangeOf,
  daysLeft,
  isActive,
  planAwards,
  quarterSeasons,
  rankLabel,
  rankStandings,
  seasonAt,
  seasonTitleExpiry,
  statusOf,
  titleKeyForRank,
} from "@/lib/seasons/rules";

/**
 * 赛季规则。
 *
 * 最要紧的一条不在这个文件里能测出来，但要一直记着：
 * **赛季只重置排名，绝不碰余额**。这里的每个函数都不接触积分 ——
 * 那本身就是设计的一部分。
 */

const DAY = 86_400_000;
const Q3 = quarterSeasons(2026)[2]; // 2026Q3：7/1 ~ 10/1（东八区）

describe("赛季区间", () => {
  it("一年四个季度，首尾相接不留缝", () => {
    const list = quarterSeasons(2026);
    assert.equal(list.length, 4);
    for (let i = 1; i < list.length; i++) {
      assert.equal(list[i].startsAt, list[i - 1].endsAt, "两个赛季之间有缝，那几天不属于任何赛季");
    }
  });

  it("**边界按东八区** —— 和签到、日统计用同一个日界", () => {
    // 东八区 2026-07-01 00:00 = UTC 2026-06-30 16:00
    assert.equal(Q3.startsAt, Date.UTC(2026, 5, 30, 16));
    assert.equal(Q3.endsAt, Date.UTC(2026, 8, 30, 16));
  });

  it("key 与名字都认得出是哪个赛季", () => {
    assert.equal(Q3.key, "2026Q3");
    assert.match(Q3.name, /2026/);
    assert.match(Q3.name, /秋季赛/);
  });

  it("结束那一刻属于下个赛季 —— 开区间省得纠结「最后一天算不算」", () => {
    assert.equal(isActive(Q3, Q3.endsAt - 1), true);
    assert.equal(isActive(Q3, Q3.endsAt), false);
    assert.equal(isActive(Q3, Q3.startsAt), true);
    assert.equal(isActive(Q3, Q3.startsAt - 1), false);
  });

  it("状态三态分得清", () => {
    assert.equal(statusOf(Q3, Q3.startsAt - DAY), "upcoming");
    assert.equal(statusOf(Q3, Q3.startsAt + DAY), "active");
    assert.equal(statusOf(Q3, Q3.endsAt + DAY), "ended");
  });

  it("**倒计时** —— 赛季只有在「还剩几天」被看见时才起作用", () => {
    assert.equal(daysLeft(Q3, Q3.endsAt - 3 * DAY), 3);
    assert.equal(daysLeft(Q3, Q3.endsAt - 1), 1, "最后一天不该显示 0 天");
    assert.equal(daysLeft(Q3, Q3.endsAt), 0);
    assert.equal(daysLeft(Q3, Q3.endsAt + DAY), 0);
  });

  it("日期范围换成 daily_stats 用的 YYYY-MM-DD，且结束日不越界", () => {
    const { from, to } = dateRangeOf(Q3);
    assert.equal(from, "2026-07-01");
    assert.equal(to, "2026-09-30", "把 10-01 也算进来了 —— 那天属于下个赛季");
  });

  it("找得到某个时刻属于哪个赛季", () => {
    const list = quarterSeasons(2026);
    assert.equal(seasonAt(list, Date.UTC(2026, 7, 15))?.key, "2026Q3");
    assert.equal(seasonAt(list, Date.UTC(2027, 0, 15)), null);
  });
});

describe("排名", () => {
  const rows = [
    { wxId: "a", quality: 10, messages: 100, chars: 1 },
    { wxId: "b", quality: 30, messages: 50, chars: 1 },
    { wxId: "c", quality: 30, messages: 50, chars: 1 },
    { wxId: "d", quality: 20, messages: 10, chars: 1 },
  ];

  it("按高质量消息排，不看总条数", () => {
    const ranked = rankStandings(rows);
    assert.equal(ranked[0].quality, 30);
    assert.equal(ranked[ranked.length - 1].wxId, "a", "总条数最多的排到了前面");
  });

  it("**并列之后跳号**（1,1,3）—— 不跳号的话第三个人会被叫成第二名", () => {
    const ranked = rankStandings(rows);
    assert.deepEqual(ranked.map((r) => r.rank), [1, 1, 3, 4]);
  });

  it("排序稳定 —— 同分同条数时按 wxId，不会每次刷新换位置", () => {
    const a = rankStandings(rows).map((r) => r.wxId);
    const b = rankStandings([...rows].reverse()).map((r) => r.wxId);
    assert.deepEqual(a, b);
  });

  it("空榜不炸", () => {
    assert.deepEqual(rankStandings([]), []);
  });
});

describe("称号只发前三", () => {
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      wxId: `u${i}`,
      quality: 100 - i,
      messages: 10,
      chars: 1,
    }));

  it("**只发前三** —— 发到前二十就变成参与奖", () => {
    const plan = planAwards(rankStandings(make(20)));
    assert.equal(plan.awards.length, 3);
    assert.deepEqual(plan.awards.map((a) => a.rank), [1, 2, 3]);
    assert.deepEqual(Object.keys(SEASON_TITLE_KEYS), ["1", "2", "3"]);
  });

  it("名次对得上称号", () => {
    assert.equal(titleKeyForRank(1), "season_champion");
    assert.equal(titleKeyForRank(2), "season_runner_up");
    assert.equal(titleKeyForRank(3), "season_third");
    assert.equal(titleKeyForRank(4), null);
  });

  it("**这个赛季没人参与就不发** —— 那时候发称号只会让称号贬值", () => {
    const quiet = rankStandings([
      { wxId: "a", quality: 2, messages: 5, chars: 1 },
      { wxId: "b", quality: 1, messages: 3, chars: 1 },
    ]);
    const plan = planAwards(quiet);
    assert.equal(plan.awards.length, 0);
    assert.equal(plan.ok, true, "不发称号不等于结算失败");
    assert.match(plan.reason, new RegExp(String(MIN_QUALITY_FOR_TITLE)));
  });

  it("够格的发、不够格的不发 —— 同一个赛季里可以只发前两名", () => {
    const mixed = rankStandings([
      { wxId: "a", quality: 50, messages: 10, chars: 1 },
      { wxId: "b", quality: 20, messages: 10, chars: 1 },
      { wxId: "c", quality: 3, messages: 10, chars: 1 },
    ]);
    const plan = planAwards(mixed);
    assert.deepEqual(plan.awards.map((a) => a.wxId), ["a", "b"]);
  });

  it("一个人都没有时说清楚", () => {
    const plan = planAwards([]);
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /没有任何人上榜/);
  });

  it("并列第一时两个人都拿冠军", () => {
    const tied = rankStandings([
      { wxId: "a", quality: 50, messages: 10, chars: 1 },
      { wxId: "b", quality: 50, messages: 10, chars: 1 },
      { wxId: "c", quality: 30, messages: 10, chars: 1 },
    ]);
    const plan = planAwards(tied);
    assert.deepEqual(plan.awards.map((a) => a.rank), [1, 1, 3]);
    assert.equal(plan.awards.filter((a) => a.titleKey === "season_champion").length, 2);
  });
});

describe("赛季称号的有效期", () => {
  it("**挂到下个赛季结束** —— 一直挂着的话三年后每个人后面都跟着一串", () => {
    const expiry = seasonTitleExpiry(Q3);
    assert.equal(expiry, Q3.endsAt + (Q3.endsAt - Q3.startsAt));
    assert.ok(expiry > Q3.endsAt);
  });

  it("到期在下一个赛季结束前后 —— 不是一个月也不是一年", () => {
    const span = seasonTitleExpiry(Q3) - Q3.endsAt;
    assert.ok(span > 80 * DAY && span < 100 * DAY, `${span / DAY} 天`);
  });
});

describe("名次的说法", () => {
  it("前三有专门的叫法", () => {
    assert.equal(rankLabel(1), "冠军");
    assert.equal(rankLabel(2), "亚军");
    assert.equal(rankLabel(3), "季军");
  });

  it("其余按第 N 名", () => {
    assert.equal(rankLabel(7), "第 7 名");
  });
});

describe("**这些规则一个字都不碰积分**", () => {
  it("导出的函数签名里没有任何余额相关的东西", () => {
    /*
     * 这条断言看起来很怪，但它锁的是整个赛季设计的前提：
     * 清一次积分就等于告诉所有人「你攒的东西随时可能没有」，
     * 而那之后没有人会再把它当回事。
     *
     * 用源码检查而不是靠记性 —— 将来有人想「顺手」在结算里
     * 清一下分的时候，这一条会红。
     */
    const source = readFileSync(new URL("../src/lib/seasons/rules.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

    for (const forbidden of ["pointsLedger", "grantPoints", "\\bbalance\\b"]) {
      assert.doesNotMatch(
        code,
        new RegExp(forbidden),
        `赛季规则里出现了 ${forbidden} —— 赛季只重置排名，绝不碰余额`,
      );
    }
  });

  it("结算模块也不碰余额", () => {
    const source = readFileSync(new URL("../src/lib/seasons/settle.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

    for (const forbidden of ["grantPoints", "pointsLedger", "revertPoints"]) {
      assert.equal(
        code.includes(forbidden),
        false,
        `赛季结算里出现了 ${forbidden} —— 清一次积分，之后没有人会再把它当回事`,
      );
    }
  });
});
