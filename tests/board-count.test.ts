import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * 版块帖子计数测试。
 *
 * 线上事故：boards.postCount 只在网页发帖时 +1，群聊转帖与删帖都不动它，
 * 「群聊沉淀」版的帖子只能从转帖进来，于是线上明明有 2 篇帖子却常年显示 0 ——
 * 计数器悄悄漂移，把「统计坏了」伪装成了「确实没有帖子」。
 * 这里断言的是唯一口径 recountBoardPosts：所有写路径共用这一份，
 * 口径错了下面每一条都会红。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-board-count-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type StatsModule = typeof import("@/lib/forum/board-stats");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");
type Eq = typeof import("drizzle-orm")["eq"];

let stats: StatsModule;
let dbm: DbModule;
let schema: SchemaModule;
let eq: Eq;

let archiveId: string;
let generalId: string;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  eq = (await import("drizzle-orm")).eq;
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });

  // 版块用生产的 seedBoards 建，保证「群聊沉淀」的配置与线上一字不差
  const { seedBoards } = await import("@/lib/forum/seed-boards");
  seedBoards();
  stats = await import("@/lib/forum/board-stats");

  archiveId = boardId("archive");
  generalId = boardId("general");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function boardId(key: string): string {
  const row = dbm.db.select().from(schema.boards).where(eq(schema.boards.key, key)).get();
  assert.ok(row, `种子版块 ${key} 必须存在`);
  return row.id;
}

function storedCount(id: string): number {
  return dbm.db.select().from(schema.boards).where(eq(schema.boards.id, id)).get()!.postCount;
}

let seq = 0;
function insertPost(input: {
  boardId: string;
  status?: "draft" | "published" | "locked" | "hidden" | "deleted";
  deletedAt?: number | null;
  visibility?: "public" | "unlisted" | "member" | "role" | "group" | "private";
  visibilityLocked?: boolean;
}): string {
  seq++;
  return dbm.db
    .insert(schema.posts)
    .values({
      boardId: input.boardId,
      authorId: "u_author",
      title: `测试帖 ${seq}`,
      content: "正文",
      contentHtml: "<p>正文</p>",
      status: input.status ?? "published",
      deletedAt: input.deletedAt ?? null,
      visibility: input.visibility ?? "member",
      visibilityLocked: input.visibilityLocked ?? false,
    })
    .returning({ id: schema.posts.id })
    .get().id;
}

function reset() {
  dbm.db.delete(schema.posts).run();
  dbm.db.update(schema.boards).set({ postCount: 0 }).run();
}

describe("重现线上事故：群聊沉淀显示 0", () => {
  it("**转帖入库后重算，计数从假 0 变成真实帖子数**", () => {
    reset();
    // 线上现场：archive 版有 2 篇 group 锁定的转帖，post_count 却是 0，
    // 因为转帖路径当年忘了更新计数。重算必须能把它救回来
    insertPost({ boardId: archiveId, visibility: "group", visibilityLocked: true });
    insertPost({ boardId: archiveId, visibility: "member", visibilityLocked: false });
    assert.equal(storedCount(archiveId), 0, "前置：漂移状态就是 0");

    const n = stats.recountBoardPosts(archiveId, dbm.db);
    assert.equal(n, 2);
    assert.equal(storedCount(archiveId), 2, "重算结果必须写回数据库，否则页面还是显示 0");
  });

  it("空版块重算得到的是「真实的 0」", () => {
    // 硬规则：故障不能伪装成业务结果。修好之后 0 只剩一种含义 ——
    // 版块里确实没有帖子。这条保证重算不会凭空造数
    reset();
    assert.equal(stats.recountBoardPosts(archiveId, dbm.db), 0);
  });
});

describe("计数口径：读者看得到的才算", () => {
  it("published 与 locked 都算 —— 锁定只是不能回复，帖子还在", () => {
    reset();
    insertPost({ boardId: generalId, status: "published" });
    insertPost({ boardId: generalId, status: "locked" });
    assert.equal(stats.recountBoardPosts(generalId, dbm.db), 2);
  });

  it("draft / hidden / deleted 不算 —— 计进去就是「显示 5 篇点进去只有 2 篇」", () => {
    reset();
    insertPost({ boardId: generalId, status: "published" });
    insertPost({ boardId: generalId, status: "draft" });
    insertPost({ boardId: generalId, status: "hidden" });
    insertPost({ boardId: generalId, status: "deleted", deletedAt: Date.now() });
    assert.equal(stats.recountBoardPosts(generalId, dbm.db), 1);
  });

  it("软删除（deletedAt 非空）即使状态没改也不算", () => {
    // 双保险：删除要同时写 status 和 deletedAt，但只要有一个生效计数就得减，
    // 否则两个字段不同步时又会出现虚高
    reset();
    insertPost({ boardId: generalId, status: "published", deletedAt: Date.now() });
    assert.equal(stats.recountBoardPosts(generalId, dbm.db), 0);
  });

  it("只重算指定版块，不动别的版块", () => {
    reset();
    insertPost({ boardId: generalId });
    dbm.db.update(schema.boards).set({ postCount: 7 }).where(eq(schema.boards.id, archiveId)).run();
    stats.recountBoardPosts(generalId, dbm.db);
    assert.equal(storedCount(generalId), 1);
    assert.equal(storedCount(archiveId), 7, "别的版块的计数不该被顺手改掉");
  });
});

describe("删帖 / 恢复要触发重算", () => {
  it("删掉再恢复，计数跟着降回升 —— 以前只加不减，删 10 篇还挂着虚高数字", () => {
    reset();
    const id = insertPost({ boardId: generalId });
    insertPost({ boardId: generalId });
    stats.recountBoardPosts(generalId, dbm.db);
    assert.equal(storedCount(generalId), 2);

    // 模拟 moderatePost 的 delete patch（生产代码在 patch 后调 recountBoardPosts）
    dbm.db
      .update(schema.posts)
      .set({ status: "deleted", deletedAt: Date.now() })
      .where(eq(schema.posts.id, id))
      .run();
    assert.equal(stats.recountBoardPosts(generalId, dbm.db), 1);

    dbm.db
      .update(schema.posts)
      .set({ status: "published", deletedAt: null })
      .where(eq(schema.posts.id, id))
      .run();
    assert.equal(stats.recountBoardPosts(generalId, dbm.db), 2);
  });
});

describe("事务与全量校准", () => {
  it("能在事务里跑 —— 发帖与计数必须同一事务落库，否则崩溃时二者不一致", () => {
    reset();
    dbm.db.transaction((tx) => {
      insertPost({ boardId: archiveId });
      stats.recountBoardPosts(archiveId, tx);
    });
    assert.equal(storedCount(archiveId), 1);
  });

  it("recountAllBoards 修正全部漂移并报告 before/after", () => {
    reset();
    // 线上另一处漂移：general 实际 5 篇、计数只有 4（来路不明的第 5 篇没被计上）
    for (let i = 0; i < 5; i++) insertPost({ boardId: generalId });
    dbm.db.update(schema.boards).set({ postCount: 4 }).where(eq(schema.boards.id, generalId)).run();

    const report = stats.recountAllBoards(dbm.db);
    const general = report.find((r) => r.key === "general");
    assert.ok(general);
    assert.equal(general.before, 4, "报告必须如实给出修正前的值，否则运维看不出发生过漂移");
    assert.equal(general.after, 5);
    assert.equal(storedCount(generalId), 5);

    // 再跑一遍应当无漂移 —— 校准脚本靠这一点当巡检用
    const again = stats.recountAllBoards(dbm.db);
    assert.ok(again.every((r) => r.before === r.after), "重复校准不该再有任何变化");
  });
});
