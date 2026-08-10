import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * 排行榜。
 *
 * ─────────────────────────────────────────
 * 没注册过这个站的人也在榜上
 * ─────────────────────────────────────────
 *
 * 榜单按 `daily_stats` 的 wx_id 聚合 —— 也就是说**群里的每一个人
 * 都在榜上，包括从没打开过这个站的人**。线上第 4 活跃的那位就没有账号。
 *
 * 而退出榜单的开关（`user_privacy.hide_from_leaderboard`）
 * 需要一个账号才拨得动。于是暴露对所有人成立，
 * 而退出只对加入过的人开放 —— 这条不对称站不住。
 *
 * 隐私页自己写着：「这个站把发言量做成了对未登录访客公开的榜单，
 * 这是微信里不存在的暴露」。一个从没来过的人，
 * 不该因为别人建了这个站而把微信昵称和头像挂到公网上。
 *
 * ─────────────────────────────────────────
 * 隐去名字，不隐去这个人
 * ─────────────────────────────────────────
 *
 * 名次和条数照旧 —— 那是社区真实的活跃分布，抹掉它等于让榜单说假话。
 * 隐去的只有身份：名字和头像。
 *
 * 登录成员看得到全名：他们和这些人在同一批群里，
 * 那些昵称他们每天都在微信里看见，这里没有多出新的暴露。
 */

describe("真库", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "al-board-"));
  process.env.DB_PATH = join(tmp, "test.db");
  process.env.NEKOBOT_API_KEY = "nk_test";

  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const board = await import("@/lib/queries/leaderboard");
  const { todayKey } = await import("@/lib/time");

  after(() => rmSync(tmp, { recursive: true, force: true }));

  const CONV = "g_a";
  const reset = () => {
    for (const t of [schema.dailyStats, schema.people, schema.users, schema.groups]) {
      dbm.db.delete(t).run();
    }
    dbm.db.insert(schema.groups).values({ convId: CONV, name: "A 群", isGroup: true }).run();
  };

  /** 一行当天统计 —— 榜单是从这张表聚合出来的 */
  const stat = (wxId: string, quality: number) =>
    dbm.db
      .insert(schema.dailyStats)
      .values({
        wxId,
        convId: CONV,
        date: todayKey(),
        messages: quality,
        qualityMessages: quality,
        charsTotal: quality * 20,
      })
      .run();

  /** 群成员档案（来自上游同步）—— 有档案不代表有账号 */
  const person = (wxId: string, name: string) =>
    dbm.db
      .insert(schema.people)
      .values({ wxId, displayName: name, avatarUrl: `https://x/${wxId}.jpg` })
      .run();

  /** 真的注册过这个站 */
  const account = (id: string, wxId: string) =>
    dbm.db.insert(schema.users).values({ id, wxId, status: "active" }).run();

  const guest = () => board.getLeaderboard({ period: "all", convIds: [CONV], viewer: null });
  const member = () =>
    board.getLeaderboard({
      period: "all",
      convIds: [CONV],
      viewer: { id: "u_me", wxId: "wx_me" } as never,
    });

  describe("**访客看到的榜单**", () => {
    it("**没账号的人不具名**", () => {
      reset();
      stat("wx_ghost", 100);
      person("wx_ghost", "群里的老王");
      const [row] = guest();
      assert.equal(row.name, "群成员");
      assert.equal(row.avatarUrl, null);
    });

    it("**名次和条数照旧是真的** —— 抹掉它等于让榜单说假话", () => {
      reset();
      stat("wx_ghost", 100);
      person("wx_ghost", "群里的老王");
      const [row] = guest();
      assert.equal(row.rank, 1);
      assert.equal(row.quality, 100);
    });

    it("有账号的人照常显示名字", () => {
      reset();
      stat("wx_a", 100);
      person("wx_a", "小明");
      account("u_a", "wx_a");
      assert.equal(guest()[0].name, "小明");
    });

    it("**登录成员看得到全名** —— 那些昵称他们每天在微信里都看见", () => {
      reset();
      stat("wx_ghost", 100);
      person("wx_ghost", "群里的老王");
      assert.equal(member()[0].name, "群里的老王");
    });

    it("匿名不改变排序", () => {
      reset();
      stat("wx_ghost", 200);
      person("wx_ghost", "老王");
      stat("wx_a", 100);
      person("wx_a", "小明");
      account("u_a", "wx_a");
      assert.deepEqual(guest().map((r) => r.quality), [200, 100]);
      assert.deepEqual(guest().map((r) => r.name), ["群成员", "小明"]);
    });

    it("**wx_id 永远不会出现在名字里** —— 那是隐私事故", () => {
      /*
       * 没有档案的人走 resolveDisplayName 的兜底。
       * 兜底如果回落成 wx_id，榜单就把微信号发到公网上了。
       */
      reset();
      stat("wxid_secret_abc", 50);
      for (const row of guest()) {
        assert.equal(row.name.includes("wxid_"), false, `名字里带了 wx_id：${row.name}`);
      }
    });
  });

  describe("看不到任何群的人拿到空榜", () => {
    it("不传群 = 空榜，不是全量榜", () => {
      reset();
      stat("wx_a", 100);
      assert.deepEqual(board.getLeaderboard({ period: "all", convIds: [], viewer: null }), []);
    });
  });
});

describe("接线", () => {
  it("**页面上说明了不具名这件事** —— 不说的话一串「群成员」看起来像数据坏了", () => {
    const page = readFileSync(
      new URL("../src/app/(app)/leaderboard/page.tsx", import.meta.url),
      "utf8",
    );
    assert.match(page, /不具名/);
  });

  it("**匿名只针对访客** —— 判定写在查询层，不靠页面记得传", () => {
    const q = readFileSync(new URL("../src/lib/queries/leaderboard.ts", import.meta.url), "utf8");
    assert.match(q, /const anonymize = !options\.viewer;/);
  });
});
