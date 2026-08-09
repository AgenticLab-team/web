import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_ESCALATION,
  checkApprove,
  checkReject,
  checkRequest,
  checkWithdraw,
  consentProgress,
  statusLabel,
} from "@/lib/moderation/escalation-rules";

/**
 * 可见性提升。
 *
 * 这条队列是「群聊转帖锁定在原群」这条硬约束的**唯一出口**，
 * 所以它自己必须是最严的一段流程。通过之后内容立刻扩散，
 * 而扩散不可逆 —— 事后撤回撤不掉别人已经看到的东西。
 */

describe("提交申请", () => {
  const base = {
    fromVisibility: "group" as const,
    toVisibility: "member" as const,
    fromGroupChat: true,
    reason: "这段讨论对所有人都有价值",
    hasPending: false,
  };

  it("群聊转帖提升到「仅成员」是允许的", () => {
    assert.equal(checkRequest(base).ok, true);
  });

  it("必须说明理由 —— 审核的人要靠它判断", () => {
    assert.equal(checkRequest({ ...base, reason: "  " }).ok, false);
  });

  it("**群聊内容永远升不到公开**", () => {
    // 群里说的话不该出现在搜索引擎里 ——
    // 那不是「更多人能看到」，是「所有人永远都能搜到」
    const r = checkRequest({ ...base, toVisibility: "public" });
    assert.equal(r.ok, false);
    assert.match(r.error!, /永远不会公开/);
  });

  it("**unlisted 同样不行** —— 它只是不索引，链接照样人人可开", () => {
    assert.equal(checkRequest({ ...base, toVisibility: "unlisted" }).ok, false);
  });

  it("非群聊内容不受这条限制", () => {
    assert.equal(
      checkRequest({
        ...base,
        fromGroupChat: false,
        fromVisibility: "member",
        toVisibility: "public",
      }).ok,
      true,
    );
  });

  it("**收紧可见性不需要走队列**", () => {
    // 混进来只会让队列里出现无需审核的东西
    const r = checkRequest({
      ...base,
      fromVisibility: "member",
      toVisibility: "private",
    });
    assert.equal(r.ok, false);
    assert.match(r.error!, /不需要审核/);
  });

  it("目标和当前一样时拒绝", () => {
    assert.equal(checkRequest({ ...base, toVisibility: "group" }).ok, false);
  });

  it("同一篇帖子不能有两条待处理的申请", () => {
    assert.equal(checkRequest({ ...base, hasPending: true }).ok, false);
  });

  it("提升上限就是「仅成员」", () => {
    assert.equal(MAX_ESCALATION, "member");
  });
});

describe("批准", () => {
  const base = {
    actorId: "u_mod",
    requestedBy: "u_requester",
    postAuthorId: "u_author",
    status: "pending",
    consentRequired: 3,
    consentGranted: 3,
    note: "内容确实有价值，原作者都同意了",
  };

  it("条件齐全时可以批准", () => {
    assert.equal(checkApprove(base).ok, true);
  });

  it("必须写明理由", () => {
    assert.equal(checkApprove({ ...base, note: " " }).ok, false);
  });

  it("**自己批自己提交的申请也放行**（2026-08 站长指令）", () => {
    assert.equal(checkApprove({ ...base, actorId: "u_requester" }).ok, true);
  });

  it("自己帖子的提升申请也能批 —— 同上，去掉的是「换个人」这道", () => {
    assert.equal(checkApprove({ ...base, actorId: "u_author" }).ok, true);
  });

  it("**原作者同意没凑齐就不能批**", () => {
    // 「先批了再去要同意」在流程上说得通，但内容已经扩散出去了，
    // 而扩散不可逆
    const r = checkApprove({ ...base, consentGranted: 1 });
    assert.equal(r.ok, false);
    assert.match(r.error!, /还差 2 位/);
  });

  it("**自批放行了，但同意这条一寸没松** —— 它保护的是群里说话的人", () => {
    /*
     * 放松「不能自批」时最容易顺手把这条也带走：
     * 同一个函数、相邻的几行。这条测试就是防那次「顺手」。
     */
    const r = checkApprove({ ...base, actorId: "u_requester", consentGranted: 0 });
    assert.equal(r.ok, false);
    assert.match(r.error!, /原作者同意/);
  });

  it("不需要任何同意时（没有原作者信息）可以直接批", () => {
    assert.equal(checkApprove({ ...base, consentRequired: 0, consentGranted: 0 }).ok, true);
  });

  it("已处理过的不能再批一次", () => {
    assert.equal(checkApprove({ ...base, status: "approved" }).ok, false);
    assert.equal(checkApprove({ ...base, status: "rejected" }).ok, false);
    assert.equal(checkApprove({ ...base, status: "withdrawn" }).ok, false);
  });
});

describe("驳回", () => {
  const base = {
    actorId: "u_mod",
    requestedBy: "u_requester",
    status: "pending",
    note: "这段对话涉及个人隐私",
  };

  it("正常驳回通过", () => {
    assert.equal(checkReject(base).ok, true);
  });

  it("**驳回不要求同意齐全**", () => {
    // 驳回是让内容维持现状，没有任何扩散风险 ——
    // 卡着不让驳回只会让队列越积越长
    assert.equal(checkReject(base).ok, true);
  });

  it("必须写明理由 —— 石沉大海的申请会让人下次直接绕过流程", () => {
    assert.equal(checkReject({ ...base, note: "" }).ok, false);
  });

  it("自己驳回自己提交的申请也放行 —— 和撤回殊途同归", () => {
    assert.equal(checkReject({ ...base, actorId: "u_requester" }).ok, true);
  });
});

describe("撤回", () => {
  const base = { actorId: "u_requester", requestedBy: "u_requester", status: "pending" };

  it("申请人自己可以撤回", () => {
    assert.equal(checkWithdraw(base).ok, true);
  });

  it("**别人不能替他撤回** —— 那等于替他放弃", () => {
    assert.equal(checkWithdraw({ ...base, actorId: "u_mod" }).ok, false);
  });

  it("已处理的撤不了", () => {
    assert.equal(checkWithdraw({ ...base, status: "approved" }).ok, false);
  });
});

describe("同意进度", () => {
  it("正常计算", () => {
    const p = consentProgress(4, 2);
    assert.equal(p.ratio, 0.5);
    assert.equal(p.missing, 2);
    assert.equal(p.complete, false);
  });

  it("齐全时标记完成", () => {
    assert.equal(consentProgress(3, 3).complete, true);
  });

  it("**不需要同意时算作已完成，而不是 NaN**", () => {
    const p = consentProgress(0, 0);
    assert.equal(p.ratio, 1);
    assert.equal(p.complete, true);
    assert.ok(Number.isFinite(p.ratio));
  });

  it("同意数超过需求数时不会算出大于 1 的比例", () => {
    // 数据不一致时进度条不该溢出容器
    const p = consentProgress(2, 5);
    assert.equal(p.ratio, 1);
    assert.equal(p.missing, 0);
  });

  it("负数不会算出负进度", () => {
    const p = consentProgress(-1, -5);
    assert.ok(p.ratio >= 0 && p.ratio <= 1);
    assert.ok(p.missing >= 0);
  });
});

describe("状态文案", () => {
  it("四种状态都有中文名", () => {
    for (const s of ["pending", "approved", "rejected", "withdrawn"]) {
      assert.notEqual(statusLabel(s), s, `${s} 没有中文名`);
    }
  });

  it("未知状态原样返回", () => {
    assert.equal(statusLabel("weird"), "weird");
  });
});
