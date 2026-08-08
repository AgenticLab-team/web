import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * 群消息检索测试。
 *
 * **搜索是最容易绕过权限的入口** —— 只要能搜到只言片语，
 * 私密内容就已经泄露了。所以隔离必须逐条断言，
 * 而且要断言「换个人搜同一个词必须为空」，不是「搜得到但少几条」。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-msearch-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type SearchModule = typeof import("@/lib/search/messages");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let search: SearchModule;
let dbm: DbModule;
let schema: SchemaModule;

const G1 = "g1@chatroom";
const G2 = "g2@chatroom";
const ALICE = "wx_alice";
const BOB = "wx_bob";

/** 造一个最小可用的 user，只填可见性判定读的字段 */
function userOf(wxId: string | null) {
  return { id: `u_${wxId}`, wxId, status: "active", kind: "member" } as never;
}

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  search = await import("@/lib/search/messages");
  const { segmentForIndex } = await import("@/lib/db/fts");

  dbm.db
    .insert(schema.groups)
    .values([
      { convId: G1, name: "一号群", syncEnabled: true, bound: true },
      { convId: G2, name: "二号群", syncEnabled: true, bound: true },
    ])
    .run();

  dbm.db
    .insert(schema.groupMembers)
    .values([
      { convId: G1, wxId: ALICE, displayName: "Alice" },
      { convId: G2, wxId: ALICE, displayName: "Alice" },
      { convId: G1, wxId: BOB, displayName: "Bob" },
    ])
    .run();

  dbm.db
    .insert(schema.people)
    .values([
      { wxId: ALICE, displayName: "Alice" },
      { wxId: BOB, displayName: "Bob" },
    ])
    .run();

  const rows = [
    { id: "m1", convId: G1, sender: ALICE, content: "我们讨论一下 MCP 的鉴权方案吧", ts: 1_786_000_000_000 },
    { id: "m2", convId: G1, sender: BOB, content: "鉴权可以用短期令牌加轮换", ts: 1_786_000_060_000 },
    { id: "m3", convId: G1, sender: ALICE, content: "今天天气不错啊各位", ts: 1_786_000_120_000 },
    { id: "m4", convId: G2, sender: ALICE, content: "二号群里也在聊鉴权这个话题", ts: 1_786_000_180_000 },
  ];

  const insertFts = dbm.sqlite.prepare(
    `INSERT INTO messages_fts (msg_id, conv_id, sender_wx_id, content) VALUES (?, ?, ?, ?)`,
  );

  for (const row of rows) {
    dbm.db
      .insert(schema.messages)
      .values({
        id: row.id,
        convId: row.convId,
        senderWxId: row.sender,
        senderName: row.sender === ALICE ? "Alice" : "Bob",
        type: "text",
        content: row.content,
        length: row.content.length,
        isQuality: true,
        ts: row.ts,
        indexed: true,
      })
      .run();
    insertFts.run(row.id, row.convId, row.sender, segmentForIndex(row.content));
  }
});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe("检索的权限隔离", () => {
  it("访客搜不到任何东西，且明确标记为无权限", () => {
    const result = search.searchMessages(null, { query: "鉴权" });
    assert.equal(result.hits.length, 0);
    assert.equal(result.noAccess, true, "要能区分「没搜到」与「没权限」");
  });

  it("成员能搜到自己所在群的消息", () => {
    const result = search.searchMessages(userOf(ALICE), { query: "鉴权" });
    assert.equal(result.hits.length, 3, "Alice 在两个群，三条都能搜到");
  });

  it("**换个人搜同一个词必须只剩他能看的**", () => {
    const result = search.searchMessages(userOf(BOB), { query: "鉴权" });
    const convIds = new Set(result.hits.map((h) => h.convId));
    assert.deepEqual([...convIds], [G1], "Bob 只在一号群");
    assert.equal(result.hits.length, 2);
  });

  it("越权指定群等于没搜到，不报错也不泄露该群存在", () => {
    const result = search.searchMessages(userOf(BOB), { query: "鉴权", convId: G2 });
    assert.deepEqual(result.hits, []);
    assert.equal(result.noAccess, false, "不是无权限，是这次查询没结果");
  });

  it("限定自己所在的群能正常缩小范围", () => {
    const result = search.searchMessages(userOf(ALICE), { query: "鉴权", convId: G2 });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].convId, G2);
  });
});

describe("检索能力", () => {
  it("两字中文词能搜到", () => {
    assert.ok(search.searchMessages(userOf(ALICE), { query: "鉴权" }).hits.length > 0);
  });

  it("英文词能搜到", () => {
    assert.ok(search.searchMessages(userOf(ALICE), { query: "MCP" }).hits.length > 0);
  });

  it("片段带高亮标记", () => {
    const hit = search.searchMessages(userOf(ALICE), { query: "鉴权" }).hits[0];
    assert.ok(hit.snippet.includes("<mark>"), hit.snippet);
  });

  it("**片段里的中文不带切分空格**", () => {
    // 索引里是逐字切开的，不还原的话每个字之间都有空格
    const hit = search.searchMessages(userOf(ALICE), { query: "鉴权" }).hits[0];
    const plain = hit.snippet.replace(/<\/?mark>/g, "");
    assert.ok(!/[一-鿿] [一-鿿]/.test(plain), `片段没还原：${plain}`);
  });

  it("按发言人过滤", () => {
    const result = search.searchMessages(userOf(ALICE), { query: "鉴权", senderWxId: BOB });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].senderWxId, BOB);
  });

  it("只搜自己说过的话", () => {
    const result = search.searchMessages(userOf(ALICE), { query: "鉴权", onlyMine: true });
    assert.ok(result.hits.every((h) => h.senderWxId === ALICE));
  });

  it("按时间范围过滤", () => {
    const none = search.searchMessages(userOf(ALICE), {
      query: "鉴权",
      from: "2020-01-01",
      to: "2020-01-02",
    });
    assert.equal(none.hits.length, 0, "范围外应为空");
  });

  it("总数与分页各算各的", () => {
    const page = search.searchMessages(userOf(ALICE), { query: "鉴权", limit: 1 });
    assert.equal(page.hits.length, 1);
    assert.equal(page.total, 3, "总数是全部匹配数，不是这一页的数量");
  });

  it("空查询返回空而不是全部", () => {
    assert.equal(search.searchMessages(userOf(ALICE), { query: "" }).hits.length, 0);
    assert.equal(search.searchMessages(userOf(ALICE), { query: "   " }).hits.length, 0);
  });

  it("注入字符不会让检索炸掉", () => {
    for (const q of ['"', "*", "()", "^", 'a" OR "b', "AND OR NOT"]) {
      assert.doesNotThrow(() => search.searchMessages(userOf(ALICE), { query: q }), `查询 ${q}`);
    }
  });
});

describe("上下文", () => {
  it("能取到目标消息的前后文", () => {
    const context = search.messageContext(userOf(ALICE), "m2", 3);
    assert.ok(context);
    assert.equal(context.convId, G1);
    assert.ok(context.messages.length >= 3);
    assert.equal(context.messages.filter((m) => m.isTarget).length, 1);
  });

  it("上下文按时间正序，读起来才是对话", () => {
    const context = search.messageContext(userOf(ALICE), "m2", 3)!;
    const stamps = context.messages.map((m) => m.ts);
    assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b));
  });

  it("**只包含同一个群的消息**，不会串台", () => {
    const context = search.messageContext(userOf(ALICE), "m2", 10)!;
    assert.ok(context.messages.every((m) => ["m1", "m2", "m3"].includes(m.id)));
  });

  it("看不到那个群的人取不到上下文", () => {
    assert.equal(search.messageContext(userOf(BOB), "m4", 5), null);
    assert.equal(search.messageContext(null, "m1", 5), null);
  });

  it("不存在的消息返回 null", () => {
    assert.equal(search.messageContext(userOf(ALICE), "nope", 5), null);
  });
});

describe("我的存档", () => {
  it("只算自己在可见群里说过的话", () => {
    assert.equal(search.myMessageCount(userOf(ALICE)), 3);
    assert.equal(search.myMessageCount(userOf(BOB)), 1);
  });

  it("访客为 0", () => {
    assert.equal(search.myMessageCount(null), 0);
  });
});
