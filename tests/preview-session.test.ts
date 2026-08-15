import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 预览会话的完整往返：开、还原、退出。
 *
 * 规则那一层已经单独测过了（tests/preview-rules.test.ts）。
 * 这里测的是**真的落了库之后**还成不成立 ——
 * 令牌是不是只存哈希、撤权之后还原是不是立刻失效、
 * 退出之后同一个令牌还能不能再用。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-preview-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let preview: typeof import("@/lib/rbac/preview");
let can: typeof import("@/lib/rbac/can");
let session: typeof import("@/lib/auth/session");

const ADMIN_ROLE = "01ROLEADMIN0000000000000AA";
const MOD_ROLE = "01ROLEMOD00000000000000AA";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  preview = await import("@/lib/rbac/preview");
  can = await import("@/lib/rbac/can");
  session = await import("@/lib/auth/session");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function makeUser(id: string, wxId: string, status = "active") {
  dbm.db
    .insert(schema.users)
    .values({ id, wxId, wxNickname: wxId, status: status as "active" })
    .run();
}

function grant(userId: string, roleId: string) {
  dbm.db.insert(schema.userRoles).values({ userId, roleId }).run();
}

beforeEach(() => {
  for (const table of [
    schema.previewSessions,
    schema.userRoles,
    schema.rolePermissions,
    schema.roles,
    schema.users,
    schema.auditLogs,
  ]) {
    dbm.db.delete(table).run();
  }
  can.invalidatePermissionCache();

  dbm.db
    .insert(schema.roles)
    .values([
      { id: ADMIN_ROLE, key: "admin", name: "管理员" },
      { id: MOD_ROLE, key: "mod", name: "版主" },
    ])
    .run();

  dbm.db
    .insert(schema.rolePermissions)
    .values([
      { roleId: ADMIN_ROLE, permissionKey: "system.impersonate", granted: true },
      { roleId: ADMIN_ROLE, permissionKey: "forum.view", granted: true },
      { roleId: ADMIN_ROLE, permissionKey: "forum.post.delete.any", granted: true },
      { roleId: MOD_ROLE, permissionKey: "forum.view", granted: true },
      { roleId: MOD_ROLE, permissionKey: "forum.post.delete.any", granted: true },
    ])
    .run();
  can.invalidatePermissionCache();

  makeUser("01ADMIN000000000000000000", "admin_wx");
  makeUser("01MOD00000000000000000000", "mod_wx");
  grant("01ADMIN000000000000000000", ADMIN_ROLE);
  grant("01MOD00000000000000000000", MOD_ROLE);
});

const ADMIN = "01ADMIN000000000000000000";
const MOD = "01MOD00000000000000000000";

describe("开一次预览", () => {
  it("拿得到令牌，能还原成被预览的那个人", () => {
    const started = preview.startPreview(ADMIN, MOD);
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const active = preview.resolvePreview(started.token);
    assert.equal(active?.subject.id, MOD);
    assert.equal(active?.viewer.id, ADMIN, "真实身份丢了 —— 审计就没法记在真人头上");
  });

  it("**库里只存哈希** —— 数据库泄露不等于能变成别人", () => {
    const started = preview.startPreview(ADMIN, MOD);
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const row = dbm.db.select().from(schema.previewSessions).get()!;
    assert.notEqual(row.tokenHash, started.token);
    assert.equal(row.tokenHash.length, 64);
  });

  it("**进入就记审计**，记的是真人", () => {
    preview.startPreview(ADMIN, MOD);
    const log = dbm.db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "rbac.preview.start"))
      .get();

    assert.ok(log, "预览是只读的，只在写操作时记账的话这个功能永远不产生日志");
    assert.equal(log!.actorId, ADMIN);
    assert.equal(log!.targetId, MOD);
  });

  it("没有那个权限点就开不了", () => {
    const started = preview.startPreview(MOD, ADMIN);
    assert.equal(started.ok, false);
    assert.equal(dbm.db.select().from(schema.previewSessions).all().length, 0);
  });

  it("找不到的人开不了", () => {
    const started = preview.startPreview(ADMIN, "01NOBODY00000000000000000");
    assert.equal(started.ok, false);
    if (started.ok) return;
    assert.match(started.reason, /找不到/);
  });

  it("乱给一个令牌还原不出东西", () => {
    assert.equal(preview.resolvePreview("bogus"), null);
    assert.equal(preview.resolvePreview(undefined), null);
  });
});

describe("★ 预览态下**一个字都不能写**", () => {
  /*
   * ═════════════════════════════════════════
   * 这一组补的是「所有人都依赖、没有人验证」的那一句
   * ═════════════════════════════════════════
   *
   * 后台所有写操作走 `requireWritableAdmin()`，而它第一件事就是
   * `await assertNotPreviewing()`。那句调用有测试守着（源码断言），
   * 而**被调的那一句本身**没有：
   * `scripts/mutate.mjs` 把 `if (preview) throw` 删掉，
   * 整套测试一条都不红 —— 预览态下处处可写。
   *
   * 后果不是「数据被改坏」，是**改动记在了别人名下**：
   * 管理员以某个人的视角复现问题时点了一下，那个动作就成了他的。
   */
  it("★ 有预览在身上 → 抛 PreviewWriteError", async () => {
    await assert.rejects(
      () => session.assertNotPreviewing({ userId: "u_被预览的人" } as never),
      (err: Error) => err.name === "PreviewWriteError",
      "预览态下写操作没被拦住",
    );
  });

  it("不在预览态 → 放行", async () => {
    await session.assertNotPreviewing(null);
  });

  it("**错误信息是给人看的** —— 它会直接显示在后台", async () => {
    const err = await session
      .assertNotPreviewing({ userId: "u_x" } as never)
      .then(() => null)
      .catch((e: Error) => e);
    assert.ok(err);
    assert.ok(err.message.trim().length > 0, "抛了个没有话的错误");
  });
});

describe("**撤权立刻生效**", () => {
  it("令牌还没过期，但权限撤了 —— 预览当场失效", () => {
    const started = preview.startPreview(ADMIN, MOD);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.ok(preview.resolvePreview(started.token), "开完就该能还原");

    /*
     * 令牌是 30 分钟有效的，而权限可能在这 30 分钟里被撤掉。
     * 撤权之后还能继续预览，等于撤权没生效。
     */
    dbm.db
      .delete(schema.rolePermissions)
      .where(eq(schema.rolePermissions.permissionKey, "system.impersonate"))
      .run();
    can.invalidatePermissionCache();

    assert.equal(preview.resolvePreview(started.token), null, "撤权之后还能预览");
  });

  it("被预览的人被封了，预览也当场断掉", () => {
    const started = preview.startPreview(ADMIN, MOD);
    if (!started.ok) return;

    dbm.db.update(schema.users).set({ status: "banned" }).where(eq(schema.users.id, MOD)).run();
    assert.equal(preview.resolvePreview(started.token), null);
  });
});

describe("退出与掐断", () => {
  it("退出之后同一个令牌不能再用", () => {
    const started = preview.startPreview(ADMIN, MOD);
    if (!started.ok) return;

    preview.endPreview(started.token);
    assert.equal(preview.resolvePreview(started.token), null, "退出之后令牌还能用");
  });

  it("退出也记审计", () => {
    const started = preview.startPreview(ADMIN, MOD);
    if (!started.ok) return;
    preview.endPreview(started.token);

    const log = dbm.db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "rbac.preview.end"))
      .get();
    assert.equal(log?.actorId, ADMIN);
  });

  it("重复退出不炸、也不重复记账", () => {
    const started = preview.startPreview(ADMIN, MOD);
    if (!started.ok) return;
    preview.endPreview(started.token);
    preview.endPreview(started.token);

    const logs = dbm.db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "rbac.preview.end"))
      .all();
    assert.equal(logs.length, 1);
  });

  it("**一键掐断某人的全部预览** —— 出事时不必等 cookie 过期", () => {
    makeUser("01OTHER00000000000000000A", "other_wx");
    const a = preview.startPreview(ADMIN, MOD);
    const b = preview.startPreview(ADMIN, "01OTHER00000000000000000A");
    if (!a.ok || !b.ok) return assert.fail("开预览失败");

    assert.equal(preview.revokePreviewsOf(ADMIN), 2);
    assert.equal(preview.resolvePreview(a.token), null);
    assert.equal(preview.resolvePreview(b.token), null);
  });

  it("掐断之后记的是 revoked，不是 exit —— 事后要分得清是谁结束的", () => {
    const started = preview.startPreview(ADMIN, MOD);
    if (!started.ok) return;
    preview.revokePreviewsOf(ADMIN);

    const row = dbm.db.select().from(schema.previewSessions).get()!;
    assert.equal(row.endReason, "revoked");
  });
});

describe("权限交集真的落了库", () => {
  it("**扣掉了哪几项要存下来** —— 事后复盘要能回答「他当时看到的准不准」", () => {
    // 给版主一项管理员没有的权限
    dbm.db
      .insert(schema.rolePermissions)
      .values({ roleId: MOD_ROLE, permissionKey: "moderation.queue", granted: true })
      .run();
    can.invalidatePermissionCache();

    const started = preview.startPreview(ADMIN, MOD);
    assert.equal(started.ok, true);
    if (!started.ok) return;

    assert.deepEqual(started.plan.withheld, ["moderation.queue"]);
    const active = preview.resolvePreview(started.token)!;
    assert.deepEqual(active.withheld, ["moderation.queue"]);
  });

  it("倒计时还原得出来", () => {
    const started = preview.startPreview(ADMIN, MOD);
    if (!started.ok) return;
    const active = preview.resolvePreview(started.token)!;
    assert.ok(active.minutesLeft > 25 && active.minutesLeft <= 30, `${active.minutesLeft} 分钟`);
  });
});

describe("掐断也要留痕", () => {
  it("**被掐断的预览也进审计** —— 生产演练里就是这儿漏的：进去有记录，被掐掉没有", () => {
    const started = preview.startPreview(ADMIN, MOD);
    if (!started.ok) return;
    preview.revokePreviewsOf(ADMIN);

    const logs = dbm.db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "rbac.preview.end"))
      .all();

    assert.equal(logs.length, 1, "掐断恰恰是出事时才发生的动作，那条记录比正常进出更该留着");
    assert.equal(logs[0].actorId, ADMIN);
    assert.equal(logs[0].reason, "revoked");
  });

  it("掐断多条就记多条", () => {
    makeUser("01OTHER00000000000000000B", "other_b");
    preview.startPreview(ADMIN, MOD);
    preview.startPreview(ADMIN, "01OTHER00000000000000000B");
    preview.revokePreviewsOf(ADMIN);

    const logs = dbm.db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "rbac.preview.end"))
      .all();
    assert.equal(logs.length, 2);
  });
});
