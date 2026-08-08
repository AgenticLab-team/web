import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * 通知聚合测试。
 *
 * 不聚合的后果不是「通知有点多」，是**用户把通知整个关掉** ——
 * 那等于一条都没发。所以聚合规则必须准确。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-notify-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type NotifyModule = typeof import("@/lib/forum/notify");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let n: NotifyModule;
let dbm: DbModule;
let schema: SchemaModule;

const ME = "u_me";
const ALICE = "u_alice";
const POST = "p1";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  n = await import("@/lib/forum/notify");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function reset() {
  dbm.db.delete(schema.notifications).run();
  dbm.db.delete(schema.subscriptions).run();
}

describe("聚合标题", () => {
  it("一条时保持原样", () => {
    assert.equal(n.aggregateTitle("张三回复了你的帖子", "张三", 1), "张三回复了你的帖子");
  });

  it("多条时换成「某某等 N 人」", () => {
    assert.equal(n.aggregateTitle("李四回复了你的帖子", "李四", 3), "李四等 3 人回复了你的帖子");
  });

  it("没有人名时只说数量", () => {
    assert.equal(n.aggregateTitle("有人回复了你的帖子", null, 5), "5 人有人回复了你的帖子");
  });
});

describe("通知聚合", () => {
  it("同一聚合键的未读通知合并成一条", () => {
    reset();
    for (const name of ["张三", "李四", "王五"]) {
      n.notify({
        userId: ME,
        type: "reply_to_post",
        groupKey: `reply:${POST}`,
        title: `${name}回复了你的帖子`,
        actorId: `u_${name}`,
        actorName: name,
      });
    }

    const rows = dbm.db.select().from(schema.notifications).all();
    assert.equal(rows.length, 1, "三条回复应该合并成一条通知");
    assert.equal(rows[0].count, 3);
    assert.ok(rows[0].title.includes("3 人"), rows[0].title);
  });

  it("不同聚合键各自成条", () => {
    reset();
    n.notify({ userId: ME, type: "reply_to_post", groupKey: "reply:a", title: "帖子 A 有回复" });
    n.notify({ userId: ME, type: "reply_to_post", groupKey: "reply:b", title: "帖子 B 有回复" });
    assert.equal(dbm.db.select().from(schema.notifications).all().length, 2);
  });

  it("**已读的不再合并**，新动静重新冒出来", () => {
    reset();
    n.notify({ userId: ME, type: "reply_to_post", groupKey: "reply:x", title: "第一次" });
    n.markRead(ME);
    n.notify({ userId: ME, type: "reply_to_post", groupKey: "reply:x", title: "第二次" });

    const rows = dbm.db.select().from(schema.notifications).all();
    assert.equal(rows.length, 2, "已读之后的新通知必须是新的一条，不能改掉已读那条");
    assert.equal(rows.filter((r) => r.readAt === null).length, 1);
  });

  it("不给自己发通知", () => {
    reset();
    n.notify({
      userId: ME,
      type: "reply_to_post",
      groupKey: "reply:self",
      title: "自己回自己",
      actorId: ME,
    });
    assert.equal(dbm.db.select().from(schema.notifications).all().length, 0);
  });

  it("未读计数只算未读", () => {
    reset();
    n.notify({ userId: ME, type: "system", groupKey: "s1", title: "一" });
    n.notify({ userId: ME, type: "system", groupKey: "s2", title: "二" });
    assert.equal(n.unreadCount(ME), 2);
    n.markRead(ME);
    assert.equal(n.unreadCount(ME), 0);
  });

  it("标记单条已读不影响其它条", () => {
    reset();
    n.notify({ userId: ME, type: "system", groupKey: "s1", title: "一" });
    n.notify({ userId: ME, type: "system", groupKey: "s2", title: "二" });
    const first = dbm.db.select().from(schema.notifications).all()[0];
    n.markRead(ME, first.id);
    assert.equal(n.unreadCount(ME), 1);
  });
});

describe("新回复通知的去重", () => {
  it("回复者自己不会收到通知", () => {
    reset();
    n.notifyNewReply({
      postId: POST,
      postTitle: "标题",
      postAuthorId: ALICE,
      replyAuthorId: ALICE, // 作者回自己的帖
      replyAuthorName: "Alice",
      floor: 1,
      mentions: [],
    });
    assert.equal(dbm.db.select().from(schema.notifications).all().length, 0);
  });

  it("同时是作者又被 @ 时只发一条", () => {
    reset();
    n.notifyNewReply({
      postId: POST,
      postTitle: "标题",
      postAuthorId: ME,
      replyAuthorId: ALICE,
      replyAuthorName: "Alice",
      floor: 2,
      mentions: [ME], // 既是作者又被提及
    });
    const rows = dbm.db.select().from(schema.notifications).all();
    assert.equal(rows.length, 1, "同一件事不该发两条通知");
    // 被 @ 的优先级更高，应当是 mention 而不是普通回复
    assert.equal(rows[0].type, "mention");
  });

  it("订阅者收到通知，但已经收到过的人不重复收", () => {
    reset();
    dbm.db
      .insert(schema.subscriptions)
      .values([
        { userId: ME, targetType: "post", targetId: POST },
        { userId: "u_watcher", targetType: "post", targetId: POST },
      ])
      .run();

    n.notifyNewReply({
      postId: POST,
      postTitle: "标题",
      postAuthorId: ME,
      replyAuthorId: ALICE,
      replyAuthorName: "Alice",
      floor: 3,
      mentions: [],
    });

    const rows = dbm.db.select().from(schema.notifications).all();
    assert.equal(rows.length, 2, "作者一条 + 订阅者一条");
    const byUser = new Map(rows.map((r) => [r.userId, r.type]));
    assert.equal(byUser.get(ME), "reply_to_post", "作者拿到的是「回复了你的帖子」而非订阅通知");
    assert.equal(byUser.get("u_watcher"), "subscribed_reply");
  });

  it("静音的订阅者不收通知", () => {
    reset();
    dbm.db
      .insert(schema.subscriptions)
      .values({ userId: "u_muted", targetType: "post", targetId: POST, mutedAt: Date.now() })
      .run();

    n.notifyNewReply({
      postId: POST,
      postTitle: "标题",
      postAuthorId: ALICE,
      replyAuthorId: "u_third",
      replyAuthorName: "第三人",
      floor: 4,
      mentions: [],
    });

    const rows = dbm.db.select().from(schema.notifications).all();
    assert.ok(!rows.some((r) => r.userId === "u_muted"), "静音后不该再收到通知");
  });
});

describe("自动订阅", () => {
  it("发帖后自动订阅", () => {
    reset();
    n.autoSubscribe(ME, POST);
    assert.equal(n.isSubscribed(ME, POST), true);
  });

  it("**退订过的人不会被自动订阅回来**", () => {
    reset();
    n.autoSubscribe(ME, POST);
    // 模拟用户手动退订（静音而不是删记录）
    dbm.db.update(schema.subscriptions).set({ mutedAt: Date.now() }).run();

    // 再回一帖，不该被订阅回来
    n.autoSubscribe(ME, POST);
    assert.equal(n.isSubscribed(ME, POST), false, "退订按钮必须真的有用");
  });
});
