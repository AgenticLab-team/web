import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { and, eq } from "drizzle-orm";

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

  /*
   * ═════════════════════════════════════════
   * 下面这一组是**变异测试逼出来的**
   * ═════════════════════════════════════════
   *
   * `scripts/mutate.mjs` 往 `can()` 里下刀，四刀活了下来 ——
   * 也就是说：把封禁检查整段删掉、把身份组的「明确禁止」删掉、
   * 把用户级授权和禁止的顺序调换、让过期的授权继续算数，
   * **整套测试一条都不会红**。
   *
   * 那四处都不是边角：它们是「谁能做什么」这条链上最靠前的几道闸。
   */
  it("★ 封禁 / 注销 / 暂停的账号，哪怕身份组给了权限也一律拒绝", () => {
    dbm.db.insert(schema.userRoles).values({ userId: "u_a", roleId: adminRoleId }).run();
    canMod.invalidatePermissionCache();

    const load = () => dbm.db.select().from(schema.users).all().find((u) => u.id === "u_a")!;
    assert.equal(canMod.can(load(), PERMISSION).allowed, true, "先确认这个身份组本来是有权限的");

    for (const status of ["banned", "deleted", "suspended"] as const) {
      dbm.db.update(schema.users).set({ status }).where(eq(schema.users.id, "u_a")).run();
      const d = canMod.can(load(), PERMISSION);
      assert.equal(d.allowed, false, `status=${status} 时仍然放行了`);
    }
  });

  it("★ 就算 banned 这个身份组被误配了权限，封禁的人也一样拿不到", () => {
    /*
     * ═════════════════════════════════════════
     * 这一条测的是**冗余本身**
     * ═════════════════════════════════════════
     *
     * `can()` 最前面有一道「封禁 / 注销一切免谈」，而 `effectiveRoles()`
     * 里还有一道：封禁的人只剩一个 `banned` 隐式身份组，
     * 原来的身份组全丢掉。两道闸互相冗余 ——
     * 所以把前面那道删掉，上面那条测试照样绿
     * （`scripts/mutate.mjs` 里那一刀一直活着）。
     *
     * 冗余不是多余：第二道闸只在「banned 身份组没有任何权限」时才够。
     * 而权限是后台可以配的 —— 有人手滑给 banned 配上一条，
     * 第二道闸就破了，只剩最前面那一道。
     *
     * 所以这里直接把那个手滑造出来：给 banned 配上权限，
     * 再确认封禁的人依然拿不到。这样两道闸各自都被验过。
     */
    const bannedRoleId = dbm.db
      .select()
      .from(schema.roles)
      .all()
      .find((r) => r.key === "banned")!.id;

    const before = dbm.db
      .select()
      .from(schema.rolePermissions)
      .all()
      .find((r) => r.roleId === bannedRoleId && r.permissionKey === PERMISSION);

    dbm.db
      .insert(schema.rolePermissions)
      .values({ roleId: bannedRoleId, permissionKey: PERMISSION, granted: true })
      .onConflictDoUpdate({
        target: [schema.rolePermissions.roleId, schema.rolePermissions.permissionKey],
        set: { granted: true },
      })
      .run();
    dbm.db.update(schema.users).set({ status: "banned" }).where(eq(schema.users.id, "u_a")).run();
    canMod.invalidatePermissionCache();

    try {
      const user = dbm.db.select().from(schema.users).all().find((u) => u.id === "u_a")!;
      assert.equal(
        canMod.can(user, PERMISSION).allowed,
        false,
        "banned 身份组被误配权限之后，封禁的人拿到了权限",
      );
    } finally {
      dbm.db
        .delete(schema.rolePermissions)
        .where(
          and(
            eq(schema.rolePermissions.roleId, bannedRoleId),
            eq(schema.rolePermissions.permissionKey, PERMISSION),
          ),
        )
        .run();
      if (before) dbm.db.insert(schema.rolePermissions).values(before).run();
      canMod.invalidatePermissionCache();
    }
  });

  it("★ 身份组里的「明确禁止」压过另一个身份组的允许", () => {
    // 一个人同时在两个组里：一个给了权限，一个明确禁止 —— 必须是禁止赢
    dbm.db
      .insert(schema.userRoles)
      .values([
        { userId: "u_a", roleId: adminRoleId },
        { userId: "u_a", roleId: memberRoleId },
      ])
      .run();
    /*
     * ⚠️ `beforeEach` 不清 `rolePermissions`（那是种子数据），
     * 所以这里改完必须自己还原 —— 第一版没还原，
     * 把后面一条**原有的**测试搞红了，而那看起来像是那条测试坏了。
     */
    const before = dbm.db
      .select()
      .from(schema.rolePermissions)
      .all()
      .find((r) => r.roleId === memberRoleId && r.permissionKey === PERMISSION);
    dbm.db
      .insert(schema.rolePermissions)
      .values({ roleId: memberRoleId, permissionKey: PERMISSION, granted: false })
      .onConflictDoUpdate({
        target: [schema.rolePermissions.roleId, schema.rolePermissions.permissionKey],
        set: { granted: false },
      })
      .run();
    canMod.invalidatePermissionCache();

    try {
      const user = dbm.db.select().from(schema.users).all().find((u) => u.id === "u_a")!;
      assert.equal(canMod.can(user, PERMISSION).allowed, false, "明确禁止没有压过允许");
    } finally {
      dbm.db
        .delete(schema.rolePermissions)
        .where(
          and(
            eq(schema.rolePermissions.roleId, memberRoleId),
            eq(schema.rolePermissions.permissionKey, PERMISSION),
          ),
        )
        .run();
      if (before) dbm.db.insert(schema.rolePermissions).values(before).run();
      canMod.invalidatePermissionCache();
    }
  });

  it("★ 用户级的「禁止」压过用户级的「授权」（顺序不能反）", () => {
    /*
     * 同一个人身上同时挂着一条授权和一条禁止 —— 这在治理里是真实存在的：
     * 先临时授权，出了事再单独禁止，而那条授权还没到期。
     * 判定链里禁止必须先看，否则「先禁后授」和「先授后禁」结果不一样，
     * 而两条记录的先后在库里是不保证的。
     */
    dbm.db
      .insert(schema.permissionOverrides)
      .values([
        { userId: "u_a", permissionKey: PERMISSION, granted: true, reason: "临时授权", grantedBy: "u_b" },
        { userId: "u_a", permissionKey: PERMISSION, granted: false, reason: "出事了，单独禁止", grantedBy: "u_b" },
      ])
      .run();
    canMod.invalidatePermissionCache();

    const user = dbm.db.select().from(schema.users).all().find((u) => u.id === "u_a")!;
    const d = canMod.can(user, PERMISSION);
    assert.equal(d.allowed, false, "同时有授权和禁止时，禁止必须赢");
    assert.match(d.reason ?? "", /单独禁止/);
  });

  it("★ 过期的用户级授权不算数", () => {
    dbm.db
      .insert(schema.permissionOverrides)
      .values({
        userId: "u_a",
        permissionKey: PERMISSION,
        granted: true,
        reason: "上周的临时授权",
        grantedBy: "u_b",
        expiresAt: Date.now() - 60_000,
      })
      .run();
    canMod.invalidatePermissionCache();

    const user = dbm.db.select().from(schema.users).all().find((u) => u.id === "u_a")!;
    assert.equal(canMod.can(user, PERMISSION).allowed, false, "已经过期的授权还在生效");
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
