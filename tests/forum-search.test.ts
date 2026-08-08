import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// 可见性模块是纯函数、无副作用，可以静态导入；
// 放到 before() 里赋值的话，模块顶层的常量会拿到 undefined
import { GUEST } from "@/lib/forum/visibility";

/**
 * 论坛检索测试。
 *
 * **搜索是最容易绕过权限的入口** —— 只要能搜到标题，
 * 私密内容就已经泄露了一半。所以可见性过滤必须逐条断言。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-fsearch-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type SearchModule = typeof import("@/lib/forum/search");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let search: SearchModule;
let dbm: DbModule;
let schema: SchemaModule;

const AUTHOR = "u_author";
const BOARD = "b1";
const GROUP = "g1@chatroom";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  search = await import("@/lib/forum/search");

  dbm.db
    .insert(schema.boards)
    .values({ id: BOARD, key: "b1", name: "版块" })
    .run();

  const rows = [
    { id: "p_public", title: "MCP 鉴权方案讨论", content: "关于鉴权的细节", visibility: "public" as const },
    { id: "p_member", title: "内部路线图", content: "只有成员能看的鉴权计划", visibility: "member" as const },
    { id: "p_group", title: "群里聊到的鉴权", content: "从群聊转来的内容", visibility: "group" as const },
    { id: "p_private", title: "我的私密草稿", content: "鉴权笔记", visibility: "private" as const },
  ];

  for (const row of rows) {
    dbm.db
      .insert(schema.posts)
      .values({
        id: row.id,
        boardId: BOARD,
        authorId: AUTHOR,
        title: row.title,
        content: row.content,
        contentHtml: `<p>${row.content}</p>`,
        excerpt: row.content,
        visibility: row.visibility,
        visibilityGroupId: row.visibility === "group" ? GROUP : null,
        status: "published",
      })
      .run();
    search.indexPost(row.id, row.title, row.content);
  }

  dbm.db
    .insert(schema.replies)
    .values({
      id: "r1",
      postId: "p_public",
      authorId: "u_other",
      content: "补充一点关于令牌轮换的做法",
      contentHtml: "<p>x</p>",
      floor: 1,
    })
    .run();
  search.indexReply("p_public", "r1", "补充一点关于令牌轮换的做法");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const guest = GUEST;
const member = { userId: "u_m", kind: "member" as const, groupIds: [], roleIds: [], canModerate: false };
const groupMember = { ...member, userId: "u_g", groupIds: [GROUP] };
const author = { ...member, userId: AUTHOR };
const admin = { ...member, userId: "u_a", canModerate: true };

describe("检索的可见性收口", () => {
  it("访客只搜得到公开帖", () => {
    const ids = search.searchForum(guest, "鉴权").map((h) => h.postId);
    assert.deepEqual(ids, ["p_public"], `访客不该搜到受限内容：${ids.join(", ")}`);
  });

  it("成员搜得到公开与成员级，但搜不到群级与私密", () => {
    const ids = search.searchForum(member, "鉴权").map((h) => h.postId).sort();
    assert.deepEqual(ids, ["p_member", "p_public"].sort());
  });

  it("群成员额外搜得到群级内容", () => {
    const ids = search.searchForum(groupMember, "鉴权").map((h) => h.postId).sort();
    assert.deepEqual(ids, ["p_group", "p_member", "p_public"].sort());
  });

  it("作者搜得到自己的私密内容", () => {
    const ids = search.searchForum(author, "鉴权").map((h) => h.postId);
    assert.ok(ids.includes("p_private"));
  });

  it("**别人搜不到我的私密内容，连标题都搜不到**", () => {
    for (const viewer of [guest, member, groupMember]) {
      const ids = search.searchForum(viewer, "私密草稿").map((h) => h.postId);
      assert.ok(!ids.includes("p_private"), "私密帖不该出现在别人的搜索结果里");
    }
  });

  it("管理员能搜到全部", () => {
    const ids = search.searchForum(admin, "鉴权").map((h) => h.postId);
    assert.equal(ids.length, 4);
  });
});

describe("中文检索", () => {
  it("两字中文词能搜到", () => {
    // trigram 分词器对 2 字词完全失效，这个坑踩过一次就够了
    assert.ok(search.searchForum(guest, "鉴权").length > 0);
  });

  it("英文词能搜到", () => {
    assert.ok(search.searchForum(guest, "MCP").length > 0);
  });

  it("回复内容也能搜到，并标记出来", () => {
    const hits = search.searchForum(guest, "轮换");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].postId, "p_public");
    assert.equal(hits[0].matchedInReply, true);
  });

  it("同一帖标题与回复都命中时只出现一次", () => {
    const hits = search.searchForum(guest, "鉴权 令牌");
    const ids = hits.map((h) => h.postId);
    assert.equal(new Set(ids).size, ids.length, "结果里不该有重复的帖子");
  });

  it("空查询返回空，不返回全部", () => {
    // 空查询返回全部内容是很常见的实现失误，等于一键泄露
    assert.deepEqual(search.searchForum(admin, ""), []);
    assert.deepEqual(search.searchForum(admin, "   "), []);
  });

  it("注入字符不会让检索炸掉", () => {
    for (const q of ['"', "*", "()", "AND OR NOT", "^", 'a" OR "b']) {
      assert.doesNotThrow(() => search.searchForum(guest, q), `查询 ${q} 抛错了`);
    }
  });
});

describe("索引维护", () => {
  it("重建索引后仍然搜得到", () => {
    const n = search.rebuildIndex();
    assert.ok(n >= 5, `重建了 ${n} 条`);
    assert.ok(search.searchForum(guest, "鉴权").length > 0);
  });

  it("从索引移除后搜不到", () => {
    search.removeFromIndex("p_public");
    const ids = search.searchForum(guest, "鉴权").map((h) => h.postId);
    assert.ok(!ids.includes("p_public"));
    // 恢复，免得影响其它测试
    search.rebuildIndex();
  });
});
