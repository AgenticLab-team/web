import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CODE_LENGTH,
  MAX_EXPIRY_DAYS,
  MAX_USES_LIMIT,
  ancestorsOf,
  buildTree,
  checkCreate,
  checkRedeem,
  describeInvite,
  generateCode,
  isValidCodeShape,
  normalizeCode,
  shouldRevertReward,
  shouldReward,
} from "@/lib/invites/rules";

/**
 * 邀请。
 *
 * 邀请体系最容易变成刷分工具 —— 拉一个僵尸号的成本几乎为零。
 * 所以这些断言的重点不是「怎么邀请」，是**「怎么让刷邀请不划算」**。
 */

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

describe("邀请码形态", () => {
  it("长度固定", () => {
    assert.equal(generateCode().length, CODE_LENGTH);
  });

  it("**不含形近字符**", () => {
    // 这些码会被人念出来、抄下来、在微信里转发 ——
    // 少一个歧义字符，就少一批「码是对的但输错了」的求助
    const confusing = ["0", "O", "1", "I", "L", "2", "Z", "5", "S", "8", "B"];
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      for (const c of confusing) {
        assert.ok(!code.includes(c), `生成的码 ${code} 含有形近字符 ${c}`);
      }
    }
  });

  it("生成的码都通过自己的形态校验", () => {
    for (let i = 0; i < 50; i++) {
      assert.ok(isValidCodeShape(generateCode()));
    }
  });

  it("**大小写与空格连字符都不影响**", () => {
    // 人会把 ABCD-1234 抄成 abcd 1234，为这个让人重输一次不值得
    const code = generateCode();
    assert.equal(normalizeCode(code.toLowerCase()), code);
    assert.equal(normalizeCode(` ${code.slice(0, 4)}-${code.slice(4)} `), code);
  });

  it("长度不对或含非法字符的会被识破", () => {
    assert.equal(isValidCodeShape("ABC"), false);
    assert.equal(isValidCodeShape("00000000"), false);
  });

  it("随机源可注入，便于复现", () => {
    const fixed = generateCode(() => 0);
    assert.equal(fixed, fixed[0].repeat(CODE_LENGTH));
  });
});

describe("创建", () => {
  const base = { maxUses: 5, expiresInDays: 7, note: "给厦大那边的朋友" };

  it("正常创建通过", () => {
    assert.equal(checkCreate(base).ok, true);
  });

  it("不限次与不限期是允许的", () => {
    assert.equal(checkCreate({ ...base, maxUses: null, expiresInDays: null }).ok, true);
  });

  it("次数必须是正整数", () => {
    assert.equal(checkCreate({ ...base, maxUses: 0 }).ok, false);
    assert.equal(checkCreate({ ...base, maxUses: -1 }).ok, false);
    assert.equal(checkCreate({ ...base, maxUses: 1.5 }).ok, false);
  });

  it("**次数上限有意义** —— 再多不如直接开放注册", () => {
    const r = checkCreate({ ...base, maxUses: MAX_USES_LIMIT + 1 });
    assert.equal(r.ok, false);
    assert.match(r.error!, /开放注册/);
  });

  it("**有效期上限有意义** —— 躺半年的码没人记得它干什么用", () => {
    const r = checkCreate({ ...base, expiresInDays: MAX_EXPIRY_DAYS + 1 });
    assert.equal(r.ok, false);
  });
});

describe("兑换", () => {
  const invite = {
    maxUses: 5,
    usedCount: 1,
    expiresAt: NOW + DAY,
    revokedAt: null as number | null,
    createdBy: "u_inviter",
  };
  const base = { invite, userId: "u_new", alreadyInvited: false, now: NOW };

  it("正常兑换通过", () => {
    assert.equal(checkRedeem(base).ok, true);
  });

  it("不存在的码被拒", () => {
    assert.equal(checkRedeem({ ...base, invite: null }).ok, false);
  });

  it("撤销的码被拒", () => {
    assert.equal(checkRedeem({ ...base, invite: { ...invite, revokedAt: NOW } }).ok, false);
  });

  it("过期的码被拒", () => {
    assert.equal(checkRedeem({ ...base, invite: { ...invite, expiresAt: NOW - 1 } }).ok, false);
  });

  it("用完的码被拒", () => {
    assert.equal(checkRedeem({ ...base, invite: { ...invite, usedCount: 5 } }).ok, false);
  });

  it("不限次的码不会被判为用完", () => {
    assert.equal(
      checkRedeem({ ...base, invite: { ...invite, maxUses: null, usedCount: 9999 } }).ok,
      true,
    );
  });

  it("**不能用自己创建的码** —— 会在邀请树里造出自环", () => {
    assert.equal(checkRedeem({ ...base, userId: "u_inviter" }).ok, false);
  });

  it("**一个人只能被邀请一次**", () => {
    // 不限制的话，注销重注册就能反复给同一个邀请人送奖励
    const r = checkRedeem({ ...base, alreadyInvited: true });
    assert.equal(r.ok, false);
    assert.match(r.error!, /已经通过邀请/);
  });
});

describe("奖励发放", () => {
  const base = {
    inviteeCheckedIn: true,
    inviteeStatus: "active",
    alreadyRewarded: false,
    reverted: false,
  };

  it("被邀请人完成首次打卡后才发", () => {
    assert.equal(shouldReward(base), true);
  });

  it("**只注册没打卡不发** —— 否则拉一堆僵尸号就能刷分", () => {
    assert.equal(shouldReward({ ...base, inviteeCheckedIn: false }), false);
  });

  it("被邀请人被封时不发", () => {
    assert.equal(shouldReward({ ...base, inviteeStatus: "banned" }), false);
  });

  it("发过的不重复发", () => {
    assert.equal(shouldReward({ ...base, alreadyRewarded: true }), false);
  });

  it("回滚过的不再补发 —— 否则封了再解封就能重领", () => {
    assert.equal(shouldReward({ ...base, reverted: true }), false);
  });
});

describe("奖励回滚", () => {
  const base = { inviteeStatus: "banned", alreadyRewarded: true, reverted: false };

  it("**被邀请人被封时回滚** —— 否则刷号被抓也不亏", () => {
    assert.equal(shouldRevertReward(base), true);
  });

  it("账号被删同样回滚", () => {
    assert.equal(shouldRevertReward({ ...base, inviteeStatus: "deleted" }), true);
  });

  it("正常用户不回滚", () => {
    assert.equal(shouldRevertReward({ ...base, inviteeStatus: "active" }), false);
  });

  it("暂停不回滚 —— 暂停是可逆的，封禁才是定论", () => {
    assert.equal(shouldRevertReward({ ...base, inviteeStatus: "suspended" }), false);
  });

  it("没发过的没得回滚", () => {
    assert.equal(shouldRevertReward({ ...base, alreadyRewarded: false }), false);
  });

  it("**不会回滚两次**", () => {
    assert.equal(shouldRevertReward({ ...base, reverted: true }), false);
  });
});

describe("状态描述", () => {
  const invite = {
    maxUses: 5,
    usedCount: 2,
    expiresAt: NOW + DAY,
    revokedAt: null as number | null,
    createdBy: "u1",
  };

  it("可用时说清楚还剩几次", () => {
    const s = describeInvite(invite, NOW);
    assert.equal(s.usable, true);
    assert.equal(s.remaining, 3);
    assert.match(s.label, /还剩 3 次/);
  });

  it("不限次时 remaining 是 null 而不是 0", () => {
    const s = describeInvite({ ...invite, maxUses: null }, NOW);
    assert.equal(s.remaining, null);
    assert.equal(s.usable, true);
  });

  it("三种不可用状态分得清", () => {
    assert.equal(describeInvite({ ...invite, revokedAt: NOW }, NOW).label, "已撤销");
    assert.equal(describeInvite({ ...invite, expiresAt: NOW - 1 }, NOW).label, "已过期");
    assert.equal(describeInvite({ ...invite, usedCount: 5 }, NOW).label, "已用完");
  });
});

describe("邀请树", () => {
  const rows = [
    { id: "a", invitedBy: null },
    { id: "b", invitedBy: "a" },
    { id: "c", invitedBy: "a" },
    { id: "d", invitedBy: "b" },
  ];

  it("从根展开出下游", () => {
    const tree = buildTree(rows, "a")!;
    assert.equal(tree.children.length, 2);
    assert.equal(tree.children.find((c) => c.value.id === "b")!.children.length, 1);
  });

  it("叶子节点没有子树", () => {
    assert.equal(buildTree(rows, "d")!.children.length, 0);
  });

  it("不存在的根返回 null", () => {
    assert.equal(buildTree(rows, "nobody"), null);
  });

  it("**数据成环时不会转死**", () => {
    // invitedBy 正常无环，但数据被手工改过就可能成环，
    // 那时递归会直接把进程转死
    const cyclic = [
      { id: "x", invitedBy: "y" },
      { id: "y", invitedBy: "x" },
    ];
    assert.doesNotThrow(() => buildTree(cyclic, "x"));
  });

  it("深度有上限，防止异常数据拖垮页面", () => {
    const deep = Array.from({ length: 50 }, (_, i) => ({
      id: `n${i}`,
      invitedBy: i === 0 ? null : `n${i - 1}`,
    }));

    let node = buildTree(deep, "n0")!;
    let depth = 0;
    while (node.children.length > 0) {
      node = node.children[0];
      depth++;
    }
    assert.ok(depth < 10, `深度 ${depth} 超出预期`);
  });
});

describe("追溯上游", () => {
  const rows = [
    { id: "a", invitedBy: null },
    { id: "b", invitedBy: "a" },
    { id: "c", invitedBy: "b" },
  ];

  it("一路往上列出邀请人", () => {
    assert.deepEqual(ancestorsOf(rows, "c").map((r) => r.id), ["b", "a"]);
  });

  it("没有邀请人时是空数组", () => {
    assert.deepEqual(ancestorsOf(rows, "a"), []);
  });

  it("**成环时会停下来**", () => {
    const cyclic = [
      { id: "x", invitedBy: "y" },
      { id: "y", invitedBy: "x" },
    ];
    assert.doesNotThrow(() => ancestorsOf(cyclic, "x"));
    assert.ok(ancestorsOf(cyclic, "x").length <= 5);
  });

  it("邀请人已被删除时安全停止", () => {
    assert.deepEqual(ancestorsOf([{ id: "z", invitedBy: "gone" }], "z"), []);
  });
});
