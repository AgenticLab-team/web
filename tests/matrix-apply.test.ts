import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 矩阵改动的预演与落库。
 *
 * ─────────────────────────────────────────
 * 这一组里最要紧的一条是「预演不留痕」
 * ─────────────────────────────────────────
 *
 * 预演的办法是真改一遍、量完、回滚。这个办法的好处是预览和现实之间
 * 没有第二份实现;坏处是**回滚一旦漏了,预览就变成了偷偷保存**。
 *
 * 所以每一条预演测试后面都跟着一句「库里没变」。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-matrix-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let apply: typeof import("@/lib/rbac/matrix-apply");
let can: typeof import("@/lib/rbac/can");

const ADMIN_ROLE = "01ROLEADMIN0000000000000AA";
const MOD_ROLE = "01ROLEMOD00000000000000AA";
const U1 = "01USER1000000000000000000";
const U2 = "01USER2000000000000000000";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  apply = await import("@/lib/rbac/matrix-apply");
  can = await import("@/lib/rbac/can");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const change = (roleId: string, key: string, from: "granted" | "denied" | "none", to: "granted" | "denied" | "none") => ({
  roleId,
  roleName: roleId === ADMIN_ROLE ? "管理员" : "版主",
  permissionKey: key,
  from,
  to,
});

beforeEach(() => {
  for (const t of [
    schema.auditLogs,
    schema.userRoles,
    schema.rolePermissions,
    schema.roles,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }
  can.invalidatePermissionCache();

  dbm.db
    .insert(schema.roles)
    .values([
      { id: ADMIN_ROLE, key: "admin", name: "管理员", priority: 90 },
      { id: MOD_ROLE, key: "mod", name: "版主", priority: 70 },
    ])
    .run();
  dbm.db
    .insert(schema.rolePermissions)
    .values([
      { roleId: ADMIN_ROLE, permissionKey: "role.manage", granted: true },
      { roleId: ADMIN_ROLE, permissionKey: "forum.post.delete.any", granted: true },
      { roleId: MOD_ROLE, permissionKey: "forum.view", granted: true },
    ])
    .run();
  dbm.db
    .insert(schema.users)
    .values([
      { id: U1, wxId: "u1", wxNickname: "甲", status: "active" },
      { id: U2, wxId: "u2", wxNickname: "乙", status: "active" },
    ])
    .run();
  dbm.db
    .insert(schema.userRoles)
    .values([
      { userId: U1, roleId: ADMIN_ROLE },
      { userId: U2, roleId: MOD_ROLE },
    ])
    .run();
  can.invalidatePermissionCache();
});

function cellCount() {
  return dbm.db.select().from(schema.rolePermissions).all().length;
}

describe("**预演不留痕**", () => {
  it("预演之后库里一格没变", () => {
    const before = cellCount();
    apply.previewMatrixChange([change(MOD_ROLE, "forum.post.delete.any", "none", "granted")]);
    assert.equal(cellCount(), before, "预演把改动写进去了 —— 这就成了偷偷保存");
  });

  it("预演之后判定也没变 —— 缓存要跟着回滚", () => {
    /*
     * 事务回滚了但权限缓存没清的话,后面每一次 can() 都在用
     * 一个数据库里根本不存在的矩阵 —— 而且不会有任何报错。
     */
    const u2 = dbm.db.select().from(schema.users).where(eq(schema.users.id, U2)).get()!;
    apply.previewMatrixChange([change(MOD_ROLE, "forum.post.delete.any", "none", "granted")]);
    assert.equal(can.can(u2, "forum.post.delete.any").allowed, false, "缓存里留着预演的结果");
  });

  it("量 keystone 也不留痕", () => {
    const before = cellCount();
    apply.keystoneHoldersAfter([change(ADMIN_ROLE, "role.manage", "granted", "none")]);
    assert.equal(cellCount(), before);
  });

  it("连续预演多次，结果一样", () => {
    const c = [change(MOD_ROLE, "forum.post.delete.any", "none", "granted")];
    const a = apply.previewMatrixChange(c).summary;
    const b = apply.previewMatrixChange(c).summary;
    assert.equal(a, b, "第二次预演拿到的是第一次留下的脏状态");
  });
});

describe("影响面是按人算的", () => {
  it("授予之后，那个身份组的人真的多一项", () => {
    const diff = apply.previewMatrixChange([
      change(MOD_ROLE, "forum.post.delete.any", "none", "granted"),
    ]);
    assert.equal(diff.impact.gained.length, 1);
    assert.equal(diff.impact.gained[0].name, "乙");
    assert.deepEqual(diff.impact.gained[0].permissions, ["forum.post.delete.any"]);
    assert.match(diff.summary, /获得 1 项/);
    assert.match(diff.summary, /影响 1 人/);
  });

  it("收回之后，那个人真的少一项", () => {
    const diff = apply.previewMatrixChange([
      change(ADMIN_ROLE, "forum.post.delete.any", "granted", "none"),
    ]);
    assert.equal(diff.impact.lost[0].name, "甲");
    assert.match(diff.summary, /失去 1 项/);
  });

  it("**没人持有的身份组，影响 0 人** —— 而不是按身份组数量瞎报", () => {
    dbm.db.delete(schema.userRoles).where(eq(schema.userRoles.roleId, MOD_ROLE)).run();
    can.invalidatePermissionCache();

    const diff = apply.previewMatrixChange([
      change(MOD_ROLE, "forum.post.delete.any", "none", "granted"),
    ]);
    assert.equal(diff.summary, "没有人的实际权限会改变");
  });

  it("**他从别的身份组已经有了，就不算获得**", () => {
    // 甲同时是管理员和版主；管理员已经给了他 delete.any
    dbm.db.insert(schema.userRoles).values({ userId: U1, roleId: MOD_ROLE }).run();
    can.invalidatePermissionCache();

    const diff = apply.previewMatrixChange([
      change(MOD_ROLE, "forum.post.delete.any", "none", "granted"),
    ]);
    const gainedByJia = diff.impact.gained.find((u) => u.userId === U1);
    assert.equal(gainedByJia, undefined, "他本来就有，却报成了新获得");
  });

  it("**改成显式拒绝会打掉他从别的组拿到的权限** —— 这条最容易估错", () => {
    /*
     * 看着像「没给他加东西」,实际是「拿走了他的东西」。
     * 甲从管理员组有 delete.any；给版主组加一条显式拒绝,
     * 而他也在版主组里 —— 显式拒绝压过任何允许。
     */
    dbm.db.insert(schema.userRoles).values({ userId: U1, roleId: MOD_ROLE }).run();
    can.invalidatePermissionCache();

    const diff = apply.previewMatrixChange([
      change(MOD_ROLE, "forum.post.delete.any", "none", "denied"),
    ]);
    const lost = diff.impact.lost.find((u) => u.userId === U1);
    assert.ok(lost, "显式拒绝没被算成「失去」—— 那预览就是错的");
    assert.deepEqual(lost!.permissions, ["forum.post.delete.any"]);
  });
});

describe("keystone 计数", () => {
  it("把 role.manage 摘掉之后就没人能改矩阵了", () => {
    assert.equal(apply.keystoneHoldersAfter([change(ADMIN_ROLE, "role.manage", "granted", "none")]), 0);
  });

  it("不动它的时候还有人", () => {
    assert.equal(apply.keystoneHoldersAfter([change(MOD_ROLE, "forum.view", "granted", "none")]), 1);
  });

  it("**封禁的人不算数** —— 他握着钥匙也开不了门", () => {
    dbm.db.update(schema.users).set({ status: "banned" }).where(eq(schema.users.id, U1)).run();
    can.invalidatePermissionCache();
    assert.equal(apply.keystoneHoldersAfter([]), 0);
  });
});

describe("真的保存", () => {
  it("格子写进去了", () => {
    const changes = [change(MOD_ROLE, "forum.post.delete.any", "none", "granted")];
    apply.applyMatrixChange(changes, U1, "让版主能删帖", { gained: [], lost: [] });

    const row = dbm.db
      .select()
      .from(schema.rolePermissions)
      .where(eq(schema.rolePermissions.permissionKey, "forum.post.delete.any"))
      .all()
      .find((r) => r.roleId === MOD_ROLE);
    assert.ok(row);
    assert.equal(row!.granted, true);
  });

  it("**none 是删掉这一行，不是存一行 false** —— false 是显式拒绝，两回事", () => {
    apply.applyMatrixChange(
      [change(MOD_ROLE, "forum.view", "granted", "none")],
      U1,
      "收回",
      { gained: [], lost: [] },
    );
    const rows = dbm.db
      .select()
      .from(schema.rolePermissions)
      .where(eq(schema.rolePermissions.permissionKey, "forum.view"))
      .all();
    assert.equal(rows.length, 0, "存成了 granted=false —— 那是显式拒绝，会压过别的身份组");
  });

  it("显式拒绝存的是 granted=false", () => {
    apply.applyMatrixChange(
      [change(MOD_ROLE, "forum.view", "granted", "denied")],
      U1,
      "禁掉",
      { gained: [], lost: [] },
    );
    const row = dbm.db
      .select()
      .from(schema.rolePermissions)
      .where(eq(schema.rolePermissions.permissionKey, "forum.view"))
      .get();
    assert.equal(row?.granted, false);
  });

  it("保存之后判定立刻跟着变 —— 缓存要清", () => {
    apply.applyMatrixChange(
      [change(MOD_ROLE, "forum.post.delete.any", "none", "granted")],
      U1,
      "让版主能删帖",
      { gained: [], lost: [] },
    );
    const u2 = dbm.db.select().from(schema.users).where(eq(schema.users.id, U2)).get()!;
    assert.equal(can.can(u2, "forum.post.delete.any").allowed, true);
  });

  it("**一次改动一条审计，不是一格一条**", () => {
    /*
     * 一格一条的话,改三十格会在日志里刷出三十行,
     * 而事后要回答的是「那次改动做了什么」,不是「第 17 格变成了什么」。
     */
    apply.applyMatrixChange(
      [
        change(MOD_ROLE, "forum.post.delete.any", "none", "granted"),
        change(MOD_ROLE, "forum.post.edit.any", "none", "granted"),
        change(MOD_ROLE, "moderation.queue", "none", "granted"),
      ],
      U1,
      "版主扩权",
      { gained: [{ userId: U2, name: "乙", permissions: ["a", "b", "c"] }], lost: [] },
    );

    const logs = dbm.db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "rbac.matrix.edit"))
      .all();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].actorId, U1);
  });

  it("**审计里带着影响面** —— 事后复盘要知道当时以为会影响谁", () => {
    apply.applyMatrixChange(
      [change(MOD_ROLE, "forum.post.delete.any", "none", "granted")],
      U1,
      "版主扩权",
      { gained: [{ userId: U2, name: "乙", permissions: ["forum.post.delete.any"] }], lost: [] },
    );
    const log = dbm.db.select().from(schema.auditLogs).get()!;
    assert.match(log.reason!, /版主扩权/);
    assert.match(log.reason!, /影响 1 人/);
  });

  it("改前改后都记下来了", () => {
    apply.applyMatrixChange(
      [change(MOD_ROLE, "forum.view", "granted", "denied")],
      U1,
      "禁掉版主看论坛",
      { gained: [], lost: [] },
    );
    const log = dbm.db.select().from(schema.auditLogs).get()!;
    assert.match(JSON.stringify(log.before), /granted/);
    assert.match(JSON.stringify(log.after), /denied/);
  });
});

describe("操作者的优先级", () => {
  it("取手上最高的那个", () => {
    dbm.db.insert(schema.userRoles).values({ userId: U2, roleId: ADMIN_ROLE }).run();
    assert.equal(apply.actorPriority(U2), 90);
  });

  it("撤销过的身份组不算", () => {
    dbm.db
      .insert(schema.userRoles)
      .values({ userId: U2, roleId: ADMIN_ROLE, revokedAt: Date.now() })
      .run();
    assert.equal(apply.actorPriority(U2), 70);
  });

  it("什么都没有的人是 0", () => {
    dbm.db.delete(schema.userRoles).run();
    assert.equal(apply.actorPriority(U2), 0);
  });
});
