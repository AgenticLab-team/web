import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  KEYSTONE_PERMISSION,
  MIN_REASON_LENGTH,
  diffCells,
  guardrailErrors,
  isRiskyChange,
  stateLabel,
  summarizeImpact,
  type CellChange,
  type MatrixState,
} from "@/lib/rbac/matrix-edit";
import { stripComments as strip } from "./_source";

/**
 * 权限矩阵的在线编辑。
 *
 * 改一格,可能有四十个人从此能删别人的帖。而在矩阵上,
 * 那一格和旁边四百格长得一模一样 —— 它的影响面是看不见的。
 */

const cur = (rows: [string, string, MatrixState][]) => {
  const m = new Map<string, Map<string, MatrixState>>();
  for (const [role, perm, state] of rows) {
    if (!m.has(role)) m.set(role, new Map());
    m.get(role)!.set(perm, state);
  }
  return m;
};

const NAMES: Record<string, string> = { r1: "管理员", r2: "版主", r3: "站长" };
const nameOf = (id: string) => NAMES[id] ?? id;

describe("只留下真的变了的格子", () => {
  it("**没变的不进 diff** —— 前端往往整表提交", () => {
    /*
     * 原样存下去的话变更历史里会全是噪音,
     * 而噪音多的历史等于没有历史 ——
     * 没有人会去翻一份每次都几百条的日志。
     */
    const changes = diffCells(
      cur([["r1", "forum.view", "granted"]]),
      [
        { roleId: "r1", permissionKey: "forum.view", state: "granted" },
        { roleId: "r1", permissionKey: "forum.react", state: "granted" },
      ],
      nameOf,
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].permissionKey, "forum.react");
  });

  it("库里没有这一行时,起点是 none", () => {
    const changes = diffCells(cur([]), [{ roleId: "r1", permissionKey: "forum.view", state: "granted" }], nameOf);
    assert.equal(changes[0].from, "none");
  });

  it("撤销授予（granted → none）也算改动", () => {
    const changes = diffCells(
      cur([["r1", "forum.view", "granted"]]),
      [{ roleId: "r1", permissionKey: "forum.view", state: "none" }],
      nameOf,
    );
    assert.deepEqual([changes[0].from, changes[0].to], ["granted", "none"]);
  });

  it("带上身份组的名字 —— diff 里不该出现一串 id", () => {
    const changes = diffCells(cur([]), [{ roleId: "r1", permissionKey: "forum.view", state: "granted" }], nameOf);
    assert.equal(changes[0].roleName, "管理员");
  });

  it("排过序 —— 两次预览的顺序要一样,否则人会以为改动变了", () => {
    const cells = [
      { roleId: "r2", permissionKey: "b", state: "granted" as const },
      { roleId: "r1", permissionKey: "a", state: "granted" as const },
    ];
    const a = diffCells(cur([]), cells, nameOf).map((c) => c.permissionKey);
    const b = diffCells(cur([]), [...cells].reverse(), nameOf).map((c) => c.permissionKey);
    assert.deepEqual(a, b);
  });

  it("什么都没提交时是空的", () => {
    assert.deepEqual(diffCells(cur([]), [], nameOf), []);
  });
});

describe("**提权:这里唯一不能商量的一条**", () => {
  const base = {
    actorPriority: 90,
    rolePriority: new Map([["r1", 90], ["r2", 70], ["r3", 100]]),
    keystoneHoldersAfter: 3,
    reason: "整理版主权限",
  };
  const change = (o: Partial<CellChange>): CellChange => ({
    roleId: "r2",
    roleName: "版主",
    permissionKey: "system.settings",
    from: "none",
    to: "granted",
    ...o,
  });

  it("授予一项自己没有的权限 —— 拒绝", () => {
    /*
     * role.manage 是 dangerLevel 2,管理员有。
     * 而 ADMIN_DENIES 里明确不给管理员 system.settings。
     *
     * 如果矩阵编辑只查 role.manage,管理员就能编辑「管理员」这个身份组
     * 给自己加上 system.settings —— ADMIN_DENIES 整张表当场作废。
     */
    const errors = guardrailErrors({
      ...base,
      changes: [change({})],
      actorPermissions: new Set(["role.manage"]),
    });
    assert.ok(errors.some((e) => e.includes("system.settings")), errors.join("；"));
  });

  it("授予一项自己有的权限 —— 放行", () => {
    const errors = guardrailErrors({
      ...base,
      changes: [change({})],
      actorPermissions: new Set(["role.manage", "system.settings"]),
    });
    assert.deepEqual(errors, []);
  });

  it("**撤掉显式拒绝也算授予** —— 只看 granted 会漏掉这一路", () => {
    const errors = guardrailErrors({
      ...base,
      changes: [change({ from: "denied", to: "none" })],
      actorPermissions: new Set(["role.manage"]),
    });
    assert.ok(errors.some((e) => e.includes("system.settings")), "denied → none 放过去了");
  });

  it("**收回权限不受这条限制** —— 你可以拿走你自己没有的东西", () => {
    const errors = guardrailErrors({
      ...base,
      changes: [change({ from: "granted", to: "none" })],
      actorPermissions: new Set(["role.manage"]),
    });
    assert.deepEqual(errors, [], "收回也被挡了 —— 那清理越权配置就没法做");
  });

  it("改成显式拒绝也是收回,不需要自己有这项权限", () => {
    const errors = guardrailErrors({
      ...base,
      changes: [change({ from: "granted", to: "denied" })],
      actorPermissions: new Set(["role.manage"]),
    });
    assert.deepEqual(errors, []);
  });
});

describe("不能动比自己高的身份组", () => {
  const base = {
    actorPermissions: new Set(["role.manage", "user.suspend"]),
    actorPriority: 90,
    rolePriority: new Map([["r1", 90], ["r2", 70], ["r3", 100]]),
    keystoneHoldersAfter: 3,
    reason: "调整权限",
  };

  it("**管理员不能摘站长的权限** —— 每一项都合规，合起来是一次夺权", () => {
    const errors = guardrailErrors({
      ...base,
      changes: [
        { roleId: "r3", roleName: "站长", permissionKey: "user.suspend", from: "granted", to: "none" },
      ],
    });
    assert.ok(errors.some((e) => e.includes("优先级比你高")));
  });

  it("改低优先级的可以", () => {
    const errors = guardrailErrors({
      ...base,
      changes: [
        { roleId: "r2", roleName: "版主", permissionKey: "user.suspend", from: "none", to: "granted" },
      ],
    });
    assert.deepEqual(errors, []);
  });

  it("改同级的可以 —— 同一个信任层级内部的调整，有审计兜着", () => {
    const errors = guardrailErrors({
      ...base,
      changes: [
        { roleId: "r1", roleName: "管理员", permissionKey: "user.suspend", from: "none", to: "granted" },
      ],
    });
    assert.deepEqual(errors, []);
  });
});

describe("**不能把门从里面锁上**", () => {
  const base = {
    changes: [
      {
        roleId: "r1",
        roleName: "管理员",
        permissionKey: KEYSTONE_PERMISSION,
        from: "granted" as const,
        to: "none" as const,
      },
    ],
    actorPermissions: new Set(["role.manage"]),
    actorPriority: 100,
    rolePriority: new Map([["r1", 90]]),
    reason: "清理权限",
  };

  it("改完之后没人能再改矩阵 —— 拒绝", () => {
    const errors = guardrailErrors({ ...base, keystoneHoldersAfter: 0 });
    assert.ok(errors.some((e) => e.includes("没有人能再改")), errors.join("；"));
  });

  it("还剩一个人就放行 —— 一个人也是人", () => {
    const errors = guardrailErrors({ ...base, keystoneHoldersAfter: 1 });
    assert.deepEqual(errors, []);
  });

  it("keystone 是 role.manage —— 摘掉它矩阵就永远改不回来了", () => {
    assert.equal(KEYSTONE_PERMISSION, "role.manage");
  });
});

describe("必填理由", () => {
  const base = {
    changes: [
      { roleId: "r1", roleName: "管理员", permissionKey: "forum.view", from: "none" as const, to: "none" as const },
    ],
    actorPermissions: new Set<string>(),
    actorPriority: 100,
    rolePriority: new Map([["r1", 90]]),
    keystoneHoldersAfter: 2,
  };

  it("空理由不行", () => {
    const errors = guardrailErrors({
      ...base,
      changes: [{ ...base.changes[0], to: "denied" as const }],
      reason: "   ",
    });
    assert.ok(errors.some((e) => e.includes("为什么")));
  });

  it("太短也不行", () => {
    const errors = guardrailErrors({
      ...base,
      changes: [{ ...base.changes[0], to: "denied" as const }],
      reason: "改",
    });
    assert.ok(errors.some((e) => e.includes("为什么")));
    assert.ok(MIN_REASON_LENGTH >= 4);
  });

  it("什么都没改时，直接说没改动", () => {
    const errors = guardrailErrors({ ...base, changes: [], reason: "" });
    assert.deepEqual(errors, ["没有任何改动"]);
  });

  it("同一条错误只报一次 —— 三十格触发同一个问题不该刷三十行", () => {
    const errors = guardrailErrors({
      ...base,
      changes: Array.from({ length: 5 }, (_, i) => ({
        roleId: "r1",
        roleName: "管理员",
        permissionKey: "system.settings",
        from: "none" as const,
        to: "granted" as const,
        i,
      })),
      reason: "批量调整",
    });
    assert.equal(errors.length, 1);
  });
});

describe("「将获得 3 项、失去 1 项，影响 4 人」", () => {
  it("三个数字都对", () => {
    const text = summarizeImpact({
      gained: [
        { userId: "a", name: "甲", permissions: ["p1", "p2"] },
        { userId: "b", name: "乙", permissions: ["p3"] },
      ],
      lost: [{ userId: "c", name: "丙", permissions: ["p4"] }],
    });
    assert.match(text, /获得 3 项/);
    assert.match(text, /失去 1 项/);
    assert.match(text, /影响 3 人/);
  });

  it("**失去排在获得前面** —— 收回权限更容易出事，放句尾人会读漏", () => {
    const text = summarizeImpact({
      gained: [{ userId: "a", name: "甲", permissions: ["p1"] }],
      lost: [{ userId: "b", name: "乙", permissions: ["p2"] }],
    });
    assert.ok(text.indexOf("失去") < text.indexOf("获得"), text);
  });

  it("同一个人既得又失，只算一个人", () => {
    const text = summarizeImpact({
      gained: [{ userId: "a", name: "甲", permissions: ["p1"] }],
      lost: [{ userId: "a", name: "甲", permissions: ["p2"] }],
    });
    assert.match(text, /影响 1 人/);
  });

  it("**改了格子但没人受影响时要说出来** —— 「影响 0 人」比空白有用得多", () => {
    /*
     * 这种情况很常见:给一个没人持有的身份组加权限、
     * 或者加的那项权限他从别的组已经有了。
     * 不说的话人会以为预览坏了。
     */
    assert.equal(summarizeImpact({ gained: [], lost: [] }), "没有人的实际权限会改变");
  });

  it("只有失去时不出现「获得 0 项」", () => {
    const text = summarizeImpact({
      gained: [],
      lost: [{ userId: "a", name: "甲", permissions: ["p1"] }],
    });
    assert.doesNotMatch(text, /获得/);
  });
});

describe("哪些改动要标红", () => {
  const c = (to: MatrixState): CellChange => ({
    roleId: "r",
    roleName: "x",
    permissionKey: "p",
    from: "none",
    to,
  });

  it("**改成显式拒绝一律标红** —— 它会打掉这人从别的身份组拿到的权限", () => {
    /*
     * 这是三态操作里最容易估错后果的一个:
     * 看着像「没给他加东西」,实际是「拿走了他的东西」。
     */
    assert.equal(isRiskyChange(c("denied"), 0), true);
  });

  it("授予危险级权限标红", () => {
    assert.equal(isRiskyChange(c("granted"), 2), true);
    assert.equal(isRiskyChange(c("granted"), 3), true);
  });

  it("授予普通权限不标红 —— 全标红等于没标", () => {
    assert.equal(isRiskyChange(c("granted"), 0), false);
    assert.equal(isRiskyChange(c("granted"), 1), false);
  });

  it("撤销授予不标红 —— 收回是收敛方向", () => {
    assert.equal(isRiskyChange({ ...c("none"), from: "granted" }, 3), false);
  });
});

describe("三态的说法", () => {
  it("三个都有名字", () => {
    assert.equal(stateLabel("granted"), "允许");
    assert.equal(stateLabel("denied"), "显式拒绝");
    assert.equal(stateLabel("none"), "未授予");
  });
});

describe("规则层不碰 IO", () => {
  it("纯函数 —— 护栏出错的后果不可逆，测试必须能密集地跑", () => {
    const src = readFileSync(new URL("../src/lib/rbac/matrix-edit.ts", import.meta.url), "utf8");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(src.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});

describe("接线", () => {
  const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  
  it("**保存时重跑一遍护栏** —— 不能因为「预览时查过了」就跳过", () => {
    /*
     * 预览和保存之间隔着人的思考时间,期间权限可能被撤、身份组可能被删。
     * 而客户端传回来的东西谁都不该信。
     */
    const code = strip(src("lib/rbac/matrix-actions.ts"));
    const save = code.slice(code.indexOf("function saveMatrixEdit"));
    assert.match(save.slice(0, 300), /evaluate\(/, "保存没走那条带护栏的路");
    assert.match(code, /function evaluate/);
    assert.match(code.slice(code.indexOf("function evaluate")), /guardrailErrors\(/);
  });

  it("**保存走 requireWritableAdmin** —— 预览态下不能真的改权限矩阵", () => {
    const code = strip(src("lib/rbac/matrix-actions.ts"));
    const save = code.slice(code.indexOf("function saveMatrixEdit"), code.indexOf("function evaluate"));
    assert.match(save, /requireWritableAdmin\("role\.manage"\)/);
  });

  it("预览只用 requireAdmin —— 它不写库，不该被预览态拦住", () => {
    const code = strip(src("lib/rbac/matrix-actions.ts"));
    const preview = code.slice(
      code.indexOf("function previewMatrixEdit"),
      code.indexOf("function saveMatrixEdit"),
    );
    assert.match(preview, /requireAdmin\("role\.manage"\)/);
    assert.doesNotMatch(preview, /requireWritableAdmin/);
  });

  it("**预演靠抛异常回滚** —— 手动 rollback 会在出错那条路上被跳过", () => {
    const code = strip(src("lib/rbac/matrix-apply.ts"));
    const fn = code.slice(code.indexOf("function previewMatrixChange"));
    assert.match(fn.slice(0, 900), /throw new Error\(ROLLBACK\)/);
  });

  it("**预演之后清缓存** —— 事务回滚了但缓存里还留着改动后的样子", () => {
    const code = strip(src("lib/rbac/matrix-apply.ts"));
    const fn = code.slice(
      code.indexOf("function previewMatrixChange"),
      code.indexOf("function keystoneHoldersAfter"),
    );
    assert.match(fn, /invalidatePermissionCache\(\)/);
  });

  it("落库整串在一个事务里 —— 一半生效的矩阵是最糟的状态", () => {
    const code = strip(src("lib/rbac/matrix-apply.ts"));
    const fn = code.slice(code.indexOf("function applyMatrixChange"));
    assert.match(fn.slice(0, 200), /sqlite\.transaction\(/);
  });

  it("编辑界面是三步走的 —— 预览那一步不能省", () => {
    const ui = src("components/admin/MatrixEditor.tsx");
    assert.match(ui, /previewMatrixEdit/);
    assert.match(ui, /saveMatrixEdit/);
    // 没预览过（diff 为 null）时不该出现保存按钮
    assert.match(ui, /!diff \?/);
  });

  it("**分类切换不走 URL** —— 走 URL 的话攒着的改动会整页丢掉", () => {
    const ui = strip(src("components/admin/MatrixEditor.tsx"));
    assert.match(ui, /setActive\(/);
    assert.doesNotMatch(ui, /router\.push|<Link/, "分类切换用了导航，改动会丢");
  });

  it("矩阵页真的用上了这个编辑器", () => {
    assert.match(src("app/(app)/admin/roles/page.tsx"), /<MatrixEditor/);
  });
});

describe("**认不出的东西一律拒绝**", () => {
  const base = {
    actorPermissions: new Set(["role.manage", "forum.post.create"]),
    actorPriority: 100,
    rolePriority: new Map([["r1", 90]]),
    keystoneHoldersAfter: 2,
    reason: "生产演练时发现的",
  };

  it("拼错的权限点不会被静默存下来", () => {
    /*
     * 生产演练里我自己就写错了一个:`user.ban` 根本不存在（是 user.suspend）。
     * 原来的实现会把它当成一次正常改动存进 role_permissions ——
     * 一行永远匹配不到任何东西的记录。
     *
     * 「存下来了但不起作用」是这套系统里最难查的一类问题:
     * 矩阵上看着是打勾的,而判定永远走不到那一格。
     */
    const errors = guardrailErrors({
      ...base,
      changes: [
        { roleId: "r1", roleName: "管理员", permissionKey: "user.ban", from: "none", to: "granted" },
      ],
    });
    assert.ok(errors.some((e) => e.includes("user.ban")), errors.join("；"));
  });

  it("真实的权限点照样放行", () => {
    const errors = guardrailErrors({
      ...base,
      changes: [
        {
          roleId: "r1",
          roleName: "管理员",
          permissionKey: "forum.post.create",
          from: "none",
          to: "granted",
        },
      ],
    });
    assert.deepEqual(errors, []);
  });

  it("**退役掉的权限点会被拒** —— 它已经不在清单里了", () => {
    /*
     * 这一条是退役机制的另一半：seed 把它从库里删掉，
     * 而这里挡住「再把它加回来」。
     *
     * `forum.view` 是真的退役过的 —— 论坛能不能看已经有
     * `site.forum_public` 和版块的 `visible_to` 两层在管，
     * 第三个勾只会让人搞不清最后谁说了算。
     */
    const errors = guardrailErrors({
      ...base,
      changes: [
        { roleId: "r1", roleName: "管理员", permissionKey: "forum.view", from: "none", to: "granted" },
      ],
    });
    assert.ok(errors.some((e) => e.includes("forum.view")), errors.join("；"));
  });

  it("认不出的身份组也拒绝 —— 它可能刚被删掉了", () => {
    const errors = guardrailErrors({
      ...base,
      changes: [
        {
          roleId: "nope",
          roleName: "不存在",
          permissionKey: "forum.post.create",
          from: "none",
          to: "granted",
        },
      ],
    });
    assert.ok(errors.some((e) => e.includes("找不到")));
  });

  it("**认不出的身份组不会因为优先级默认 0 而蒙混过关**", () => {
    // rolePriority.get() 返回 undefined → ?? 0 → 比谁都低 → 优先级检查放行
    const errors = guardrailErrors({
      ...base,
      actorPriority: 1,
      changes: [
        {
          roleId: "nope",
          roleName: "不存在",
          permissionKey: "forum.post.create",
          from: "none",
          to: "granted",
        },
      ],
    });
    assert.notDeepEqual(errors, []);
  });
});
