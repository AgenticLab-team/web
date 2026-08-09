import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 实时通知的断线补漏 —— 整个功能里最不能错的部分。
 *
 * 微信内置浏览器随手杀连接，重连后必须把断线期间的动静补上：
 * 漏掉一条 @，当事人会以为自己没被 @ —— 比没有通知功能更糟。
 * 这里锁三件事：
 *   1. listSince 的游标语义：含端点、升序、按人隔离 ——
 *      「含端点」是同一毫秒第二条不丢的唯一保证；
 *   2. 轮询器只派发新动静，不重复、不漏聚合计数的变化；
 *   3. 订阅表的进出（退订、连接数上限挤旧）。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-live-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
delete process.env.VAPID_SUBJECT;

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let live: typeof import("@/lib/notifications/live");
let pushStore: typeof import("@/lib/notifications/push-store");
let wp: typeof import("@/lib/notifications/webpush");

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  live = await import("@/lib/notifications/live");
  pushStore = await import("@/lib/notifications/push-store");
  wp = await import("@/lib/notifications/webpush");
});

after(() => {
  live.stopWatcher();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  dbm.db.delete(schema.notifications).run();
  dbm.db.delete(schema.pushSubscriptions).run();
});

function insertNotification(input: {
  id?: string;
  userId: string;
  title: string;
  updatedAt: number;
  count?: number;
  readAt?: number | null;
  type?: "mention" | "reply_to_post";
}) {
  const id = input.id ?? `ntf-${input.userId}-${input.updatedAt}-${Math.random()}`;
  dbm.db
    .insert(schema.notifications)
    .values({
      id,
      userId: input.userId,
      type: input.type ?? "mention",
      groupKey: id,
      title: input.title,
      count: input.count ?? 1,
      readAt: input.readAt ?? null,
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    })
    .run();
  return id;
}

describe("listSince：补漏查询的游标语义", () => {
  it("含端点、升序 —— 游标毫秒上的第二条不能丢", () => {
    insertNotification({ userId: "u1", title: "旧", updatedAt: 1000 });
    insertNotification({ userId: "u1", title: "边界", updatedAt: 2000 });
    insertNotification({ userId: "u1", title: "新", updatedAt: 3000 });

    const got = live.listSince("u1", 2000);
    assert.deepEqual(
      got.map((n) => n.title),
      ["边界", "新"],
      "== 游标的那条必须在结果里（>= 而非 >）",
    );
  });

  it("只补自己的 —— 别人的动静混进来是另一种事故", () => {
    insertNotification({ userId: "u1", title: "我的", updatedAt: 2000 });
    insertNotification({ userId: "u2", title: "别人的", updatedAt: 2500 });

    const got = live.listSince("u1", 0);
    assert.deepEqual(got.map((n) => n.title), ["我的"]);
  });

  it("带的未读数是绝对值 —— 客户端角标靠它幂等", () => {
    insertNotification({ userId: "u1", title: "未读1", updatedAt: 1000 });
    insertNotification({ userId: "u1", title: "已读", updatedAt: 2000, readAt: 2500 });
    insertNotification({ userId: "u1", title: "未读2", updatedAt: 3000 });

    const got = live.listSince("u1", 0);
    assert.equal(got.length, 3);
    for (const item of got) assert.equal(item.unread, 2);
  });

  it("回放有上限 —— 断了一个月的游标不该灌回几千条", () => {
    for (let i = 0; i < 10; i++) {
      insertNotification({ userId: "u1", title: `n${i}`, updatedAt: 1000 + i });
    }
    assert.equal(live.listSince("u1", 0, 3).length, 3);
  });
});

describe("轮询器：增量派发", () => {
  it("新动静派发一次，重复轮询不重发；聚合计数变化算新动静", () => {
    const base = Date.now();
    live.resetWatcherForTest(base);
    const got: { title: string; count: number; unread: number }[] = [];
    const unsubscribe = live.subscribeLive("u1", (e) =>
      got.push({ title: e.title, count: e.count, unread: e.unread }),
    );

    const id = insertNotification({ userId: "u1", title: "第一条", updatedAt: base + 10 });
    live.pollOnce();
    assert.equal(got.length, 1);
    assert.equal(got[0].unread, 1);

    // 同样的数据再轮询 —— 不能重发
    live.pollOnce();
    assert.equal(got.length, 1);

    /*
     * 聚合：同一行 count+1 但 updatedAt 恰好没变（毫秒同刻）。
     * 只按 (id, updatedAt) 去重会漏掉它 —— 键里必须带 count。
     */
    dbm.sqlite
      .prepare(`UPDATE notifications SET count = 2, title = '两人回复了你' WHERE id = ?`)
      .run(id);
    live.pollOnce();
    assert.equal(got.length, 2);
    assert.equal(got[1].count, 2);

    unsubscribe();
    insertNotification({ userId: "u1", title: "退订后", updatedAt: base + 20 });
    live.pollOnce();
    assert.equal(got.length, 2, "退订之后不该再收到");
  });

  it("进程重启（水位线重置）不回放历史 —— 补历史是客户端游标的职责", () => {
    const base = Date.now();
    insertNotification({ userId: "u1", title: "重启前", updatedAt: base - 1000 });
    live.resetWatcherForTest(base);
    const got: string[] = [];
    live.subscribeLive("u1", (e) => got.push(e.title));
    live.pollOnce();
    assert.deepEqual(got, []);
  });

  it("同一个人连接数超限时挤掉最旧的，并通知它收尾", () => {
    live.resetWatcherForTest(Date.now());
    let evicted = 0;
    live.subscribeLive("u1", () => {}, () => evicted++);
    live.subscribeLive("u1", () => {}, () => evicted++);
    live.subscribeLive("u1", () => {}, () => evicted++);
    live.subscribeLive("u1", () => {}, () => evicted++);
    assert.equal(evicted, 0);
    live.subscribeLive("u1", () => {}, () => evicted++);
    assert.equal(evicted, 1, "第五条连接应挤掉最旧的一条");
  });
});

describe("推送订阅表", () => {
  const validKeys = () => ({
    p256dh: wp.generateVapidKeys().publicKey,
    auth: Buffer.alloc(16, 1).toString("base64url"),
  });

  it("校验把守写入口：http endpoint、坏公钥都进不来", () => {
    const keys = validKeys();
    assert.ok(
      pushStore.validateSubscription({ endpoint: "http://push.example/x", ...keys }),
      "http 应被拒",
    );
    assert.ok(
      pushStore.validateSubscription({
        endpoint: "https://push.example/x",
        p256dh: "not-a-key",
        auth: keys.auth,
      }),
      "坏 p256dh 应被拒",
    );
    assert.equal(
      pushStore.validateSubscription({ endpoint: "https://push.example/x", ...keys }),
      null,
    );
  });

  it("同一 endpoint 重新订阅是更新而非报错，且清零失败计数", () => {
    const keys = validKeys();
    pushStore.savePushSubscription("u1", { endpoint: "https://push.example/a", ...keys });
    const [row] = pushStore.listActivePushSubscriptions("u1");
    pushStore.recordPushFailure(row.id, "网络抖动", false);

    pushStore.savePushSubscription("u1", { endpoint: "https://push.example/a", ...keys });
    const rows = pushStore.listActivePushSubscriptions("u1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].failCount, 0, "重新订阅即「我还在」，失败计数应清零");
  });

  it("404/410 立即删；一般失败累计，连续 8 次才停用 —— 网络抖动不该误杀", () => {
    const keys = validKeys();
    pushStore.savePushSubscription("u1", { endpoint: "https://push.example/gone", ...keys });
    const [gone] = pushStore.listActivePushSubscriptions("u1");
    pushStore.recordPushFailure(gone.id, "410", true);
    assert.equal(pushStore.listActivePushSubscriptions("u1").length, 0);

    pushStore.savePushSubscription("u1", { endpoint: "https://push.example/flaky", ...keys });
    const [flaky] = pushStore.listActivePushSubscriptions("u1");
    for (let i = 0; i < 7; i++) pushStore.recordPushFailure(flaky.id, "500", false);
    assert.equal(pushStore.listActivePushSubscriptions("u1").length, 1, "7 次还不该停用");
    pushStore.recordPushFailure(flaky.id, "500", false);
    assert.equal(pushStore.listActivePushSubscriptions("u1").length, 0, "第 8 次停用");

    const summary = pushStore.pushSubscriptionSummary();
    assert.equal(summary.disabled, 1);
  });

  it("每人最多 5 台设备，超过挤掉最旧的 —— 换手机的人不该被旧手机挡住", () => {
    for (let i = 0; i < 6; i++) {
      pushStore.savePushSubscription("u1", {
        endpoint: `https://push.example/device-${i}`,
        ...validKeys(),
      });
    }
    assert.equal(pushStore.listActivePushSubscriptions("u1").length, 5);
  });
});
