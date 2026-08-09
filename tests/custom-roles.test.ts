import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  MAX_ROLE_NAME,
  RESERVED_KEYS,
  SYSTEM_ACTOR,
  canAutoGrant,
  canDelete,
  checkRole,
  planSettle,
  seatsLeft,
  type HolderState,
} from "@/lib/rbac/role-rules";
import { stripComments as strip } from "./_source";

/**
 * 自定义身份组。
 *
 * ─────────────────────────────────────────
 * 四个字段，零引用
 * ─────────────────────────────────────────
 *
 * `roles` 表上 max_holders / auto_grant_rule / auto_revoke / badge_style
 * 四列在 schema 之外没有任何地方读或写，而后台那一页是只读的 ——
 * 身份组只能靠改代码里的 BUILTIN_ROLES 来增减。
 *
 * ─────────────────────────────────────────
 * 这一组测试大半在测「不能提权」
 * ─────────────────────────────────────────
 *
 * 「累计 1000 分自动给某某身份」听起来只是荣誉，而身份组是
 * **权限容器**。一条写错的规则（把 >= 写成 <=）会把一个带删帖权的组
 * 发给全站所有人 —— 自动地、无声地、每五分钟一次。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const draft = (over: Partial<Parameters<typeof checkRole>[0]> = {}) => ({
  key: "veteran",
  name: "老兵",
  priority: 10,
  ...over,
});

describe("身份组的校验", () => {
  it("正常的过", () => {
    assert.equal(checkRole(draft(), []).ok, true);
  });

  it("**key 的形状卡死** —— 带空格或中文的 key 迟早在某处被截断", () => {
    /*
     * 而截断之后的判定结果是「放行」（找不到就当没有这个组）。
     */
    for (const bad of ["老兵", "with space", "9lives", "has-dash", "", "a b"]) {
      assert.equal(checkRole(draft({ key: bad }), []).ok, false, `${bad} 竟然过了`);
    }
  });

  it("**大写会被规范成小写**，不是拒掉 —— 那是笔误，不是错误", () => {
    const r = checkRole(draft({ key: "Veteran" }), []);
    assert.equal(r.ok && r.draft.key, "veteran");
    // 规范之后再判重名，否则 Veteran 和 veteran 会变成两个组
    assert.equal(checkRole(draft({ key: "VETERAN" }), ["veteran"]).ok, false);
  });

  it("**内置 key 不许被占** —— 占了之后按 key 判「是不是管理员」的地方会拿到错的那个", () => {
    for (const key of RESERVED_KEYS) {
      assert.equal(checkRole(draft({ key }), []).ok, false, `${key} 竟然能用`);
    }
  });

  it("重名拒", () => {
    assert.equal(checkRole(draft(), ["veteran"]).ok, false);
  });

  it("名字必填、限长 —— 它会显示在所有人的名字旁边", () => {
    assert.equal(checkRole(draft({ name: "  " }), []).ok, false);
    assert.equal(checkRole(draft({ name: "长".repeat(MAX_ROLE_NAME + 1) }), []).ok, false);
  });

  it("颜色要是 #RRGGBB", () => {
    assert.equal(checkRole(draft({ color: "red" }), []).ok, false);
    assert.equal(checkRole(draft({ color: "#0d5c47" }), []).ok, true);
  });

  it("名额上限要么不填要么 ≥1", () => {
    assert.equal(checkRole(draft({ maxHolders: 0 }), []).ok, false);
    assert.equal(checkRole(draft({ maxHolders: -1 }), []).ok, false);
    assert.equal(checkRole(draft({ maxHolders: null }), []).ok, true);
    assert.equal(checkRole(draft({ maxHolders: 5 }), []).ok, true);
  });

  it("优先级要在 0–1000", () => {
    assert.equal(checkRole(draft({ priority: -1 }), []).ok, false);
    assert.equal(checkRole(draft({ priority: 1001 }), []).ok, false);
  });
});

describe("**自动授予是一条提权路径**", () => {
  it("内置组一律不许自动发 —— 它们决定谁是管理员", () => {
    const r = canAutoGrant({ isSystem: true, maxDangerLevel: 0 });
    assert.equal(r.ok, false);
  });

  it("**带危险权限的组不许自动发**", () => {
    /*
     * 判据是权限的 dangerLevel，不是「是不是内置组」——
     * 一个自定义组照样可以挂上危险权限。
     */
    const r = canAutoGrant({ isSystem: false, maxDangerLevel: 2 });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /没有声音|危险权限/);
  });

  it("只挂普通权限的自定义组可以", () => {
    assert.equal(canAutoGrant({ isSystem: false, maxDangerLevel: 1 }).ok, true);
    assert.equal(canAutoGrant({ isSystem: false, maxDangerLevel: 0 }).ok, true);
  });

  it("**保存时和结算时各判一次**", () => {
    /*
     * 只在保存时判的话：保存时这个组没有危险权限，
     * 后来有人给它加了一个 —— 那条规则会继续把危险权限发出去，
     * 而且没有任何地方会提。
     */
    assert.match(strip(src("lib/rbac/role-actions.ts")), /canAutoGrant\(/);
    assert.match(strip(src("lib/rbac/role-settle.ts")), /if \(!role\.autoGrantAllowed\)/);
  });
});

describe("**自动回收只回收自动发的**", () => {
  const holders: HolderState[] = [
    { userId: "auto1", auto: true },
    { userId: "manual1", auto: false },
  ];

  it("手动给的那个不动 —— 那是一个人的决定", () => {
    /*
     * 一次分数波动抹掉站长亲手给的荣誉，而当事人只会看到
     * 「我的身份没了」，没有任何解释。
     */
    const plan = planSettle({ eligible: [], holders, maxHolders: null, autoRevoke: true });
    assert.deepEqual(plan.revoke, ["auto1"]);
  });

  it("没开自动回收就一个都不收", () => {
    const plan = planSettle({ eligible: [], holders, maxHolders: null, autoRevoke: false });
    assert.deepEqual(plan.revoke, []);
  });

  it("还够格的不收", () => {
    const plan = planSettle({
      eligible: ["auto1"],
      holders,
      maxHolders: null,
      autoRevoke: true,
    });
    assert.deepEqual(plan.revoke, []);
  });
});

describe("名额上限", () => {
  it("不限时全发", () => {
    const plan = planSettle({ eligible: ["a", "b", "c"], holders: [], maxHolders: null, autoRevoke: false });
    assert.equal(plan.grant.length, 3);
    assert.equal(plan.waitlisted.length, 0);
  });

  it("满了就候补，而且**说得出有多少人在候补**", () => {
    /*
     * 不说的话，「为什么我够格却没拿到」无从解释。
     */
    const plan = planSettle({ eligible: ["a", "b", "c"], holders: [], maxHolders: 2, autoRevoke: false });
    assert.equal(plan.grant.length, 2);
    assert.equal(plan.waitlisted.length, 1);
  });

  it("已经持有的人不占新名额", () => {
    const plan = planSettle({
      eligible: ["a", "b"],
      holders: [{ userId: "a", auto: true }],
      maxHolders: 2,
      autoRevoke: false,
    });
    assert.deepEqual(plan.grant, ["b"]);
  });

  it("**先回收再发放** —— 否则满员的组永远发不出新的", () => {
    /*
     * 这一轮正好有人不够格该腾出位置，而顺序反了的话那个位置腾不出来。
     */
    const plan = planSettle({
      eligible: ["new"],
      holders: [{ userId: "old", auto: true }],
      maxHolders: 1,
      autoRevoke: true,
    });
    assert.deepEqual(plan.revoke, ["old"]);
    assert.deepEqual(plan.grant, ["new"]);
  });

  it("满员且没人该走 —— 新人只能候补", () => {
    const plan = planSettle({
      eligible: ["old", "new"],
      holders: [{ userId: "old", auto: true }],
      maxHolders: 1,
      autoRevoke: true,
    });
    assert.deepEqual(plan.grant, []);
    assert.deepEqual(plan.waitlisted, ["new"]);
  });

  it("seatsLeft 不给负数", () => {
    assert.equal(seatsLeft(3, 5), 0);
    assert.equal(seatsLeft(null, 5), null);
    assert.equal(seatsLeft(5, 3), 2);
  });
});

describe("删除", () => {
  it("内置的不能删", () => {
    assert.equal(canDelete({ isSystem: true, holders: 0 }).ok, false);
  });

  it("**有人持有的不能删** —— 删了他们的权限会无声地少一块", () => {
    const r = canDelete({ isSystem: false, holders: 3 });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /3 个人/);
  });

  it("空的可以删", () => {
    assert.equal(canDelete({ isSystem: false, holders: 0 }).ok, true);
  });
});

describe("接线", () => {
  it("自动发的记在 granted_by 上 —— 那是区分人给的还是规则给的唯一依据", () => {
    assert.equal(SYSTEM_ACTOR, "system");
    assert.match(strip(src("lib/rbac/role-settle.ts")), /grantedBy: SYSTEM_ACTOR/);
    assert.match(strip(src("lib/rbac/role-admin.ts")), /grantedBy === SYSTEM_ACTOR/);
  });

  it("**规则复用活动那套资格引擎**，不另造一套", () => {
    /*
     * schema 上那行注释写着「复用活动系统的资格引擎规则 JSON」——
     * 而在这之前没有任何地方读过它。再造一套的话，两套判定语义早晚分叉。
     */
    const settle = strip(src("lib/rbac/role-settle.ts"));
    assert.match(settle, /evaluateEligibility\(role\.autoGrantRule as Rule/);
    assert.match(settle, /computeAllStats\(\)/);
  });

  it("指标一次算完，所有组共用", () => {
    const settle = strip(src("lib/rbac/role-settle.ts"));
    const loopAt = settle.indexOf("for (const role of configured)");
    const statsAt = settle.indexOf("const stats = computeAllStats()");
    assert.ok(statsAt > 0 && statsAt < loopAt, "在循环里逐个组重算了指标");
  });

  it("挂在已经在跑的那一轮定时任务上", () => {
    const health = readFileSync(new URL("../scripts/health.ts", import.meta.url), "utf8");
    assert.match(health, /name: "身份组结算"/);
    assert.match(health, /settleAutoRoles\(\)/);
  });

  it("**有效持有才算数** —— 撤销过的和过期的不能算进人数", () => {
    /*
     * 按 user_roles 直接数行数会把撤销记录也算进去，
     * 于是一个撤干净的组永远删不掉。
     */
    const admin = strip(src("lib/rbac/role-admin.ts"));
    assert.match(admin, /isNull\(userRoles\.revokedAt\)/);
    assert.match(admin, /expiresAt[\s\S]*?IS NULL OR/);
  });

  it("内置组只让改外观", () => {
    const actions = strip(src("lib/rbac/role-actions.ts"));
    assert.match(actions, /if \(current\.isSystem\)/);
    assert.match(actions, /"key", "maxHolders", "autoGrantRule", "autoRevoke"/);
  });

  it("删除是软删 —— 硬删会让审计日志变成一串孤儿", () => {
    const actions = strip(src("lib/rbac/role-actions.ts"));
    assert.match(actions, /set\(\{ deletedAt: Date\.now\(\) \}\)/);
    assert.doesNotMatch(actions, /db\.delete\(roles\)/);
  });

  it("规则层不碰数据库", () => {
    const code = src("lib/rbac/role-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(code.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });

  it("后台那一页不再是只读的", () => {
    assert.match(src("app/(app)/admin/roles/page.tsx"), /<RoleEditor/);
  });

  it("自动授予被拦下时要说清楚为什么", () => {
    /*
     * 灰掉但不解释的话，人只会以为是坏了，然后去找别的路 ——
     * 而别的路多半更糟。
     */
    assert.match(src("components/admin/RoleEditor.tsx"), /autoGrantBlockedReason/);
  });
});
