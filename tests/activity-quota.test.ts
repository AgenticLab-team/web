import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 名额的占用与归还。
 *
 * 60 个名额被 300 个人同时抢：**「先查再改」在这里必然出错** ——
 * 两个请求同时读到 quota_used = 59，都判断「还有」，然后都加一。
 * 所以扣减必须是一条带条件的 UPDATE，条件和写入在同一条语句里。
 *
 * 另一条：quota_used 只是缓存列，真值是流水。
 * 名额算错在限量活动里是致命事故，必须能事后重算比对。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-quota-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type Quota = typeof import("@/lib/activities/quota");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let quota: Quota;
let dbm: DbModule;
let schema: SchemaModule;

const ACT = "act1";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  quota = await import("@/lib/activities/quota");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.activityQuotaLog).run();
  dbm.db.delete(schema.activities).run();
});

function activity(quotaTotal: number | null, used = 0) {
  dbm.db
    .insert(schema.activities)
    .values({
      id: ACT,
      moduleKey: "domain",
      title: "域名发放",
      quotaTotal,
      quotaUsed: used,
      status: "open",
      createdBy: "u_admin",
    })
    .run();
}

function claim(applicationId: string) {
  return quota.claimQuota({ activityId: ACT, applicationId, reason: "提交申请" });
}

function used(): number {
  return dbm.db.select().from(schema.activities).where(eq(schema.activities.id, ACT)).get()!.quotaUsed;
}

describe("占名额", () => {
  it("有名额时占得到", () => {
    activity(60);
    const r = claim("app1");
    assert.equal(r.ok, true);
    assert.equal(r.full, undefined);
    assert.equal(used(), 1);
  });

  it("**占满之后转候补，而不是报错**", () => {
    // 名额满不是错误，是要走另一条路
    activity(2);
    claim("app1");
    claim("app2");

    const third = claim("app3");
    assert.equal(third.ok, true);
    assert.equal(third.full, true);
    assert.equal(used(), 2, "满了之后不该再加");
  });

  it("**永远不会超卖**", () => {
    activity(3);
    for (let i = 0; i < 20; i++) claim(`app${i}`);
    assert.equal(used(), 3);
  });

  it("**已经满了的活动一次都占不到**", () => {
    activity(5, 5);
    const r = claim("app1");
    assert.equal(r.full, true);
    assert.equal(used(), 5);
  });

  it("不限名额时一直能占", () => {
    activity(null);
    for (let i = 0; i < 10; i++) assert.equal(claim(`app${i}`).full, undefined);
    assert.equal(used(), 10);
  });

  it("活动不存在时如实报错", () => {
    const r = quota.claimQuota({ activityId: "没有这个", applicationId: "a", reason: "x" });
    assert.equal(r.ok, false);
  });
});

describe("流水", () => {
  it("每次占用都记一笔", () => {
    activity(60);
    claim("app1");
    claim("app2");

    const log = dbm.db.select().from(schema.activityQuotaLog).all();
    assert.equal(log.length, 2);
    assert.ok(log.every((l) => l.delta === 1));
    assert.deepEqual(log.map((l) => l.balanceAfter).sort(), [1, 2]);
  });

  it("**满了没占到时不记流水** —— 没发生的事不该有记录", () => {
    activity(1);
    claim("app1");
    claim("app2");
    assert.equal(dbm.db.select().from(schema.activityQuotaLog).all().length, 1);
  });

  it("流水带上是哪一份申请，事后能对上", () => {
    activity(60);
    claim("app_x");
    assert.equal(dbm.db.select().from(schema.activityQuotaLog).get()!.applicationId, "app_x");
  });

  it("不限名额时也记流水 —— 事后要能统计一共发了多少", () => {
    activity(null);
    claim("app1");
    assert.equal(dbm.db.select().from(schema.activityQuotaLog).all().length, 1);
  });
});

describe("归还名额", () => {
  it("撤回时还回来", () => {
    activity(60);
    claim("app1");
    const r = quota.releaseQuota({ activityId: ACT, applicationId: "app1", reason: "用户撤回" });

    assert.equal(r.ok, true);
    assert.equal(used(), 0);
  });

  it("**还回来之后别人能占到**", () => {
    activity(1);
    claim("app1");
    assert.equal(claim("app2").full, true);

    quota.releaseQuota({ activityId: ACT, applicationId: "app1", reason: "判无效" });
    assert.equal(claim("app3").full, undefined, "名额还回来了就该能占");
  });

  it("**不会扣成负数**", () => {
    // 负的已用数会让「还剩几个」算出比总数还多
    activity(60);
    const r = quota.releaseQuota({ activityId: ACT, applicationId: "app1", reason: "无中生有" });
    assert.equal(r.ok, false);
    assert.equal(used(), 0);
  });

  it("归还也记流水", () => {
    activity(60);
    claim("app1");
    quota.releaseQuota({ activityId: ACT, applicationId: "app1", reason: "撤回" });

    const log = dbm.db.select().from(schema.activityQuotaLog).all();
    assert.equal(log.length, 2);
    assert.ok(log.some((l) => l.delta === -1));
  });
});

describe("对账", () => {
  it("正常情况下缓存列与流水一致", () => {
    activity(60);
    claim("app1");
    claim("app2");
    quota.releaseQuota({ activityId: ACT, applicationId: "app1", reason: "撤回" });

    const audit = quota.auditQuota(ACT);
    assert.equal(audit.cached, 1);
    assert.equal(audit.computed, 1);
    assert.equal(audit.consistent, true);
  });

  it("**有人直接改库时能查出来**", () => {
    // 名额算错在限量活动里是致命事故，所以要能随时对账
    activity(60);
    claim("app1");
    dbm.db.update(schema.activities).set({ quotaUsed: 42 }).where(eq(schema.activities.id, ACT)).run();

    const audit = quota.auditQuota(ACT);
    assert.equal(audit.consistent, false);
    assert.equal(audit.cached, 42);
    assert.equal(audit.computed, 1);
  });

  it("算得出还剩几个", () => {
    activity(60);
    claim("app1");
    assert.equal(quota.auditQuota(ACT).remaining, 59);
  });

  it("不限名额时 remaining 是 null 而不是 0", () => {
    activity(null);
    const audit = quota.auditQuota(ACT);
    assert.equal(audit.remaining, null);
    assert.equal(audit.total, null);
  });

  it("剩余数不会算成负的", () => {
    activity(5, 99);
    assert.equal(quota.auditQuota(ACT).remaining, 0);
  });
});
