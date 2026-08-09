import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * @提及 与回复关系的落库测试 —— 真实数据库往返。
 *
 * 重点验证两件纯函数测试覆盖不到的事：
 *   1. 回填可安全重跑（生产上有 4 万多条消息，跑一半断了必须能直接再跑）
 *   2. 唯一索引兜住同步与回填并发时的重复写入
 */

// 必须在 import 任何用到 env 的模块之前设置
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "al-test-")), "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

const SEP = " ";
const CONV = "test@chatroom";

type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");
type InteractionsModule = typeof import("@/lib/messages/interactions");

let dbm: DbModule;
let schema: SchemaModule;
let ix: InteractionsModule;

let seq = 0;
function seedMessage(input: { id: string; content: string; type?: string; sender?: string; ts?: number }) {
  dbm.db
    .insert(schema.messages)
    .values({
      id: input.id,
      convId: CONV,
      senderWxId: input.sender ?? "wxid_sender",
      senderName: "发送者",
      type: input.type ?? "text",
      content: input.content,
      length: input.content.length,
      ts: input.ts ?? 1_786_000_000_000 + seq++,
    })
    .run();
}

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  ix = await import("@/lib/messages/interactions");

  // 名册：土豆（曾用名"马铃薯"）、两个同名的小明
  dbm.db
    .insert(schema.groupMembers)
    .values([
      { convId: CONV, wxId: "wxid_potato", displayName: "土豆", wxName: "potato" },
      { convId: CONV, wxId: "wxid_ming_a", displayName: "小明", wxName: "ming_a" },
      { convId: CONV, wxId: "wxid_ming_b", displayName: "小明", wxName: "ming_b" },
    ])
    .run();
  dbm.db
    .insert(schema.groupMemberEvents)
    .values({
      convId: CONV,
      wxId: "wxid_potato",
      event: "rename",
      detail: { from: "马铃薯", to: "土豆" },
    })
    .run();
});

after(() => {
  rmSync(join(process.env.DB_PATH!, ".."), { recursive: true, force: true });
});

describe("回填", () => {
  it("解析出 resolved / ambiguous / unknown / 曾用名，并落库", () => {
    seedMessage({ id: "m1", content: `@土豆${SEP}看看这个` });
    seedMessage({ id: "m2", content: `@小明${SEP}你来` });
    seedMessage({ id: "m3", content: `@不存在的人${SEP}在吗` });
    seedMessage({ id: "m4", content: `@马铃薯${SEP}老名字还认识吗` });
    seedMessage({ id: "m5", content: "没有提及的普通消息" });

    const stats = ix.backfillConv(CONV);
    assert.equal(stats.scanned, 5);
    assert.equal(stats.mentionRows, 4);
    assert.equal(stats.resolved, 2, "土豆 + 曾用名马铃薯");
    assert.equal(stats.ambiguous, 1, "两个小明");
    assert.equal(stats.unknown, 1);

    const rows = dbm.db.select().from(schema.messageMentions).all();
    const byMsg = new Map(rows.map((r) => [r.messageId, r]));
    assert.equal(byMsg.get("m1")!.wxId, "wxid_potato");
    assert.equal(byMsg.get("m2")!.status, "ambiguous");
    assert.deepEqual(
      [...(byMsg.get("m2")!.candidates as string[])].sort(),
      ["wxid_ming_a", "wxid_ming_b"],
    );
    assert.equal(byMsg.get("m3")!.status, "unknown");
    // 字面昵称是证据，必须原样保留
    assert.equal(byMsg.get("m4")!.name, "马铃薯");
    assert.equal(byMsg.get("m4")!.wxId, "wxid_potato");
  });

  it("重跑结果不变 —— 先删后插，不叠加", () => {
    const first = dbm.db.select().from(schema.messageMentions).all().length;
    const stats = ix.backfillConv(CONV);
    assert.equal(stats.mentionRows, 4);
    const second = dbm.db.select().from(schema.messageMentions).all().length;
    assert.equal(second, first, "重跑后行数必须一致");
  });

  it("refermsg XML 出现时回填出 reply_to_id（上游透传后的路径）", () => {
    seedMessage({
      id: "m6",
      type: "quote",
      content: "<refermsg><svrid>1234</svrid></refermsg>",
    });
    ix.backfillConv(CONV);
    const row = dbm.db.select().from(schema.messages).all().find((m) => m.id === "m6");
    assert.equal(row!.replyToId, "1234");
  });

  it("纯文本 quote（上游现状）reply_to_id 保持 null", () => {
    seedMessage({ id: "m7", type: "quote", content: "有道理" });
    ix.backfillConv(CONV);
    const row = dbm.db.select().from(schema.messages).all().find((m) => m.id === "m7");
    assert.equal(row!.replyToId, null);
  });
});

describe("并发兜底", () => {
  it("同一条消息的提及重复插入被唯一索引挡住", () => {
    const mentions = [
      { name: "土豆", status: "resolved" as const, wxId: "wxid_potato", candidates: [], position: 0 },
    ];
    const msg = { id: "m1", convId: CONV, ts: 1 };
    ix.insertMentions(dbm.db, msg, mentions);
    ix.insertMentions(dbm.db, msg, mentions);

    const rows = dbm.db
      .select()
      .from(schema.messageMentions)
      .all()
      .filter((r) => r.messageId === "m1");
    assert.equal(rows.length, 1);
  });
});

describe("查询", () => {
  it("mentionCountFor 只数可见群，范围外为 0", () => {
    assert.equal(ix.mentionCountFor("wxid_potato", [CONV]), 2);
    assert.equal(ix.mentionCountFor("wxid_potato", ["other@chatroom"]), 0);
    assert.equal(ix.mentionCountFor("wxid_potato", []), 0);
  });

  it("mentionsForMessages 按消息分组、按位置排序", () => {
    seedMessage({ id: "m8", content: `@土豆${SEP}和 @小明${SEP}都来` });
    ix.backfillConv(CONV);
    const map = ix.mentionsForMessages(["m8"]);
    const list = map.get("m8")!;
    assert.equal(list.length, 2);
    assert.ok(list[0].position < list[1].position);
  });

  it("replyTargetsFor 取得到被回复消息的原文", () => {
    const map = ix.replyTargetsFor(["m1"]);
    assert.equal(map.get("m1")!.content, `@土豆${SEP}看看这个`);
  });

  it("replyReceivedCountFor：有人回复 m1 后计数为 1", async () => {
    const { eq } = await import("drizzle-orm");
    // m6 的 reply_to_id 是 1234，不指向真实消息；再造一条指向 m1 的
    dbm.db
      .update(schema.messages)
      .set({ replyToId: "m1" })
      .where(eq(schema.messages.id, "m7"))
      .run();
    assert.equal(ix.replyReceivedCountFor("wxid_sender", [CONV]), 1);
  });
});
