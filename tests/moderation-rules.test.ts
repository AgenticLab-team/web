import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkAssign,
  checkHandleAppeal,
  checkHandleReport,
  compareQueue,
  escalatedSeverity,
  isOverdue,
  reasonLabel,
  severityForReason,
  severityLabel,
  slaDeadline,
} from "@/lib/moderation/rules";

/**
 * 审核队列的判定规则。
 *
 * 这里最要紧的三条都不是功能，是制度：
 * 不能处理自己举报的、不能处理针对自己的举报、
 * **不能复核自己下的处罚**。缺了最后一条，申诉入口就是个摆设。
 */

describe("严重度", () => {
  it("涉法涉黄进紧急队列", () => {
    assert.equal(severityForReason("illegal"), 2);
    assert.equal(severityForReason("porn"), 2);
  });

  it("侵犯隐私次之 —— 扩散出去就撤不回来了", () => {
    assert.equal(severityForReason("privacy"), 1);
  });

  it("其余按普通处理", () => {
    assert.equal(severityForReason("spam"), 0);
    assert.equal(severityForReason("abuse"), 0);
    assert.equal(severityForReason("offtopic"), 0);
    assert.equal(severityForReason("other"), 0);
  });
});

describe("多人举报升级", () => {
  it("**三个不同的人举报同一目标就升一级**", () => {
    // 一个人可能看错，三个人各自独立举报，基本不会同时看错
    assert.equal(escalatedSeverity(0, 3), 1);
    assert.equal(escalatedSeverity(1, 5), 2);
  });

  it("两个人还不够", () => {
    assert.equal(escalatedSeverity(0, 2), 0);
  });

  it("**已经是最高级就不再叠加**", () => {
    assert.equal(escalatedSeverity(2, 10), 2);
  });

  it("只有一个举报人时不变", () => {
    assert.equal(escalatedSeverity(0, 1), 0);
  });
});

describe("队列排序", () => {
  const item = (severity: number, createdAt: number, reportCount = 1) => ({
    severity,
    createdAt,
    reportCount,
  });

  it("严重度高的排前面", () => {
    assert.ok(compareQueue(item(2, 1000), item(0, 100)) < 0);
  });

  it("**同严重度先来先处理**", () => {
    // 按最新排的话老举报永远沉底，而举报三天没人管的人最可能直接放弃这个站
    assert.ok(compareQueue(item(0, 100), item(0, 1000)) < 0);
  });

  it("同严重度下举报人多的优先", () => {
    assert.ok(compareQueue(item(0, 1000, 5), item(0, 100, 1)) < 0);
  });

  it("排序结果稳定可复现", () => {
    const list = [item(0, 500), item(2, 900), item(0, 100), item(1, 800)];
    const sorted = [...list].sort(compareQueue).map((i) => [i.severity, i.createdAt]);
    assert.deepEqual(sorted, [
      [2, 900],
      [1, 800],
      [0, 100],
      [0, 500],
    ]);
  });
});

describe("处理时限", () => {
  const T0 = 1_700_000_000_000;

  it("越严重时限越短", () => {
    assert.ok(slaDeadline(T0, 2) < slaDeadline(T0, 1));
    assert.ok(slaDeadline(T0, 1) < slaDeadline(T0, 0));
  });

  it("紧急件两小时内要处理", () => {
    assert.equal(isOverdue(T0, 2, T0 + 3600_000), false);
    assert.equal(isOverdue(T0, 2, T0 + 3 * 3600_000), true);
  });

  it("普通件不会刚提交就算超时", () => {
    assert.equal(isOverdue(T0, 0, T0 + 3600_000), false);
  });

  it("未知严重度按普通件算，不会当成永不超时", () => {
    assert.equal(isOverdue(T0, 99, T0 + 100 * 3600_000), true);
  });
});

describe("处理举报的利益冲突", () => {
  const base = {
    actorId: "u_mod",
    reporterIds: ["u_reporter"],
    targetUserId: "u_bad",
    status: "open",
    resolution: "已删除并警告",
  };

  it("正常处理通过", () => {
    assert.equal(checkHandleReport(base).ok, true);
  });

  it("**必须写清楚怎么处理的**", () => {
    assert.equal(checkHandleReport({ ...base, resolution: "  " }).ok, false);
  });

  it("**不能处理自己提交的举报**", () => {
    const r = checkHandleReport({ ...base, actorId: "u_reporter" });
    assert.equal(r.ok, false);
    assert.match(r.error!, /自己提交/);
  });

  it("自己混在一群举报人里也不行", () => {
    assert.equal(
      checkHandleReport({ ...base, reporterIds: ["u_a", "u_mod", "u_b"] }).ok,
      false,
    );
  });

  it("**不能处理针对自己的举报**", () => {
    const r = checkHandleReport({ ...base, targetUserId: "u_mod" });
    assert.equal(r.ok, false);
    assert.match(r.error!, /你自己/);
  });

  it("被举报人未知时不误拦", () => {
    assert.equal(checkHandleReport({ ...base, targetUserId: null }).ok, true);
  });

  it("已经处理过的不能再处理一次", () => {
    assert.equal(checkHandleReport({ ...base, status: "resolved" }).ok, false);
    assert.equal(checkHandleReport({ ...base, status: "rejected" }).ok, false);
  });

  it("已认领（reviewing）的可以继续处理", () => {
    assert.equal(checkHandleReport({ ...base, status: "reviewing" }).ok, true);
  });
});

describe("处理申诉的利益冲突", () => {
  const base = {
    actorId: "u_other_mod",
    punisherId: "u_mod",
    appealantId: "u_user",
    status: "open",
    response: "复核后维持原判，理由如下……",
  };

  it("由别的管理员复核通过", () => {
    assert.equal(checkHandleAppeal(base).ok, true);
  });

  it("**不能复核自己下的处罚**", () => {
    // 由原处罚人来判，等于让他给自己的判断打分，
    // 那这个入口只是让人多绕一圈再绝望一次
    const r = checkHandleAppeal({ ...base, actorId: "u_mod" });
    assert.equal(r.ok, false);
    assert.match(r.error!, /自己下的处罚/);
  });

  it("不能处理自己的申诉", () => {
    assert.equal(checkHandleAppeal({ ...base, actorId: "u_user" }).ok, false);
  });

  it("**必须给出答复，不能只点通过或驳回**", () => {
    assert.equal(checkHandleAppeal({ ...base, response: "" }).ok, false);
    assert.equal(checkHandleAppeal({ ...base, response: "   " }).ok, false);
  });

  it("已处理的申诉不能再判一次", () => {
    assert.equal(checkHandleAppeal({ ...base, status: "accepted" }).ok, false);
    assert.equal(checkHandleAppeal({ ...base, status: "rejected" }).ok, false);
  });
});

describe("认领", () => {
  it("待处理和处理中都能认领", () => {
    assert.equal(checkAssign("open").ok, true);
    assert.equal(checkAssign("reviewing").ok, true);
  });

  it("已结案的不能再认领", () => {
    assert.equal(checkAssign("resolved").ok, false);
    assert.equal(checkAssign("duplicate").ok, false);
  });
});

describe("展示用文案", () => {
  it("举报理由有中文名", () => {
    assert.equal(reasonLabel("porn"), "色情内容");
    assert.equal(reasonLabel("offtopic"), "跑题灌水");
  });

  it("严重度有中文名", () => {
    assert.equal(severityLabel(2), "紧急");
    assert.equal(severityLabel(0), "普通");
  });

  it("未知值原样返回，不显示 undefined", () => {
    assert.equal(reasonLabel("brand_new"), "brand_new");
    assert.equal(severityLabel(7), "7");
  });
});
