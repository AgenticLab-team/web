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
    for (const t of [
      schema.dailyStats,
      schema.people,
      schema.userPrivacy,
      schema.users,
      schema.groups,
    ]) {
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

  describe("**「别人看不到这一行」要标出来 —— 但只标给管理员**", () => {
    /*
     * 管理员看到的是**完整**的榜（隐私排除对他返回空名单）。
     * 界面上不标的话，他会以为公开的榜就长这样，
     * 然后照着一个只有他自己看得见的名次去发公告、发奖 ——
     * 那是一次好心办出来的隐私事故。
     *
     * 反过来，这个信息**绝不能给普通成员**：
     * 告诉他们「谁把自己藏了」等于把那个开关直接废掉 ——
     * 藏起来的人反而更显眼。
     */
    const hide = (userId: string) =>
      dbm.db
        .insert(schema.userPrivacy)
        .values({ userId, hideFromLeaderboard: true })
        .run();

    it("**普通成员的结果里根本没有这两个字段**", () => {
      /*
       * 用一个**没藏起来**的人来测 —— 藏起来的那个对成员本来就不出现，
       * 拿它测的话，测的是「排除生效了」而不是「字段没漏」。
       *
       * 恒为 undefined 而不是 false：一个 `hiddenFromOthers: false`
       * 的字段本身就在说「这个概念存在」，而普通成员不该知道它存在。
       */
      reset();
      stat("wx_a", 100);
      person("wx_a", "小明");
      account("u_a", "wx_a");
      const [row] = member();
      assert.equal("hiddenFromOthers" in row, false, "把「谁藏了自己」告诉普通成员了");
      assert.equal("anonymousToGuests" in row, false);
    });

    it("**访客那一侧同样没有这两个字段**", () => {
      reset();
      stat("wx_ghost", 100);
      const [row] = guest();
      assert.equal("hiddenFromOthers" in row, false);
      assert.equal("anonymousToGuests" in row, false);
    });

    it("**字段只在特权视角下才加** —— 判定写在查询层", () => {
      /*
       * 靠页面记得不渲染是不行的：这两个字段一旦进了响应，
       * 任何一个能看网络面板的成员都拿得到。
       */
      const q = readFileSync(
        new URL("../src/lib/queries/leaderboard.ts", import.meta.url),
        "utf8",
      );
      assert.match(q, /const privacy = leaderboardPrivacy\(options\.viewer \?\? null\)/);
      assert.match(q, /\.\.\.\(privileged[\s\S]{0,20}\?[\s\S]{0,10}\{/);
    });

    it("**权限只在 privacy/queries.ts 里判一次**", () => {
      /*
       * 榜单需要两件事：该排除谁、哪几行别人看不到。
       * 分开调的话 `bypassesPrivacy` 会被判两遍 ——
       * 而它背后是一次完整的权限解析，一次榜单查询因此多花三条 SQL。
       *
       * 更要紧的是漏判的方向：调用点各写一遍的话，
       * 漏的永远是「把关掉开关的人重新暴露出去」。
       */
      const pq = readFileSync(
        new URL("../src/lib/privacy/queries.ts", import.meta.url),
        "utf8",
      );
      assert.match(pq, /export function leaderboardPrivacy\(/);
      assert.match(pq, /hiddenForAudit: privileged \? new Set\(all\) : null/);

      const q = readFileSync(
        new URL("../src/lib/queries/leaderboard.ts", import.meta.url),
        "utf8",
      );
      assert.equal(q.includes("bypassesPrivacy"), false, "榜单自己又判了一遍权限");
    });

    it("**藏起来的人对普通成员根本不出现** —— 那才是开关的本意", () => {
      reset();
      stat("wx_a", 100);
      person("wx_a", "小明");
      account("u_a", "wx_a");
      hide("u_a");
      assert.deepEqual(member().map((r) => r.wxId), []);
    });

    it("访客那一侧同样看不到藏起来的人", () => {
      reset();
      stat("wx_a", 100);
      person("wx_a", "小明");
      account("u_a", "wx_a");
      hide("u_a");
      assert.deepEqual(guest().map((r) => r.wxId), []);
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

describe("**界面上的两个标**", () => {
  const list = readFileSync(
    new URL("../src/components/LeaderboardList.tsx", import.meta.url),
    "utf8",
  );

  it("「仅你可见」标出别人看不到的那一行", () => {
    assert.match(list, /entry\.hiddenFromOthers &&/);
    assert.match(list, /仅你可见/);
  });

  it("「访客不具名」标出没注册过本站的人", () => {
    assert.match(list, /entry\.anonymousToGuests &&/);
    assert.match(list, /访客不具名/);
  });

  it("**组件不自己判权限** —— 字段在查询层就只给特权视角", () => {
    /*
     * 组件里再判一次的话，就有两处在决定「谁看得到这个信息」，
     * 而两处迟早分叉。更要紧的是：字段一旦进了响应，
     * 任何一个能看网络面板的成员都拿得到 —— 藏在组件里没有用。
     */
    assert.equal(list.includes("moderation.queue"), false);
    assert.equal(list.includes("bypassesPrivacy"), false);
  });

  it("**两个标各说各的**，不能合成一个", () => {
    // 「藏起来了」和「没注册」是两件事，合成一个标之后管理员分不清该怎么办
    assert.notEqual(
      list.indexOf("仅你可见"),
      list.indexOf("访客不具名"),
    );
  });
});
