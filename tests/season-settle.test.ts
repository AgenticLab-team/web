import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 赛季结算。
 *
 * ─────────────────────────────────────────
 * 第一条压过其它所有条
 * ─────────────────────────────────────────
 *
 * **它一个字都不能碰余额。** 清一次积分就等于告诉所有人
 * 「你攒的东西随时可能没有」，而那之后没有人会再把它当回事 ——
 * ECONOMY.md 里三条致命项之一。
 *
 * 其次是**冻结**：daily_stats 会被存储裁剪动到，
 * 而「2026 春季赛冠军是谁」一旦发生就不该再变。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-season-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type DbModule = typeof import("@/lib/db");

let dbm: DbModule;
let schema: typeof import("@/lib/db/schema");
let settle: typeof import("@/lib/seasons/settle");
let queries: typeof import("@/lib/seasons/queries");
let prefsStore: typeof import("@/lib/notifications/store");

/** 一个已经结束的赛季：2026-07-01 ~ 2026-10-01（东八区） */
const START = Date.UTC(2026, 5, 30, 16);
const END = Date.UTC(2026, 8, 30, 16);
const AFTER = END + 86_400_000;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  settle = await import("@/lib/seasons/settle");
  queries = await import("@/lib/seasons/queries");
  prefsStore = await import("@/lib/notifications/store");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.seasonStandings,
    schema.seasons,
    schema.userTitles,
    schema.titles,
    schema.notifications,
    schema.pointsLedger,
    schema.dailyStats,
    schema.groups,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }
  prefsStore.invalidatePrefsCache();

  dbm.db.insert(schema.groups).values({ convId: "g1", name: "g1", syncEnabled: true }).run();
  for (const key of ["season_champion", "season_runner_up", "season_third"]) {
    dbm.db
      .insert(schema.titles)
      .values({ key, name: key, rarity: "epic", source: "seasonal", enabled: true })
      .run();
  }
});

function season(over: Record<string, unknown> = {}) {
  return dbm.db
    .insert(schema.seasons)
    .values({ key: "2026Q3", name: "2026 秋季赛", startsAt: START, endsAt: END, ...over })
    .returning()
    .get();
}

function user(id: string, points = 1000) {
  dbm.db
    .insert(schema.users)
    .values({ id, wxId: `wx_${id}`, wxNickname: id, status: "active", points, pointsTotal: points })
    .run();
}

function stats(wxId: string, quality: number, date = "2026-08-15") {
  dbm.db
    .insert(schema.dailyStats)
    .values({ wxId, convId: "g1", date, messages: quality * 2, qualityMessages: quality, charsTotal: 100 })
    .onConflictDoUpdate({
      target: [schema.dailyStats.wxId, schema.dailyStats.convId, schema.dailyStats.date],
      set: { qualityMessages: quality },
    })
    .run();
}

function standings(seasonId: string) {
  return dbm.db
    .select()
    .from(schema.seasonStandings)
    .where(eq(schema.seasonStandings.seasonId, seasonId))
    .all();
}

function pointsOf(id: string) {
  return dbm.db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;
}

describe("**赛季不碰任何人的余额**", () => {
  it("结算前后积分与累计一分不差", () => {
    const row = season();
    user("alice", 1234);
    user("bob", 5678);
    stats("wx_alice", 50);
    stats("wx_bob", 30);

    const before = [pointsOf("alice"), pointsOf("bob")].map((u) => [u.points, u.pointsTotal]);
    settle.settleSeason(row, AFTER);
    const after = [pointsOf("alice"), pointsOf("bob")].map((u) => [u.points, u.pointsTotal]);

    assert.deepEqual(after, before, "赛季结算动了余额");
  });

  it("**一条积分流水都不产生**", () => {
    const row = season();
    user("alice");
    stats("wx_alice", 50);

    settle.settleSeason(row, AFTER);
    assert.equal(dbm.db.select().from(schema.pointsLedger).all().length, 0);
  });
});

describe("冻结名次", () => {
  it("把名次存下来", () => {
    const row = season();
    user("alice");
    user("bob");
    stats("wx_alice", 50);
    stats("wx_bob", 30);

    const result = settle.settleSeason(row, AFTER);
    assert.equal(result.ok, true);
    assert.equal(result.frozen, 2);

    const frozen = standings(row.id).sort((a, b) => a.rank - b.rank);
    assert.deepEqual(frozen.map((s) => s.wxId), ["wx_alice", "wx_bob"]);
    assert.deepEqual(frozen.map((s) => s.rank), [1, 2]);
  });

  it("**冻结之后即使明细被裁剪，冠军也不变**", () => {
    const row = season();
    user("alice");
    user("bob");
    stats("wx_alice", 50);
    stats("wx_bob", 30);
    settle.settleSeason(row, AFTER);

    // 模拟存储裁剪：把冠军那段明细删掉
    dbm.db.delete(schema.dailyStats).run();

    const settled = dbm.db.select().from(schema.seasons).where(eq(schema.seasons.id, row.id)).get()!;
    const board = queries.seasonBoard(settled, ["g1"]);
    assert.equal(board[0]?.wxId, "wx_alice", "明细没了之后冠军换人了");
  });

  it("只统计这个赛季区间内的", () => {
    const row = season();
    user("alice");
    stats("wx_alice", 50, "2026-08-15");
    stats("wx_alice", 999, "2026-10-05"); // 下个赛季

    settle.settleSeason(row, AFTER);
    assert.equal(standings(row.id)[0].quality, 50, "把下个赛季的算进来了");
  });

  it("**没上榜的人不占位** —— 没发言就不在名次里", () => {
    const row = season();
    user("alice");
    user("silent");
    stats("wx_alice", 50);

    settle.settleSeason(row, AFTER);
    assert.deepEqual(standings(row.id).map((s) => s.wxId), ["wx_alice"]);
  });
});

describe("称号", () => {
  it("前三拿到称号并收到通知", () => {
    const row = season();
    for (const [id, q] of [["a", 50], ["b", 40], ["c", 30], ["d", 20]] as const) {
      user(id);
      stats(`wx_${id}`, q);
    }

    const result = settle.settleSeason(row, AFTER);
    assert.equal(result.awarded, 3);

    const held = dbm.db.select().from(schema.userTitles).all();
    assert.equal(held.length, 3);
    assert.ok(held.every((h) => h.source === "seasonal"));
    assert.ok(held.every((h) => (h.expiresAt ?? 0) > END), "赛季称号没有到期时间");

    const notes = dbm.db.select().from(schema.notifications).all();
    assert.equal(notes.length, 3);
    assert.match(notes[0].title, /2026 秋季赛/);
  });

  it("**第四名没有** —— 发到前二十就变成参与奖", () => {
    const row = season();
    for (const [id, q] of [["a", 50], ["b", 40], ["c", 30], ["d", 20]] as const) {
      user(id);
      stats(`wx_${id}`, q);
    }
    settle.settleSeason(row, AFTER);

    const frozen = standings(row.id).sort((a, b) => a.rank - b.rank);
    assert.equal(frozen[3].awardedTitleKey, null);
  });

  it("这个赛季没人参与就不发称号，但名次照样冻结", () => {
    const row = season();
    user("a");
    stats("wx_a", 3); // 低于门槛

    const result = settle.settleSeason(row, AFTER);
    assert.equal(result.ok, true);
    assert.equal(result.awarded, 0);
    assert.equal(result.frozen, 1, "不发称号不等于不冻结");
    assert.equal(dbm.db.select().from(schema.userTitles).all().length, 0);
  });

  it("**榜上但没注册过的人：名次冻结，称号发不了**", () => {
    /*
     * daily_stats 是按 wx_id 统计的，而只有二十几个人在站上有账号。
     * 他确实是这个赛季的第一名，只是这个站还没有能给他挂东西的地方。
     */
    const row = season();
    stats("wx_ghost", 50);

    const result = settle.settleSeason(row, AFTER);
    assert.equal(result.frozen, 1);
    assert.equal(result.awarded, 0);
    assert.equal(standings(row.id)[0].awardedTitleKey, "season_champion", "名次记录里还是要写清楚该发什么");
  });

  it("连任的人顺延到期日，而不是插一条新的", () => {
    const first = season();
    user("a");
    stats("wx_a", 50);
    settle.settleSeason(first, AFTER);

    const held = dbm.db.select().from(schema.userTitles).all();
    assert.equal(held.length, 1);
    const firstExpiry = held[0].expiresAt!;

    // 下一个赛季，同一个人又是第一
    const second = dbm.db
      .insert(schema.seasons)
      .values({
        key: "2026Q4",
        name: "2026 冬季赛",
        startsAt: END,
        endsAt: END + 90 * 86_400_000,
      })
      .returning()
      .get();
    stats("wx_a", 60, "2026-11-15");
    settle.settleSeason(second, END + 100 * 86_400_000);

    const after = dbm.db.select().from(schema.userTitles).all();
    assert.equal(after.length, 1, "同一个人挂了两个「赛季冠军」");
    assert.ok(after[0].expiresAt! > firstExpiry, "连任之后到期日没有顺延");
  });
});

describe("幂等", () => {
  it("**结算过的赛季不再结算**", () => {
    const row = season();
    user("a");
    stats("wx_a", 50);

    const first = settle.settleSeason(row, AFTER);
    assert.equal(first.ok, true);

    const reloaded = dbm.db.select().from(schema.seasons).where(eq(schema.seasons.id, row.id)).get()!;
    const second = settle.settleSeason(reloaded, AFTER);
    assert.equal(second.ok, false);
    assert.match(second.reason, /已经结算过/);
    assert.equal(standings(row.id).length, 1);
    assert.equal(dbm.db.select().from(schema.userTitles).all().length, 1);
  });

  it("赛季还没结束就不结算", () => {
    const row = season();
    const result = settle.settleSeason(row, START + 86_400_000);
    assert.equal(result.ok, false);
    assert.match(result.reason, /还没结束/);
    assert.equal(standings(row.id).length, 0);
  });

  it("扫描任务只挑该结算的", () => {
    season();
    dbm.db
      .insert(schema.seasons)
      .values({
        key: "2027Q1",
        name: "2027 春季赛",
        startsAt: AFTER,
        endsAt: AFTER + 90 * 86_400_000,
      })
      .run();
    user("a");
    stats("wx_a", 50);

    const results = settle.settleDueSeasons(AFTER);
    assert.equal(results.length, 1);
    assert.equal(results[0].seasonKey, "2026Q3");
  });

  it("扫描任务重复跑不重复结算", () => {
    season();
    user("a");
    stats("wx_a", 50);

    settle.settleDueSeasons(AFTER);
    const again = settle.settleDueSeasons(AFTER);
    assert.equal(again.length, 0, "已经结算过的又被扫出来了");
  });
});

describe("当前赛季", () => {
  it("表里没有时现造一个 —— 空榜看起来像出了故障", () => {
    const now = Date.UTC(2026, 7, 15);
    const current = queries.currentSeason(now);
    assert.ok(current);
    assert.equal(current.key, "2026Q3");
  });

  it("重复调用不会造出两个", () => {
    const now = Date.UTC(2026, 7, 15);
    queries.currentSeason(now);
    queries.currentSeason(now);
    assert.equal(dbm.db.select().from(schema.seasons).all().length, 1);
  });

  it("视图里带着倒计时 —— 页面不用自己算", () => {
    const view = queries.currentSeasonView(END - 5 * 86_400_000);
    assert.equal(view?.status, "active");
    assert.equal(view?.daysLeft, 5);
  });
});
