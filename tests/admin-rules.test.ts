import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkNote,
  checkPointsAdjust,
  checkReason,
  checkRoleGrant,
  checkRoleRevoke,
  checkStatusChange,
  isElevatedRole,
  isNoopStatusChange,
  shouldRevokeSessions,
} from "@/lib/admin/rules";

/**
 * 管理员写操作的护栏测试。
 *
 * 这里测的每一条都是「做错了没法自己救回来」的操作：
 * 把自己封掉、把最后一个站长撤掉、一次发出几万分。
 * 权限校验挡的是「谁能做」，这些护栏挡的是「做了会锁死自己」。
 */

describe("理由", () => {
  it("空理由不行", () => {
    assert.equal(checkReason("").ok, false);
  });

  it("**只有空白的理由也不行**", () => {
    // 不然「填了理由」这件事一个空格就能糊弄过去
    const r = checkReason("   \n\t ");
    assert.equal(r.ok, false);
    assert.equal(r.error, "必须填写理由");
  });

  it("正常理由通过", () => {
    assert.equal(checkReason("刷屏，暂停三天").ok, true);
  });
});

describe("积分调整", () => {
  const base = { threshold: 500, hasLargePermission: false };

  it("常规加分通过", () => {
    assert.equal(checkPointsAdjust({ ...base, delta: 50, reason: "活动奖励" }).ok, true);
  });

  it("扣分也通过", () => {
    assert.equal(checkPointsAdjust({ ...base, delta: -50, reason: "违规扣分" }).ok, true);
  });

  it("必须填理由", () => {
    assert.equal(checkPointsAdjust({ ...base, delta: 50, reason: " " }).ok, false);
  });

  it("**变动值不能是 0**", () => {
    // 0 分调整只会在流水里留一条什么都没发生的记录
    assert.equal(checkPointsAdjust({ ...base, delta: 0, reason: "手滑" }).ok, false);
  });

  it("**变动值不能是小数**", () => {
    // 积分是整数账本，一旦出现 0.5 分，余额对账就再也对不平
    assert.equal(checkPointsAdjust({ ...base, delta: 1.5, reason: "四舍五入" }).ok, false);
  });

  it("变动值不能是 NaN", () => {
    assert.equal(checkPointsAdjust({ ...base, delta: Number.NaN, reason: "解析失败" }).ok, false);
  });

  it("**大额调整没有额外权限就挡下来**", () => {
    const r = checkPointsAdjust({ ...base, delta: 5000, reason: "补发" });
    assert.equal(r.ok, false);
    assert.match(r.error!, /500/, "错误信息里要写清楚门槛是多少");
  });

  it("大额扣分同样受限", () => {
    assert.equal(checkPointsAdjust({ ...base, delta: -5000, reason: "回收" }).ok, false);
  });

  it("刚好等于门槛就算大额", () => {
    assert.equal(checkPointsAdjust({ ...base, delta: 500, reason: "补发" }).ok, false);
    assert.equal(checkPointsAdjust({ ...base, delta: 499, reason: "补发" }).ok, true);
  });

  it("有大额权限就放行", () => {
    assert.equal(
      checkPointsAdjust({ ...base, hasLargePermission: true, delta: 5000, reason: "补发" }).ok,
      true,
    );
  });
});

describe("状态变更", () => {
  const base = { actorId: "u_admin", targetId: "u_target", reason: "刷屏" };

  it("封别人可以", () => {
    assert.equal(checkStatusChange(base).ok, true);
  });

  it("**不能改自己的状态**", () => {
    // 把自己锁在门外之后没人能救，只能进服务器改数据库
    const r = checkStatusChange({ ...base, targetId: "u_admin" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "不能改自己的状态");
  });

  it("必须填理由", () => {
    assert.equal(checkStatusChange({ ...base, reason: "" }).ok, false);
  });

  it("状态没变就是空操作", () => {
    assert.equal(isNoopStatusChange("active", "active"), true);
    assert.equal(isNoopStatusChange("active", "banned"), false);
  });

  it("**封禁和停用都要立即踢下线**", () => {
    assert.equal(shouldRevokeSessions("banned"), true);
    assert.equal(shouldRevokeSessions("suspended"), true, "停用期间也不该还能继续用旧会话");
    assert.equal(shouldRevokeSessions("active"), false, "解封不该顺手把人踢下线");
  });
});

describe("身份组授予", () => {
  const base = { reason: "接手版务", hasAdminGrantPermission: false, alreadyHeld: false };

  it("授予普通身份组通过", () => {
    assert.equal(checkRoleGrant({ ...base, roleKey: "moderator" }).ok, true);
  });

  it("必须填理由", () => {
    assert.equal(checkRoleGrant({ ...base, roleKey: "moderator", reason: "" }).ok, false);
  });

  it("**没有 role.grant.admin 就不能授予 admin**", () => {
    // 否则版主可以把自己提成站长，权限分级形同虚设
    assert.equal(checkRoleGrant({ ...base, roleKey: "admin" }).ok, false);
  });

  it("**没有 role.grant.admin 就不能授予 owner**", () => {
    assert.equal(checkRoleGrant({ ...base, roleKey: "owner" }).ok, false);
  });

  it("有权限就能授予管理员", () => {
    assert.equal(
      checkRoleGrant({ ...base, roleKey: "admin", hasAdminGrantPermission: true }).ok,
      true,
    );
  });

  it("重复授予会被挡下", () => {
    const r = checkRoleGrant({ ...base, roleKey: "moderator", alreadyHeld: true });
    assert.equal(r.ok, false);
    assert.match(r.error!, /已经有/);
  });

  it("提权检查先于重复检查 —— 不能靠重复授予探测身份组", () => {
    assert.equal(
      checkRoleGrant({ ...base, roleKey: "owner", alreadyHeld: true }).error,
      "你没有授予管理员的权限",
    );
  });
});

describe("身份组撤销", () => {
  const base = { reason: "卸任", hasAdminGrantPermission: true, currentHolders: 3 };

  it("撤销普通身份组通过", () => {
    assert.equal(checkRoleRevoke({ ...base, roleKey: "moderator" }).ok, true);
  });

  it("必须填理由", () => {
    assert.equal(checkRoleRevoke({ ...base, roleKey: "moderator", reason: " " }).ok, false);
  });

  it("没有权限不能撤销管理员", () => {
    assert.equal(
      checkRoleRevoke({ ...base, roleKey: "admin", hasAdminGrantPermission: false }).ok,
      false,
    );
  });

  it("**不能移除最后一个站长**", () => {
    // 移除之后系统里再没有人能授予管理员，只能改数据库救
    const r = checkRoleRevoke({ ...base, roleKey: "owner", currentHolders: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "不能移除最后一个站长");
  });

  it("**持有人数异常为 0 时也挡住**", () => {
    // 数据不一致时应该保守拒绝，而不是「反正已经没人了，随便撤」
    assert.equal(checkRoleRevoke({ ...base, roleKey: "owner", currentHolders: 0 }).ok, false);
  });

  it("还有第二个站长时可以撤", () => {
    assert.equal(checkRoleRevoke({ ...base, roleKey: "owner", currentHolders: 2 }).ok, true);
  });

  it("最后一个 admin 可以撤 —— 只有 owner 是不可再生的", () => {
    assert.equal(checkRoleRevoke({ ...base, roleKey: "admin", currentHolders: 1 }).ok, true);
  });
});

describe("管理员备注", () => {
  it("空备注不行", () => {
    assert.equal(checkNote("  ").ok, false);
  });

  it("正常备注通过", () => {
    assert.equal(checkNote("此人此前有过一次争议，已当面沟通").ok, true);
  });
});

describe("高权身份组集合", () => {
  it("owner 与 admin 属于高权", () => {
    assert.equal(isElevatedRole("owner"), true);
    assert.equal(isElevatedRole("admin"), true);
  });

  it("版主不属于高权", () => {
    assert.equal(isElevatedRole("moderator"), false);
    assert.equal(isElevatedRole("member"), false);
  });
});
