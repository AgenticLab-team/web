import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 性能守卫。
 *
 * ─────────────────────────────────────────
 * N+1 是唯一一种「不会被发现」的 bug
 * ─────────────────────────────────────────
 *
 * 它不报错、不崩、测试全绿。二十条数据的时候没人看得出来，
 * 两千条的时候页面开始转圈 —— 而那时候没有任何一个时刻能指着说
 * 「就是这次改动带来的」，因为它一直都在。
 *
 * 所以这里给每个列表查询定一个**查询条数预算**，
 * 然后把数据量翻十倍再跑一次：**条数不许跟着涨**。
 * 涨了就是 N+1，哪怕现在只有二十行数据。
 *
 * ─────────────────────────────────────────
 * 顺带盯全表扫描
 * ─────────────────────────────────────────
 *
 * SQLite 的 EXPLAIN QUERY PLAN 会直说 SCAN 还是 SEARCH。
 * 大表上的 SCAN 今天不痛，是因为表还小。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-perf-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type DbModule = typeof import("@/lib/db");

let dbm: DbModule;
let schema: typeof import("@/lib/db/schema");
let members: typeof import("@/lib/members/queries");
let links: typeof import("@/lib/links/queries");
let radar: typeof import("@/lib/radar/queries");
let notify: typeof import("@/lib/forum/notify");
let leaderboard: typeof import("@/lib/queries/leaderboard");
let match: typeof import("@/lib/radar/match");

const NOW = 1_800_000_000_000;

/** 数一次调用打了多少条 SQL —— drizzle 和裸 SQL 都会走 prepare */
function countQueries<T>(fn: () => T): { result: T; queries: number } {
  const original = dbm.sqlite.prepare.bind(dbm.sqlite);
  let queries = 0;
  (dbm.sqlite as unknown as { prepare: typeof original }).prepare = (sql: string) => {
    queries++;
    return original(sql);
  };
  try {
    return { result: fn(), queries };
  } finally {
    (dbm.sqlite as unknown as { prepare: typeof original }).prepare = original;
  }
}

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  members = await import("@/lib/members/queries");
  links = await import("@/lib/links/queries");
  radar = await import("@/lib/radar/queries");
  notify = await import("@/lib/forum/notify");
  leaderboard = await import("@/lib/queries/leaderboard");
  match = await import("@/lib/radar/match");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.keywordHits,
    schema.keywordSubs,
    schema.linkMentions,
    schema.links,
    schema.userSkills,
    schema.notifications,
    schema.dailyStats,
    schema.groupMembers,
    schema.groups,
    schema.people,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }
});

let seq = 0;

/** 造 n 个同群成员，每人一个标签 */
function seedMembers(n: number) {
  dbm.db.insert(schema.groups).values({ convId: "g1", name: "g1", syncEnabled: true }).onConflictDoNothing().run();
  for (let i = 0; i < n; i++) {
    const id = `u${++seq}`;
    dbm.db
      .insert(schema.users)
      .values({ id, wxId: `wx_${id}`, wxNickname: `成员${i}`, status: "active" })
      .run();
    dbm.db.insert(schema.people).values({ wxId: `wx_${id}`, displayName: `成员${i}` }).run();
    dbm.db.insert(schema.groupMembers).values({ convId: "g1", wxId: `wx_${id}` }).run();
    dbm.db.insert(schema.userSkills).values({ userId: id, slug: `s${i % 5}`, label: `技能${i % 5}` }).run();
  }
}

function seedLinks(n: number) {
  for (let i = 0; i < n; i++) {
    const id = `l${++seq}`;
    dbm.db
      .insert(schema.links)
      .values({
        id,
        urlKey: `a.com/${id}`,
        url: `https://a.com/${id}`,
        domain: "a.com",
        title: id,
        shareCount: 1,
        firstSharedAt: NOW,
        lastSharedAt: NOW,
      })
      .run();
    dbm.db
      .insert(schema.linkMentions)
      .values({ linkId: id, convId: "g1", messageId: `m${id}`, sharedAt: NOW })
      .run();
  }
}

function seedNotifications(n: number) {
  for (let i = 0; i < n; i++) {
    dbm.db
      .insert(schema.notifications)
      .values({ userId: "me", type: "mention", groupKey: `k${++seq}`, title: `通知${i}` })
      .run();
  }
}

function seedStats(users: number, days: number) {
  for (let u = 0; u < users; u++) {
    for (let d = 0; d < days; d++) {
      dbm.db
        .insert(schema.dailyStats)
        .values({
          wxId: `wx_u${u}`,
          convId: "g1",
          date: `2026-08-${String((d % 28) + 1).padStart(2, "0")}`,
          messages: 10,
          qualityMessages: 5,
          charsTotal: 100,
        })
        .onConflictDoNothing()
        .run();
    }
  }
}

function viewer(id: string) {
  return { id, wxId: `wx_${id}` } as never;
}

/**
 * 核心断言：数据翻十倍，查询条数不许涨。
 *
 * 允许一个很小的浮动（比如某些查询在有数据/无数据时分支不同），
 * 但**不允许随行数线性增长** —— 那就是 N+1。
 */
function assertNoNPlusOne(
  label: string,
  seed: (n: number) => void,
  run: () => unknown,
  budget: number,
) {
  seed(3);
  const small = countQueries(run).queries;

  seed(30);
  const large = countQueries(run).queries;

  assert.ok(
    small <= budget,
    `${label}：小数据量就用了 ${small} 条查询，超过预算 ${budget}`,
  );
  /*
   * 只禁止「涨」，不要求相等。
   *
   * 空列表会走短路分支，条数反而比有数据时多一两条 ——
   * 要求严格相等的话，这个测试会在完全正常的代码上红，
   * 然后被人放宽成一个没有意义的上界。**变多才是 N+1**。
   */
  assert.ok(
    large <= small,
    `${label}：数据从 3 条涨到 33 条，查询条数从 ${small} 变成 ${large} —— 这是 N+1`,
  );
  assert.ok(large <= budget, `${label}：${large} 条查询超过预算 ${budget}`);
}

describe("列表查询不能是 N+1", () => {
  it("**成员目录**：成员再多也是固定几条查询", () => {
    dbm.db.insert(schema.groups).values({ convId: "g1", name: "g1", syncEnabled: true }).run();
    dbm.db
      .insert(schema.users)
      .values({ id: "me", wxId: "wx_me", wxNickname: "我", status: "active" })
      .run();
    dbm.db.insert(schema.groupMembers).values({ convId: "g1", wxId: "wx_me" }).run();

    assertNoNPlusOne("成员目录", seedMembers, () => members.memberDirectory(viewer("me")), 12);
  });

  it("**资源库**：链接再多也是固定几条查询", () => {
    dbm.db.insert(schema.groupMembers).values({ convId: "g1", wxId: "wx_me" }).run();
    assertNoNPlusOne("资源库", seedLinks, () => links.listLinks(viewer("me")), 6);
  });

  it("**通知列表**：通知再多也是一条查询", () => {
    assertNoNPlusOne("通知列表", seedNotifications, () => notify.listNotifications("me", 50), 4);
  });

  it("**通知计数**：分页签的计数不能逐类去查", () => {
    assertNoNPlusOne("通知计数", seedNotifications, () => notify.notificationCounts("me"), 4);
  });

  it("**排行榜**：人数与天数再多也是一条聚合", () => {
    assertNoNPlusOne(
      "排行榜",
      (n) => seedStats(n, 5),
      () => leaderboard.getLeaderboard({ convIds: ["g1"] }),
      6,
    );
  });
});

describe("有界的循环是可以接受的，但界要写死", () => {
  it("雷达订阅列表的查询条数跟**订阅数**走，而订阅数有上限", () => {
    dbm.db
      .insert(schema.users)
      .values({ id: "me", wxId: "wx_me", status: "active" })
      .run();

    const add = (n: number) => {
      for (let i = 0; i < n; i++) {
        dbm.db
          .insert(schema.keywordSubs)
          .values({ userId: "me", keyword: `词${++seq}`, keywordKey: `词${seq}` })
          .run();
      }
    };

    add(3);
    const small = countQueries(() => radar.mySubs("me", NOW)).queries;
    add(7); // 到上限 10 个
    const large = countQueries(() => radar.mySubs("me", NOW)).queries;

    assert.ok(large > small, "这个查询确实是按订阅数循环的");
    const { MAX_KEYWORDS_PER_USER } = match;
    assert.ok(
      large <= MAX_KEYWORDS_PER_USER + 3,
      `订阅列表用了 ${large} 条查询 —— 上限是 ${MAX_KEYWORDS_PER_USER} 个词，超出说明界没兜住`,
    );
  });
});

describe("热点查询不能全表扫描", () => {
  function planOf(sql: string): string {
    return dbm.sqlite
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((r) => (r as { detail: string }).detail)
      .join(" | ");
  }

  const HOT: [string, string, string][] = [
    [
      "按天回看",
      "messages",
      "SELECT * FROM messages WHERE conv_id='g' AND ts>=1 AND ts<2 ORDER BY ts",
    ],
    [
      "某人某天的发言",
      "messages",
      "SELECT content FROM messages WHERE sender_wx_id='w' AND ts>=1 AND ts<2",
    ],
    [
      "雷达预估扫描",
      "messages",
      "SELECT content FROM messages WHERE conv_id IN ('g') AND ts>=1 AND type IN ('text','quote')",
    ],
    [
      "**排行榜聚合**",
      "daily_stats",
      "SELECT wx_id, sum(quality_messages) q FROM daily_stats WHERE conv_id IN ('g') AND date>='2026-01-01' GROUP BY wx_id ORDER BY q DESC LIMIT 50",
    ],
    [
      "我的日统计",
      "daily_stats",
      "SELECT * FROM daily_stats WHERE wx_id='w' AND date>='2026-01-01'",
    ],
    ["我在哪些群", "group_members", "SELECT conv_id FROM group_members WHERE wx_id='w' AND left_at IS NULL"],
    ["群里有谁", "group_members", "SELECT wx_id FROM group_members WHERE conv_id='g' AND left_at IS NULL"],
    [
      "未读通知数",
      "notifications",
      "SELECT count(*) FROM notifications WHERE user_id='u' AND read_at IS NULL",
    ],
    [
      "链接可见性",
      "link_mentions",
      "SELECT link_id FROM link_mentions WHERE conv_id IN ('g')",
    ],
    ["关键词命中", "keyword_hits", "SELECT * FROM keyword_hits WHERE sub_id='s' ORDER BY hit_at DESC LIMIT 5"],
    ["我的技能标签", "user_skills", "SELECT * FROM user_skills WHERE user_id IN ('a','b')"],
  ];

  for (const [label, table, sql] of HOT) {
    it(`${label} 走索引，不扫 ${table}`, () => {
      const plan = planOf(sql);
      assert.doesNotMatch(
        plan,
        new RegExp(`SCAN ${table}\\b`),
        `\n  ${label} 在 ${table} 上全表扫描了：\n  ${plan}\n  表还小的时候不痛，大了就是这一页最慢的地方\n`,
      );
    });
  }

  it("**排行榜那条索引真的存在** —— 没有它就退回全表扫描", () => {
    const indexes = dbm.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='daily_stats'`)
      .all()
      .map((r) => (r as { name: string }).name);
    assert.ok(
      indexes.includes("daily_stats_conv_date_idx"),
      `daily_stats 上的索引：${indexes.join(", ")}`,
    );
  });
});
