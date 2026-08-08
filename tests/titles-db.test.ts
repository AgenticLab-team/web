import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 称号的数据库侧。
 *
 * 最要紧的一条：**佩戴的称号要重新校验有效期**。
 * users.activeTitleId 是冗余列，租用的称号到期后没有任何人会去清它 ——
 * 不校验的话，过期称号会一直挂在名字后面，而用户完全不知道为什么。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-titles-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type QueriesModule = typeof import("@/lib/titles/queries");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let q: QueriesModule;
let dbm: DbModule;
let schema: SchemaModule;

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  q = await import("@/lib/titles/queries");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.userTitles).run();
  dbm.db.delete(schema.titles).run();
  dbm.db.delete(schema.users).run();

  dbm.db
    .insert(schema.users)
    .values([
      { id: "u1", wxId: "wx1", siteNickname: "甲", pointsTotal: 1000, streakBest: 30 },
      { id: "u2", wxId: "wx2", siteNickname: "乙" },
    ])
    .run();

  dbm.db
    .insert(schema.titles)
    .values([
      { id: "t_seed", key: "seed_user", name: "种子用户", icon: "🌱", rarity: "legendary", source: "grant", limitCount: 2, sort: 100 },
      { id: "t_rent", key: "custom", name: "自定义称号", icon: "🏷️", rarity: "rare", source: "purchase", price: 300, rentDays: 30, sort: 50 },
      { id: "t_off", key: "retired", name: "已停用", rarity: "common", source: "grant", enabled: false, sort: 1 },
    ])
    .run();
});

function give(userId: string, titleId: string, over: Record<string, unknown> = {}) {
  dbm.db.insert(schema.userTitles).values({ userId, titleId, ...over }).run();
}

describe("持有列表", () => {
  it("列出持有的称号", () => {
    give("u1", "t_seed");
    const list = q.titlesOf("u1", NOW);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "种子用户");
    assert.equal(list[0].active, true);
  });

  it("**过期的仍然陈列出来，只是标记为失效**", () => {
    // 直接消失会让人以为系统弄丢了自己的东西
    give("u1", "t_rent", { expiresAt: NOW - DAY });
    const list = q.titlesOf("u1", NOW);
    assert.equal(list.length, 1);
    assert.equal(list[0].active, false);
    assert.equal(list[0].expired, true);
  });

  it("被收回的标记为收回，与过期分得开", () => {
    give("u1", "t_seed", { revokedAt: NOW - DAY });
    const list = q.titlesOf("u1", NOW);
    assert.equal(list[0].expired, false);
    assert.equal(list[0].revokedAt !== null, true);
  });

  it("别人的称号不会串进来", () => {
    give("u2", "t_seed");
    assert.equal(q.titlesOf("u1", NOW).length, 0);
  });

  it("标出当前佩戴的那一个", () => {
    give("u1", "t_seed");
    give("u1", "t_rent", { expiresAt: NOW + DAY });
    dbm.db.update(schema.users).set({ activeTitleId: "t_rent" }).where(eq(schema.users.id, "u1")).run();

    const list = q.titlesOf("u1", NOW);
    assert.equal(list.find((t) => t.titleId === "t_rent")!.equipped, true);
    assert.equal(list.find((t) => t.titleId === "t_seed")!.equipped, false);
  });
});

describe("当前佩戴", () => {
  it("正常佩戴时取得到", () => {
    give("u1", "t_seed");
    dbm.db.update(schema.users).set({ activeTitleId: "t_seed" }).where(eq(schema.users.id, "u1")).run();
    assert.equal(q.equippedTitle("u1", NOW)!.name, "种子用户");
  });

  it("没佩戴时返回 null", () => {
    give("u1", "t_seed");
    assert.equal(q.equippedTitle("u1", NOW), null);
  });

  it("**佩戴的称号过期后不再显示**", () => {
    // activeTitleId 是冗余列，到期后没有任何人会去清它
    give("u1", "t_rent", { expiresAt: NOW - 1 });
    dbm.db.update(schema.users).set({ activeTitleId: "t_rent" }).where(eq(schema.users.id, "u1")).run();
    assert.equal(q.equippedTitle("u1", NOW), null, "过期称号不该还挂在名字后面");
  });

  it("**佩戴的称号被收回后不再显示**", () => {
    give("u1", "t_seed", { revokedAt: NOW - 1 });
    dbm.db.update(schema.users).set({ activeTitleId: "t_seed" }).where(eq(schema.users.id, "u1")).run();
    assert.equal(q.equippedTitle("u1", NOW), null);
  });

  it("批量取与单个取结论一致", () => {
    give("u1", "t_seed");
    give("u2", "t_rent", { expiresAt: NOW - 1 });
    dbm.db.update(schema.users).set({ activeTitleId: "t_seed" }).where(eq(schema.users.id, "u1")).run();
    dbm.db.update(schema.users).set({ activeTitleId: "t_rent" }).where(eq(schema.users.id, "u2")).run();

    const batch = q.equippedTitles(["u1", "u2"], NOW);
    assert.equal(batch.get("u1")?.name, "种子用户");
    assert.equal(batch.has("u2"), false, "过期的在批量里也要被滤掉");
    assert.equal(batch.get("u1")?.name, q.equippedTitle("u1", NOW)?.name);
  });

  it("空数组不查库也不报错", () => {
    assert.equal(q.equippedTitles([], NOW).size, 0);
  });
});

describe("名额", () => {
  it("在册的才算数", () => {
    give("u1", "t_seed");
    give("u2", "t_seed");
    assert.equal(q.holderCount("t_seed", NOW), 2);
  });

  it("**收回的不占名额** —— 否则收回之后名额永远补不回来", () => {
    give("u1", "t_seed");
    give("u2", "t_seed", { revokedAt: NOW - DAY });
    assert.equal(q.holderCount("t_seed", NOW), 1);
  });

  it("过期的也不占名额", () => {
    give("u1", "t_rent", { expiresAt: NOW - DAY });
    assert.equal(q.holderCount("t_rent", NOW), 0);
  });
});

describe("称号目录", () => {
  it("默认不列停用的", () => {
    const keys = q.listTitles().map((t) => t.key);
    assert.ok(keys.includes("seed_user"));
    assert.ok(!keys.includes("retired"), "停用的不该出现在可授予列表里");
  });

  it("需要时能列出停用的", () => {
    assert.ok(q.listTitles(true).some((t) => t.key === "retired"));
  });

  it("按 key 取得到", () => {
    assert.equal(q.titleByKey("seed_user")?.name, "种子用户");
    assert.equal(q.titleByKey("nope"), null);
  });
});

describe("成就统计", () => {
  it("**指标名必须与 AchievementStats 的键对得上**", () => {
    // 对不上的话条件永远不成立，而且不会报错 —— 成就静默地永远发不出去
    const stats = q.achievementStats("u1");
    for (const key of ["pointsTotal", "streakBest", "posts", "replies", "qualityMessages", "checkins"]) {
      assert.ok(key in stats, `缺少指标 ${key}`);
      assert.equal(typeof stats[key as keyof typeof stats], "number");
    }
  });

  it("读得到用户身上的累计值", () => {
    const stats = q.achievementStats("u1");
    assert.equal(stats.pointsTotal, 1000);
    assert.equal(stats.streakBest, 30);
  });

  it("没有任何记录时全是 0，不是 undefined", () => {
    const stats = q.achievementStats("u2");
    assert.equal(stats.posts, 0);
    assert.equal(stats.checkins, 0);
  });

  it("不存在的用户不炸", () => {
    assert.equal(q.achievementStats("nobody").pointsTotal, 0);
  });
});

describe("内置称号写入", () => {
  it("幂等：重复执行不会写重复", async () => {
    dbm.db.delete(schema.titles).run();
    const { seedTitles } = await import("@/lib/titles/seed-titles");
    const first = seedTitles();
    const second = seedTitles();
    assert.ok(first > 0);
    assert.equal(second, 0, "第二次不该再写入任何东西");
  });

  it("**只补不改**：管理员改过的值不能被重启冲掉", async () => {
    dbm.db.delete(schema.titles).run();
    const { seedTitles } = await import("@/lib/titles/seed-titles");
    seedTitles();

    dbm.db.update(schema.titles).set({ name: "改过的名字" }).where(eq(schema.titles.key, "seed_user")).run();
    seedTitles();

    assert.equal(q.titleByKey("seed_user")?.name, "改过的名字");
  });
});
