import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 内容管理的查询层。
 *
 * 与前台列表最大的不同：**这里不做可见性收口**。
 * 管理员本来就要能看到被隐藏和删除的东西 ——
 * 看不到就没法恢复，也没法判断当初删得对不对。
 *
 * 所以这个文件里的断言几乎都是「能不能看见」，
 * 而进入这一层之前的权限判定必须严丝合缝（页面上是 requireAdmin）。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-adminposts-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type Mod = typeof import("@/lib/admin/posts");
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
  mod = await import("@/lib/admin/posts");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [schema.replies, schema.posts, schema.boards, schema.users]) {
    dbm.db.delete(t).run();
  }
  dbm.db
    .insert(schema.boards)
    .values([
      { id: "b1", key: "general", name: "综合" },
      { id: "b2", key: "archive", name: "群聊沉淀" },
    ])
    .run();
  dbm.db
    .insert(schema.users)
    .values([
      { id: "u1", wxId: "wx1", siteNickname: "甲" },
      { id: "u2", wxId: "wxid_bare999", siteNickname: null, wxNickname: null },
    ])
    .run();
});

function post(id: string, over: Record<string, unknown> = {}) {
  dbm.db
    .insert(schema.posts)
    .values({
      id,
      boardId: "b1",
      authorId: "u1",
      title: `帖子 ${id}`,
      content: "正文内容",
      contentHtml: "<p>正文内容</p>",
      ...over,
    })
    .run();
}

describe("管理员能看到的范围", () => {
  it("**被隐藏和删除的都要能看到**", () => {
    // 看不到就没法恢复，也没法判断当初删得对不对
    post("p1");
    post("p2", { status: "hidden" });
    post("p3", { status: "deleted", deletedAt: Date.now(), deleteReason: "广告" });

    assert.equal(mod.listPostsForAdmin().total, 3);
  });

  it("「已删除」是一个可用的筛选项", () => {
    post("p1");
    post("p2", { status: "deleted", deletedAt: Date.now() });

    const { rows } = mod.listPostsForAdmin({ status: "deleted" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "p2");
  });

  it("带出删除理由 —— 复查时要知道当初为什么删", () => {
    post("p1", { status: "deleted", deletedAt: Date.now(), deleteReason: "重复发广告" });
    assert.equal(mod.listPostsForAdmin().rows[0].deleteReason, "重复发广告");
  });

  it("**匿名帖在后台仍然显示作者**", () => {
    // 匿名是对其他用户的，不是对管理员的 ——
    // 否则处理纠纷时连是谁发的都查不到
    post("p1", { anonymous: true });
    const row = mod.listPostsForAdmin().rows[0];
    assert.match(row.authorName, /匿名发布/);
    assert.equal(row.authorId, "u1");
  });

  it("**昵称走统一解析，不漏 wxid**", () => {
    post("p1", { authorId: "u2" });
    const name = mod.listPostsForAdmin().rows[0].authorName;
    assert.ok(!name.includes("wxid_"), `漏出了 wxid：${name}`);
  });
});

describe("筛选", () => {
  it("按关键词搜标题", () => {
    post("p1", { title: "关于向量检索" });
    post("p2", { title: "别的话题" });
    assert.equal(mod.listPostsForAdmin({ keyword: "向量" }).rows.length, 1);
  });

  it("关键词也搜正文", () => {
    post("p1", { content: "这里提到了向量数据库" });
    post("p2");
    assert.equal(mod.listPostsForAdmin({ keyword: "向量数据库" }).rows.length, 1);
  });

  it("按版块筛选", () => {
    post("p1");
    post("p2", { boardId: "b2" });
    assert.equal(mod.listPostsForAdmin({ boardId: "b2" }).rows[0].id, "p2");
  });

  it("按作者筛选", () => {
    post("p1");
    post("p2", { authorId: "u2" });
    assert.equal(mod.listPostsForAdmin({ authorId: "u2" }).rows[0].id, "p2");
  });

  it("**能单独筛出群聊转帖**", () => {
    // 它们受硬约束管辖，需要能单独复查
    post("p1");
    post("p2", { visibilityLocked: true });

    const { rows } = mod.listPostsForAdmin({ fromGroupChat: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fromGroupChat, true);
  });

  it("总数是筛选后的总数，不是全表", () => {
    post("p1", { title: "找我" });
    post("p2");
    post("p3");
    assert.equal(mod.listPostsForAdmin({ keyword: "找我" }).total, 1);
  });

  it("空库不报错", () => {
    const r = mod.listPostsForAdmin();
    assert.equal(r.total, 0);
    assert.deepEqual(r.rows, []);
  });
});

describe("分桶计数", () => {
  it("按状态与版块分桶", () => {
    post("p1");
    post("p2", { status: "hidden" });
    post("p3", { boardId: "b2" });

    const f = mod.postFacets();
    assert.equal(f.status.find((s) => s.value === "hidden")?.count, 1);
    assert.equal(f.boards.find((b) => b.id === "b2")?.count, 1);
  });

  it("统计群聊转帖数量", () => {
    post("p1", { visibilityLocked: true });
    post("p2");
    assert.equal(mod.postFacets().groupDerived, 1);
  });
});

describe("选中项概况", () => {
  it("**给出去重后的作者数** —— 界面上要说「影响几位作者」", () => {
    post("p1");
    post("p2");
    post("p3", { authorId: "u2" });

    const s = mod.summarizeSelection(["p1", "p2", "p3"]);
    assert.equal(s.count, 3);
    assert.equal(s.authors, 2);
  });

  it("标出其中有几篇是群聊转帖", () => {
    post("p1", { visibilityLocked: true });
    post("p2");
    assert.equal(mod.summarizeSelection(["p1", "p2"]).groupDerived, 1);
  });

  it("给出前几个标题，让人看见具体是哪几篇", () => {
    for (let i = 0; i < 8; i++) post(`p${i}`);
    const s = mod.summarizeSelection(Array.from({ length: 8 }, (_, i) => `p${i}`));
    assert.equal(s.titles.length, 5);
  });

  it("空选择不报错", () => {
    assert.equal(mod.summarizeSelection([]).count, 0);
  });

  it("不存在的 id 不会被算进去", () => {
    post("p1");
    assert.equal(mod.summarizeSelection(["p1", "nope"]).count, 1);
  });
});

describe("孤儿帖子", () => {
  it("**版块被删后，里面的帖子会被检出来**", () => {
    // 这类帖子查得到、打不开
    post("p1", { boardId: "b2" });
    dbm.db.update(schema.boards).set({ deletedAt: Date.now() }).where(eq(schema.boards.id, "b2")).run();

    const orphans = mod.orphanPosts();
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].id, "p1");
  });

  it("版块正常时没有孤儿", () => {
    post("p1");
    assert.deepEqual(mod.orphanPosts(), []);
  });

  it("已删除的帖子不算孤儿 —— 它本来就不该被打开", () => {
    post("p1", { boardId: "b2", status: "deleted", deletedAt: Date.now() });
    dbm.db.update(schema.boards).set({ deletedAt: Date.now() }).where(eq(schema.boards.id, "b2")).run();
    assert.deepEqual(mod.orphanPosts(), []);
  });
});

describe("回复列表", () => {
  function reply(id: string, over: Record<string, unknown> = {}) {
    dbm.db
      .insert(schema.replies)
      .values({
        id,
        postId: "p1",
        authorId: "u1",
        content: `回复 ${id}`,
        contentHtml: `<p>回复 ${id}</p>`,
        floor: 1,
        ...over,
      })
      .run();
  }

  it("带出所属帖子的标题", () => {
    post("p1", { title: "原帖标题" });
    reply("r1");
    assert.equal(mod.listRepliesForAdmin()[0].postTitle, "原帖标题");
  });

  it("被折叠和删除的回复也要能看到", () => {
    post("p1");
    reply("r1", { collapsed: true });
    reply("r2", { floor: 2, status: "deleted" });
    assert.equal(mod.listRepliesForAdmin().length, 2);
  });

  it("按帖子筛选", () => {
    post("p1");
    post("p2");
    reply("r1");
    reply("r2", { postId: "p2", floor: 1 });
    assert.equal(mod.listRepliesForAdmin({ postId: "p2" }).length, 1);
  });

  it("按内容搜索", () => {
    post("p1");
    reply("r1", { content: "这里提到了检索增强" });
    reply("r2", { floor: 2, content: "无关内容" });
    assert.equal(mod.listRepliesForAdmin({ keyword: "检索增强" }).length, 1);
  });
});
