import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 通知开关是不是真的接上了。
 *
 * `notification_prefs` 这张表在这之前**一行代码都没读过** ——
 * 表建好了、面板画好了、开关能拨动，而 notify() 根本不看它。
 * 那种开关比没有开关更糟：用户以为自己关掉了，然后继续被打扰，
 * 最后的应对是不再打开这个站。
 *
 * 所以这一组测试盯的是链路本身：拨了开关之后，通知**真的不再产生**。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-notif-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type DbModule = typeof import("@/lib/db");
type NotifyModule = typeof import("@/lib/forum/notify");
type StoreModule = typeof import("@/lib/notifications/store");

let dbm: DbModule;
let schema: typeof import("@/lib/db/schema");
let notifyMod: NotifyModule;
let store: StoreModule;

const ALICE = "u_alice";
const BOB = "u_bob";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  notifyMod = await import("@/lib/forum/notify");
  store = await import("@/lib/notifications/store");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.notifications).run();
  dbm.db.delete(schema.notificationPrefs).run();
  store.invalidatePrefsCache();
});

function send(over: Partial<Parameters<NotifyModule["notify"]>[0]> = {}) {
  notifyMod.notify({
    userId: ALICE,
    type: "reaction",
    groupKey: `k${Math.random()}`,
    title: "有人给你点了表情",
    actorId: BOB,
    actorName: "Bob",
    ...over,
  });
}

function rows(userId = ALICE) {
  return dbm.db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId))
    .all();
}

function mute(type: string) {
  store.savePrefs(ALICE, {
    ...store.getPrefs(ALICE),
    [type]: { site: false, email: false },
  });
}

describe("开关真的接上了", () => {
  it("默认状态下通知照发", () => {
    send();
    assert.equal(rows().length, 1);
  });

  it("**关掉之后不再产生这一行** —— 不是产生了再在读的时候过滤", () => {
    mute("reaction");
    send();
    assert.equal(rows().length, 0, "开关是假的：通知还是写进去了");
    assert.equal(notifyMod.unreadCount(ALICE), 0, "未读数还在涨");
  });

  it("只影响关掉的那一类", () => {
    mute("reaction");
    send({ type: "reaction" });
    send({ type: "mention", title: "有人 @ 了你" });
    assert.deepEqual(rows().map((r) => r.type), ["mention"]);
  });

  it("只影响这一个人", () => {
    mute("reaction");
    send({ userId: ALICE });
    // actorId 也要换掉 —— 自己给自己的通知本来就不发
    send({ userId: BOB, actorId: ALICE, actorName: "Alice" });
    assert.equal(rows(ALICE).length, 0);
    assert.equal(rows(BOB).length, 1);
  });

  it("重新打开之后又能收到（但补不回关掉的那段）", () => {
    mute("reaction");
    send();
    store.savePrefs(ALICE, { ...store.getPrefs(ALICE), reaction: { site: true, email: false } });
    send();
    assert.equal(rows().length, 1, "打开后新的没进来，或者关掉的被补回来了");
  });

  it("**处罚通知关不掉** —— 存了 false 也照发", () => {
    mute("moderation");
    send({ type: "moderation", title: "你的帖子被删除了" });
    assert.equal(rows().length, 1, "用户把「自己被处罚」这件事静音掉了");
  });

  it("系统公告也关不掉", () => {
    mute("system");
    send({ type: "system", title: "站点维护通知" });
    assert.equal(rows().length, 1);
  });
});

describe("缓存不会让开关看起来是假的", () => {
  it("刚保存完立刻生效，不等 TTL", () => {
    send();
    assert.equal(rows().length, 1);

    mute("reaction");
    send();
    assert.equal(rows().length, 1, "关完马上又收到一条 —— 用户的结论是这个开关没用");
  });

  it("重新打开也是立刻生效", () => {
    mute("reaction");
    store.savePrefs(ALICE, { ...store.getPrefs(ALICE), reaction: { site: true, email: false } });
    send();
    assert.equal(rows().length, 1);
  });

  it("存进去的形状是完整的偏好表，不是只存改动的那一项", () => {
    mute("reaction");
    const saved = dbm.db
      .select()
      .from(schema.notificationPrefs)
      .where(eq(schema.notificationPrefs.userId, ALICE))
      .get();
    const channels = saved?.channels as Record<string, { site: boolean }>;
    assert.ok(channels.mention, "只存了改动的那一项，其余类型将来会读不到");
    assert.equal(channels.reaction.site, false);
  });
});

describe("筛选与计数", () => {
  beforeEach(() => {
    send({ type: "mention", groupKey: "m1", title: "@1" });
    send({ type: "reply_to_post", groupKey: "r1", title: "回复 1" });
    send({ type: "reaction", groupKey: "x1", title: "表情 1" });
    send({ type: "moderation", groupKey: "d1", title: "处罚" });
  });

  it("各页签的条数对得上", () => {
    const counts = notifyMod.notificationCounts(ALICE);
    assert.equal(counts.all, 4);
    assert.equal(counts.unread, 4);
    assert.equal(counts.mention, 1);
    assert.equal(counts.reply, 1);
    assert.equal(counts.account, 1);
  });

  it("**筛选在 SQL 里做** —— 不是取一页回来再过滤", () => {
    // 只取 1 条的时候，「@ 我」依然要能拿到那条 @，
    // 而不是因为最近 1 条不是 @ 就显示空
    const list = notifyMod.listNotifications(ALICE, 1, "mention");
    assert.equal(list.length, 1);
    assert.equal(list[0].type, "mention");
  });

  it("未读页签在读完之后清空", () => {
    notifyMod.markRead(ALICE);
    const counts = notifyMod.notificationCounts(ALICE);
    assert.equal(counts.unread, 0);
    assert.equal(counts.all, 4, "已读的不该从列表里消失");
    assert.equal(notifyMod.listNotifications(ALICE, 50, "unread").length, 0);
  });

  it("回复页签盖住三种回复", () => {
    send({ type: "subscribed_reply", groupKey: "s1", title: "关注的帖子" });
    send({ type: "reply_to_reply", groupKey: "rr1", title: "楼中楼" });
    assert.equal(notifyMod.notificationCounts(ALICE).reply, 3);
  });

  it("关掉的类型不会在任何页签里出现", () => {
    dbm.db.delete(schema.notifications).run();
    mute("reaction");
    send({ type: "reaction", groupKey: "x2" });
    assert.equal(notifyMod.notificationCounts(ALICE).all, 0);
  });
});

describe("聚合仍然生效", () => {
  it("同键未读合并成一条并计数", () => {
    send({ groupKey: "same", title: "Bob给你点了表情" });
    send({ groupKey: "same", title: "Bob给你点了表情" });
    const list = rows();
    assert.equal(list.length, 1);
    assert.equal(list[0].count, 2);
  });

  it("已读的不再合并 —— 新动静应该重新冒出来", () => {
    send({ groupKey: "same" });
    notifyMod.markRead(ALICE);
    send({ groupKey: "same" });
    assert.equal(rows().length, 2);
    assert.equal(notifyMod.unreadCount(ALICE), 1);
  });

  it("关掉之后连合并都不会发生", () => {
    send({ groupKey: "same" });
    mute("reaction");
    send({ groupKey: "same" });
    assert.equal(rows()[0].count, 1, "关掉之后旧那条的计数还在涨");
  });
});
