import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkApprove,
  checkReject,
  checkRequest,
  checkWithdraw,
  isExpired,
  statusLabel,
} from "@/lib/admin/approval-rules";

/**
 * 危险操作留痕（原双人复核）。
 *
 * 2026-08 站长指令：管理员操作不再被「必须换一个人」挡住，
 * 自己批自己放行。这组测试盯住的是**改完之后还剩什么**：
 *   - 松掉的只有那一条 —— 自批要能通过
 *   - 注册表和过期这两道安全边界一步没松 —— 它们防的不是人，
 *     是任意代码执行入口和「批一条旧记录」
 */

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;

describe("发起", () => {
  const base = { reason: "需要把每日上限调低，最近发行过快", known: true, payloadValid: true };

  it("正常发起通过", () => {
    assert.equal(checkRequest(base).ok, true);
  });

  it("必须写理由", () => {
    assert.equal(checkRequest({ ...base, reason: "  " }).ok, false);
  });

  it("**理由太短不算理由** —— 复核的人要靠它判断", () => {
    assert.equal(checkRequest({ ...base, reason: "改一下" }).ok, false);
  });

  it("**没登记的动作直接拒绝受理**", () => {
    // 允许任意动作等于在数据库里开一个延迟执行的远程调用入口
    const r = checkRequest({ ...base, known: false });
    assert.equal(r.ok, false);
    assert.match(r.error!, /没有登记/);
  });

  it("参数不合法时带出具体原因，而不是笼统地说失败", () => {
    const r = checkRequest({ ...base, payloadValid: false, payloadError: "未知配置项 foo" });
    assert.equal(r.ok, false);
    assert.match(r.error!, /未知配置项/);
  });
});

describe("批准", () => {
  const base = {
    actorId: "u_approver",
    requestedBy: "u_requester",
    status: "pending",
    expiresAt: NOW + HOUR,
    now: NOW,
    note: "确认过数据，同意",
  };

  it("另一个人批准通过", () => {
    assert.equal(checkApprove(base).ok, true);
  });

  it("**自己批自己也放行**（站长指令）—— 留痕不是闸门", () => {
    assert.equal(checkApprove({ ...base, actorId: "u_requester" }).ok, true);
  });

  it("必须写批准意见 —— 松掉的是「换个人」，不是「说清楚」", () => {
    assert.equal(checkApprove({ ...base, note: "" }).ok, false);
  });

  it("**过期的不能再执行** —— 这条不随复核一起松：payload 是旧的", () => {
    const r = checkApprove({ ...base, expiresAt: NOW - 1 });
    assert.equal(r.ok, false);
    assert.match(r.error!, /过期/);
  });

  it("**自批也过不了过期这道** —— 两条规则是独立的，别在放松时一起带走", () => {
    const r = checkApprove({ ...base, actorId: "u_requester", expiresAt: NOW - 1 });
    assert.equal(r.ok, false);
  });

  it("没设有效期的不会被误判为过期", () => {
    assert.equal(checkApprove({ ...base, expiresAt: null }).ok, true);
  });

  it("已处理过的不能再批", () => {
    for (const status of ["approved", "rejected", "executed", "failed", "expired"]) {
      assert.equal(checkApprove({ ...base, status }).ok, false, `${status} 不该还能批`);
    }
  });
});

describe("驳回", () => {
  const base = {
    actorId: "u_approver",
    requestedBy: "u_requester",
    status: "pending",
    expiresAt: NOW - HOUR,
    now: NOW,
    note: "现在不适合改",
  };

  it("**驳回不受有效期限制** —— 驳回是让事情不发生，没有风险", () => {
    assert.equal(checkReject(base).ok, true);
  });

  it("驳回也要写原因", () => {
    assert.equal(checkReject({ ...base, note: "" }).ok, false);
  });

  it("自己驳回自己提出的也放行 —— 和撤回殊途同归，没理由拦", () => {
    assert.equal(checkReject({ ...base, actorId: "u_requester" }).ok, true);
  });
});

describe("撤回", () => {
  it("发起人自己可以撤回", () => {
    assert.equal(
      checkWithdraw({ actorId: "u_a", requestedBy: "u_a", status: "pending" }).ok,
      true,
    );
  });

  it("别人不能替他撤回", () => {
    assert.equal(
      checkWithdraw({ actorId: "u_b", requestedBy: "u_a", status: "pending" }).ok,
      false,
    );
  });

  it("已处理的撤不了", () => {
    assert.equal(
      checkWithdraw({ actorId: "u_a", requestedBy: "u_a", status: "executed" }).ok,
      false,
    );
  });
});

describe("过期判定", () => {
  it("到点就算过期", () => {
    assert.equal(isExpired(NOW, NOW), true);
    assert.equal(isExpired(NOW + 1, NOW), false);
  });

  it("没有有效期就永不过期", () => {
    assert.equal(isExpired(null, NOW), false);
  });
});

describe("状态文案", () => {
  it("每个状态都有中文名", () => {
    for (const s of ["pending", "approved", "rejected", "expired", "executed", "failed"]) {
      assert.notEqual(statusLabel(s), s, `${s} 没有中文名`);
    }
  });

  it("未知状态原样返回", () => {
    assert.equal(statusLabel("weird"), "weird");
  });
});
