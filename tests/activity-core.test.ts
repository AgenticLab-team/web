import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateEligibility,
  metricLabel,
  validateRule,
  type Rule,
} from "@/lib/activities/eligibility";
import {
  activityStatusLabel,
  applicationStatusLabel,
  canTransitionActivity,
  canTransitionApplication,
  holdsQuota,
  isActivityOpen,
  quotaDelta,
} from "@/lib/activities/state";

/**
 * 活动框架的核心判定。
 *
 * 资格引擎存在的主要理由是**在开放之前就知道有几个人够格** ——
 * 60 个名额，是 500 人抢还是只有 12 个人合格，
 * 这两种情况的应对完全相反。
 */

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;

describe("资格判定", () => {
  const stats = {
    quality_messages: 87,
    messages: 340,
    level: 4,
    bound_since: "2026-06-20",
    in_group: ["20000000001@chatroom"],
  };

  it("全部满足时通过", () => {
    const rule: Rule = {
      all: [
        { metric: "quality_messages", op: ">=", value: 50 },
        { metric: "level", op: ">=", value: 3 },
      ],
    };
    assert.equal(evaluateEligibility(rule, stats).eligible, true);
  });

  it("**没通过时给出具体差距**", () => {
    // 「你 87 条，要求 200 条」比「不够格」有用得多 ——
    // 限量活动里最容易吵的就是「凭什么他能申请我不能」
    const rule: Rule = { metric: "quality_messages", op: ">=", value: 200 };
    const result = evaluateEligibility(rule, stats);

    assert.equal(result.eligible, false);
    assert.match(result.failures[0].message, /87/);
    assert.match(result.failures[0].message, /200/);
    assert.equal(result.failures[0].gap, 113);
  });

  it("**指标缺失判为不通过，而不是当成 0 或放行**", () => {
    // 当成 0 会误伤；直接放行更糟 —— 一个拼错的指标名会让所有人都够格，
    // 而这在开放前的人数预估里完全看不出来
    const rule: Rule = { metric: "forum_posts", op: ">=", value: 1 };
    const result = evaluateEligibility(rule, stats);
    assert.equal(result.eligible, false);
    assert.match(result.failures[0].message, /缺少/);
  });

  it("日期型比较", () => {
    const early: Rule = { metric: "bound_since", op: "<=", value: "2026-07-25" };
    assert.equal(evaluateEligibility(early, stats).eligible, true);

    const late: Rule = { metric: "bound_since", op: "<=", value: "2026-01-01" };
    assert.equal(evaluateEligibility(late, stats).eligible, false);
  });

  it("集合型：在指定群里", () => {
    const inGroup: Rule = { metric: "in_group", value: ["20000000001@chatroom"] };
    assert.equal(evaluateEligibility(inGroup, stats).eligible, true);

    const other: Rule = { metric: "in_group", value: ["别的群"] };
    assert.equal(evaluateEligibility(other, stats).eligible, false);
  });

  it("any：满足其一即可", () => {
    const rule: Rule = {
      any: [
        { metric: "quality_messages", op: ">=", value: 9999 },
        { metric: "level", op: ">=", value: 3 },
      ],
    };
    assert.equal(evaluateEligibility(rule, stats).eligible, true);
  });

  it("any 全都不满足时列出所有条件", () => {
    const rule: Rule = {
      any: [
        { metric: "level", op: ">=", value: 99 },
        { metric: "messages", op: ">=", value: 99_999 },
      ],
    };
    const result = evaluateEligibility(rule, stats);
    assert.equal(result.eligible, false);
    assert.match(result.failures[0].message, /任意一条/);

    /*
     * 各条路要原样带出来，不能折叠成一句长句子。
     *
     * 折叠的话，人得自己在里面找哪条最接近 ——
     * 而「哪条最接近」正是他唯一想知道的事。
     */
    const branches = result.failures[0].anyOf;
    assert.ok(branches, "没带出各条路");
    assert.equal(branches!.length, 2);
    assert.match(branches![0].message, /等级/);
    assert.match(branches![1].message, /发言/);
  });

  it("not：排除条件", () => {
    const rule: Rule = { not: { metric: "level", op: ">=", value: 10 } };
    assert.equal(evaluateEligibility(rule, stats).eligible, true);

    const excluded: Rule = { not: { metric: "level", op: ">=", value: 3 } };
    assert.equal(evaluateEligibility(excluded, stats).eligible, false);
  });

  it("嵌套组合", () => {
    const rule: Rule = {
      all: [
        { metric: "level", op: ">=", value: 3 },
        {
          any: [
            { metric: "quality_messages", op: ">=", value: 50 },
            { metric: "messages", op: ">=", value: 1000 },
          ],
        },
      ],
    };
    assert.equal(evaluateEligibility(rule, stats).eligible, true);
  });

  it("**没配规则 = 人人可参加**，这是明确语义不是遗漏", () => {
    const result = evaluateEligibility(null, stats);
    assert.equal(result.eligible, true);
    assert.match(result.outcomes[0].message, /没有资格限制/);
  });

  it("指标有中文名，未知指标原样返回", () => {
    assert.equal(metricLabel("quality_messages"), "高质量发言数");
    assert.equal(metricLabel("brand_new"), "brand_new");
  });
});

describe("规则本身的校验", () => {
  it("合法规则通过", () => {
    assert.equal(validateRule({ metric: "level", op: ">=", value: 3 }).ok, true);
    assert.equal(validateRule({ all: [{ metric: "level", value: 3 }] }).ok, true);
  });

  it("**未知指标名被拒**", () => {
    // 拼错的指标名会让所有人都判为不够格，而这在预估人数时看不出原因
    const r = validateRule({ metric: "quality_msgs", value: 3 });
    assert.equal(r.ok, false);
    assert.match(r.error!, /未知指标/);
  });

  it("**空的 all 被拒** —— 它会让所有人通过", () => {
    const r = validateRule({ all: [] });
    assert.equal(r.ok, false);
    assert.match(r.error!, /所有人通过/);
  });

  it("缺少 value 被拒", () => {
    assert.equal(validateRule({ metric: "level" }).ok, false);
  });

  it("空规则是合法的（人人可参加）", () => {
    assert.equal(validateRule(null).ok, true);
  });

  it("认不出的结构被拒", () => {
    assert.equal(validateRule({ 随便: 1 }).ok, false);
  });
});

describe("活动状态机", () => {
  it("正常路径可以走通", () => {
    const path = ["draft", "open", "closed", "reviewing", "fulfilling", "completed"] as const;
    for (let i = 0; i < path.length - 1; i++) {
      assert.equal(
        canTransitionActivity(path[i], path[i + 1]).ok,
        true,
        `${path[i]} → ${path[i + 1]} 应该允许`,
      );
    }
  });

  it("**终态不能再流转**", () => {
    assert.equal(canTransitionActivity("completed", "open").ok, false);
    assert.equal(canTransitionActivity("cancelled", "open").ok, false);
  });

  it("不能跳步", () => {
    assert.equal(canTransitionActivity("draft", "completed").ok, false);
  });

  it("任何非终态都能取消", () => {
    for (const s of ["draft", "scheduled", "open", "closed", "reviewing", "fulfilling"] as const) {
      assert.equal(canTransitionActivity(s, "cancelled").ok, true, `${s} 应该能取消`);
    }
  });

  it("状态没变时明确拒绝，而不是当成成功", () => {
    assert.equal(canTransitionActivity("open", "open").ok, false);
  });
});

describe("申请状态机", () => {
  it("正常路径", () => {
    assert.equal(canTransitionApplication("submitted", "approved").ok, true);
    assert.equal(canTransitionApplication("approved", "fulfilling").ok, true);
    assert.equal(canTransitionApplication("fulfilling", "fulfilled").ok, true);
  });

  it("**判无效之后可以改了重提**", () => {
    assert.equal(canTransitionApplication("invalid", "submitted").ok, true);
  });

  it("**履约失败之后可以重提**", () => {
    // 域名被别人抢注这种情况，用户应该能换一个再来
    assert.equal(canTransitionApplication("failed", "submitted").ok, true);
  });

  it("已完成的不能再改", () => {
    assert.equal(canTransitionApplication("fulfilled", "submitted").ok, false);
    assert.equal(canTransitionApplication("fulfilled", "failed").ok, false);
  });

  it("候补可以转正也可以被驳回", () => {
    assert.equal(canTransitionApplication("waitlisted", "approved").ok, true);
    assert.equal(canTransitionApplication("waitlisted", "rejected").ok, true);
  });
});

describe("名额占用", () => {
  it("在途和已完成的占名额", () => {
    for (const s of ["submitted", "approved", "fulfilling", "fulfilled"] as const) {
      assert.equal(holdsQuota(s), true, `${s} 应该占名额`);
    }
  });

  it("**候补不占名额** —— 占了的话候补就没有意义了", () => {
    assert.equal(holdsQuota("waitlisted"), false);
  });

  it("作废的状态不占名额", () => {
    for (const s of ["invalid", "rejected", "cancelled", "expired", "failed"] as const) {
      assert.equal(holdsQuota(s), false, `${s} 不该占名额`);
    }
  });

  it("新提交要占一个", () => {
    assert.equal(quotaDelta(null, "submitted"), 1);
  });

  it("**撤回要把名额还回来**", () => {
    assert.equal(quotaDelta("submitted", "cancelled"), -1);
  });

  it("**判无效要把名额还回来** —— 否则填错一次就白占一个名额", () => {
    assert.equal(quotaDelta("submitted", "invalid"), -1);
  });

  it("在占用状态之间流转不重复扣", () => {
    assert.equal(quotaDelta("submitted", "approved"), 0);
    assert.equal(quotaDelta("approved", "fulfilled"), 0);
  });

  it("从候补转正要占一个", () => {
    assert.equal(quotaDelta("waitlisted", "approved"), 1);
  });

  it("履约失败要把名额还回来 —— 好让候补的人能补上", () => {
    assert.equal(quotaDelta("fulfilling", "failed"), -1);
  });
});

describe("开放判定", () => {
  it("进行中且在时间窗内就是开放", () => {
    assert.equal(isActivityOpen("open", NOW - HOUR, NOW + HOUR, NOW).open, true);
  });

  it("**还没到时间时说清楚什么时候开**", () => {
    const r = isActivityOpen("open", NOW + HOUR, null, NOW);
    assert.equal(r.open, false);
    assert.match(r.reason!, /开放/);
  });

  it("过了截止时间就关闭", () => {
    assert.equal(isActivityOpen("open", null, NOW - 1, NOW).open, false);
  });

  it("草稿和已排期都不开放", () => {
    assert.equal(isActivityOpen("draft", null, null, NOW).open, false);
    assert.equal(isActivityOpen("scheduled", NOW + HOUR, null, NOW).open, false);
  });

  it("取消的活动明说是取消，不是「已结束」", () => {
    const r = isActivityOpen("cancelled", null, null, NOW);
    assert.match(r.reason!, /取消/);
  });

  it("没有时间限制时只看状态", () => {
    assert.equal(isActivityOpen("open", null, null, NOW).open, true);
  });
});

describe("状态文案", () => {
  it("活动状态都有中文名", () => {
    for (const s of ["draft", "open", "closed", "completed", "cancelled"]) {
      assert.notEqual(activityStatusLabel(s), s);
    }
  });

  it("申请状态都有中文名", () => {
    for (const s of ["submitted", "waitlisted", "approved", "fulfilled", "failed"]) {
      assert.notEqual(applicationStatusLabel(s), s);
    }
  });

  it("未知状态原样返回", () => {
    assert.equal(activityStatusLabel("weird"), "weird");
  });
});
