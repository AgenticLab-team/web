import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 称号的自动授予与到期结算。
 *
 * ─────────────────────────────────────────
 * 这一整块之前是死的
 * ─────────────────────────────────────────
 *
 * `meetsCondition`、`achievementStats`、`renewalExpiry`、`isTitleExpired`
 * 四个函数写好了、有测试、看起来很完整 —— 而没有任何地方调用它们。
 * 也就是说那五个成就称号谁也拿不到，而称号架的空状态还写着
 * 「连续打卡、在论坛发帖和回复都会解锁」。
 *
 * 所以这组测试盯的第一件事就是：**它现在真的会授予**。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-titles-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type DbModule = typeof import("@/lib/db");

let dbm: DbModule;
let schema: typeof import("@/lib/db/schema");
let settle: typeof import("@/lib/titles/settle");
let queries: typeof import("@/lib/titles/queries");
let prefsStore: typeof import("@/lib/notifications/store");

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  settle = await import("@/lib/titles/settle");
  queries = await import("@/lib/titles/queries");
  prefsStore = await import("@/lib/notifications/store");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.userTitles,
    schema.titles,
    schema.notifications,
    schema.notificationPrefs,
    schema.pointsLedger,
    schema.checkins,
    schema.posts,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }
  prefsStore.invalidatePrefsCache();
});

function user(id: string, over: Record<string, unknown> = {}) {
  dbm.db
    .insert(schema.users)
    .values({
      id,
      wxId: `wx_${id}`,
      wxNickname: id,
      status: "active",
      lastActiveAt: NOW,
      ...over,
    })
    .run();
}

let seq = 0;
function title(over: Record<string, unknown> = {}) {
  const id = `t${++seq}`;
  dbm.db
    .insert(schema.titles)
    .values({
      id,
      key: `k${seq}`,
      name: `称号${seq}`,
      rarity: "common",
      source: "achievement",
      enabled: true,
      ...over,
    })
    .run();
  return id;
}

function hold(userId: string, titleId: string, over: Record<string, unknown> = {}) {
  return dbm.db
    .insert(schema.userTitles)
    .values({ userId, titleId, source: "purchase", ...over })
    .returning({ id: schema.userTitles.id })
    .get().id;
}

function heldTitles(userId: string) {
  return dbm.db
    .select()
    .from(schema.userTitles)
    .where(eq(schema.userTitles.userId, userId))
    .all();
}

function notifications(userId: string) {
  return dbm.db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId))
    .all();
}

describe("成就称号真的会被授予", () => {
  beforeEach(() => user("alice", { streakBest: 30 }));

  it("**达成条件就拿到** —— 这之前谁也拿不到", () => {
    title({ conditionKind: "streakBest", conditionValue: 30, name: "常客" });

    const granted = settle.grantAchievementsFor("alice", NOW);
    assert.deepEqual(granted, ["常客"]);
    assert.equal(heldTitles("alice").length, 1);
    assert.equal(heldTitles("alice")[0].source, "achievement");
  });

  it("没达成就不给", () => {
    title({ conditionKind: "streakBest", conditionValue: 100 });
    assert.deepEqual(settle.grantAchievementsFor("alice", NOW), []);
  });

  it("**幂等** —— 跑十遍还是一个", () => {
    title({ conditionKind: "streakBest", conditionValue: 30 });
    for (let i = 0; i < 10; i++) settle.grantAchievementsFor("alice", NOW);
    assert.equal(heldTitles("alice").length, 1);
  });

  it("**拿到要通知** —— 悄悄出现在个人页里等于没有发生过", () => {
    title({ conditionKind: "streakBest", conditionValue: 30, name: "常客" });
    settle.grantAchievementsFor("alice", NOW);

    const list = notifications("alice");
    assert.equal(list.length, 1);
    assert.match(list[0].title, /解锁称号「常客」/);
    assert.equal(list[0].type, "system");
  });

  it("成就通知走 system —— 关不掉", () => {
    // 用户把 system 关掉也照发：解锁通知属于「与账号有关」那一类
    prefsStore.savePrefs("alice", {
      ...prefsStore.getPrefs("alice"),
      system: { site: false, email: false, push: false },
    });
    title({ conditionKind: "streakBest", conditionValue: 30 });
    settle.grantAchievementsFor("alice", NOW);
    assert.equal(notifications("alice").length, 1);
  });

  it("停用的称号不授予", () => {
    title({ conditionKind: "streakBest", conditionValue: 30, enabled: false });
    assert.deepEqual(settle.grantAchievementsFor("alice", NOW), []);
  });

  it("非成就来源的称号不会被自动授予", () => {
    title({ source: "purchase", conditionKind: "streakBest", conditionValue: 1 });
    assert.deepEqual(settle.grantAchievementsFor("alice", NOW), []);
  });

  it("条件字段拼错时不给，也不炸", () => {
    title({ conditionKind: "streakBset", conditionValue: 1 });
    assert.deepEqual(settle.grantAchievementsFor("alice", NOW), []);
  });

  it("多个条件各自判定", () => {
    user("bob", { streakBest: 5, pointsTotal: 1000 });
    title({ conditionKind: "streakBest", conditionValue: 30, name: "连胜" });
    title({ conditionKind: "pointsTotal", conditionValue: 500, name: "富有" });

    assert.deepEqual(settle.grantAchievementsFor("bob", NOW), ["富有"]);
  });
});

describe("到期", () => {
  beforeEach(() => {
    user("alice", { points: 1000 });
  });

  it("**到期的称号从名字后面摘下来** —— 挂着一个过期称号是在说谎", () => {
    const t = title({ source: "purchase", price: 300, rentDays: 30 });
    hold("alice", t, { expiresAt: NOW - DAY });
    dbm.db.update(schema.users).set({ activeTitleId: t }).where(eq(schema.users.id, "alice")).run();

    const result = settle.settleTitles(NOW);
    assert.equal(result.expired, 1);

    const row = dbm.db.select().from(schema.users).where(eq(schema.users.id, "alice")).get()!;
    assert.equal(row.activeTitleId, null);
  });

  it("**记录不删** —— 「我曾经拿到过」也是履历", () => {
    const t = title({ source: "purchase", price: 300, rentDays: 30 });
    hold("alice", t, { expiresAt: NOW - DAY });

    settle.settleTitles(NOW);
    assert.equal(heldTitles("alice").length, 1);

    const owned = queries.titlesOf("alice", NOW);
    assert.equal(owned[0].expired, true);
    assert.equal(owned[0].active, false);
  });

  it("到期要通知", () => {
    const t = title({ source: "purchase", price: 300, rentDays: 30, name: "月租称号" });
    hold("alice", t, { expiresAt: NOW - DAY });

    settle.settleTitles(NOW);
    assert.match(notifications("alice")[0].title, /「月租称号」已到期/);
  });

  it("没到期的不动", () => {
    const t = title({ source: "purchase", price: 300, rentDays: 30 });
    hold("alice", t, { expiresAt: NOW + 30 * DAY });
    assert.equal(settle.settleTitles(NOW).expired, 0);
  });

  it("不会到期的称号不受影响", () => {
    const t = title();
    hold("alice", t, { expiresAt: null });
    assert.equal(settle.settleTitles(NOW).expired, 0);
  });

  it("已经收回的不再处理", () => {
    const t = title({ source: "purchase", price: 300, rentDays: 30 });
    hold("alice", t, { expiresAt: NOW - DAY, revokedAt: NOW - 2 * DAY });
    assert.equal(settle.settleTitles(NOW).expired, 0);
  });
});

describe("自动续费 —— 默认不扣钱", () => {
  beforeEach(() => user("alice", { points: 1000 }));

  it("**默认是关的** —— 默认开着的自动续费会悄悄扣掉别人的分", () => {
    const t = title({ source: "purchase", price: 300, rentDays: 30 });
    const id = hold("alice", t, { expiresAt: NOW - DAY });

    const row = dbm.db.select().from(schema.userTitles).where(eq(schema.userTitles.id, id)).get()!;
    assert.equal(row.autoRenew, false);

    const result = settle.settleTitles(NOW);
    assert.equal(result.renewed, 0);
    assert.equal(result.expired, 1);
    assert.equal(
      dbm.db.select().from(schema.users).where(eq(schema.users.id, "alice")).get()!.points,
      1000,
      "没开自动续费却被扣了分",
    );
  });

  it("开了才扣，扣完顺延", () => {
    const t = title({ source: "purchase", price: 300, rentDays: 30, name: "月租" });
    const id = hold("alice", t, { expiresAt: NOW - DAY, autoRenew: true });

    const result = settle.settleTitles(NOW);
    assert.equal(result.renewed, 1);
    assert.equal(result.expired, 0);

    const row = dbm.db.select().from(schema.userTitles).where(eq(schema.userTitles.id, id)).get()!;
    assert.ok((row.expiresAt ?? 0) > NOW, "续费之后没有顺延到期时间");
    assert.equal(
      dbm.db.select().from(schema.users).where(eq(schema.users.id, "alice")).get()!.points,
      700,
    );
  });

  it("**分不够就让它过期，不扣成负数**", () => {
    user("poor", { points: 100 });
    const t = title({ source: "purchase", price: 300, rentDays: 30 });
    hold("poor", t, { expiresAt: NOW - DAY, autoRenew: true });

    const result = settle.settleTitles(NOW);
    assert.equal(result.renewFailed, 1);
    assert.equal(result.expired, 1);
    assert.equal(
      dbm.db.select().from(schema.users).where(eq(schema.users.id, "poor")).get()!.points,
      100,
      "扣成负数等于让人背上一笔没同意过的债",
    );
    assert.match(notifications("poor")[0].body ?? "", /积分不够/);
  });

  it("续费要记账 —— 积分的每一次变动都要有账", () => {
    const t = title({ source: "purchase", price: 300, rentDays: 30 });
    hold("alice", t, { expiresAt: NOW - DAY, autoRenew: true });
    settle.settleTitles(NOW);

    const ledger = dbm.db.select().from(schema.pointsLedger).all();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].delta, -300);
    assert.match(ledger[0].reason ?? "", /自动续费/);
  });

  it("**重复结算不重复扣费** —— 幂等键挡住", () => {
    const t = title({ source: "purchase", price: 300, rentDays: 30 });
    hold("alice", t, { expiresAt: NOW - DAY, autoRenew: true });

    settle.settleTitles(NOW);
    const after = dbm.db.select().from(schema.users).where(eq(schema.users.id, "alice")).get()!.points;
    settle.settleTitles(NOW);
    settle.settleTitles(NOW);

    assert.equal(
      dbm.db.select().from(schema.users).where(eq(schema.users.id, "alice")).get()!.points,
      after,
      "跑了三遍被扣了三次",
    );
  });

  it("续费成功要通知，并说明怎么关掉", () => {
    const t = title({ source: "purchase", price: 300, rentDays: 30, name: "月租" });
    hold("alice", t, { expiresAt: NOW - DAY, autoRenew: true });
    settle.settleTitles(NOW);

    const list = notifications("alice");
    assert.match(list[0].title, /已自动续费/);
    assert.match(list[0].body ?? "", /关掉自动续费/);
  });
});

describe("到期提醒 —— 到期当天才说就来不及了", () => {
  beforeEach(() => user("alice", { points: 1000 }));

  it("提前几天提醒一次", () => {
    const t = title({ source: "purchase", price: 300, rentDays: 30, name: "月租" });
    hold("alice", t, { expiresAt: NOW + 2 * DAY });

    const result = settle.settleTitles(NOW);
    assert.equal(result.reminded, 1);
    assert.match(notifications("alice")[0].title, /2 天后到期/);
  });

  it("**只提醒一次** —— 每五分钟提醒一次会让人把通知全关掉", () => {
    const t = title({ source: "purchase", price: 300, rentDays: 30 });
    hold("alice", t, { expiresAt: NOW + 2 * DAY });

    settle.settleTitles(NOW);
    assert.equal(settle.settleTitles(NOW).reminded, 0);
    assert.equal(settle.settleTitles(NOW + 3600_000).reminded, 0);
  });

  it("还早的不提醒", () => {
    const t = title({ source: "purchase", price: 300, rentDays: 30 });
    hold("alice", t, { expiresAt: NOW + 20 * DAY });
    assert.equal(settle.settleTitles(NOW).reminded, 0);
  });

  it("提醒文案区分开没开自动续费 —— 两种情况该做的事不一样", () => {
    const a = title({ source: "purchase", price: 300, rentDays: 30 });
    hold("alice", a, { expiresAt: NOW + 2 * DAY, autoRenew: true });
    settle.settleTitles(NOW);
    assert.match(notifications("alice")[0].body ?? "", /自动续费 300 分/);

    dbm.db.delete(schema.notifications).run();
    user("bob", { points: 1000 });
    const b = title({ source: "purchase", price: 300, rentDays: 30 });
    hold("bob", b, { expiresAt: NOW + 2 * DAY, autoRenew: false });
    settle.settleTitles(NOW);
    assert.match(notifications("bob")[0].body ?? "", /自动摘下/);
  });
});

describe("全量结算", () => {
  it("只扫最近活跃过的人 —— 三个月没来的人不可能新达成什么", () => {
    user("active", { streakBest: 30, lastActiveAt: NOW - DAY });
    user("gone", { streakBest: 30, lastActiveAt: NOW - 200 * DAY });
    title({ conditionKind: "streakBest", conditionValue: 30 });

    const result = settle.settleAll({ now: NOW });
    assert.equal(result.granted, 1);
    assert.equal(heldTitles("active").length, 1);
    assert.equal(heldTitles("gone").length, 0);
  });

  it("非活跃账号不授予", () => {
    user("banned", { streakBest: 30, status: "banned" });
    title({ conditionKind: "streakBest", conditionValue: 30 });
    assert.equal(settle.settleAll({ now: NOW }).granted, 0);
  });

  it("授予与到期在同一轮里都会跑", () => {
    user("alice", { streakBest: 30, points: 1000 });
    title({ conditionKind: "streakBest", conditionValue: 30 });
    const rented = title({ source: "purchase", price: 300, rentDays: 30 });
    hold("alice", rented, { expiresAt: NOW - DAY });

    const result = settle.settleAll({ now: NOW });
    assert.equal(result.granted, 1);
    assert.equal(result.expired, 1);
  });
});
