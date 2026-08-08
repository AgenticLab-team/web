import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 群发的投递。
 *
 * 「发了一半」是最糟的状态：一部分人收到，一部分没有，
 * 而重发会让前一部分人收到两遍。所以这里锁三件事：
 *   逐条留痕（中途崩溃也知道发到哪了）、
 *   已发的不重发、
 *   发之前再校验一次内容哈希。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-bcast-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type Sender = typeof import("@/lib/broadcast/sender");
type Rules = typeof import("@/lib/broadcast/rules");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");
type Client = typeof import("@/lib/nekobot/client");

let sender: Sender;
let rules: Rules;
let dbm: DbModule;
let schema: SchemaModule;
let client: Client;

const CONTENT = "本周论坛精选：三篇关于向量检索的讨论";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  rules = await import("@/lib/broadcast/rules");
  client = await import("@/lib/nekobot/client");
  sender = await import("@/lib/broadcast/sender");
});

after(() => {
  mock.restoreAll();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  dbm.db.delete(schema.broadcastDeliveries).run();
  dbm.db.delete(schema.broadcasts).run();
  mock.restoreAll();
});

/** 不真的等 —— 测试里等三十秒毫无意义 */
const noSleep = async () => {};

function stubQuota(perMinute = 20) {
  mock.method(client.nekobot, "sendQuota", async () => ({
    per_minute: { used: 0, limit: perMinute },
    per_hour: { used: 0, limit: 200 },
  }));
}

function makeBroadcast(over: Record<string, unknown> = {}, convIds = ["g1", "g2", "g3"]) {
  const id = dbm.db
    .insert(schema.broadcasts)
    .values({
      channel: "wechat",
      content: CONTENT,
      contentHash: rules.contentHash(CONTENT),
      status: "sending",
      createdBy: "u_author",
      approvedBy: "u_reviewer",
      startedAt: Date.now(),
      ...over,
    })
    .returning({ id: schema.broadcasts.id })
    .get().id;

  for (const convId of convIds) {
    dbm.db.insert(schema.broadcastDeliveries).values({ broadcastId: id, convId }).run();
  }
  return id;
}

describe("正常投递", () => {
  it("逐个群发出去并记下 msg_svr_id", async () => {
    stubQuota();
    let n = 0;
    mock.method(client.nekobot, "sendText", async () => ({ msg_svr_id: `m${++n}` }));

    const id = makeBroadcast();
    const report = await sender.deliverBroadcast(id, { sleep: noSleep });

    assert.equal(report.sent, 3);
    assert.equal(report.failed, 0);

    const deliveries = dbm.db.select().from(schema.broadcastDeliveries).all();
    assert.ok(deliveries.every((d) => d.status === "sent"));
    assert.ok(deliveries.every((d) => d.msgSvrId), "msg_svr_id 是撤回的唯一凭据，必须留下");
  });

  it("完成后整条标为已发送", async () => {
    stubQuota();
    mock.method(client.nekobot, "sendText", async () => ({ msg_svr_id: "m1" }));

    const id = makeBroadcast();
    await sender.deliverBroadcast(id, { sleep: noSleep });

    const row = dbm.db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, id)).get()!;
    assert.equal(row.status, "sent");
    assert.equal(row.sentCount, 3);
    assert.ok(row.finishedAt);
  });

  it("**每条之间会等一段时间** —— 一秒连发是最典型的风控触发姿势", async () => {
    stubQuota();
    mock.method(client.nekobot, "sendText", async () => ({ msg_svr_id: "m" }));

    const waits: number[] = [];
    const id = makeBroadcast();
    await sender.deliverBroadcast(id, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    assert.equal(waits.length, 2, "三个群之间应该等两次");
    assert.ok(waits.every((w) => w > 0));
  });
});

describe("部分失败", () => {
  it("**一个群失败不影响其他群，但会被单独记下来**", async () => {
    stubQuota();
    mock.method(client.nekobot, "sendText", async (convId: string) => {
      if (convId === "g2") throw new Error("该群已解散");
      return { msg_svr_id: "m" };
    });

    const id = makeBroadcast();
    const report = await sender.deliverBroadcast(id, { sleep: noSleep });

    assert.equal(report.sent, 2);
    assert.equal(report.failed, 1);

    const bad = dbm.db
      .select()
      .from(schema.broadcastDeliveries)
      .where(eq(schema.broadcastDeliveries.convId, "g2"))
      .get()!;
    assert.equal(bad.status, "failed");
    assert.match(bad.error!, /解散/);
  });

  it("全部失败时整条标为失败", async () => {
    stubQuota();
    mock.method(client.nekobot, "sendText", async () => {
      throw new Error("上游不可达");
    });

    const id = makeBroadcast();
    await sender.deliverBroadcast(id, { sleep: noSleep });

    const row = dbm.db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, id)).get()!;
    assert.equal(row.status, "failed");
  });

  it("部分成功时整条仍算已发送 —— 但失败数留着", async () => {
    stubQuota();
    mock.method(client.nekobot, "sendText", async (convId: string) => {
      if (convId === "g3") throw new Error("失败");
      return { msg_svr_id: "m" };
    });

    const id = makeBroadcast();
    await sender.deliverBroadcast(id, { sleep: noSleep });

    const row = dbm.db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, id)).get()!;
    assert.equal(row.status, "sent");
    assert.equal(row.failedCount, 1);
    assert.match(row.error!, /1 个群/);
  });
});

describe("不重发", () => {
  it("**已经发成功的群不会再收到一遍**", async () => {
    stubQuota();
    const targets: string[] = [];
    mock.method(client.nekobot, "sendText", async (convId: string) => {
      targets.push(convId);
      return { msg_svr_id: "m" };
    });

    const id = makeBroadcast();
    // 模拟上一次跑到一半：g1 已经发出去了
    dbm.db
      .update(schema.broadcastDeliveries)
      .set({ status: "sent", msgSvrId: "old", sentAt: Date.now() })
      .where(eq(schema.broadcastDeliveries.convId, "g1"))
      .run();

    const report = await sender.deliverBroadcast(id, { sleep: noSleep });

    assert.ok(!targets.includes("g1"), "g1 已经收到过了，重发会让那群人看到两遍");
    assert.equal(report.skipped, 1);
    assert.equal(report.sent, 2);
  });
});

describe("发送前的最后一道闸", () => {
  it("**内容与复核时不一致就中止**", async () => {
    stubQuota();
    const sendMock = mock.method(client.nekobot, "sendText", async () => ({ msg_svr_id: "m" }));

    // 复核之后内容被改了
    const id = makeBroadcast({ content: "偷偷改过的内容" });

    const report = await sender.deliverBroadcast(id, { sleep: noSleep });

    assert.equal(sendMock.mock.callCount(), 0, "一条都不该发出去");
    assert.match(report.error!, /不一致/);

    const row = dbm.db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, id)).get()!;
    assert.equal(row.status, "failed");
  });

  it("**查不到上游额度就不发**", async () => {
    // 「查不到就当没限制」是最危险的默认值 —— 那正是撞上风控的姿势
    mock.method(client.nekobot, "sendQuota", async () => {
      throw new Error("上游不可达");
    });
    const sendMock = mock.method(client.nekobot, "sendText", async () => ({ msg_svr_id: "m" }));

    const id = makeBroadcast();
    const report = await sender.deliverBroadcast(id, { sleep: noSleep });

    assert.equal(sendMock.mock.callCount(), 0);
    assert.match(report.error!, /额度/);
  });

  it("找不到群发时如实报错，不静默返回成功", async () => {
    const report = await sender.deliverBroadcast("不存在", { sleep: noSleep });
    assert.ok(report.error);
  });
});

describe("msg_svr_id 缺失", () => {
  it("**没拿到消息 id 仍算发送成功，但记下「撤不回」**", async () => {
    // 消息确实发出去了。当成失败会导致重发，那更糟
    stubQuota();
    mock.method(client.nekobot, "sendText", async () => ({ ok: true }));

    const id = makeBroadcast({}, ["g1"]);
    const report = await sender.deliverBroadcast(id, { sleep: noSleep });

    assert.equal(report.sent, 1);
    const d = dbm.db.select().from(schema.broadcastDeliveries).get()!;
    assert.equal(d.status, "sent");
    assert.equal(d.msgSvrId, null);
    assert.match(d.error!, /撤不回/);
  });
});

describe("队列", () => {
  it("只取 sending 状态的微信群发", () => {
    makeBroadcast({ status: "sending" });
    makeBroadcast({ status: "approved" }, ["g4"]);
    makeBroadcast({ status: "sent" }, ["g5"]);
    makeBroadcast({ channel: "site", status: "sending" }, ["g6"]);

    assert.equal(sender.pendingBroadcasts().length, 1);
  });

  it("没有排队的返回空数组", () => {
    assert.deepEqual(sender.pendingBroadcasts(), []);
  });
});
