import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 版块与标签管理的数据库侧。
 *
 * 两条贯穿始终：
 *   1. **真实计数与冗余计数都要给出来。** 冗余列漂移过一次
 *      （「群聊沉淀」实际 2 篇却显示 0，0 被当成了「确实没有」），
 *      修好一次不代表以后不会再漂，所以后台要能一眼看出不一致。
 *   2. **改配置前算得出影响面。** 收紧可见性上限会让已发出的帖子
 *      从别人眼前消失，作者不会收到任何通知。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-boards-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type Mod = typeof import("@/lib/admin/boards");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let mod: Mod;
let dbm: DbModule;
let schema: SchemaModule;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  mod = await import("@/lib/admin/boards");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [schema.postTags, schema.tags, schema.posts, schema.boards]) {
    dbm.db.delete(t).run();
  }
  dbm.db
    .insert(schema.boards)
    .values([
      { id: "b_main", key: "general", name: "综合讨论", sort: 10, maxVisibility: "public" },
      { id: "b_arch", key: "archive", name: "群聊沉淀", sort: 5, maxVisibility: "group" },
      { id: "b_sub", key: "sub", name: "子版块", sort: 1, parentId: "b_main" },
    ])
    .run();
});

function post(id: string, boardId: string, over: Record<string, unknown> = {}) {
  dbm.db
    .insert(schema.posts)
    .values({
      id,
      boardId,
      authorId: "u1",
      title: `帖子 ${id}`,
      content: "正文",
      contentHtml: "<p>正文</p>",
      ...over,
    })
    .run();
}

describe("版块列表", () => {
  it("按 sort 倒序排列", () => {
    const keys = mod.listBoardsForAdmin().map((b) => b.key);
    assert.deepEqual(keys, ["general", "archive", "sub"]);
  });

  it("统计真实帖子数", () => {
    post("p1", "b_main");
    post("p2", "b_main");
    post("p3", "b_arch");

    const list = mod.listBoardsForAdmin();
    assert.equal(list.find((b) => b.key === "general")!.livePosts, 2);
    assert.equal(list.find((b) => b.key === "archive")!.livePosts, 1);
  });

  it("删除和草稿不计入真实帖子数", () => {
    post("p1", "b_main");
    post("p2", "b_main", { status: "deleted", deletedAt: Date.now() });
    post("p3", "b_main", { status: "draft" });

    assert.equal(mod.listBoardsForAdmin().find((b) => b.key === "general")!.livePosts, 1);
  });

  it("锁定的帖子仍然计入 —— 它还看得见", () => {
    post("p1", "b_main", { status: "locked" });
    assert.equal(mod.listBoardsForAdmin().find((b) => b.key === "general")!.livePosts, 1);
  });

  it("**真实计数与冗余计数分别给出，能看出漂移**", () => {
    // 冗余列漂移过一次，0 被当成了「确实没有帖子」
    post("p1", "b_arch");
    post("p2", "b_arch");
    // 故意不更新 post_count，模拟漂移
    const row = mod.listBoardsForAdmin().find((b) => b.key === "archive")!;
    assert.equal(row.livePosts, 2);
    assert.equal(row.cachedCount, 0);
    assert.notEqual(row.livePosts, row.cachedCount, "两个数必须能分别拿到，否则漂移看不出来");
  });

  it("统计子版块数量", () => {
    assert.equal(mod.listBoardsForAdmin().find((b) => b.key === "general")!.childCount, 1);
    assert.equal(mod.listBoardsForAdmin().find((b) => b.key === "sub")!.childCount, 0);
  });

  it("软删除的版块不出现在列表里", () => {
    dbm.db
      .update(schema.boards)
      .set({ deletedAt: Date.now() })
      .where(eq(schema.boards.id, "b_sub"))
      .run();

    const keys = mod.listBoardsForAdmin().map((b) => b.key);
    assert.ok(!keys.includes("sub"));
    assert.equal(keys.length, 2);
  });

  it("父版块被软删后，子版块计数不再把它算进去", () => {
    dbm.db
      .update(schema.boards)
      .set({ deletedAt: Date.now() })
      .where(eq(schema.boards.id, "b_sub"))
      .run();

    assert.equal(mod.listBoardsForAdmin().find((b) => b.key === "general")!.childCount, 0);
  });
});

describe("层级表", () => {
  it("给出每个版块的父级，供环检测使用", () => {
    const parents = mod.boardParents();
    assert.equal(parents.get("b_sub"), "b_main");
    assert.equal(parents.get("b_main"), null);
  });
});

describe("收紧上限的影响面", () => {
  it("**算得出具体是哪几篇**", () => {
    post("p1", "b_main", { visibility: "public" });
    post("p2", "b_main", { visibility: "public" });
    post("p3", "b_main", { visibility: "member" });

    const impact = mod.capImpact("b_main", "member");
    assert.equal(impact.affected, 2);
    assert.equal(impact.samples.length, 2);
    assert.ok(impact.samples.every((s) => s.title.length > 0), "要给标题，不能只给 id");
  });

  it("放宽上限不影响任何帖子", () => {
    post("p1", "b_main", { visibility: "member" });
    assert.equal(mod.capImpact("b_main", "public").affected, 0);
  });

  it("样本最多给 5 条，但总数是真实的", () => {
    for (let i = 0; i < 12; i++) post(`p${i}`, "b_main", { visibility: "public" });
    const impact = mod.capImpact("b_main", "private");
    assert.equal(impact.affected, 12);
    assert.equal(impact.samples.length, 5);
  });

  it("已删除的帖子不算受影响 —— 它本来就看不见了", () => {
    post("p1", "b_main", { visibility: "public", status: "deleted", deletedAt: Date.now() });
    assert.equal(mod.capImpact("b_main", "member").affected, 0);
  });

  it("空版块不报错", () => {
    assert.equal(mod.capImpact("b_arch", "private").affected, 0);
  });
});

describe("标签", () => {
  function tag(id: string, name: string, over: Record<string, unknown> = {}) {
    dbm.db.insert(schema.tags).values({ id, name, slug: name.toLowerCase(), ...over }).run();
  }

  it("统计真实关联数", () => {
    tag("t1", "rag");
    post("p1", "b_main");
    post("p2", "b_main");
    dbm.db.insert(schema.postTags).values([
      { postId: "p1", tagId: "t1" },
      { postId: "p2", tagId: "t1" },
    ]).run();

    assert.equal(mod.listTagsForAdmin()[0].liveCount, 2);
  });

  it("已删除帖子的标签关联不算数", () => {
    tag("t1", "rag");
    post("p1", "b_main", { status: "deleted", deletedAt: Date.now() });
    dbm.db.insert(schema.postTags).values({ postId: "p1", tagId: "t1" }).run();

    assert.equal(mod.listTagsForAdmin()[0].liveCount, 0);
  });

  it("列出某个标签下的帖子 id，供合并使用", () => {
    tag("t1", "rag");
    post("p1", "b_main");
    dbm.db.insert(schema.postTags).values({ postId: "p1", tagId: "t1" }).run();

    assert.deepEqual(mod.postIdsOfTag("t1"), ["p1"]);
  });

  it("没人用的标签会被列为可清理", () => {
    tag("t1", "used");
    tag("t2", "orphan");
    post("p1", "b_main");
    dbm.db.insert(schema.postTags).values({ postId: "p1", tagId: "t1" }).run();

    const orphans = mod.orphanTags().map((t) => t.name);
    assert.deepEqual(orphans, ["orphan"]);
  });

  it("**锁定的标签不会被列为可清理**", () => {
    // 锁定往往正是为了预留一个还没开始用的官方标签
    tag("t1", "reserved", { locked: true });
    assert.equal(mod.orphanTags().length, 0);
  });

  it("没有标签时不报错", () => {
    assert.deepEqual(mod.listTagsForAdmin(), []);
    assert.deepEqual(mod.orphanTags(), []);
  });
});
