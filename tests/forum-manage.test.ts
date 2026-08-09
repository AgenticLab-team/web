import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { and, eq } from "drizzle-orm";

/**
 * 帖子页行内管理的权限边界。
 *
 * 这里测的是最不能出错的那几条线：
 *   - 自己的帖 vs 别人的帖
 *   - 版主的版块 vs 别人的版块（scope 匹配）
 *   - 已软删除的帖子还能做什么
 *   - 管理员删的帖子作者不能自己捞回来
 *
 * 所有判定都必须走 can() —— 测试直接用数据库里的角色配置驱动，
 * 不 mock 权限层：mock 掉它就等于没测。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-manage-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type ManageModule = typeof import("@/lib/forum/manage");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");
type CanModule = typeof import("@/lib/rbac/can");

let mod: ManageModule;
let dbm: DbModule;
let schema: SchemaModule;
let rbac: CanModule;

const AUTHOR = "u_author";
const OTHER = "u_other";
const MOD_B1 = "u_mod_b1"; // 只管 b1 的版主
const BANNED = "u_banned";

function user(id: string) {
  return dbm.db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;
}

function post(id: string) {
  return dbm.db.select().from(schema.posts).where(eq(schema.posts.id, id)).get()!;
}

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  mod = await import("@/lib/forum/manage");
  rbac = await import("@/lib/rbac/can");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.moderationActions,
    schema.notifications,
    schema.auditLogs,
    schema.userRoles,
    schema.rolePermissions,
    schema.roles,
    schema.posts,
    schema.boards,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }

  dbm.db
    .insert(schema.roles)
    .values([
      { id: "r_member", key: "member", name: "成员" },
      { id: "r_mod", key: "moderator", name: "版主" },
    ])
    .run();

  dbm.db
    .insert(schema.rolePermissions)
    .values([
      { roleId: "r_member", permissionKey: "forum.post.edit.own" },
      { roleId: "r_member", permissionKey: "forum.post.delete.own" },
      { roleId: "r_mod", permissionKey: "forum.post.edit.own" },
      { roleId: "r_mod", permissionKey: "forum.post.delete.own" },
      { roleId: "r_mod", permissionKey: "forum.post.edit.any" },
      { roleId: "r_mod", permissionKey: "forum.post.delete.any" },
      { roleId: "r_mod", permissionKey: "forum.post.feature" },
      { roleId: "r_mod", permissionKey: "forum.post.pin" },
      { roleId: "r_mod", permissionKey: "forum.post.lock" },
      { roleId: "r_mod", permissionKey: "forum.post.move" },
    ])
    .run();

  dbm.db
    .insert(schema.users)
    .values([
      { id: AUTHOR, wxId: "wx_author", siteNickname: "作者" },
      { id: OTHER, wxId: "wx_other", siteNickname: "路人" },
      { id: MOD_B1, wxId: "wx_mod", siteNickname: "版主" },
      { id: BANNED, wxId: "wx_banned", siteNickname: "封禁", status: "banned" },
    ])
    .run();

  // 版主的权限**限定在 b1**：scope 不匹配时必须拒绝
  dbm.db
    .insert(schema.userRoles)
    .values([{ userId: MOD_B1, roleId: "r_mod", scopeType: "board", scopeId: "b1", grantedBy: "sys" }])
    .run();

  dbm.db
    .insert(schema.boards)
    .values([
      { id: "b1", key: "general", name: "综合", maxVisibility: "public" },
      { id: "b2", key: "inner", name: "内部", maxVisibility: "member" },
      { id: "b_locked", key: "closed", name: "封存", locked: true },
    ])
    .run();

  dbm.db
    .insert(schema.posts)
    .values([
      {
        id: "p1",
        boardId: "b1",
        authorId: AUTHOR,
        title: "作者的帖子",
        content: "正文",
        contentHtml: "<p>正文</p>",
        visibility: "public",
      },
      {
        id: "p2",
        boardId: "b2",
        authorId: OTHER,
        title: "别的版块的帖子",
        content: "正文",
        contentHtml: "<p>正文</p>",
      },
    ])
    .run();

  // 角色→权限有进程内缓存，重建完数据必须失效，否则测的是上一轮的配置
  rbac.invalidatePermissionCache();
});

describe("postCapabilities：按钮显示的依据", () => {
  it("作者对自己的帖子：能编辑能删能收尾，但没有版主动作", () => {
    const caps = mod.postCapabilities(user(AUTHOR), post("p1"));
    assert.equal(caps.edit, true);
    assert.equal(caps.deleteOwn, true);
    assert.equal(caps.deleteAny, false);
    assert.equal(caps.feature, false);
    assert.equal(caps.pin, false);
    assert.equal(caps.move, false);

    /*
     * 锁自己的帖子是**楼主该有的动作**（FORUM.md 4.3）——
     * 「这个问题解决了，不用再讨论了」和「这串吵起来了，版主叫停」
     * 是两件事，不该由同一个权限管。
     *
     * 真正的分界线在解锁那边：楼主只解得开自己加的那把，
     * 见 tests/post-lock.test.ts。
     */
    assert.equal(caps.lock, true);
    // 没锁的时候没有解锁这回事
    assert.equal(caps.unlock, false);
  });

  it("**楼主解不开版主加的锁** —— 否则版主叫停就形同虚设", () => {
    const locked = { ...post("p1"), status: "locked" as const, lockedBy: MOD_B1 };
    const caps = mod.postCapabilities(user(AUTHOR), locked);
    assert.equal(caps.unlock, false);
    assert.equal(caps.lock, false, "已经锁上了还给锁的按钮");
  });

  it("楼主解得开自己加的锁", () => {
    const locked = { ...post("p1"), status: "locked" as const, lockedBy: AUTHOR };
    assert.equal(mod.postCapabilities(user(AUTHOR), locked).unlock, true);
  });

  it("普通成员对别人的帖子：什么都不能做", () => {
    const caps = mod.postCapabilities(user(OTHER), post("p1"));
    assert.deepEqual(caps, mod.NO_CAPS);
  });

  it("版主在自己版块：全套管理动作", () => {
    const caps = mod.postCapabilities(user(MOD_B1), post("p1"));
    assert.equal(caps.deleteAny, true);
    assert.equal(caps.feature, true);
    assert.equal(caps.pin, true);
    assert.equal(caps.lock, true);
    assert.equal(caps.move, true);
    assert.equal(caps.edit, true); // edit.any
  });

  it("**版主出了自己的版块就是普通成员**", () => {
    // scope 匹配错了的话，一个小版块的版主就能删全站的帖子
    const caps = mod.postCapabilities(user(MOD_B1), post("p2"));
    assert.deepEqual(caps, mod.NO_CAPS);
  });

  it("未登录没有任何能力", () => {
    assert.deepEqual(mod.postCapabilities(null, post("p1")), mod.NO_CAPS);
  });

  it("已删除的帖子只剩恢复入口，且作者只有自删的才能恢复", () => {
    dbm.db
      .update(schema.posts)
      .set({ status: "deleted", deletedBy: MOD_B1 })
      .where(eq(schema.posts.id, "p1"))
      .run();

    const authorCaps = mod.postCapabilities(user(AUTHOR), post("p1"));
    // 管理员删的，作者不能捞回来 —— 否则处罚形同虚设
    assert.deepEqual(authorCaps, mod.NO_CAPS);

    const modCaps = mod.postCapabilities(user(MOD_B1), post("p1"));
    assert.equal(modCaps.restore, true);
    assert.equal(modCaps.edit, false);
    assert.equal(modCaps.deleteAny, false);
  });
});

describe("moderatePostCore：版主动作", () => {
  it("处罚必须填理由", () => {
    const result = mod.moderatePostCore(user(MOD_B1), { postId: "p1", action: "delete", reason: "  " });
    assert.equal(result.ok, false);
    assert.equal(post("p1").status, "published");
  });

  it("普通成员冒充版主会被 can() 拦下，帖子不动", () => {
    const result = mod.moderatePostCore(user(OTHER), { postId: "p1", action: "delete", reason: "试试" });
    assert.equal(result.ok, false);
    assert.equal(post("p1").status, "published");
  });

  it("版主删帖：状态、处罚记录、通知作者、审计缺一不可", () => {
    const result = mod.moderatePostCore(user(MOD_B1), { postId: "p1", action: "delete", reason: "广告" });
    assert.equal(result.ok, true);
    assert.ok(result.actionId, "要返回处罚记录 id，申诉时对得上号");

    assert.equal(post("p1").status, "deleted");

    const action = dbm.db
      .select()
      .from(schema.moderationActions)
      .where(eq(schema.moderationActions.targetId, "p1"))
      .get();
    assert.equal(action?.reason, "广告");

    // 悄悄删帖是最招怨的做法 —— 作者必须收到通知
    const noticed = dbm.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, AUTHOR))
      .all();
    assert.ok(noticed.length >= 1);

    const audited = dbm.db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "forum.post.delete"))
      .all();
    assert.equal(audited.length, 1);
  });

  it("版主出了自己的版块，动作被拒", () => {
    const result = mod.moderatePostCore(user(MOD_B1), { postId: "p2", action: "lock", reason: "锁" });
    assert.equal(result.ok, false);
    assert.equal(post("p2").status, "published");
  });

  it("加精记下是谁加的；恢复能把删除痕迹清干净", () => {
    mod.moderatePostCore(user(MOD_B1), { postId: "p1", action: "feature", reason: "值得沉淀" });
    assert.equal(post("p1").featured, true);
    assert.equal(post("p1").featuredBy, MOD_B1);

    mod.moderatePostCore(user(MOD_B1), { postId: "p1", action: "delete", reason: "误删演练" });
    mod.moderatePostCore(user(MOD_B1), { postId: "p1", action: "restore", reason: "恢复" });
    const restored = post("p1");
    assert.equal(restored.status, "published");
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.deletedBy, null);
  });
});

describe("movePostCore：移动版块", () => {
  it("普通成员不能移动，作者也不行", () => {
    assert.equal(mod.movePostCore(user(AUTHOR), { postId: "p1", toBoardId: "b2" }).ok, false);
    assert.equal(post("p1").boardId, "b1");
  });

  it("**可见性按目标版块封顶重新收口**", () => {
    // p1 是 public，b2 封顶 member —— 不收口的话就是把内部版块当公开跳板
    const result = mod.movePostCore(user(MOD_B1), { postId: "p1", toBoardId: "b2", reason: "归类" });
    assert.equal(result.ok, true);
    const moved = post("p1");
    assert.equal(moved.boardId, "b2");
    assert.equal(moved.visibility, "member");
  });

  it("群聊转帖的可见性锁死不动，移到哪都是原群可见", () => {
    dbm.db
      .update(schema.posts)
      .set({ visibility: "group", visibilityGroupId: "g1", visibilityLocked: true })
      .where(eq(schema.posts.id, "p1"))
      .run();
    const result = mod.movePostCore(user(MOD_B1), { postId: "p1", toBoardId: "b2" });
    assert.equal(result.ok, true);
    assert.equal(post("p1").visibility, "group");
  });

  it("目标版块锁定或相同时拒绝", () => {
    assert.equal(mod.movePostCore(user(MOD_B1), { postId: "p1", toBoardId: "b_locked" }).ok, false);
    assert.equal(mod.movePostCore(user(MOD_B1), { postId: "p1", toBoardId: "b1" }).ok, false);
  });

  it("两边版块的计数都重算", () => {
    mod.movePostCore(user(MOD_B1), { postId: "p1", toBoardId: "b2", reason: "归类" });
    const b1 = dbm.db.select().from(schema.boards).where(eq(schema.boards.id, "b1")).get()!;
    const b2 = dbm.db.select().from(schema.boards).where(eq(schema.boards.id, "b2")).get()!;
    assert.equal(b1.postCount, 0);
    assert.equal(b2.postCount, 2);
  });

  it("移动要留处罚记录并通知作者", () => {
    mod.movePostCore(user(MOD_B1), { postId: "p1", toBoardId: "b2", reason: "更合适的版块" });
    const action = dbm.db
      .select()
      .from(schema.moderationActions)
      .where(
        and(eq(schema.moderationActions.targetId, "p1"), eq(schema.moderationActions.action, "move")),
      )
      .get();
    assert.ok(action);
    const noticed = dbm.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, AUTHOR))
      .all();
    assert.ok(noticed.length >= 1);
  });
});

describe("自删与撤销", () => {
  it("只能删自己的", () => {
    assert.equal(mod.deleteOwnPostCore(user(OTHER), "p1").ok, false);
    assert.equal(post("p1").status, "published");
  });

  it("被封禁的账号连自己的帖子也动不了", () => {
    // 「是作者」不等于「可以删」—— can() 在这里不是走形式
    dbm.db.update(schema.posts).set({ authorId: BANNED }).where(eq(schema.posts.id, "p1")).run();
    assert.equal(mod.deleteOwnPostCore(user(BANNED), "p1").ok, false);
  });

  it("自删软删并留审计，作者能自己恢复", () => {
    const result = mod.deleteOwnPostCore(user(AUTHOR), "p1");
    assert.equal(result.ok, true);
    assert.equal(post("p1").status, "deleted");
    assert.equal(post("p1").deletedBy, AUTHOR);

    const audited = dbm.db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "forum.post.delete.own"))
      .all();
    assert.ok(audited.length >= 1, "自删也要记审计 —— 以前这条路一条账都没记");

    const restored = mod.restoreOwnPostCore(user(AUTHOR), "p1");
    assert.equal(restored.ok, true);
    assert.equal(post("p1").status, "published");
  });

  it("**管理员删的作者不能自己捞回来**", () => {
    mod.moderatePostCore(user(MOD_B1), { postId: "p1", action: "delete", reason: "违规" });
    const result = mod.restoreOwnPostCore(user(AUTHOR), "p1");
    assert.equal(result.ok, false);
    assert.equal(post("p1").status, "deleted");
  });

  it("自删后版块计数跟着降", () => {
    mod.deleteOwnPostCore(user(AUTHOR), "p1");
    const b1 = dbm.db.select().from(schema.boards).where(eq(schema.boards.id, "b1")).get()!;
    assert.equal(b1.postCount, 0);
  });
});
