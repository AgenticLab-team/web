import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 论坛活跃榜。
 *
 * ═════════════════════════════════════════
 * 它为什么是**另一个榜**，不是一个混合分
 * ═════════════════════════════════════════
 *
 * 站长要「论坛和 GitHub 活跃度也上榜单」。算一个综合分需要回答
 * 「一篇长文顶几条群消息」—— 那个问题没有答案，而随便定一个比例
 * 会直接变成大家优化的目标。
 *
 * GitHub 那一半**没有做**，理由是数据不全：141 个账号里只有 4 个
 * 绑了 GitHub（2.8%），而且只覆盖没关掉提醒的人、只最近九十天。
 * 一份注定不全的名单做成排名不只是不完整，是**说错话** ——
 * 它宣称「这几个人贡献最多」，而那对没被测量的另外 137 个人是假的。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-forumboard-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let board: typeof import("@/lib/queries/forum-board");

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  board = await import("@/lib/queries/forum-board");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.replies).run();
  dbm.db.delete(schema.posts).run();
  dbm.db.delete(schema.users).run();
});

let seq = 0;
function user(id: string, name: string, wxId: string) {
  dbm.db
    .insert(schema.users)
    .values({ id, wxId, siteNickname: name, status: "active", createdAt: Date.now() })
    .run();
}

function post(authorId: string, over: Record<string, unknown> = {}) {
  dbm.db
    .insert(schema.posts)
    .values({
      id: `p${++seq}`,
      boardId: "b1",
      authorId,
      title: "标题",
      content: "正文",
      contentHtml: "<p>正文</p>",
      status: "published",
      visibility: "public",
      anonymous: false,
      replyCount: 0,
      reactionCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...over,
    })
    .run();
}

function reply(authorId: string, content: string, over: Record<string, unknown> = {}) {
  dbm.db
    .insert(schema.replies)
    .values({
      id: `r${++seq}`,
      postId: "p1",
      authorId,
      content,
      contentHtml: `<p>${content}</p>`,
      floor: ++seq,
      anonymous: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...over,
    })
    .run();
}

describe("**按条数排会让「+1」的人夺冠**", () => {
  it("回复要够长才算", () => {
    /*
     * 群聊榜排的是高质量消息，理由写在首页上：「按总条数排会让
     * 复读机上榜」。论坛这边一模一样。
     */
    user("u1", "认真回的", "wx1");
    user("u2", "刷加一的", "wx2");
    reply("u1", "这一段我觉得关键在于取舍，长度肯定够十五个字了");
    for (let i = 0; i < 20; i++) reply("u2", "+1");

    const got = board.forumBoard({ days: null });
    assert.equal(got.length, 1, `刷屏的人不该上榜：${got.map((e) => e.name)}`);
    assert.equal(got[0].name, "认真回的");
  });

  it("发帖比回复重，但回复不会完全不算", () => {
    user("u1", "只发帖", "wx1");
    user("u2", "只回帖", "wx2");
    post("u1");
    for (let i = 0; i < 4; i++) reply("u2", "这条回复足够长，超过十五个字了没问题");

    const got = board.forumBoard({ days: null });
    // 1 篇 = 3 分，4 条回复 = 4 分 —— 认真回帖的人赢得了，但不是碾压
    assert.equal(got[0].name, "只回帖");
    assert.equal(got.find((e) => e.name === "只发帖")?.score, board.POST_WEIGHT);
  });
});

describe("**匿名帖不计入**", () => {
  it("发了匿名帖不加分", () => {
    /*
     * 数字本身不说出是哪几篇，但在一个几十人的社区里，
     * 「某人的计数从 0 变成 1」和「今天出现了一篇匿名帖」
     * 放在一起就够指认了。
     */
    user("u1", "小明", "wx1");
    post("u1", { anonymous: true });
    assert.deepEqual(board.forumBoard({ days: null }), []);
  });

  it("匿名回复也不加分", () => {
    user("u1", "小明", "wx1");
    reply("u1", "这条回复足够长，超过十五个字了没问题", { anonymous: true });
    assert.deepEqual(board.forumBoard({ days: null }), []);
  });
});

describe("该排除的都排除了", () => {
  it("草稿、隐藏、删掉的帖子都不算", () => {
    user("u1", "小明", "wx1");
    post("u1", { status: "draft" });
    post("u1", { status: "hidden" });
    post("u1", { deletedAt: Date.now() });
    assert.deepEqual(board.forumBoard({ days: null }), []);
  });

  it("**关掉了「出现在榜单上」的人两个榜都不出现**", () => {
    /*
     * 用的是和群聊榜同一份名单。两份的话，一个人在设置里藏起来之后
     * 会发现自己还在另一个榜上 —— 而他不会知道去哪里再关一次。
     */
    user("u1", "藏起来的", "wx1");
    post("u1");
    assert.deepEqual(board.forumBoard({ days: null, hiddenWxIds: ["wx1"] }), []);
  });

  it("时间范围收得住", () => {
    user("u1", "旧的", "wx1");
    user("u2", "新的", "wx2");
    post("u1", { createdAt: Date.now() - 40 * 86_400_000 });
    post("u2");

    const week = board.forumBoard({ days: 7 });
    assert.deepEqual(week.map((e) => e.name), ["新的"]);
    assert.equal(board.forumBoard({ days: null }).length, 2);
  });
});

describe("名次本身", () => {
  it("从 1 开始，连续，不跳号", () => {
    for (let i = 1; i <= 3; i++) {
      user(`u${i}`, `第${i}`, `wx${i}`);
      for (let n = 0; n < 4 - i; n++) post(`u${i}`);
    }
    const got = board.forumBoard({ days: null });
    assert.deepEqual(got.map((e) => e.rank), [1, 2, 3]);
  });

  it("一条都没有时返回空数组，不是抛错", () => {
    assert.deepEqual(board.forumBoard({ days: null }), []);
  });
});
