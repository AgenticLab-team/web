import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  PRIVILEGED_DANGER_LEVEL,
  describeRisk,
  isPrivileged,
  lockoutRisk,
  passwordLoginVerdict,
  privilegedPermissions,
} from "@/lib/auth/passkey-policy";

/**
 * 管理员强制 Passkey。
 *
 * ─────────────────────────────────────────
 * 这个开关在库里躺了很久，没有任何地方读它
 * ─────────────────────────────────────────
 *
 * 默认值是 "true"，标签写着「管理员强制 Passkey 或 2FA」，
 * 说明写着「管理员账号不接受纯密码登录」，后台设置页把它显示成开着的。
 * 而没有一行代码读它。
 *
 * 这比忘了做糟得多：忘了做至少没人以为它在。
 * 一个显示成「开」的安全开关，效果是让人**不再去想这件事**。
 */

describe("谁算「管理员」", () => {
  it("**不按角色名判** —— 按权限的危险等级", () => {
    /*
     * can.ts 开头就写着「任何地方都不许自己写 if (role === "admin")」。
     * 按名字判的东西会在有人加一个「运营」角色、
     * 给了它一半管理员权限的那天悄悄失效。
     */
    const src = readFileSync(new URL("../src/lib/auth/passkey-policy.ts", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    assert.doesNotMatch(code, /=== ?"admin"/);
    assert.doesNotMatch(code, /roleKey/);
    assert.match(code, /dangerLevelOf/);
  });

  it("拿着危险级权限就算", () => {
    assert.equal(isPrivileged(["system.settings"]), true, "极危");
    assert.equal(isPrivileged(["role.grant"]), true, "危险");
  });

  it("只有普通权限不算", () => {
    assert.equal(isPrivileged(["forum.view", "forum.react", "activity.apply"]), false);
  });

  it("**「敏感」级不算** —— 版主日常操作要是都强制 Passkey，这条规则会先被关掉", () => {
    // moderation.action 是 dangerLevel 1
    assert.equal(isPrivileged(["moderation.action"]), false);
    assert.equal(PRIVILEGED_DANGER_LEVEL, 2);
  });

  it("一堆普通权限里混一项危险的，也算", () => {
    assert.equal(isPrivileged(["forum.view", "forum.react", "points.adjust"]), true);
  });

  it("空权限不算", () => {
    assert.equal(isPrivileged([]), false);
  });

  it("说得出「你为什么算管理员」", () => {
    const list = privilegedPermissions(["forum.view", "system.settings", "role.grant"]);
    assert.deepEqual(list, ["role.grant", "system.settings"]);
  });

  it("认不出的权限点不会被当成危险的", () => {
    assert.equal(isPrivileged(["some.made.up.key"]), false);
  });
});

describe("密码登录的判定", () => {
  const verdict = (o: Partial<Parameters<typeof passwordLoginVerdict>[0]>) =>
    passwordLoginVerdict({ privileged: true, hasPasskey: true, enforced: true, ...o });

  it("开关关着时谁都能用密码", () => {
    assert.equal(verdict({ enforced: false }).allowed, true);
    assert.equal(verdict({ enforced: false, hasPasskey: false }).allowed, true);
  });

  it("普通成员不受影响 —— 这条规则针对的是有权限的人", () => {
    assert.equal(verdict({ privileged: false }).allowed, true);
    assert.equal(verdict({ privileged: false, hasPasskey: false }).allowed, true);
  });

  it("**有权限 + 有 Passkey → 拒绝密码**，这才是这个开关的正事", () => {
    const v = verdict({});
    assert.equal(v.allowed, false);
    if (v.allowed) return;
    assert.equal(v.code, "use_passkey");
    assert.match(v.message, /Passkey/);
  });

  it("**有权限但没绑 Passkey → 也拒绝，而且说法不一样**", () => {
    /*
     * 这种情况他现在进不来了。必须说清楚，
     * 否则他会一遍遍试密码 —— 而密码是对的。
     * 那种「明明没错却进不去」是最让人不知所措的失败。
     */
    const v = verdict({ hasPasskey: false });
    assert.equal(v.allowed, false);
    if (v.allowed) return;
    assert.equal(v.code, "no_passkey_bound");
    assert.match(v.message, /还没有绑定|没有绑定/);
    assert.match(v.message, /密码是对的/, "不说这句的话他会以为是自己记错了密码");
  });

  it("两种拒绝的文案不一样 —— 一样的话就白分了", () => {
    const a = verdict({});
    const b = verdict({ hasPasskey: false });
    if (a.allowed || b.allowed) return assert.fail("应该都被拒");
    assert.notEqual(a.message, b.message);
  });

  it("**没绑 Passkey 时不放行** —— 放行的话这个开关又变成半个谎", () => {
    /*
     * 说明里写着「不接受纯密码登录」，实际有时候接受 ——
     * 那和现在这个「显示成开、其实没读」的状态是同一类问题。
     *
     * 「会不会把所有管理员锁在外面」不靠这里放水来防，
     * 靠 lockoutRisk() 把风险摆到台面上。
     */
    assert.equal(verdict({ hasPasskey: false }).allowed, false);
  });
});

describe("会锁住谁", () => {
  const people = [
    { name: "站长", privileged: true, hasPasskey: true, hasPassword: true },
    { name: "管理员甲", privileged: true, hasPasskey: false, hasPassword: true },
    { name: "普通成员", privileged: false, hasPasskey: false, hasPassword: true },
  ];

  it("只数「有危险权限又没 Passkey」的人", () => {
    const risk = lockoutRisk(people, true);
    assert.equal(risk.strandedCount, 1);
    assert.deepEqual(risk.strandedNames, ["管理员甲"]);
  });

  it("**开关没开时也要算** —— 「开了会怎样」要在开之前就知道", () => {
    const risk = lockoutRisk(people, false);
    assert.equal(risk.strandedCount, 1, "没开就不算的话，这个数字只在出事后才出现");
    assert.equal(risk.active, false, "没开的时候没有人真的被挡");
  });

  it("开着且有人被挡 → active", () => {
    assert.equal(lockoutRisk(people, true).active, true);
  });

  it("**既没密码也没 Passkey 的人不算被挡** —— 他本来就不走密码这条路", () => {
    /*
     * 这条是在生产上跑第一遍时补的。
     *
     * 原来只看「有权限且没 Passkey」，于是一个既没密码也没 Passkey 的
     * 管理员被报成了 down —— 可这条规则没挡住他任何事。
     * 一个不成立的 down 比没有告警更糟：它教人忽略这个组件。
     */
    const risk = lockoutRisk(
      [{ name: "牛牛酱", privileged: true, hasPasskey: false, hasPassword: false }],
      true,
    );
    assert.equal(risk.strandedCount, 0);
    assert.equal(risk.active, false);
  });

  it("**但要单独数出来** —— 他设密码那天就会进不来，而那时没人会想起这条规则", () => {
    const risk = lockoutRisk(
      [{ name: "牛牛酱", privileged: true, hasPasskey: false, hasPassword: false }],
      true,
    );
    assert.equal(risk.atRiskCount, 1);
    assert.deepEqual(risk.atRiskNames, ["牛牛酱"]);
  });

  it("有密码没 Passkey 的才是真被挡", () => {
    const risk = lockoutRisk(
      [{ name: "甲", privileged: true, hasPasskey: false, hasPassword: true }],
      true,
    );
    assert.equal(risk.strandedCount, 1);
    assert.equal(risk.atRiskCount, 0);
  });

  it("人人都有 Passkey 时是干净的", () => {
    const risk = lockoutRisk([{ name: "站长", privileged: true, hasPasskey: true, hasPassword: true }], true);
    assert.equal(risk.strandedCount, 0);
    assert.equal(risk.active, false);
  });

  it("**名单顺序稳定** —— 输入顺序不影响输出，免得两次刷新看着像换了人", () => {
    const rows = [
      { name: "乙", privileged: true, hasPasskey: false, hasPassword: true },
      { name: "甲", privileged: true, hasPasskey: false, hasPassword: true },
      { name: "丙", privileged: true, hasPasskey: false, hasPassword: true },
    ];
    const a = lockoutRisk(rows, true).strandedNames;
    const b = lockoutRisk([...rows].reverse(), true).strandedNames;
    assert.deepEqual(a, b);
  });

  it("按中文排，不按码位 —— 默认 sort() 会把「乙」排在「甲」前面", () => {
    const risk = lockoutRisk(
      [
        { name: "乙", privileged: true, hasPasskey: false, hasPassword: true },
        { name: "甲", privileged: true, hasPasskey: false, hasPassword: true },
      ],
      true,
    );
    assert.deepEqual(risk.strandedNames, ["甲", "乙"]);
  });
});

describe("说给人听的那句话", () => {
  it("开着、干净 —— 说清楚它真的在生效", () => {
    const text = describeRisk(lockoutRisk([{ name: "a", privileged: true, hasPasskey: true, hasPassword: true }], true));
    assert.match(text, /已开启/);
  });

  it("**没开时要说出后果**，而不是只说「没开」", () => {
    const text = describeRisk(
      lockoutRisk([{ name: "a", privileged: true, hasPasskey: false, hasPassword: true }], false),
    );
    assert.match(text, /没开启/);
    assert.match(text, /1 人/, "不说人数的话，没人知道开了会发生什么");
  });

  it("没开、也没人会被挡 —— 要说出「现在管理员只有一道密码」", () => {
    const text = describeRisk(
      lockoutRisk([{ name: "a", privileged: true, hasPasskey: true, hasPassword: true }], false),
    );
    assert.match(text, /纯密码/);
  });

  it("**开着且有人被挡 —— 要报出是谁**，否则没法处理", () => {
    const text = describeRisk(
      lockoutRisk([{ name: "管理员甲", privileged: true, hasPasskey: false, hasPassword: true }], true),
    );
    assert.match(text, /管理员甲/);
    assert.match(text, /登不进来/);
  });
});

describe("规则层不碰 IO", () => {
  it("纯函数 —— 它在登录路径上，测试必须能密集地跑", () => {
    const src = readFileSync(new URL("../src/lib/auth/passkey-policy.ts", import.meta.url), "utf8");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm", "settings/store"]) {
      assert.equal(src.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});
