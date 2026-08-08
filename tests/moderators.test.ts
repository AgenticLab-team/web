import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 版主任免。
 *
 * 版主权限是**限定版块**的，且支持到期自动回收 ——
 * 「临时帮忙看两周」是最常见的情形，而不设到期的话，
 * 一年后没人记得当初为什么给了这个人权限，也没人好意思去收。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-mods-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type Mod = typeof import("@/lib/admin/moderators");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let mod: Mod;
let dbm: DbModule;
let schema: SchemaModule;
let moderatorRoleId: string;

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { seedDatabase } = await import("@/lib/db/seed");
  seedDatabase();
  mod = await import("@/lib/admin/moderators");

  moderatorRoleId = dbm.db
    .select()
    .from(schema.roles)
    .all()
    .find((r) => r.key === "moderator")!.id;
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.userRoles).run();
  dbm.db.delete(schema.users).run();
  dbm.db
    .insert(schema.users)
    .values([
      // 绑定成功的用户 status 是 active（见 auth/bind.ts）；
      // 候选人只列 active 的，不该把待绑定或已封禁的人列进来
      { id: "u1", wxId: "wx1", siteNickname: "甲", status: "active", lastActiveAt: NOW },
      { id: "u2", wxId: "wx2", siteNickname: "乙", status: "active", lastActiveAt: NOW - DAY },
      { id: "u3", wxId: "wx3", siteNickname: "丙", status: "active" },
    ])
    .run();
});

function appoint(userId: string, boardId: string, over: Record<string, unknown> = {}) {
  dbm.db
    .insert(schema.userRoles)
    .values({
      userId,
      roleId: moderatorRoleId,
      scopeType: "board",
      scopeId: boardId,
      grantReason: "帮忙看两周",
      ...over,
    })
    .run();
}

describe("按版块列出", () => {
  it("只列这个版块的版主", () => {
    appoint("u1", "b1");
    appoint("u2", "b2");

    const list = mod.moderatorsOf("b1", NOW);
    assert.equal(list.length, 1);
    assert.equal(list[0].userId, "u1");
  });

  it("解除过的不再列出", () => {
    appoint("u1", "b1", { revokedAt: NOW });
    assert.equal(mod.moderatorsOf("b1", NOW).length, 0);
  });

  it("**过期的仍然列出，只是标记为已到期**", () => {
    // 悄悄消失会让人以为系统弄丢了配置
    appoint("u1", "b1", { expiresAt: NOW - DAY });
    const list = mod.moderatorsOf("b1", NOW);
    assert.equal(list.length, 1);
    assert.equal(list[0].expired, true);
  });

  it("**七天内到期的会被标出来**", () => {
    appoint("u1", "b1", { expiresAt: NOW + 3 * DAY });
    const m = mod.moderatorsOf("b1", NOW)[0];
    assert.equal(m.expired, false);
    assert.equal(m.expiringSoon, true);
  });

  it("还早的不算快到期", () => {
    appoint("u1", "b1", { expiresAt: NOW + 60 * DAY });
    assert.equal(mod.moderatorsOf("b1", NOW)[0].expiringSoon, false);
  });

  it("不设到期的既不过期也不快到期", () => {
    appoint("u1", "b1");
    const m = mod.moderatorsOf("b1", NOW)[0];
    assert.equal(m.expiresAt, null);
    assert.equal(m.expired, false);
    assert.equal(m.expiringSoon, false);
  });

  it("带出任命理由 —— 一年后要能回答「当初为什么给他」", () => {
    appoint("u1", "b1");
    assert.equal(mod.moderatorsOf("b1", NOW)[0].grantReason, "帮忙看两周");
  });

  it("**昵称走统一解析，不会漏出 wxid**", () => {
    dbm.db
      .insert(schema.users)
      .values({ id: "u_bare", wxId: "wxid_leak123", siteNickname: null, wxNickname: null, status: "active" })
      .run();
    appoint("u_bare", "b1");

    const name = mod.moderatorsOf("b1", NOW)[0].name;
    assert.ok(!name.includes("wxid_"), `漏出了 wxid：${name}`);
  });

  it("没有版主时返回空数组", () => {
    assert.deepEqual(mod.moderatorsOf("b_empty", NOW), []);
  });
});

describe("全站在任概览", () => {
  it("只算在任的", () => {
    appoint("u1", "b1");
    appoint("u2", "b1", { expiresAt: NOW - DAY });
    appoint("u3", "b2", { revokedAt: NOW });

    const all = mod.allBoardModerators(NOW);
    assert.equal(all.length, 1);
    assert.equal(all[0].userId, "u1");
  });

  it("未到期的算在任", () => {
    appoint("u1", "b1", { expiresAt: NOW + DAY });
    assert.equal(mod.allBoardModerators(NOW).length, 1);
  });
});

describe("候选人", () => {
  it("**只列登录过网站的人**", () => {
    // 从没打开过网站的人当版主等于没有版主
    const ids = mod.moderatorCandidates("b1").map((c) => c.id);
    assert.ok(ids.includes("u1"));
    assert.ok(ids.includes("u2"));
    assert.ok(!ids.includes("u3"), "从没登录过的不该出现在候选里");
  });

  it("已经是这个版块版主的不再出现", () => {
    appoint("u1", "b1");
    assert.ok(!mod.moderatorCandidates("b1").map((c) => c.id).includes("u1"));
  });

  it("是别的版块版主的仍然可以被任命", () => {
    appoint("u1", "b2");
    assert.ok(mod.moderatorCandidates("b1").map((c) => c.id).includes("u1"));
  });

  it("最近活跃的排前面", () => {
    const list = mod.moderatorCandidates("b1");
    assert.equal(list[0].id, "u1");
  });

  it("被封禁的不能当候选人", () => {
    dbm.db.delete(schema.users).run();
    dbm.db
      .insert(schema.users)
      .values({ id: "u_banned", wxId: "wxb", siteNickname: "被封", status: "banned", lastActiveAt: NOW })
      .run();

    assert.equal(mod.moderatorCandidates("b1").length, 0);
  });
});
