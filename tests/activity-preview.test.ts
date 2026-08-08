import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 「现在有多少人够格」。
 *
 * 这是整套资格引擎存在的**主要理由**：60 个名额，
 * 你需要在开放之前就知道是 500 人抢 60 个，还是只有 12 个人够格 ——
 * 前者要考虑抽签，后者说明门槛定高了，两种情况的应对完全相反。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-preview-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type Queries = typeof import("@/lib/activities/queries");
type Stats = typeof import("@/lib/activities/stats");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let queries: Queries;
let statsMod: Stats;
let dbm: DbModule;
let schema: SchemaModule;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { seedDatabase } = await import("@/lib/db/seed");
  seedDatabase();
  queries = await import("@/lib/activities/queries");
  statsMod = await import("@/lib/activities/stats");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.activityQuotaLog,
    schema.activityApplications,
    schema.activities,
    schema.dailyStats,
    schema.groupMembers,
    schema.posts,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }
});

function user(id: string, over: Record<string, unknown> = {}) {
  dbm.db
    .insert(schema.users)
    .values({
      id,
      wxId: `wx_${id}`,
      siteNickname: id,
      status: "active",
      level: 1,
      firstBoundAt: new Date("2026-06-20").getTime(),
      ...over,
    })
    .run();
}

function daily(wxId: string, date: string, messages: number, quality: number) {
  dbm.db
    .insert(schema.dailyStats)
    .values({ convId: "g1", wxId, date, messages, qualityMessages: quality })
    .run();
}

describe("指标计算", () => {
  it("从每日统计聚合群聊指标", () => {
    user("alice");
    daily("wx_alice", "2026-08-01", 100, 30);
    daily("wx_alice", "2026-08-02", 50, 20);

    const stats = statsMod.computeAllStats();
    const alice = stats.find((s) => s.userId === "alice")!;
    assert.equal(alice.messages, 150);
    assert.equal(alice.quality_messages, 50);
    assert.equal(alice.active_days, 2);
  });

  it("没有数据的人各项是 0，不是 undefined", () => {
    user("bob");
    const bob = statsMod.computeAllStats().find((s) => s.userId === "bob")!;
    assert.equal(bob.messages, 0);
    assert.equal(bob.quality_messages, 0);
    assert.equal(bob.forum_posts, 0);
  });

  it("**只算注册过的账号** —— 没账号的人报不了名", () => {
    user("alice");
    assert.equal(statsMod.computeAllStats().length, 1);
  });

  it("被封的人不在候选里", () => {
    user("alice");
    user("banned", { status: "banned" });
    assert.equal(statsMod.computeAllStats().length, 1);
  });

  it("绑定日期是 YYYY-MM-DD，与规则里的写法一致", () => {
    user("alice");
    const alice = statsMod.computeAllStats()[0];
    assert.match(String(alice.bound_since), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("带上所在的群，供 in_group 规则使用", () => {
    user("alice");
    dbm.db.insert(schema.groupMembers).values({ convId: "g1", wxId: "wx_alice" }).run();

    const alice = statsMod.computeAllStats()[0];
    assert.deepEqual(alice.in_group, ["g1"]);
  });

  it("退群的不算在所在群里", () => {
    user("alice");
    dbm.db
      .insert(schema.groupMembers)
      .values({ convId: "g1", wxId: "wx_alice", leftAt: Date.now() })
      .run();

    assert.deepEqual(statsMod.computeAllStats()[0].in_group, []);
  });
});

describe("实时预估", () => {
  beforeEach(() => {
    // 三个人：一个远超、一个刚好、一个差一点
    user("strong", { level: 5 });
    daily("wx_strong", "2026-08-01", 500, 200);

    user("exact", { level: 3 });
    daily("wx_exact", "2026-08-01", 200, 50);

    user("close", { level: 3 });
    daily("wx_close", "2026-08-01", 180, 45);
  });

  it("算得出有几个人够格", () => {
    const preview = queries.eligiblePreview({
      metric: "quality_messages",
      op: ">=",
      value: 50,
    });

    assert.equal(preview.total, 3);
    assert.equal(preview.eligible, 2);
  });

  it("**门槛调一格，人数立刻变** —— 这是这个功能存在的理由", () => {
    const strict = queries.eligiblePreview({ metric: "quality_messages", op: ">=", value: 100 });
    const loose = queries.eligiblePreview({ metric: "quality_messages", op: ">=", value: 45 });

    assert.equal(strict.eligible, 1);
    assert.equal(loose.eligible, 3);
  });

  it("**列出「差一点点」的人** —— 门槛降一格能多放进来几个", () => {
    const preview = queries.eligiblePreview({
      metric: "quality_messages",
      op: ">=",
      value: 50,
    });

    assert.equal(preview.nearMiss.length, 1);
    assert.equal(preview.nearMiss[0].name, "close");
    assert.match(preview.nearMiss[0].missing, /45/);
  });

  it("给出够格的名单，可以导出", () => {
    const preview = queries.eligiblePreview({ metric: "quality_messages", op: ">=", value: 100 });
    assert.deepEqual(preview.names, ["strong"]);
  });

  it("没有规则时所有人都够格", () => {
    assert.equal(queries.eligiblePreview(null).eligible, 3);
  });

  it("**规则写错时不会静默让所有人通过**", () => {
    // 拼错的指标名会让所有人判为不够格，而不是都够格 ——
    // 前者一眼能看出异常，后者会在活动开放后才暴露
    const preview = queries.eligiblePreview({
      metric: "quality_msgs",
      op: ">=",
      value: 1,
    } as never);
    assert.equal(preview.eligible, 0);
  });

  it("组合规则也能预估", () => {
    const preview = queries.eligiblePreview({
      all: [
        { metric: "quality_messages", op: ">=", value: 50 },
        { metric: "level", op: ">=", value: 5 },
      ],
    });
    assert.equal(preview.eligible, 1);
  });

  it("一个人都没有时不炸", () => {
    dbm.db.delete(schema.users).run();
    const preview = queries.eligiblePreview(null);
    assert.equal(preview.total, 0);
    assert.equal(preview.eligible, 0);
  });
});

describe("待注册清单导出", () => {
  beforeEach(() => {
    user("alice");
    dbm.db
      .insert(schema.activities)
      .values({
        id: "act1",
        moduleKey: "domain",
        title: "域名发放",
        quotaTotal: 60,
        status: "open",
        createdBy: "u_admin",
      })
      .run();
  });

  it("只导出已通过和履约中的", () => {
    for (const [id, status] of [
      ["a1", "approved"],
      ["a2", "waitlisted"],
      ["a3", "fulfilled"],
      ["a4", "fulfilling"],
    ] as const) {
      dbm.db
        .insert(schema.activityApplications)
        .values({
          id,
          activityId: "act1",
          userId: "alice",
          status,
          normalizedKey: `${id}.sh`,
          payload: { name: id, tld: "sh" },
        })
        .run();
    }

    const list = queries.exportPendingList("act1");
    assert.match(list, /a1\.sh/);
    assert.match(list, /a4\.sh/);
    assert.ok(!list.includes("a2.sh"), "候补的还没轮到，不该出现在待注册清单里");
    assert.ok(!list.includes("a3.sh"), "已完成的不该再注册一次");
  });

  it("**格式能直接复制粘贴** —— 管理员拿它去批量注册", () => {
    dbm.db
      .insert(schema.activityApplications)
      .values({
        id: "a1",
        activityId: "act1",
        userId: "alice",
        status: "approved",
        normalizedKey: "agentic-lab.sh",
        payload: { name: "agentic-lab", tld: "sh" },
      })
      .run();

    const list = queries.exportPendingList("act1");
    const [domain, name] = list.split("\n")[0].split("\t");
    assert.equal(domain, "agentic-lab.sh");
    assert.equal(name, "alice");
  });

  it("没有待注册的返回空串，而不是一堆表头", () => {
    assert.equal(queries.exportPendingList("act1"), "");
  });
});
