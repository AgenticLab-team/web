import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 关键词雷达的扫描链路。
 *
 * 盯三条：
 *
 * **① 只在订阅者自己的群里匹配。** 否则这不是雷达，
 * 是一个能监听任意群的工具 —— 而那个工具一旦存在，
 * 「我在哪个群」这件事就没有意义了。
 *
 * **② 每天封顶，但跨天要重置。** 不封顶的话一次热闹能刷出三十条通知；
 * 封顶之后不重置的话，一次热闹会让这个订阅永远失效。
 *
 * **③ 被压掉的命中要留痕。** 少通知是有意的，瞒着不说不是 ——
 * 用户看到「今天提醒 5 次」不该以为总共只响了 5 次。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-radar-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type DbModule = typeof import("@/lib/db");

let dbm: DbModule;
let schema: typeof import("@/lib/db/schema");
let engine: typeof import("@/lib/radar/engine");
let queries: typeof import("@/lib/radar/queries");
let prefsStore: typeof import("@/lib/notifications/store");

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  engine = await import("@/lib/radar/engine");
  queries = await import("@/lib/radar/queries");
  prefsStore = await import("@/lib/notifications/store");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.keywordHits,
    schema.keywordSubs,
    schema.notifications,
    schema.notificationPrefs,
    schema.groupMembers,
    schema.messages,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }
  // 偏好有进程内缓存，而这里是直接清表 —— 缓存不可能知道
  prefsStore.invalidatePrefsCache();
});

function user(id: string) {
  dbm.db
    .insert(schema.users)
    .values({ id, wxId: `wx_${id}`, wxNickname: id, status: "active" })
    .run();
}
function joinGroup(convId: string, wxId: string) {
  dbm.db.insert(schema.groupMembers).values({ convId, wxId }).run();
}
function sub(userId: string, keyword: string, over: Record<string, unknown> = {}) {
  return dbm.db
    .insert(schema.keywordSubs)
    .values({
      userId,
      keyword,
      keywordKey: keyword.toLowerCase(),
      ...over,
    })
    .returning({ id: schema.keywordSubs.id })
    .get().id;
}

let seq = 0;
function msg(over: Partial<Parameters<typeof engine.scanMessages>[0][number]> = {}) {
  return {
    id: `m${++seq}`,
    convId: "g1",
    content: "聊聊大模型吧",
    ts: NOW,
    senderWxId: "wx_bob",
    senderName: "Bob",
    type: "text",
    ...over,
  };
}

function notifications(userId = "alice") {
  return dbm.db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId))
    .all();
}
function hits(subId: string) {
  return dbm.db
    .select()
    .from(schema.keywordHits)
    .where(eq(schema.keywordHits.subId, subId))
    .all();
}

describe("① 只在自己的群里匹配", () => {
  beforeEach(() => {
    user("alice");
    user("bob");
    joinGroup("g1", "wx_alice");
    joinGroup("g1", "wx_bob");
    joinGroup("g2", "wx_bob");
    sub("alice", "大模型");
  });

  it("自己群里的命中", () => {
    const result = engine.scanMessages([msg({ convId: "g1" })], NOW);
    assert.equal(result.hits, 1);
    assert.equal(result.notified, 1);
    assert.equal(notifications().length, 1);
  });

  it("**别的群里的一律不命中** —— 否则这是个监听工具", () => {
    const result = engine.scanMessages([msg({ convId: "g2" })], NOW);
    assert.equal(result.hits, 0);
    assert.equal(notifications().length, 0);
  });

  it("退群之后立刻不再命中", () => {
    dbm.db.delete(schema.groupMembers).run();
    dbm.db.insert(schema.groupMembers).values({ convId: "g1", wxId: "wx_alice", leftAt: NOW }).run();

    assert.equal(engine.scanMessages([msg({ convId: "g1" })], NOW).hits, 0);
  });

  it("**自己说的话不提醒自己**", () => {
    const result = engine.scanMessages([msg({ senderWxId: "wx_alice" })], NOW);
    assert.equal(result.hits, 0);
  });

  it("暂停的订阅不匹配", () => {
    dbm.db.update(schema.keywordSubs).set({ enabled: false }).run();
    assert.equal(engine.scanMessages([msg()], NOW).hits, 0);
  });

  it("非活跃账号的订阅不匹配", () => {
    dbm.db.update(schema.users).set({ status: "banned" }).where(eq(schema.users.id, "alice")).run();
    assert.equal(engine.scanMessages([msg()], NOW).hits, 0);
  });

  it("非文字消息不扫", () => {
    assert.equal(engine.scanMessages([msg({ type: "image" })], NOW).hits, 0);
  });
});

describe("② 每天封顶，跨天重置", () => {
  let subId: string;

  beforeEach(() => {
    user("alice");
    user("bob");
    joinGroup("g1", "wx_alice");
    subId = sub("alice", "大模型");
  });

  it("**一串连续讨论不该变成一串连续通知**", () => {
    const batch = Array.from({ length: 5 }, () => msg());
    const result = engine.scanMessages(batch, NOW);

    assert.equal(result.hits, 5, "五条都算命中");
    assert.equal(result.notified, 1, "但只提醒一次 —— 十分钟内不重复");
    assert.equal(result.suppressed, 4);
  });

  it("间隔够了能再提醒，但一天最多 5 次", () => {
    for (let i = 0; i < 8; i++) {
      engine.scanMessages([msg()], NOW + i * 20 * 60_000);
    }
    assert.equal(notifications().length, 1, "同一个词的通知会聚合成一条");

    const sent = hits(subId).filter((h) => h.notified).length;
    assert.equal(sent, 5, `一天最多 5 次，实际 ${sent}`);
  });

  it("**第二天重新开始** —— 一次热闹不该让订阅永远失效", () => {
    for (let i = 0; i < 8; i++) engine.scanMessages([msg()], NOW + i * 20 * 60_000);
    assert.equal(hits(subId).filter((h) => h.notified).length, 5);

    engine.scanMessages([msg()], NOW + DAY);
    assert.equal(hits(subId).filter((h) => h.notified).length, 6, "第二天没有重置");
  });

  it("封顶之后命中仍然记录，只是不通知", () => {
    for (let i = 0; i < 8; i++) engine.scanMessages([msg()], NOW + i * 20 * 60_000);
    assert.equal(hits(subId).length, 8, "被压掉的命中也要留痕");
    assert.equal(hits(subId).filter((h) => !h.notified).length, 3);
  });

  it("列表上看得出「还在响，只是不通知了」", () => {
    for (let i = 0; i < 8; i++) engine.scanMessages([msg()], NOW + i * 20 * 60_000);
    const [row] = queries.mySubs("alice", NOW + 8 * 20 * 60_000);
    assert.equal(row.cappedToday, true);
    assert.equal(row.totalHits, 8, "总命中要能看出比通知次数多");
  });

  it("跨天之后列表上的日计数归零", () => {
    for (let i = 0; i < 8; i++) engine.scanMessages([msg()], NOW + i * 20 * 60_000);
    const [row] = queries.mySubs("alice", NOW + DAY);
    assert.equal(row.hitsToday, 0);
    assert.equal(row.cappedToday, false);
  });
});

describe("③ 幂等", () => {
  let subId: string;

  beforeEach(() => {
    user("alice");
    joinGroup("g1", "wx_alice");
    subId = sub("alice", "大模型");
  });

  it("**同一条消息重扫不重复计数**", () => {
    const batch = [msg()];
    engine.scanMessages(batch, NOW);
    const before = hits(subId).length;

    for (let i = 0; i < 5; i++) engine.scanMessages(batch, NOW);

    assert.equal(hits(subId).length, before, "重扫之后命中记录变多了");
    const row = dbm.db.select().from(schema.keywordSubs).get()!;
    assert.equal(row.totalHits, 1, "累计命中被重复加了");
  });

  it("不同消息分别记", () => {
    engine.scanMessages([msg(), msg()], NOW);
    assert.equal(hits(subId).length, 2);
  });
});

describe("多个订阅与多个人", () => {
  beforeEach(() => {
    user("alice");
    user("carol");
    joinGroup("g1", "wx_alice");
    joinGroup("g1", "wx_carol");
  });

  it("同一条消息命中多个人的订阅", () => {
    sub("alice", "大模型");
    sub("carol", "大模型");

    const result = engine.scanMessages([msg()], NOW);
    assert.equal(result.hits, 2);
    assert.equal(notifications("alice").length, 1);
    assert.equal(notifications("carol").length, 1);
  });

  it("一个人的多个词分别命中", () => {
    sub("alice", "大模型");
    sub("alice", "RAG");

    engine.scanMessages([msg({ content: "大模型配合 RAG 用" })], NOW);
    assert.equal(queries.mySubs("alice", NOW).every((s) => s.totalHits === 1), true);
    // 不同的词是不同的聚合键，所以是两条通知
    assert.equal(notifications("alice").length, 2);
  });

  it("关掉了 keyword 类通知的人收不到 —— 开关要真的管用", async () => {
    sub("alice", "大模型");
    // 走真正的保存路径 —— 它会顺手让缓存失效
    const store = await import("@/lib/notifications/store");
    store.savePrefs("alice", {
      ...store.getPrefs("alice"),
      keyword: { site: false, email: false },
    });

    const result = engine.scanMessages([msg()], NOW);
    assert.equal(result.hits, 1, "命中还是要记的");
    assert.equal(notifications("alice").length, 0, "但不该产生通知");
  });
});

describe("噪音预估的范围要和真正匹配时一致", () => {
  beforeEach(() => {
    user("alice");
    joinGroup("g1", "wx_alice");
  });

  function seedMessage(convId: string, content: string, ts: number) {
    dbm.db
      .insert(schema.messages)
      .values({
        id: `s${++seq}`,
        convId,
        senderWxId: "wx_bob",
        senderName: "Bob",
        type: "text",
        content,
        length: content.length,
        ts,
      })
      .run();
  }

  it("只数自己群里的", () => {
    for (let i = 0; i < 3; i++) seedMessage("g1", "聊聊大模型", NOW - i * 3600_000);
    for (let i = 0; i < 9; i++) seedMessage("g2", "聊聊大模型", NOW - i * 3600_000);

    assert.equal(engine.estimateHits7d("alice", "大模型", NOW), 3, "把别的群的也数进来了");
  });

  it("只数七天内的", () => {
    seedMessage("g1", "聊聊大模型", NOW - 3 * DAY);
    seedMessage("g1", "聊聊大模型", NOW - 30 * DAY);
    assert.equal(engine.estimateHits7d("alice", "大模型", NOW), 1);
  });

  it("不在任何群里的人估出来是 0，不炸", () => {
    user("loner");
    assert.equal(engine.estimateHits7d("loner", "大模型", NOW), 0);
  });

  it("**词边界规则和真正匹配时一致** —— 估不准比没有预估更害人", () => {
    seedMessage("g1", "he said hello", NOW);
    seedMessage("g1", "关于 AI 的讨论", NOW);
    assert.equal(engine.estimateHits7d("alice", "AI", NOW), 1);
  });
});
