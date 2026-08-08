import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 权限矩阵与反查测试。
 *
 * 反查是治理动作的基础 —— 「谁能封人」答错了比不知道更危险。
 * 三个来源（身份组授予、用户级例外、显式拒绝）互相覆盖的顺序
 * 必须与 can() 里的判定链完全一致，否则后台显示的和实际生效的会不一样。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-perm-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type PermModule = typeof import("@/lib/admin/permissions");
type CanModule = typeof import("@/lib/rbac/can");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let perms: PermModule;
let canMod: CanModule;
let dbm: DbModule;
let schema: SchemaModule;

const PERMISSION = "user.suspend" as const;
let adminRoleId: string;
let memberRoleId: string;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { seedDatabase } = await import("@/lib/db/seed");
  seedDatabase();
  perms = await import("@/lib/admin/permissions");
  canMod = await import("@/lib/rbac/can");

  const all = dbm.db.select().from(schema.roles).all();
  adminRoleId = all.find((r) => r.key === "admin")!.id;
  memberRoleId = all.find((r) => r.key === "member")!.id;
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.userRoles).run();
  dbm.db.delete(schema.permissionOverrides).run();
  dbm.db.delete(schema.users).run();
  dbm.db
    .insert(schema.users)
    .values([
      { id: "u_a", wxId: "wx_a", siteNickname: "阿甲", status: "active" },
      { id: "u_b", wxId: "wx_b", siteNickname: "阿乙", status: "active" },
    ])
    .run();
  canMod.invalidatePermissionCache();
});

describe("权限矩阵", () => {
  it("列出全部身份组与权限点", () => {
    const matrix = perms.buildMatrix();
    assert.ok(matrix.roles.length >= 8, `只有 ${matrix.roles.length} 个身份组`);
    const total = matrix.categories.reduce((n, c) => n + c.permissions.length, 0);
    assert.ok(total >= 60, `只有 ${total} 个权限点`);
  });

  it("三态齐全：允许 / 显式拒绝 / 未授予", () => {
    const matrix = perms.buildMatrix();
    const states = new Set<string>();
    for (const map of matrix.cells.values()) for (const state of map.values()) states.add(state);
    assert.ok(states.has("granted"), "应有允许");
    assert.ok(states.has("denied"), "admin 对 system.settings 是显式拒绝，应有拒绝态");
  });

  it("持有人数与实际授权一致", () => {
    dbm.db
      .insert(schema.userRoles)
      .values([
        { userId: "u_a", roleId: adminRoleId },
        { userId: "u_b", roleId: adminRoleId },
      ])
      .run();

    const matrix = perms.buildMatrix();
    const admin = matrix.roles.find((r) => r.key === "admin")!;
    assert.equal(admin.holders, 2);
  });

  it("撤销过的授权不计入人数", () => {
    dbm.db
      .insert(schema.userRoles)
      .values([
        { userId: "u_a", roleId: adminRoleId },
        { userId: "u_b", roleId: adminRoleId, revokedAt: Date.now() },
      ])
      .run();

    const admin = perms.buildMatrix().roles.find((r) => r.key === "admin")!;
    assert.equal(admin.holders, 1);
  });
});

describe("权限反查", () => {
  it("列出通过身份组拿到权限的人", () => {
    dbm.db.insert(schema.userRoles).values({ userId: "u_a", roleId: adminRoleId }).run();
    const holders = perms.whoHasPermission(PERMISSION);
    assert.equal(holders.length, 1);
    assert.equal(holders[0].userId, "u_a");
    assert.match(holders[0].source, /身份组/);
  });

  it("没有这个权限的身份组不会被列出来", () => {
    dbm.db.insert(schema.userRoles).values({ userId: "u_b", roleId: memberRoleId }).run();
    assert.deepEqual(perms.whoHasPermission(PERMISSION), []);
  });

  it("**已过期的临时授权不算数**", () => {
    dbm.db
      .insert(schema.userRoles)
      .values({ userId: "u_a", roleId: adminRoleId, expiresAt: Date.now() - 1000 })
      .run();
    assert.deepEqual(perms.whoHasPermission(PERMISSION), [], "到期的授权不该还显示在持有者里");
  });

  it("未过期的临时授权算数，并标出到期时间", () => {
    const expiresAt = Date.now() + 86_400_000;
    dbm.db.insert(schema.userRoles).values({ userId: "u_a", roleId: adminRoleId, expiresAt }).run();
    const holders = perms.whoHasPermission(PERMISSION);
    assert.equal(holders.length, 1);
    assert.equal(holders[0].expiresAt, expiresAt);
  });

  it("撤销的授权不算数", () => {
    dbm.db
      .insert(schema.userRoles)
      .values({ userId: "u_a", roleId: adminRoleId, revokedAt: Date.now() })
      .run();
    assert.deepEqual(perms.whoHasPermission(PERMISSION), []);
  });

  it("用户级例外能单独授予", () => {
    dbm.db
      .insert(schema.permissionOverrides)
      .values({
        userId: "u_b",
        permissionKey: PERMISSION,
        granted: true,
        reason: "临时处理刷屏",
        grantedBy: "u_a",
      })
      .run();

    const holders = perms.whoHasPermission(PERMISSION);
    assert.equal(holders.length, 1);
    assert.equal(holders[0].userId, "u_b");
    assert.match(holders[0].source, /用户级例外/);
  });

  it("**用户级拒绝会把身份组给的权限剔掉**", () => {
    dbm.db.insert(schema.userRoles).values({ userId: "u_a", roleId: adminRoleId }).run();
    dbm.db
      .insert(schema.permissionOverrides)
      .values({
        userId: "u_a",
        permissionKey: PERMISSION,
        granted: false,
        reason: "暂停这项权限",
        grantedBy: "u_b",
      })
      .run();

    assert.deepEqual(
      perms.whoHasPermission(PERMISSION),
      [],
      "被单独禁止的人不该出现在持有者名单里",
    );
  });

  it("**反查结果与 can() 的判定完全一致**", () => {
    // 后台显示的和实际生效的不一样，比不显示更危险
    dbm.db.insert(schema.userRoles).values({ userId: "u_a", roleId: adminRoleId }).run();
    dbm.db.insert(schema.userRoles).values({ userId: "u_b", roleId: memberRoleId }).run();
    canMod.invalidatePermissionCache();

    const holderIds = new Set(perms.whoHasPermission(PERMISSION).map((h) => h.userId));

    for (const id of ["u_a", "u_b"]) {
      const user = dbm.db.select().from(schema.users).all().find((u) => u.id === id)!;
      const allowed = canMod.can(user, PERMISSION).allowed;
      assert.equal(
        holderIds.has(id),
        allowed,
        `${id}：反查说${holderIds.has(id) ? "有" : "没有"}，can() 说${allowed ? "有" : "没有"}`,
      );
    }
  });

  it("同一个人从多个身份组拿到同一权限时只列一次", () => {
    dbm.db
      .insert(schema.userRoles)
      .values([
        { userId: "u_a", roleId: adminRoleId },
        { userId: "u_a", roleId: memberRoleId },
      ])
      .run();
    const holders = perms.whoHasPermission(PERMISSION);
    assert.equal(holders.filter((h) => h.userId === "u_a").length, 1);
  });
});

describe("分类标签", () => {
  it("已知分类有中文名", () => {
    assert.equal(perms.categoryLabel("forum"), "论坛");
    assert.equal(perms.categoryLabel("system"), "系统");
  });

  it("未知分类原样返回，不会显示成 undefined", () => {
    assert.equal(perms.categoryLabel("brand_new"), "brand_new");
  });
});
